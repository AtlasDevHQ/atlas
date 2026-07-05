/**
 * `WhatsAppStaticBotInstallHandler` — slice 15 of 1.5.3 Phase D (issue
 * #2753). Fourth concrete implementation of {@link StaticBotInstallHandler}
 * after the Telegram keystone (#2748), Discord (#2749), and Teams (#2752).
 *
 * WhatsApp follows the same operator-shared static-bot pattern: one
 * operator-owned Meta Business / WhatsApp Business Cloud API account
 * (env: `META_BUSINESS_ACCESS_TOKEN` + `META_BUSINESS_APP_ID`) serves
 * every customer. Each workspace's routing identifier is the **WhatsApp
 * Business phone number id** — a numeric Meta identifier (distinct from
 * the human-readable phone number) issued when the operator adds a phone
 * to their WhatsApp Business Account. Optional `display_phone` rides
 * through `extras` analogous to Discord's `guild_name` / Telegram's
 * `display_name`.
 *
 * Per-Workspace credential note: there isn't one. WhatsApp Cloud API
 * auth is keyed on the operator's System User access token; phone-number
 * IDs are routing identifiers Meta leaks in every webhook envelope's
 * `value.metadata.phone_number_id`. The `workspace_plugins.config` row
 * is written by the chat-integration cap gate
 * (`checkChatIntegrationLimitAndInstall`, mirroring the Telegram /
 * Discord handlers), which owns the advisory-locked UPSERT, so
 * `encryptSecretFields` is not in the write path at all.
 *
 * Cap gate (#3144): like Telegram, Discord, and Slack, the install UPSERT
 * runs through `checkChatIntegrationLimitAndInstall` so an over-cap
 * net-new install is refused with `ChatIntegrationLimitError` (→ 429) and
 * a reconnect is grandfathered. This replaced the original bare
 * `internalQuery` UPSERT when WhatsApp joined the unified install path
 * under umbrella #2994.
 *
 * Reachability verification: we call Meta Graph API
 * `GET /v21.0/{phone_number_id}` with `Authorization: Bearer <token>`.
 * A 200 confirms the phone number is owned by the operator's Meta
 * Business Account and the token has the requisite
 * `whatsapp_business_management` scope; the response also returns
 * `display_phone_number` and `verified_name`, which the install row
 * uses as the optional `display_phone` fallback chain when `extras`
 * doesn't supply one (`extras.display_phone` → Meta's
 * `display_phone_number` → Meta's `verified_name` → omit). Mirrors
 * Discord's `GET /guilds/{id}` → `guild_name` fallback.
 *
 * Why this scoping matters: Meta's Cloud API lets one System User token
 * access every phone number under the Business Account it was minted
 * from, but it CANNOT access numbers under another Business Account
 * (Meta returns `error.code: 100` with "Tried accessing nonexisting
 * field" or `error.code: 200` "Permissions error"). Atlas relies on this
 * — a workspace cannot claim a phone_number_id that isn't already shared
 * into the operator's Business Account, so a forged install attempt
 * fails at this `getPhoneNumber` call before touching the DB.
 *
 * Plan gating note: WhatsApp catalog row carries `min_plan: "business"`.
 * The handler itself doesn't enforce that — `WorkspaceInstaller` does,
 * upstream of dispatch. The high tier reflects Meta's per-message costs:
 * customer-initiated conversations consume operator-paid template / user-
 * initiated conversation quota, so opening WhatsApp to lower tiers would
 * unbound operator spend.
 *
 * @see ./types.ts — {@link StaticBotInstallHandler}
 * @see ./teams-static-bot-handler.ts — the cousin shape this mirrors
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  WhatsAppApiUnavailableError,
  WhatsAppPhoneNumberIdInvalidError,
  WhatsAppReachabilityError,
} from "@atlas/api/lib/effect/errors";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";
import { persistSingletonInstall } from "./persist-form-install";
import { makeChatIntegrationCapGate } from "./chat-integration-cap-gate";
import { isRoutingIdUniqueViolation } from "./routing-id-conflict";

const log = createLogger("integrations.install.whatsapp");

/** Catalog slug — the dispatch key in `registerStaticBotHandler`. */
export const WHATSAPP_SLUG: CatalogId = "whatsapp";

/**
 * Stable `plugin_catalog.id` for WhatsApp. The seeder derives row ids as
 * `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`). Kept as a
 * named constant so the install row's FK target stays in lockstep with
 * the seeder rename rule.
 */
export const WHATSAPP_CATALOG_ID = "catalog:whatsapp";

/**
 * Surfaced when a phone_number_id is already bound to a different workspace —
 * by the pre-check below AND by `confirmInstall`'s catch when the
 * migration-0120 partial unique index rejects a concurrent claim. Single
 * source so both paths return identical, actionable text (#3167).
 */
const WHATSAPP_ROUTING_CONFLICT_MESSAGE =
  "This WhatsApp number is already connected to a different Atlas workspace. Each phone number can be linked to only one workspace — disconnect it there first, or contact your operator if you believe this is an error.";

/**
 * Cross-workspace ownership guard (#3144 / Codex #3153 / #3167). Reachability
 * proves the phone_number_id is in the operator's WhatsApp Business Account,
 * not that the installing workspace controls it — so reject an id already bound
 * to a *different* workspace before persisting. The `workspace_id <> $3` filter
 * excludes the installing workspace, so a reconnect (same workspace re-binding
 * its own id) is never blocked.
 *
 * This read-only pre-check catches the common case cheaply. The
 * simultaneous-race case (two workspaces binding a never-before-seen
 * phone_number_id at the same instant) is now closed by the partial unique
 * index from migration 0120 (#3167): the losing writer's UPSERT fails with a
 * 23505 that `confirmInstall`'s catch maps back to
 * {@link WHATSAPP_ROUTING_CONFLICT_MESSAGE}, so both paths return the same error.
 */
async function assertPhoneNumberUnboundElsewhere(
  phoneNumberId: string,
  workspaceId: WorkspaceId,
): Promise<void> {
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'phone_number_id' = $2
        AND workspace_id <> $3
      LIMIT 1`,
    [WHATSAPP_CATALOG_ID, phoneNumberId, workspaceId],
  );
  if (rows.length > 0) {
    log.warn(
      { workspaceId, conflictingWorkspaceId: rows[0]?.workspace_id },
      "WhatsApp install rejected — phone_number_id already bound to a different workspace",
    );
    throw new WhatsAppPhoneNumberIdInvalidError({
      message: WHATSAPP_ROUTING_CONFLICT_MESSAGE,
    });
  }
}

/**
 * Meta Graph API version used for the phone-number lookup. Pinned rather
 * than tracking `latest` so a Meta-side schema change can't silently
 * break the install flow. Bump alongside the chat adapter's apiVersion
 * default when the rest of the WhatsApp surface is verified against a
 * newer release.
 */
const META_GRAPH_API_VERSION = "v21.0";

/**
 * WhatsApp Business phone number ids are decimal strings — Meta assigns
 * them when a phone is added to a WhatsApp Business Account. Meta's
 * docs describe them as "a numeric id" without an explicit length bound.
 * The 10–30 range here is defensive — wide enough that a future
 * Meta-side change doesn't reject valid input, tight enough to reject
 * the obvious paste mistakes (human-readable phone numbers like
 * `+1 415 555 0100`, the human display string, or a WhatsApp Business
 * Account ID which is a different identifier).
 *
 * Exported so the executeQuery dispatcher can reuse the same regex on
 * inbound webhook envelopes — keeps the phone_number_id invariant on a
 * single source of truth across install + receive paths.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers
 */
export const WHATSAPP_PHONE_NUMBER_ID_RE = /^\d{10,30}$/;

/**
 * Reachability call timeout. Meta Graph API is normally sub-second; 10s
 * gives ample headroom for transient latency while keeping the install
 * POST bounded. Mirrors the pattern in `discord-static-bot-handler.ts`.
 */
const WHATSAPP_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-deploy operator config. Read once from env by `register.ts` and
 * passed in here. The constructor refuses to build without both
 * `accessToken` and `appId` so direct callers (tests, future programmatic
 * install paths) get the same env-gated guarantee `register.ts` already
 * has.
 */
export interface WhatsAppStaticBotHandlerConfig {
  /**
   * Operator-shared System User access token from the operator's Meta
   * Business / WhatsApp Business Cloud API account
   * (`META_BUSINESS_ACCESS_TOKEN`). Scoped to the operator's WhatsApp
   * Business Account; carries `whatsapp_business_management` +
   * `whatsapp_business_messaging` permissions.
   */
  readonly accessToken: string;
  /**
   * Operator's Meta App ID (`META_BUSINESS_APP_ID`). Captured at
   * construction even though `confirmInstall` doesn't use it directly:
   * the chat adapter consumes it via env, and the handler is the
   * single source of truth for "WhatsApp is wired" so the env-gate at
   * construction time fails loud if either var is missing. Mirrors
   * Teams's `appId` capture posture.
   */
  readonly appId: string;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
}

/** Shape persisted into `workspace_plugins.config` JSONB. */
export interface WhatsAppInstallConfig {
  /** WhatsApp Business phone number id (Meta routing identifier). */
  readonly phone_number_id: string;
  /**
   * Optional admin-friendly label rendered in the integrations card —
   * falls back to Meta's `display_phone_number` (`+1 415 555 0100`)
   * captured at verification time.
   */
  readonly display_phone?: string;
}

/**
 * Meta Graph API `GET /{phone_number_id}` parsed response. Success returns
 * `{ id, verified_name?, display_phone_number?, ... }`; failure returns
 * `{ error: { message, type, code, fbtrace_id } }`. Normalized at parse
 * time into an explicit `kind: "ok" | "err"` discriminated union.
 *
 * Discriminator is HTTP status: 2xx → ok, non-2xx → err. We never key on
 * `code` presence because Meta uses `error.code: 0` for some generic
 * failure modes (so `code === 0` doesn't mean "no error"). A 2xx
 * response that *also* carries an `error` object (Meta has been
 * observed to do this on partial-batch traversals / debug payloads)
 * is treated as an upstream contract violation, not a success — the
 * 2xx branch refuses it via `null` so the caller surfaces
 * `WhatsAppApiUnavailableError` rather than writing an install row
 * for a phone number Meta is actively rejecting.
 */
type WhatsAppPhoneNumberResponse =
  | {
      readonly kind: "ok";
      readonly id: string;
      readonly displayPhoneNumber?: string;
      readonly verifiedName?: string;
    }
  | {
      readonly kind: "err";
      readonly message: string;
      readonly code: number;
    };

function parseWhatsAppPhoneNumberResponse(
  raw: unknown,
  httpStatus: number,
): WhatsAppPhoneNumberResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (httpStatus >= 200 && httpStatus < 300) {
    if (typeof body.id !== "string" || body.id.length === 0) return null;
    // Meta has been observed to ship 2xx responses carrying a populated
    // `error` object on partial-batch traversals / debug-payload opt-ins
    // / proxy-injected envelopes. Treating those as success would write
    // a workspace_plugins row for a phone number Meta is actively
    // rejecting — refuse and surface as upstream-contract-violation
    // via the caller's `null`-handling branch.
    if (typeof body.error === "object" && body.error !== null) return null;
    const displayPhoneNumber =
      typeof body.display_phone_number === "string" && body.display_phone_number.length > 0
        ? body.display_phone_number
        : undefined;
    const verifiedName =
      typeof body.verified_name === "string" && body.verified_name.length > 0
        ? body.verified_name
        : undefined;
    return {
      kind: "ok" as const,
      id: body.id,
      ...(displayPhoneNumber !== undefined ? { displayPhoneNumber } : {}),
      ...(verifiedName !== undefined ? { verifiedName } : {}),
    };
  }
  // Non-2xx: Meta's failure envelope nests under `error`. A bare
  // top-level `{ message, code }` is not what Graph API ever returns,
  // so we don't accept it — the upstream-contract-violation path
  // (returning `null`) covers it. The 2xx branch above returned early,
  // so we don't need to re-guard the `message.length === 0 && code === 0`
  // check on status.
  const err = body.error;
  if (typeof err !== "object" || err === null) return null;
  const errObj = err as Record<string, unknown>;
  const message = typeof errObj.message === "string" ? errObj.message : "";
  const code = typeof errObj.code === "number" ? errObj.code : 0;
  if (message.length === 0 && code === 0) {
    // Empty error body — let the caller treat as upstream contract
    // violation rather than fabricating an err envelope.
    return null;
  }
  return { kind: "err" as const, message, code };
}

export class WhatsAppStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;

  private readonly accessToken: string;
  private readonly appId: string;
  private readonly newId: () => string;

  constructor(config: WhatsAppStaticBotHandlerConfig) {
    if (!config.accessToken || config.accessToken.length === 0) {
      throw new Error(
        "WhatsAppStaticBotInstallHandler requires a non-empty accessToken — set META_BUSINESS_ACCESS_TOKEN in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    if (!config.appId || config.appId.length === 0) {
      throw new Error(
        "WhatsAppStaticBotInstallHandler requires a non-empty appId — set META_BUSINESS_APP_ID in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    this.accessToken = config.accessToken;
    this.appId = config.appId;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
  }

  /**
   * Operator's Meta App ID. Exposed for parity with the sibling static-
   * bot handlers' `applicationId` getter (Discord, Teams) — a future
   * WhatsApp install route can consume it to build a setup deep-link
   * without re-reading env. No consumer in this PR; the getter exists
   * to keep the structural contract consistent across the family.
   */
  get applicationId(): string {
    return this.appId;
  }

  async confirmInstall(
    workspaceId: WorkspaceId,
    routingIdentifier: string,
    _verificationProof?: string,
    extras?: Record<string, unknown>,
  ): Promise<{ readonly installRecord: InstallRecord }> {
    // ── 1. Validate the routing identifier ─────────────────────────
    if (!routingIdentifier || routingIdentifier.length === 0) {
      throw new WhatsAppPhoneNumberIdInvalidError({
        message:
          "WhatsApp install requires a non-empty phone_number_id (Meta's numeric routing id for the phone — NOT the human-readable phone number). Find it in the Meta Business Suite under WhatsApp Manager → Phone numbers → API Setup.",
      });
    }
    if (!WHATSAPP_PHONE_NUMBER_ID_RE.test(routingIdentifier)) {
      throw new WhatsAppPhoneNumberIdInvalidError({
        message: `WhatsApp phone_number_id "${routingIdentifier}" is not a valid Meta routing id (expected 10–30 decimal digits). Human-readable phone numbers ("+1 415 555 0100") and WhatsApp Business Account IDs aren't accepted — copy the Phone Number ID from the Meta Business Suite under WhatsApp Manager → Phone numbers → API Setup.`,
      });
    }

    // ── 2. Reachability via Meta Graph API ──────────────────────────
    // Throws on Graph API errors / network failures *before* any DB
    // write, so a failed verification never leaves a half-installed
    // row behind. Returns the (display_phone_number, verified_name)
    // pair so extractDisplayPhone can fall back through both before
    // omitting the label entirely.
    const apiFallback = await this.verifyReachability(routingIdentifier);

    // ── 2b. Cross-workspace ownership guard (#3144 / Codex #3153 / #3167) ─
    // The operator's Meta token can read any phone_number_id shared into
    // its WhatsApp Business Account, so reachability proves the number is
    // in the operator's account — NOT that THIS workspace controls it.
    // Reject a phone_number_id already bound to a *different* workspace so
    // one customer can't claim another's number and intercept its inbound
    // messages (a reconnect by the same workspace is excluded by the
    // `workspace_id <> $3` filter). This pre-check catches the common case
    // cheaply; the simultaneous-race residual (two workspaces racing a
    // never-before-bound id) is closed by the migration-0120 partial unique
    // index, whose 23505 the cap-gate catch below maps to the same error
    // (#3167).
    await assertPhoneNumberUnboundElsewhere(routingIdentifier, workspaceId);

    // ── 3. Persist install row — UPSERT keyed on (workspace, catalog) ─
    // The upsert SQL, the cap-result → error mapping, the concurrent
    // routing-conflict re-surface, and the RETURNING invariant all live in
    // `persistSingletonInstall` (issue #4352) — the one tested spine every
    // singleton (chat/action) install writes through. The cap gate (#3144)
    // wraps the UPSERT in a per-workspace advisory-locked transaction so
    // concurrent net-new installs can't both slip past the chat-integration
    // cap; reconnect is grandfathered inside the gate.
    const configPayload: WhatsAppInstallConfig = {
      phone_number_id: routingIdentifier,
      ...extractDisplayPhone(extras, apiFallback, workspaceId),
    };

    const persistedId = await persistSingletonInstall({
      workspaceId,
      catalogId: WHATSAPP_CATALOG_ID,
      displayName: "WhatsApp",
      log,
      config: { ...configPayload },
      newId: this.newId,
      pillar: "chat",
      capGate: makeChatIntegrationCapGate({
        orgId: workspaceId,
        catalogId: WHATSAPP_CATALOG_ID,
        displayName: "WhatsApp",
        log,
      }),
      routingConflictClassifier: (err) => {
        if (!isRoutingIdUniqueViolation(err)) return null;
        // Another workspace claimed this phone_number_id between our pre-check
        // and our UPSERT; the migration-0120 partial unique index rejected us
        // (#3167). Surface the same actionable error the pre-check returns
        // rather than a raw 500 — first writer wins, we lost the race.
        log.warn(
          { workspaceId },
          "WhatsApp install rejected — phone_number_id claimed by another workspace concurrently (unique index)",
        );
        return new WhatsAppPhoneNumberIdInvalidError({
          message: WHATSAPP_ROUTING_CONFLICT_MESSAGE,
        });
      },
    });

    log.info(
      {
        workspaceId,
        installId: persistedId,
        phoneNumberIdFingerprint: fingerprintPhoneNumberId(routingIdentifier),
      },
      "WhatsApp install completed (phone_number_id reachable, install row UPSERTed)",
    );

    return {
      installRecord: {
        id: persistedId,
        workspaceId,
        catalogId: WHATSAPP_SLUG,
      },
    };
  }

  /**
   * Round-trip Meta Graph API to confirm the phone_number_id is owned
   * by the operator's Meta Business Account and the access token has
   * the required scopes. Returns the `(displayPhoneNumber, verifiedName)`
   * pair when present so the install row can fall through them before
   * omitting the label.
   *
   * Token redaction: the access token rides in the `Authorization: Bearer`
   * header — NOT in the URL path — so URL-based redaction (the kind
   * Telegram needs) isn't required here. Errors are not attached as
   * `cause` to preserve symmetry with the sibling static-bot handlers'
   * safe-by-default posture (a future pino serializer walking through
   * `cause` could otherwise dump the request headers).
   *
   * Forensic anchors: when Meta returns a non-JSON body or a non-2xx
   * status, we capture the `x-fb-trace-id` response header into the
   * structured log payload. Operator-facing support tickets with Meta
   * require this id to anchor the request on Meta's side; without it,
   * triaging a persistent Meta-side gateway issue requires a tcpdump.
   */
  private async verifyReachability(
    phoneNumberId: string,
  ): Promise<WhatsAppReachabilityFallback> {
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(
      phoneNumberId,
    )}?fields=verified_name,display_phone_number`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, WHATSAPP_FETCH_TIMEOUT_MS, {
        Authorization: `Bearer ${this.accessToken}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
          fetchError: message,
        },
        "Meta Graph API unreachable when verifying phone_number_id",
      );
      throw new WhatsAppApiUnavailableError({
        message: `Meta Graph API unreachable when verifying phone_number_id (${message}). Retry, or check operator-side egress to graph.facebook.com and META_BUSINESS_ACCESS_TOKEN wiring.`,
      });
    }

    const fbTraceId = response.headers.get("x-fb-trace-id") ?? undefined;

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
          status: response.status,
          fbTraceId,
          parseError: message,
        },
        "Meta Graph API returned non-JSON response",
      );
      throw new WhatsAppApiUnavailableError({
        message: `Meta Graph API returned a non-JSON response when verifying phone_number_id "${phoneNumberId}" (status ${response.status}).`,
      });
    }

    const parsed = parseWhatsAppPhoneNumberResponse(rawBody, response.status);
    if (parsed === null) {
      log.warn(
        {
          phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
          status: response.status,
          fbTraceId,
        },
        "Meta Graph API returned an unexpected response shape — upstream contract violation",
      );
      throw new WhatsAppApiUnavailableError({
        message: `Meta Graph API returned an unexpected response shape when verifying phone_number_id "${phoneNumberId}" (status ${response.status}).`,
      });
    }
    if (parsed.kind === "err") {
      const hint = hintForWhatsAppError(parsed.code, response.status, parsed.message);
      throw new WhatsAppReachabilityError({
        message: `Meta rejected phone_number_id "${phoneNumberId}": ${parsed.message || "unknown error"}${hint ? ` — ${hint}` : ""}`,
        errorCode: parsed.code,
      });
    }

    return {
      displayPhoneNumber: parsed.displayPhoneNumber ?? null,
      verifiedName: parsed.verifiedName ?? null,
    };
  }
}

/**
 * Result of a successful reachability round-trip. Both fields are
 * Meta-provided and may be null when Meta omits them on the wire (rare
 * but documented — verified names are gated on Meta's business
 * verification flow). Threaded through {@link extractDisplayPhone} as
 * a two-tier fallback (display_phone_number → verified_name → omit).
 */
interface WhatsAppReachabilityFallback {
  readonly displayPhoneNumber: string | null;
  readonly verifiedName: string | null;
}

/**
 * Extract the optional `display_phone` field. Order of preference:
 *   1. `extras.display_phone` if supplied by the install caller (admin
 *      UI override, or a future install flow forwarding a custom
 *      label).
 *   2. The `display_phone_number` returned by Meta Graph API at
 *      verification time (e.g. `+1 415 555 0100`).
 *   3. The `verified_name` returned by Meta Graph API at verification
 *      time (e.g. `"Acme Test Co"`) — only present when Meta has
 *      completed business verification on the number; gives a more
 *      descriptive admin-UI label than the raw phone when available.
 *   4. Omit — the admin UI renders the phone_number_id alone.
 *
 * Drops any other keys from `extras` silently — the catalog
 * `config_schema` declares the contract; new fields land via a new
 * schema row, not via arbitrary extras injection. Logs at `warn` when
 * `display_phone` arrives at the wrong type so the silent drop is
 * observable in server logs.
 */
function extractDisplayPhone(
  extras: Record<string, unknown> | undefined,
  apiFallback: WhatsAppReachabilityFallback,
  workspaceId: WorkspaceId,
): { display_phone?: string } {
  if (extras !== undefined && "display_phone" in extras) {
    const raw = extras.display_phone;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "string") {
        log.warn(
          { workspaceId, rawType: typeof raw },
          "WhatsApp extras.display_phone is not a string — dropping and falling back to Meta-provided value",
        );
      } else {
        const trimmed = raw.trim();
        if (trimmed.length > 0) return { display_phone: trimmed };
      }
    }
  }
  if (apiFallback.displayPhoneNumber && apiFallback.displayPhoneNumber.length > 0) {
    return { display_phone: apiFallback.displayPhoneNumber };
  }
  if (apiFallback.verifiedName && apiFallback.verifiedName.length > 0) {
    return { display_phone: apiFallback.verifiedName };
  }
  return {};
}

/**
 * Per-error-code follow-up text appended to Meta's `error.message`. Logs
 * a warn when the code is novel so operators see observability gaps
 * before users do — the verbatim message still propagates in the thrown
 * error, so the user gets *some* info, but a recurring null-return
 * signals a new failure mode worth a follow-up entry here.
 *
 * Meta's [WhatsApp Cloud API error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
 * are stable numeric tags; we key on `code` first and fall back to HTTP
 * status for transport-layer issues that don't have a specific code.
 */
function hintForWhatsAppError(
  code: number,
  httpStatus: number,
  description: string,
): string | null {
  if (code === 100) {
    // "Invalid parameter" / "Tried accessing nonexisting field" — almost
    // always means the phone_number_id isn't in the operator's WhatsApp
    // Business Account.
    return "this phone_number_id isn't visible to the operator's Meta Business Account — ask the operator to share the customer's WhatsApp number into their Business Account, or re-copy the id from Meta Business Suite";
  }
  if (code === 190 || code === 102) {
    return "the operator-side META_BUSINESS_ACCESS_TOKEN may be expired or revoked — operator must mint a fresh System User token with whatsapp_business_management + whatsapp_business_messaging scopes";
  }
  if (code === 200 || code === 10) {
    return "the operator's access token lacks the whatsapp_business_management scope — operator must regenerate the System User token with that scope";
  }
  if (code === 4 || httpStatus === 429) {
    return "Meta Graph API rate-limited the verify call — wait a minute and retry";
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return "Meta refused the access token — operator must re-mint META_BUSINESS_ACCESS_TOKEN";
  }
  if (httpStatus >= 500) {
    return "Meta Graph API is degraded — check https://metastatus.com and retry";
  }
  log.warn(
    { errorCode: code, httpStatus, description },
    "WhatsApp error code not mapped in hintForWhatsAppError — consider adding a hint branch",
  );
  return null;
}

/**
 * Short, log-safe fingerprint of the phone_number_id — last 4 chars only.
 * The phone_number_id is a routing identifier, not a secret, but logging
 * the full value in every install line is noisy and lets log scrapers
 * correlate Workspace ↔ phone without going through the install row.
 */
function fingerprintPhoneNumberId(phoneNumberId: string): string {
  return phoneNumberId.length <= 4 ? phoneNumberId : `…${phoneNumberId.slice(-4)}`;
}

/**
 * `fetch` with a timeout. Bun's fetch has no built-in timeout in
 * serverless runtimes; without an AbortController-driven cap a hung Meta
 * upstream would hold the install POST open indefinitely. Mirrors
 * `discord-static-bot-handler.ts`'s `fetchWithTimeout`.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}
