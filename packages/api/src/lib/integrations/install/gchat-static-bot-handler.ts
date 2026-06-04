/**
 * `GchatStaticBotInstallHandler` — Google Chat install handler (issue
 * #2754, Phase D). Concrete implementation of
 * {@link StaticBotInstallHandler} alongside Telegram (#2748), Discord
 * (#2749), and Teams (#2752).
 *
 * Google Chat follows the same operator-shared static-bot pattern as the
 * other Phase D platforms: one operator-owned Google Workspace
 * Marketplace listing (env: `GCHAT_SERVICE_ACCOUNT_JSON` +
 * `GCHAT_PUBSUB_TOPIC`) serves every customer; each customer Workspace's
 * routing identifier is the Google Workspace **customer id** captured
 * from the Marketplace install webhook. Optional `workspace_domain` rides
 * through `extras` analogous to Telegram's `display_name` and Discord's
 * `guild_name`.
 *
 * Per-Workspace credential note: there isn't one. The bot's auth lives
 * with the operator's service account; per-Workspace state is just
 * `{ workspace_id, workspace_domain? }`, which is non-secret (the
 * customer id leaks in every Google Chat event envelope's
 * `space.customer` field once the Workspace Events subscription fires).
 * The `workspace_plugins.config` row is written by the chat-integration
 * cap gate (`checkChatIntegrationLimitAndInstall`, mirroring the Telegram
 * / Discord handlers), which owns the advisory-locked UPSERT, so
 * `encryptSecretFields` is not in the write path at all.
 *
 * Cap gate (#3143): like Telegram, Discord, and Slack, the install UPSERT
 * runs through `checkChatIntegrationLimitAndInstall` so an over-cap
 * net-new install is refused with `ChatIntegrationLimitError` (→ 429) and
 * a reconnect is grandfathered. This replaced the original bare
 * `internalQuery` UPSERT when gchat joined the unified install path under
 * umbrella #2994.
 *
 * Reachability verification — Pub/Sub round-trip: rather than waiting
 * for the first real Workspace Event (which would silently degrade if
 * the SA lacks `roles/pubsub.publisher` on the topic, or if the topic
 * doesn't exist), we publish a synthetic verification message to the
 * operator-shared Pub/Sub topic and confirm Google returns a non-empty
 * `messageIds` array. Two upstream calls run sequentially:
 *
 *   1. POST `https://oauth2.googleapis.com/token` with a JWT-bearer
 *      assertion signed by the SA's private key (the `iss` is the
 *      `client_email`, `aud` is the token endpoint, scope is
 *      `pubsub`). Returns a short-lived access token.
 *   2. POST `https://pubsub.googleapis.com/v1/<topic>:publish` with one
 *      base64'd message containing the workspace_id *fingerprint*
 *      (last 4 chars) so a log scraper can correlate the round-trip to
 *      the install attempt without exfiltrating the full customer id.
 *      Success ⇒ Pub/Sub round-trip confirmed.
 *
 * Either failure surfaces Google's verbatim `error.message` to the
 * admin so the actionable text (e.g. "User not authorized to perform
 * this action" → grant the SA `roles/pubsub.publisher` on the topic)
 * propagates instead of a generic "install failed".
 *
 * @see ./types.ts — {@link StaticBotInstallHandler}
 * @see ./telegram-static-bot-handler.ts — the keystone shape this mirrors
 * @see https://cloud.google.com/pubsub/docs/publisher#publish
 * @see https://developers.google.com/identity/protocols/oauth2/service-account
 */

import crypto from "crypto";
import { SignJWT, importPKCS8 } from "jose";
import { createLogger } from "@atlas/api/lib/logger";
import {
  BillingCheckFailedError,
  ChatIntegrationLimitError,
  GchatApiUnavailableError,
  GchatReachabilityError,
  GchatWorkspaceIdInvalidError,
} from "@atlas/api/lib/effect/errors";
import { checkChatIntegrationLimitAndInstall } from "@atlas/api/lib/billing/enforcement";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";
import { isRoutingIdUniqueViolation } from "./routing-id-conflict";

const log = createLogger("integrations.install.gchat");

/** Catalog slug — the dispatch key in `registerStaticBotHandler`. */
export const GCHAT_SLUG: CatalogId = "gchat";

/**
 * Stable `plugin_catalog.id` for Google Chat. The seeder derives row
 * ids as `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`). Kept
 * as a named constant so the install row's FK target stays in lockstep
 * with the seeder rename rule — a seeder rename without updating this
 * string would produce FK violations at first install.
 */
export const GCHAT_CATALOG_ID = "catalog:gchat";

/**
 * Surfaced when a Google Workspace customer id is already bound to a different
 * workspace — by the pre-check below AND by `confirmInstall`'s catch when the
 * migration-0120 partial unique index rejects a concurrent claim. Single
 * source so both paths return identical, actionable text (#3167).
 */
const GCHAT_ROUTING_CONFLICT_MESSAGE =
  "This Google Workspace is already connected to a different Atlas workspace. Each Google Workspace customer id can be linked to only one workspace — disconnect it there first, or contact your admin if you believe this is an error.";

/**
 * Cross-workspace ownership guard (#3154 / #3167). The Pub/Sub round-trip
 * proves the customer-supplied service account can publish, but the Google
 * Workspace customer id (`workspace_id`) is a non-secret routing identifier —
 * it rides in every inbound Google Chat event envelope. Reject a `workspace_id`
 * already bound to a *different* Atlas workspace before persisting, otherwise a
 * second workspace can claim it and the read-side resolver in `executeQuery.ts`
 * fail-closes on `rows.length > 1`, disabling BOTH workspaces. The
 * `workspace_id <> $3` filter (the installing Atlas workspace) excludes a
 * reconnect of the same workspace.
 *
 * This read-only pre-check catches the common case cheaply. The
 * simultaneous-race case (two workspaces binding a never-before-seen customer
 * id at the same instant) is now closed by the partial unique index from
 * migration 0120 (#3167): the losing writer's UPSERT fails with a 23505 that
 * `confirmInstall`'s catch maps back to {@link GCHAT_ROUTING_CONFLICT_MESSAGE},
 * so both paths return the same error.
 *
 * The literal `my_customer` self-install alias is exempt — in BOTH layers. It
 * is a caller-relative reference (each Google Workspace admin's "my own
 * tenant"), NOT a globally unique customer id, so comparing it across
 * workspaces would falsely block every later self-install. The pre-check
 * short-circuits it below; the migration-0120 index excludes it via
 * `NULLIF(config->>'workspace_id', 'my_customer')` (NULL keys are DISTINCT, so
 * never conflict). Two different tenants legitimately storing `my_customer` is
 * a separate (pre-existing) non-routability concern — the inbound resolver
 * matches the *real* customer id from the event envelope, never the literal
 * alias — and is out of scope for this guard.
 */
async function assertWorkspaceIdUnboundElsewhere(
  gchatWorkspaceId: string,
  workspaceId: WorkspaceId,
): Promise<void> {
  if (gchatWorkspaceId === "my_customer") return;
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'workspace_id' = $2
        AND workspace_id <> $3
      LIMIT 1`,
    [GCHAT_CATALOG_ID, gchatWorkspaceId, workspaceId],
  );
  if (rows.length > 0) {
    log.warn(
      { workspaceId, conflictingWorkspaceId: rows[0]?.workspace_id },
      "Google Chat install rejected — workspace_id already bound to a different workspace",
    );
    throw new GchatWorkspaceIdInvalidError({
      message: GCHAT_ROUTING_CONFLICT_MESSAGE,
    });
  }
}

/**
 * Google Workspace customer ids are documented as the string `my_customer`
 * (for the calling admin's own Workspace) or an opaque alphanumeric
 * identifier rendered as `C` + 8 alphanumerics (e.g. `C01abc234`). The
 * regex below admits the literal `my_customer` plus any non-empty string
 * that looks like a Workspace customer id (alphanumeric, optional
 * leading `C`, 6–32 chars). Defensive bounds — Google has been known to
 * issue longer ids for newer customers, so the 32-char cap is the
 * forward-compat envelope rather than the published shape.
 *
 * Exported so `executeQuery`'s gchat branch can reuse the same regex on
 * inbound Pub/Sub envelopes — single source of truth for the
 * customer-id invariant across install + receive paths.
 */
export const GCHAT_WORKSPACE_ID_RE = /^(my_customer|C?[A-Za-z0-9]{6,32})$/;

/**
 * Reachability call timeout. Google's token + Pub/Sub endpoints are
 * normally sub-second; 15s gives ample headroom for transient latency
 * (token endpoint has a small but non-zero p99 spike during quota-burst
 * windows) while keeping the install POST bounded. Mirrors the pattern
 * in `telegram-static-bot-handler.ts` / `discord-static-bot-handler.ts`.
 */
const GCHAT_FETCH_TIMEOUT_MS = 15_000;

/** Google OAuth2 token endpoint — the same one used by every GCP SDK. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Pub/Sub scope sufficient for `topics.publish`. */
const GCHAT_TOKEN_SCOPE = "https://www.googleapis.com/auth/pubsub";

/**
 * Validated subset of the service-account JSON file an operator
 * downloads from the GCP Console. The full file has ~10 fields (private
 * key id, token uri, etc.); we capture the two that gate the JWT-bearer
 * flow.
 *
 * Branded so the *only* constructor is {@link parseServiceAccountJson}
 * — direct object literals can't satisfy the `__brand` field, which
 * means a future caller (test, future programmatic install path) can't
 * hand the handler an unvalidated SA shape. Mirrors the `WorkspaceId`
 * brand pattern from `@useatlas/types/proactive`.
 */
export type GchatServiceAccount = {
  readonly client_email: string;
  /** PEM-encoded RSA private key — `-----BEGIN PRIVATE KEY-----` block. */
  readonly private_key: string;
} & { readonly __brand: "GchatServiceAccount" };

/**
 * Branded Pub/Sub topic path — `projects/<project>/topics/<topic>`.
 * Sole constructor is {@link asPubsubTopicPath}, which runs the same
 * shape gate {@link assertValidPubsubTopic} used to provide as a side-
 * effect-only call. The brand lets `verifyReachability` interpolate
 * `this.pubsubTopic` into the URL with no re-validation — the type
 * itself carries the contract forward.
 */
export type PubsubTopicPath = string & { readonly __brand: "PubsubTopicPath" };

/**
 * Per-deploy operator config. Read once from env by `register.ts` and
 * passed in here. Both required fields are branded — direct construction
 * with a plain string / object literal is a TS error, so a half-wired
 * deploy must fail at the `parseServiceAccountJson` / `asPubsubTopicPath`
 * gate rather than at first install attempt.
 */
export interface GchatStaticBotHandlerConfig {
  /** Parsed contents of `GCHAT_SERVICE_ACCOUNT_JSON`. */
  readonly serviceAccount: GchatServiceAccount;
  /**
   * Fully-qualified Pub/Sub topic path the operator's Workspace Events
   * subscription publishes to. The verification round-trip publishes
   * one synthetic message here and reads back the messageId.
   */
  readonly pubsubTopic: PubsubTopicPath;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
  /**
   * Production-and-test seam for minting the Google OAuth2 access token.
   * Defaults to the real JWT-bearer mint via `jose` + the OAuth2 token
   * endpoint. Tests inject a fake so they don't need a real RSA key or
   * network access. `register.ts` doesn't pass this — production runs
   * the default impl.
   */
  readonly accessTokenProvider?: () => Promise<string>;
}

/** Shape persisted into `workspace_plugins.config` JSONB. */
export interface GchatInstallConfig {
  /** Google Workspace customer id (routing identifier). */
  readonly workspace_id: string;
  /** Optional admin-friendly label rendered in the integrations card. */
  readonly workspace_domain?: string;
}

/**
 * Parse + validate the raw `GCHAT_SERVICE_ACCOUNT_JSON` env-var string
 * into a {@link GchatServiceAccount}. Throws (caught by `register.ts`)
 * when the JSON is unparseable or missing required fields; the helper
 * is exported so admin-UI provisioning flows can run the same gate.
 */
export function parseServiceAccountJson(raw: string): GchatServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // SECURITY: deliberately do NOT attach `cause: err` and aggressively
    // sanitize `err.message` before interpolation. `raw` is the full
    // service-account JSON (including `private_key`), and on modern V8
    // `JSON.parse` errors include an excerpt of the input near the
    // parse-failure offset. With `cause: err` set, pino's default `err`
    // serializer (used by `register.ts`'s log call when this throws at
    // boot) walks the cause chain and can surface that excerpt — which
    // may contain bytes from the PEM private key — into operator log
    // streams. Mirrors the bot-token redaction posture in
    // `telegram-static-bot-handler.ts` / `discord-static-bot-handler.ts`,
    // strengthened here because the env value is multi-kB and the
    // parse-error excerpt is much more likely to land inside the key body.
    const safeMessage = sanitizeParseError(
      err instanceof Error ? err.message : String(err),
    );
    // SECURITY (see comment block above): attaching `cause: err` here
    // would let pino's default `err` serializer walk the chain and
    // surface the raw `SyntaxError.input` (which contains the SA
    // private key) in operator log streams.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`GCHAT_SERVICE_ACCOUNT_JSON is not valid JSON (${safeMessage}).`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      "GCHAT_SERVICE_ACCOUNT_JSON must parse to an object — got a primitive.",
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.client_email !== "string" || obj.client_email.length === 0) {
    throw new Error(
      "GCHAT_SERVICE_ACCOUNT_JSON is missing the required `client_email` field.",
    );
  }
  if (typeof obj.private_key !== "string" || !obj.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "GCHAT_SERVICE_ACCOUNT_JSON is missing or malformed `private_key` (expected PKCS#8 PEM with `-----BEGIN PRIVATE KEY-----`).",
    );
  }
  // The brand cast is safe here — this is the only point in the
  // codebase where a `GchatServiceAccount` is constructed, and the two
  // load-bearing fields have been validated above.
  return {
    client_email: obj.client_email,
    private_key: obj.private_key,
  } as GchatServiceAccount;
}

/**
 * Sole constructor for {@link PubsubTopicPath}. Google's canonical
 * format is `projects/<project>/topics/<topic>`; bare topic names are a
 * common admin mistake that produces a 404 at publish time with a
 * confusing message. Reject up front so the env-gate at register.ts
 * fails loudly on boot.
 */
export function asPubsubTopicPath(raw: string): PubsubTopicPath {
  if (!raw || !raw.startsWith("projects/") || !raw.includes("/topics/")) {
    throw new Error(
      `GCHAT_PUBSUB_TOPIC must be a fully-qualified topic path (projects/<project>/topics/<topic>) — got "${raw}".`,
    );
  }
  return raw as PubsubTopicPath;
}

/**
 * Discriminated union for the OAuth2 token-endpoint response. Modeled
 * the same way as Discord's `parseDiscordGuildResponse` — HTTP status
 * is the primary discriminator (2xx → ok, 4xx/5xx → err) because
 * Google's wire shape can carry an `error` field even on success
 * responses in some legacy contexts, so absence-of-`error` is NOT a
 * safe discriminator on its own.
 */
type GoogleTokenResponse =
  | { readonly kind: "ok"; readonly accessToken: string }
  | { readonly kind: "err"; readonly status: number; readonly description: string };

/** Parse the OAuth2 token-endpoint response into a {@link GoogleTokenResponse}. */
function parseGoogleTokenResponse(raw: unknown, httpStatus: number): GoogleTokenResponse {
  const body =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (httpStatus >= 200 && httpStatus < 300) {
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    if (accessToken.length > 0) {
      return { kind: "ok" as const, accessToken };
    }
  }
  const description =
    typeof body.error_description === "string" && body.error_description.length > 0
      ? body.error_description
      : typeof body.error === "string" && body.error.length > 0
        ? body.error
        : "unknown error";
  return { kind: "err" as const, status: httpStatus, description };
}

/**
 * Discriminated union for the Pub/Sub `topics.publish` response. Same
 * HTTP-status-primary parsing pattern as the token response above.
 * `errorStatus` preserves Google's typed status string
 * (`PERMISSION_DENIED`, `NOT_FOUND`, `UNAUTHENTICATED`, etc.) so the
 * thrown {@link GchatReachabilityError} carries it forward — see the
 * type's JSDoc for why that matters.
 */
type PubsubPublishResponse =
  | { readonly kind: "ok"; readonly messageIds: ReadonlyArray<string> }
  | {
      readonly kind: "err";
      readonly status: number;
      readonly message: string;
      readonly errorStatus: string | undefined;
    };

/** Parse the Pub/Sub publish response into a {@link PubsubPublishResponse}. */
function parsePubsubPublishResponse(
  raw: unknown,
  httpStatus: number,
): PubsubPublishResponse {
  const body =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (httpStatus >= 200 && httpStatus < 300) {
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds.filter((m): m is string => typeof m === "string")
      : [];
    if (messageIds.length > 0) {
      return { kind: "ok" as const, messageIds };
    }
  }
  const errorObj =
    typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>)
      : {};
  const message = typeof errorObj.message === "string" ? errorObj.message : "unknown error";
  const errorStatus =
    typeof errorObj.status === "string" && errorObj.status.length > 0
      ? errorObj.status
      : undefined;
  return {
    kind: "err" as const,
    status: httpStatus,
    message,
    errorStatus,
  };
}

export class GchatStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;

  private readonly serviceAccount: GchatServiceAccount;
  private readonly pubsubTopic: PubsubTopicPath;
  private readonly newId: () => string;
  private readonly accessTokenProvider: () => Promise<string>;

  constructor(config: GchatStaticBotHandlerConfig) {
    // No truthiness re-checks on serviceAccount / pubsubTopic: the
    // brands on those fields mean a TS-compiled call site has already
    // gone through `parseServiceAccountJson` / `asPubsubTopicPath`,
    // both of which throw on invalid input. Keeping the checks here
    // would duplicate the parser's contract and silently drift.
    this.serviceAccount = config.serviceAccount;
    this.pubsubTopic = config.pubsubTopic;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
    this.accessTokenProvider =
      config.accessTokenProvider ?? (() => this.mintAccessTokenViaJwtBearer());
  }

  async confirmInstall(
    workspaceId: WorkspaceId,
    routingIdentifier: string,
    _verificationProof?: string,
    extras?: Record<string, unknown>,
  ): Promise<{ readonly installRecord: InstallRecord }> {
    // ── 1. Validate the routing identifier ─────────────────────────
    if (!routingIdentifier || routingIdentifier.length === 0) {
      throw new GchatWorkspaceIdInvalidError({
        message:
          "Google Chat install requires a non-empty workspace_id (Google Workspace customer id — find it in the Admin console under Account → Account settings → Customer ID, or check the Marketplace install webhook payload).",
      });
    }
    if (!GCHAT_WORKSPACE_ID_RE.test(routingIdentifier)) {
      throw new GchatWorkspaceIdInvalidError({
        message: `Google Workspace workspace_id "${routingIdentifier}" is not a valid customer id. Primary domains (e.g. acme.com) aren't accepted — use the alphanumeric customer id from the Admin console (e.g. C01abc234) or the literal "my_customer" for self-install.`,
      });
    }

    // ── 2. Reachability via Pub/Sub publish round-trip ─────────────
    // Throws on token-endpoint / Pub/Sub failures *before* any DB write,
    // so a failed verification never leaves a half-installed row behind.
    await this.verifyReachability(routingIdentifier);

    // ── 2b. Cross-workspace ownership guard (#3154 / #3167) ─────────
    // The Pub/Sub round-trip proves the SA can publish, NOT that THIS
    // workspace owns the customer id (which is non-secret). Reject a
    // workspace_id already bound to a *different* workspace so a second
    // workspace can't claim it and collapse the read-side resolver onto a
    // `rows.length > 1` fail-closed. A reconnect is excluded by `workspace_id
    // <> $3`. The simultaneous-race residual is closed by the migration-0120
    // partial unique index, whose 23505 the cap-gate catch below maps to the
    // same error (#3167).
    await assertWorkspaceIdUnboundElsewhere(routingIdentifier, workspaceId);

    // ── 3. Plan cap + install row — atomic (#3143, #3001) ──────────
    // Enforce the chat-integration cap and persist the workspace_plugins row
    // in ONE transaction guarded by a per-workspace advisory lock, so two
    // *distinct* net-new platforms installing concurrently can't both slip
    // past the cap. Reconnecting gchat (already installed) is never blocked
    // — the gate excludes gchat's own row from the count, and the UPSERT
    // collapses the duplicate. Identical schema + UPSERT shape to the rest
    // of the static-bot family (see telegram/discord-static-bot-handler.ts
    // for the full rationale on the NOT NULL columns from 0092/0096 and the
    // singleton-index conflict target).
    const candidateId = this.newId();
    const configPayload: GchatInstallConfig = {
      workspace_id: routingIdentifier,
      ...extractWorkspaceDomain(extras, workspaceId),
    };

    let capCheck;
    try {
      capCheck = await checkChatIntegrationLimitAndInstall<{ id: string }>(
        workspaceId,
        GCHAT_CATALOG_ID,
        {
          sql: `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
          params: [candidateId, workspaceId, GCHAT_CATALOG_ID, JSON.stringify(configPayload)],
        },
      );
    } catch (err) {
      if (isRoutingIdUniqueViolation(err)) {
        // Another workspace claimed this customer id between our pre-check and
        // our UPSERT; the migration-0120 partial unique index rejected us
        // (#3167). Surface the same actionable error the pre-check returns
        // rather than a raw 500 — first writer wins, we lost the race.
        log.warn(
          { workspaceId },
          "Google Chat install rejected — workspace_id claimed by another workspace concurrently (unique index)",
        );
        throw new GchatWorkspaceIdInvalidError({
          message: GCHAT_ROUTING_CONFLICT_MESSAGE,
        });
      }
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Failed to persist Google Chat install record — aborting install",
      );
      throw err;
    }
    if (!capCheck.allowed) {
      if (capCheck.reason === "check_failed") {
        // Count couldn't be determined — fail closed, but as a transient
        // 503 "try again", not a misleading 429 "upgrade your plan".
        log.error(
          { workspaceId },
          "Google Chat install blocked — chat-integration count check failed (failing closed)",
        );
        throw new BillingCheckFailedError({
          message: capCheck.errorMessage,
          workspaceId,
        });
      }
      log.info(
        { workspaceId, limit: capCheck.limit },
        "Google Chat install blocked — workspace at chat-integration cap",
      );
      throw new ChatIntegrationLimitError({
        message: capCheck.errorMessage,
        workspaceId,
        limit: capCheck.limit,
      });
    }

    const returned = capCheck.rows[0]?.id;
    if (typeof returned !== "string" || returned.length === 0) {
      // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING` returns
      // the row on both insert and update. Empty here means a driver /
      // wrapper regression — fail loudly rather than ship a stale id back (on
      // re-install the DB row has the existing id; falling back to the fresh
      // candidateId would strand subsequent lookups).
      throw new Error(
        `workspace_plugins UPSERT returned no id for Google Chat install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
      );
    }
    const persistedId: string = returned;

    log.info(
      {
        workspaceId,
        installId: persistedId,
        workspaceIdFingerprint: fingerprintWorkspaceId(routingIdentifier),
      },
      "Google Chat install completed (Pub/Sub round-trip succeeded, install row UPSERTed)",
    );

    return {
      installRecord: {
        id: persistedId,
        workspaceId,
        catalogId: GCHAT_SLUG,
      },
    };
  }

  /**
   * Two-call Pub/Sub round-trip:
   *
   *   1. Mint a Google OAuth2 access token (via the constructor-injected
   *      {@link GchatStaticBotHandlerConfig.accessTokenProvider} — the
   *      default impl is {@link mintAccessTokenViaJwtBearer}).
   *   2. POST a synthetic verification message to the topic; require a
   *      non-empty `messageIds` array in the response (a `2xx` with no
   *      messageIds is an upstream contract violation).
   *
   * Either failure surfaces a tagged error carrying Google's verbatim
   * `error.message` so the admin sees the actionable text. We
   * intentionally do NOT attach `cause: err` on `fetch`-error wrappers
   * — `undici` error messages can include the raw URL (which contains
   * the Pub/Sub topic and project id), and `cause` chains can drag the
   * bearer access token through to log serializers.
   */
  private async verifyReachability(workspaceIdentifier: string): Promise<void> {
    const accessToken = await this.accessTokenProvider();
    const publishUrl = `https://pubsub.googleapis.com/v1/${this.pubsubTopic}:publish`;
    const payloadJson = JSON.stringify({
      messages: [
        {
          // Base64-encode per Pub/Sub's `PubsubMessage.data` contract.
          // Keep the synthetic payload small + correlation-friendly: a
          // log scraper can grep for `atlas.install.verify` and tie a
          // publish-time observation back to the install attempt. We
          // send only the workspace_id *fingerprint* (last 4 chars), not
          // the raw id, so an exfiltrated topic doesn't leak the full
          // customer-id catalog.
          data: Buffer.from(
            JSON.stringify({
              kind: "atlas.install.verify",
              workspaceIdFingerprint: fingerprintWorkspaceId(workspaceIdentifier),
              ts: new Date().toISOString(),
            }),
            "utf8",
          ).toString("base64"),
          attributes: {
            "atlas-install-verify": "true",
          },
        },
      ],
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(publishUrl, GCHAT_FETCH_TIMEOUT_MS, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: payloadJson,
      });
    } catch (err) {
      const message = redactBearerTokens(
        err instanceof Error ? err.message : String(err),
      );
      log.warn(
        {
          workspaceIdFingerprint: fingerprintWorkspaceId(workspaceIdentifier),
          fetchError: message,
        },
        "Google Pub/Sub API unreachable when publishing install-verification message",
      );
      throw new GchatApiUnavailableError({
        message: `Google Pub/Sub API unreachable when verifying install (${message}). Retry, or check operator-side GCHAT_PUBSUB_TOPIC + network egress to pubsub.googleapis.com.`,
      });
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      const message = redactBearerTokens(
        err instanceof Error ? err.message : String(err),
      );
      log.warn(
        {
          workspaceIdFingerprint: fingerprintWorkspaceId(workspaceIdentifier),
          status: response.status,
          parseError: message,
        },
        "Google Pub/Sub API returned non-JSON response",
      );
      throw new GchatApiUnavailableError({
        message: `Google Pub/Sub API returned a non-JSON response when publishing install-verification message (status ${response.status}).`,
      });
    }

    const parsed = parsePubsubPublishResponse(rawBody, response.status);
    switch (parsed.kind) {
      case "ok":
        return;
      case "err": {
        if (parsed.status >= 200 && parsed.status < 300) {
          // 2xx with no messageIds — upstream contract violation. Google's
          // `topics.publish` always echoes message ids on success. Treat
          // as unavailable so the admin retries instead of seeing a
          // misleading 4xx admin-correctable surface.
          throw new GchatApiUnavailableError({
            message: `Google Pub/Sub returned 2xx but no messageIds when publishing install-verification message to "${this.pubsubTopic}" — likely an upstream contract drift. Retry, or contact support if persistent.`,
          });
        }
        // 5xx → upstream outage (retryable), NOT user-correctable.
        // Misclassifying a transient Google 503 as a 400 Reachability
        // error sends operators down the wrong remediation path and
        // suppresses retry behavior. 4xx auth/config failures stay on
        // the reachability path because they ARE admin-correctable
        // (re-grant pubsub.publisher, fix the topic id, etc.).
        if (parsed.status >= 500) {
          throw new GchatApiUnavailableError({
            message: `Google Pub/Sub returned a transient ${parsed.status} when publishing install-verification message: ${parsed.message}. Retry; this is an upstream Google outage, not an operator-side misconfig.`,
          });
        }
        const hint = hintForPubsubError(parsed.status, parsed.errorStatus);
        throw new GchatReachabilityError({
          message: `Google rejected the Pub/Sub round-trip for workspace_id "${workspaceIdentifier}": ${parsed.message}${hint ? ` — ${hint}` : ""}`,
          status: parsed.status,
          errorStatus: parsed.errorStatus,
        });
      }
    }
  }

  /**
   * Production default for {@link GchatStaticBotHandlerConfig.accessTokenProvider}.
   *
   * Mint a short-lived Google OAuth2 access token via the JWT-bearer
   * grant. The JWT is signed with the SA's RSA private key (RS256) and
   * carries `iss=client_email`, `aud=token_url`, `scope=pubsub`, plus
   * `exp/iat` per Google's spec. The handler's constructor wires this
   * method as the `accessTokenProvider` when none is supplied — tests
   * supply a fake provider via the constructor arg instead, avoiding
   * the need for a real RSA key or network access.
   *
   * Same `cause`-omission posture as {@link verifyReachability} — see
   * that method's JSDoc for the operator-credential redaction rationale.
   */
  private async mintAccessTokenViaJwtBearer(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.serviceAccount.client_email,
      scope: GCHAT_TOKEN_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      // Google enforces ≤ 3600s; 3600 is the documented max.
      exp: now + 3600,
    };

    let signedAssertion: string;
    try {
      const privateKey = await importPKCS8(this.serviceAccount.private_key, "RS256");
      signedAssertion = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .sign(privateKey);
    } catch (err) {
      // SECURITY: jose's `importPKCS8` errors may echo bytes from the
      // offending PEM body (e.g. "Invalid key data at offset N"). Run
      // the same PEM-aware sanitization as `sanitizeParseError` before
      // the message reaches a log line or admin-visible HTTP response.
      // Signing failures are operator-misconfig (bad private key) —
      // they're not Pub/Sub-side, so surface as an unavailable rather
      // than a reachability error.
      const message = sanitizeParseError(
        err instanceof Error ? err.message : String(err),
      );
      log.error(
        { signError: message },
        "Failed to sign Google service-account JWT — check GCHAT_SERVICE_ACCOUNT_JSON private_key shape",
      );
      throw new GchatApiUnavailableError({
        message: `Could not sign the Google service-account JWT (${message}). Operator must verify GCHAT_SERVICE_ACCOUNT_JSON private_key is a valid PKCS#8 PEM block.`,
      });
    }

    const tokenBody = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedAssertion,
    }).toString();

    let response: Response;
    try {
      response = await fetchWithTimeout(GOOGLE_TOKEN_URL, GCHAT_FETCH_TIMEOUT_MS, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });
    } catch (err) {
      const message = redactBearerTokens(
        err instanceof Error ? err.message : String(err),
      );
      log.warn({ fetchError: message }, "Google OAuth2 token endpoint unreachable");
      throw new GchatApiUnavailableError({
        message: `Google OAuth2 token endpoint unreachable (${message}). Retry, or check network egress to oauth2.googleapis.com.`,
      });
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GchatApiUnavailableError({
        message: `Google OAuth2 token endpoint returned non-JSON (status ${response.status}): ${message}.`,
      });
    }

    const parsed = parseGoogleTokenResponse(rawBody, response.status);
    switch (parsed.kind) {
      case "ok":
        return parsed.accessToken;
      case "err":
        // 5xx → transient Google outage; surface as unavailable so
        // retry semantics are correct. 4xx is genuinely admin-
        // correctable (revoked SA key, missing scope, invalid grant)
        // — those stay on the reachability path. Same posture as the
        // Pub/Sub branch above.
        if (parsed.status >= 500) {
          throw new GchatApiUnavailableError({
            message: `Google OAuth2 token endpoint returned a transient ${parsed.status}: ${parsed.description}. Retry; this is an upstream Google outage, not an operator-side misconfig.`,
          });
        }
        throw new GchatReachabilityError({
          message: `Google rejected the service-account JWT bearer exchange: ${parsed.description} — verify GCHAT_SERVICE_ACCOUNT_JSON belongs to a service account with pubsub.publisher on the configured topic.`,
          status: parsed.status,
          errorStatus: undefined,
        });
    }
  }
}

/**
 * Extract the optional `workspace_domain` field. Drops any other keys
 * from `extras` silently — the catalog `config_schema` declares the
 * contract; new fields land via a new schema row, not via arbitrary
 * extras injection. Logs at `warn` when `workspace_domain` arrives at
 * the wrong type so the silent drop is observable in server logs.
 */
function extractWorkspaceDomain(
  extras: Record<string, unknown> | undefined,
  workspaceId: WorkspaceId,
): { workspace_domain?: string } {
  if (!extras) return {};
  const raw = extras.workspace_domain;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    log.warn(
      { workspaceId, rawType: typeof raw },
      "Google Chat extras.workspace_domain is not a string — dropping",
    );
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  return { workspace_domain: trimmed };
}

/**
 * Per-status / per-status-string follow-up text appended to Google's
 * `error.message`. Logs a warn when neither bucket matches so operators
 * see observability gaps before users do — the verbatim Google message
 * still propagates in the thrown error, so the user gets *some* info,
 * but a recurring null-return signals a new failure mode worth a
 * follow-up entry here.
 */
function hintForPubsubError(
  httpStatus: number,
  errorStatus: string | undefined,
): string | null {
  if (httpStatus === 401 || errorStatus === "UNAUTHENTICATED") {
    return "the service-account JWT was rejected — confirm GCHAT_SERVICE_ACCOUNT_JSON is current and not from a deleted SA";
  }
  if (httpStatus === 403 || errorStatus === "PERMISSION_DENIED") {
    return "grant the service account `roles/pubsub.publisher` on the configured topic in the GCP console";
  }
  if (httpStatus === 404 || errorStatus === "NOT_FOUND") {
    return "the Pub/Sub topic does not exist — create it in the GCP console under Pub/Sub → Topics, or fix GCHAT_PUBSUB_TOPIC";
  }
  log.warn(
    { httpStatus, errorStatus },
    "Google Pub/Sub error not mapped in hintForPubsubError — consider adding a hint branch",
  );
  return null;
}

/**
 * Short, log-safe fingerprint of the workspace_id — last 4 chars only.
 * The workspace_id is a routing identifier, not a secret, but logging
 * the full value in every install line is noisy.
 */
function fingerprintWorkspaceId(workspaceId: string): string {
  return workspaceId.length <= 4 ? workspaceId : `…${workspaceId.slice(-4)}`;
}

/**
 * Strip any `Bearer <token>` substring from a message. Google access
 * tokens ride in the `Authorization` header but undici's
 * stringified-request errors can echo headers back into `.message`.
 * Last-mile redaction before the message reaches a log line or thrown
 * error. Mirrors the bot-token redaction in
 * `telegram-static-bot-handler.ts`.
 */
function redactBearerTokens(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, "Bearer <redacted>");
}

/**
 * Sanitize an upstream error message that may have been derived from
 * the operator's raw service-account JSON or PEM private key. Two
 * concrete risks:
 *
 *   1. `JSON.parse` error messages on modern V8 include a short excerpt
 *      of the input near the parse-failure offset. For Gchat the input
 *      is multi-kB and includes a multi-line PEM block, so the excerpt
 *      is likely to land *inside* `private_key`.
 *   2. `jose.importPKCS8` errors can echo bytes from the offending PEM
 *      body when the key fails to import for non-shape reasons (wrong
 *      algorithm, missing OID).
 *
 * Both risks are mitigated by: (a) redacting any `BEGIN/END` PEM block
 * with the body between, and (b) capping the message length so a
 * runaway upstream message can't dump a key body even if the regex
 * misses an unusual format. The cap of 200 chars is well under the
 * shortest realistic PEM body (~1.2kB for RSA-2048).
 *
 * The function is intentionally aggressive — it's better to ship a
 * slightly-less-informative operator log line than to leak key material
 * through pino's default serializers.
 */
function sanitizeParseError(message: string): string {
  return message
    .replace(/-----BEGIN[\s\S]*?END[A-Z ]*-----/g, "<redacted-pem>")
    .slice(0, 200);
}

/**
 * `fetch` with a timeout. Bun's fetch has no built-in timeout in
 * serverless runtimes; without an AbortController-driven cap a hung
 * Google upstream would hold the install POST open indefinitely.
 * Mirrors `telegram-static-bot-handler.ts`'s `fetchWithTimeout`.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
