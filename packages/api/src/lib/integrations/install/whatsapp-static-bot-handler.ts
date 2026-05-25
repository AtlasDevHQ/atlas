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
 * `value.metadata.phone_number_id`. This handler writes
 * `workspace_plugins.config` directly via `internalQuery` (mirroring
 * `teams-static-bot-handler.ts`), so `encryptSecretFields` is not in
 * the write path at all.
 *
 * Reachability verification: we call Meta Graph API
 * `GET /v21.0/{phone_number_id}` with `Authorization: Bearer <token>`.
 * A 200 confirms the phone number is owned by the operator's Meta
 * Business Account and the token has the requisite
 * `whatsapp_business_management` scope; the response also returns
 * `display_phone_number` and `verified_name`, which the install row uses
 * as the optional `display_phone` fallback when `extras` doesn't supply
 * one (mirrors Discord's `GET /guilds/{id}` → `guild_name` fallback).
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
 * Meta Graph API version used for the phone-number lookup. Pinned rather
 * than tracking `latest` so a Meta-side schema change can't silently
 * break the install flow. Bump alongside the chat adapter's apiVersion
 * default when the rest of the WhatsApp surface is verified against a
 * newer release.
 */
const META_GRAPH_API_VERSION = "v21.0";

/**
 * WhatsApp Business phone number ids are decimal strings — Meta assigns
 * them when a phone is added to a WhatsApp Business Account. Documented
 * shape is "a numeric id"; current production values are 15–17 digits but
 * Meta's docs don't bound this. The 10–30 range here is defensive — wide
 * enough that a future Meta-side change doesn't reject valid input, tight
 * enough to reject the obvious paste mistakes (human-readable phone
 * numbers like `+1 415 555 0100`, the human display string, or a Meta
 * WhatsApp Business Account ID which is a different identifier).
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
   * construction even though `confirmInstall` doesn't use it directly —
   * the chat adapter and the manifest / setup-link routes need it, and
   * the handler is the single source of truth for "WhatsApp is wired"
   * so the env-gate at construction time fails loud if either var is
   * missing. Mirrors Teams's `appId` capture posture.
   */
  readonly appId: string;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
  /** Test-only override of the Meta Graph API base URL. */
  readonly metaGraphBaseUrl?: string;
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
 * time into an explicit `kind: "ok" | "err"` discriminated union — same
 * shape Discord's handler uses, same rationale (Meta's `error.code` is a
 * real value where `0` doesn't mean "no error", so absence-of-`code` is
 * NOT a safe discriminator).
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
  // Meta's failure envelope nests under `error`. A bare top-level
  // `{ message, code }` is not what Graph API ever returns, so we don't
  // accept it — the upstream-contract-violation path covers it.
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
  private readonly metaGraphBaseUrl: string;
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
    this.metaGraphBaseUrl =
      config.metaGraphBaseUrl ?? `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
  }

  /**
   * Operator's Meta App ID. Exposed so the install route can build setup
   * deep-links / manifest download URLs without re-reading env. Mirrors
   * `TeamsStaticBotInstallHandler.applicationId`.
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
    // row behind.
    const apiDisplayPhone = await this.verifyReachability(routingIdentifier);

    // ── 3. Persist install row — UPSERT keyed on (workspace, catalog) ─
    // Mirrors the email-form-handler / discord-static-bot-handler /
    // teams-static-bot-handler pattern: candidate id on INSERT,
    // RETURNING id so a CONFLICT lands on the existing row's id
    // (idempotent re-install).
    const candidateId = this.newId();
    const configPayload: WhatsAppInstallConfig = {
      phone_number_id: routingIdentifier,
      ...extractDisplayPhone(extras, apiDisplayPhone, workspaceId),
    };

    let persistedId: string;
    try {
      // Schema notes:
      //   - `pillar` + `install_id` became NOT NULL in migration 0092
      //     (#2739) and the auto-fill trigger was dropped in 0096
      //     (#2744). Every writer must name both columns explicitly.
      //   - Chat-pillar installs are singletons per (workspace, catalog),
      //     enforced by the `workspace_plugins_singleton` partial unique
      //     index (`WHERE pillar IN ('chat','action')` from migration
      //     0092). We target it via the inference clause
      //     `ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat','action')`
      //     so re-install lands on the existing row (idempotent UPSERT).
      //   - For chat-pillar there's only one install per (workspace,
      //     catalog), so `install_id` mirrors `id` — WorkspaceInstaller's
      //     datasource path uses a caller-supplied installId; static-bot
      //     chat installs don't have that surface, so we reuse the row id.
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        [candidateId, workspaceId, WHATSAPP_CATALOG_ID, JSON.stringify(configPayload)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING`
        // returns the row on both insert and update. Empty here means
        // a driver / wrapper regression — fail loudly rather than ship
        // a stale id back to the user (on re-install the DB row has
        // the existing id; falling back to the fresh candidateId would
        // strand subsequent lookups). #2807 cemented this no-fallback
        // posture across the static-bot family.
        throw new Error(
          `workspace_plugins UPSERT returned no id for WhatsApp install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Failed to persist WhatsApp install record — aborting install",
      );
      throw err;
    }

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
   * Round-trip Meta Graph API to confirm the phone_number_id is owned by
   * the operator's Meta Business Account and the access token has the
   * required scopes. Returns Meta's `display_phone_number` when present
   * so the install row can fall back to it when extras don't supply one.
   *
   * Token redaction: the access token rides in the `Authorization: Bearer`
   * header — NOT in the URL path — so URL-based redaction (the kind
   * Telegram needs) isn't required here. Errors are not attached as
   * `cause` to preserve symmetry with the sibling static-bot handlers'
   * safe-by-default posture (a future pino serializer walking through
   * `cause` could otherwise dump the request headers).
   */
  private async verifyReachability(phoneNumberId: string): Promise<string | null> {
    const url = `${this.metaGraphBaseUrl}/${encodeURIComponent(
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

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          phoneNumberIdFingerprint: fingerprintPhoneNumberId(phoneNumberId),
          status: response.status,
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

    return parsed.displayPhoneNumber ?? null;
  }
}

/**
 * Extract the optional `display_phone` field. Order of preference:
 *   1. `extras.display_phone` if supplied by the install caller (admin UI
 *      override, or a future install flow forwarding a custom label).
 *   2. The `display_phone_number` returned by Meta Graph API at
 *      verification time (e.g. `+1 415 555 0100`).
 *   3. Omit — the admin UI renders the phone_number_id alone.
 *
 * Drops any other keys from `extras` silently — the catalog
 * `config_schema` declares the contract; new fields land via a new
 * schema row, not via arbitrary extras injection. Logs at `warn` when
 * `display_phone` arrives at the wrong type so the silent drop is
 * observable in server logs.
 */
function extractDisplayPhone(
  extras: Record<string, unknown> | undefined,
  apiFallback: string | null,
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
  if (apiFallback && apiFallback.length > 0) return { display_phone: apiFallback };
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
