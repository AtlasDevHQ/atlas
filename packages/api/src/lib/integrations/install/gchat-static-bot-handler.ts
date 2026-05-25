/**
 * `GchatStaticBotInstallHandler` — slice 16 of 1.5.3 Phase D (issue
 * #2754). Fourth concrete implementation of {@link StaticBotInstallHandler}
 * after Telegram (#2748), Discord (#2749), and Teams (#2752).
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
 * This handler writes `workspace_plugins.config` directly via
 * `internalQuery` (mirroring the Telegram / Discord handlers), so
 * `encryptSecretFields` is not in the write path at all.
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
 *      base64'd message containing the workspace_id under verification
 *      so a log scraper can correlate the round-trip to the install
 *      attempt. Success ⇒ Pub/Sub round-trip confirmed.
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
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  GchatApiUnavailableError,
  GchatReachabilityError,
  GchatWorkspaceIdInvalidError,
} from "@atlas/api/lib/effect/errors";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";

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
 * downloads from the GCP Console. The full file has ~10 fields (project
 * id, private key id, token uri, etc.); we capture the three that gate
 * the JWT bearer flow and reject any other shape at construction time.
 */
export interface GchatServiceAccount {
  readonly client_email: string;
  /** PEM-encoded RSA private key — `-----BEGIN PRIVATE KEY-----` block. */
  readonly private_key: string;
  /** Optional — falls back to whatever's encoded in `pubsubTopic`. */
  readonly project_id?: string;
}

/**
 * Per-deploy operator config. Read once from env by `register.ts` and
 * passed in here. The constructor refuses to build without a parseable
 * service account JSON OR a topic — both gate the Pub/Sub round-trip, so
 * a half-wired deploy must fail at construction rather than at first
 * install attempt.
 */
export interface GchatStaticBotHandlerConfig {
  /** Parsed contents of `GCHAT_SERVICE_ACCOUNT_JSON`. */
  readonly serviceAccount: GchatServiceAccount;
  /**
   * Fully-qualified Pub/Sub topic path the operator's Workspace Events
   * subscription publishes to. Format:
   * `projects/<project>/topics/<topic>`. The verification round-trip
   * publishes one synthetic message here and reads back the messageId.
   */
  readonly pubsubTopic: string;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
  /** Test-only injection of the access-token mint (skips real JWT signing). */
  readonly accessTokenForTests?: () => Promise<string>;
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
    throw new Error(
      `GCHAT_SERVICE_ACCOUNT_JSON is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
      { cause: err },
    );
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
      "GCHAT_SERVICE_ACCOUNT_JSON is missing or malformed `private_key` (expected PEM with `-----BEGIN PRIVATE KEY-----`).",
    );
  }
  const result: { -readonly [K in keyof GchatServiceAccount]: GchatServiceAccount[K] } = {
    client_email: obj.client_email,
    private_key: obj.private_key,
  };
  if (typeof obj.project_id === "string" && obj.project_id.length > 0) {
    result.project_id = obj.project_id;
  }
  return result;
}

/**
 * Validate the operator-supplied Pub/Sub topic path. Google's canonical
 * format is `projects/<project>/topics/<topic>`; bare topic names are a
 * common admin mistake that produces a 404 at publish time with a
 * confusing message. Reject up front so the env-gate at register.ts
 * fails loudly on boot.
 */
export function assertValidPubsubTopic(topic: string): void {
  if (!topic.startsWith("projects/") || !topic.includes("/topics/")) {
    throw new Error(
      `GCHAT_PUBSUB_TOPIC must be a fully-qualified topic path (projects/<project>/topics/<topic>) — got "${topic}".`,
    );
  }
}

interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
}

interface PubsubPublishResponse {
  readonly messageIds?: ReadonlyArray<string>;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
  };
}

export class GchatStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;

  private readonly serviceAccount: GchatServiceAccount;
  private readonly pubsubTopic: string;
  private readonly newId: () => string;
  private readonly accessTokenForTests: (() => Promise<string>) | undefined;

  constructor(config: GchatStaticBotHandlerConfig) {
    if (!config.serviceAccount?.client_email || !config.serviceAccount?.private_key) {
      throw new Error(
        "GchatStaticBotInstallHandler requires a parsed serviceAccount with client_email + private_key — set GCHAT_SERVICE_ACCOUNT_JSON in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    if (!config.pubsubTopic || config.pubsubTopic.length === 0) {
      throw new Error(
        "GchatStaticBotInstallHandler requires a non-empty pubsubTopic — set GCHAT_PUBSUB_TOPIC in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    assertValidPubsubTopic(config.pubsubTopic);
    this.serviceAccount = config.serviceAccount;
    this.pubsubTopic = config.pubsubTopic;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
    this.accessTokenForTests = config.accessTokenForTests;
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

    // ── 3. Persist install row — UPSERT keyed on (workspace, catalog) ─
    // Mirrors telegram/discord-static-bot-handler.ts: candidate id on
    // INSERT, RETURNING id so a CONFLICT lands on the existing row's
    // id (idempotent re-install).
    const candidateId = this.newId();
    const configPayload: GchatInstallConfig = {
      workspace_id: routingIdentifier,
      ...extractWorkspaceDomain(extras, workspaceId),
    };

    let persistedId: string;
    try {
      // Schema: `pillar` + `install_id` became NOT NULL in 0092 (#2739)
      // and the auto-fill trigger was dropped in 0096 (#2744). The
      // ON CONFLICT inference targets the `workspace_plugins_singleton`
      // partial unique index. See telegram/discord-static-bot-handler.ts
      // for the full rationale — identical schema, identical UPSERT shape.
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        [candidateId, workspaceId, GCHAT_CATALOG_ID, JSON.stringify(configPayload)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING`
        // returns the row on both insert and update. Empty here means a
        // driver / wrapper regression — fail loudly rather than ship a
        // stale id back to the user (on re-install the DB row has the
        // existing id; falling back to the fresh candidateId would
        // strand subsequent lookups).
        throw new Error(
          `workspace_plugins UPSERT returned no id for Google Chat install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Failed to persist Google Chat install record — aborting install",
      );
      throw err;
    }

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
   *   1. Mint a Google OAuth2 access token via JWT-bearer (`mintAccessToken`)
   *   2. POST a synthetic verification message to the topic; require a
   *      non-empty `messageIds` array in the response
   *
   * Either failure surfaces a tagged error carrying Google's verbatim
   * `error.message` so the admin sees the actionable text. We
   * intentionally do NOT attach `cause: err` on `fetch`-error wrappers
   * — `undici` error messages can include the raw URL (which contains
   * the Pub/Sub topic and project id), and `cause` chains can drag the
   * bearer access token through to log serializers.
   */
  private async verifyReachability(workspaceIdentifier: string): Promise<void> {
    const accessToken = await this.mintAccessToken();
    const publishUrl = `https://pubsub.googleapis.com/v1/${this.pubsubTopic}:publish`;
    const payloadJson = JSON.stringify({
      messages: [
        {
          // Base64-encode per Pub/Sub's `PubsubMessage.data` contract.
          // Keep the synthetic payload small + correlation-friendly: a
          // log scraper can grep for `atlas.install.verify` and tie a
          // publish-time observation back to the install attempt.
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

    let parsed: PubsubPublishResponse;
    try {
      parsed = (await response.json()) as PubsubPublishResponse;
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

    if (response.status < 200 || response.status >= 300 || parsed.error) {
      const upstream = parsed.error?.message ?? "unknown error";
      const hint = hintForPubsubError(response.status, parsed.error?.status);
      throw new GchatReachabilityError({
        message: `Google rejected the Pub/Sub round-trip for workspace_id "${workspaceIdentifier}": ${upstream}${hint ? ` — ${hint}` : ""}`,
        status: response.status,
      });
    }

    if (!parsed.messageIds || parsed.messageIds.length === 0) {
      // 2xx with no messageIds is an upstream contract violation —
      // Google's `topics.publish` API always echoes the message ids when
      // the publish succeeds. Treat as unavailable so the admin retries.
      throw new GchatApiUnavailableError({
        message: `Google Pub/Sub returned 2xx but no messageIds when publishing install-verification message to "${this.pubsubTopic}" — likely an upstream contract drift. Retry, or contact support if persistent.`,
      });
    }
  }

  /**
   * Mint a short-lived Google OAuth2 access token via the JWT-bearer
   * grant. The JWT is signed with the SA's RSA private key (RS256) and
   * carries `iss=client_email`, `aud=token_url`, `scope=pubsub`, plus
   * `exp/iat` per Google's spec.
   *
   * Test seam: the constructor's `accessTokenForTests` short-circuits
   * the real signing + fetch — handler unit tests inject a fake token
   * function so they don't need a real RSA key or network access.
   */
  private async mintAccessToken(): Promise<string> {
    if (this.accessTokenForTests) {
      return this.accessTokenForTests();
    }
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
      const message = err instanceof Error ? err.message : String(err);
      // Signing failures are operator-misconfig (bad private key) —
      // they're not Pub/Sub-side, so surface as an unavailable rather
      // than a reachability error.
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

    let parsed: GoogleTokenResponse;
    try {
      parsed = (await response.json()) as GoogleTokenResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GchatApiUnavailableError({
        message: `Google OAuth2 token endpoint returned non-JSON (status ${response.status}): ${message}.`,
      });
    }

    if (response.status < 200 || response.status >= 300 || parsed.error) {
      const desc = parsed.error_description ?? parsed.error ?? "unknown error";
      throw new GchatReachabilityError({
        message: `Google rejected the service-account JWT bearer exchange: ${desc} — verify GCHAT_SERVICE_ACCOUNT_JSON belongs to a service account with pubsub.publisher on the configured topic.`,
        status: response.status,
      });
    }
    if (!parsed.access_token || parsed.access_token.length === 0) {
      throw new GchatApiUnavailableError({
        message: `Google OAuth2 token response was missing access_token (status ${response.status}).`,
      });
    }
    return parsed.access_token;
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
