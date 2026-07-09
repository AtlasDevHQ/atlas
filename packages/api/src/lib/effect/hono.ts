/**
 * Effect ↔ Hono bridge.
 *
 * Runs Effect programs inside Hono route handlers, mapping tagged errors
 * to HTTP responses and logging defects with requestId.
 *
 * @example
 * ```ts
 * import { runEffect } from "@atlas/api/lib/effect";
 *
 * router.get("/data", async (c) => {
 *   const result = await runEffect(c, myEffectProgram, { label: "fetch data" });
 *   return c.json(result, 200);
 * });
 * ```
 */

import { Array as Arr, Effect, Exit, Cause, Option, Layer } from "effect";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createLogger } from "@atlas/api/lib/logger";
import { ATLAS_ERROR_TAG_LIST, type AtlasError } from "./errors";
import {
  RequestContext,
  makeRequestContextLayer,
  AuthContext,
  makeAuthContextLayer,
} from "./services";
import { getEnterpriseRuntime, type EnterpriseSubsystem } from "./enterprise-layer";

// ── Domain error mapping ────────────────────────────────────────────

/**
 * A domain error class → HTTP status code mapping pair.
 *
 * Always construct via `domainError()` — raw tuples bypass the compile-time
 * exhaustive code check. The brand prevents direct tuple construction.
 *
 * Used by `runEffect` to convert EE domain errors into proper HTTP responses.
 * Domain errors surface either as typed failures (from Effect programs) or as
 * defects (from `Effect.tryPromise` in `runHandler`).
 */
declare const DomainErrorMappingBrand: unique symbol;
export type DomainErrorMapping = [
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signatures vary across EE error classes; { code: string } ensures the statusMap lookup is valid
  errorClass: new (...args: any[]) => Error & { code: string },
  statusMap: Record<string, ContentfulStatusCode>,
] & { readonly [DomainErrorMappingBrand]: true };

/**
 * Type-safe constructor for `DomainErrorMapping` tuples.
 *
 * Infers `TCode` from the error class's `code` property and requires the
 * status map to cover every code — the compiler will error if a code is
 * added to the error class's union without a corresponding entry here.
 *
 * @example
 * ```ts
 * // ApprovalErrorCode = "validation" | "not_found" | "conflict" | "expired"
 * const approvalErrors = domainError(ApprovalError, {
 *   validation: 400, not_found: 404, conflict: 409, expired: 410,
 * });
 * // Missing "expired" would be a compile error ↑
 * ```
 */
export function domainError<TCode extends string>(
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- must accept varied constructor signatures; TCode constraint ensures the statusMap is exhaustive
  errorClass: new (...args: any[]) => Error & { code: TCode },
  statusMap: Record<TCode, ContentfulStatusCode>,
): DomainErrorMapping {
  return [errorClass, statusMap] as unknown as DomainErrorMapping;
}

const log = createLogger("effect-bridge");

// ── Error mapping ───────────────────────────────────────────────────

/** Known error code vocabulary for HTTP error responses. */
type HttpErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "entity_ambiguous"
  | "unprocessable_entity"
  | "rate_limited"
  | "conversation_budget_exceeded"
  | "plan_limit_exceeded"
  | "plan_upgrade_required"
  | "billing_check_failed"
  | "upstream_error"
  | "service_unavailable"
  | "enterprise_load_failed"
  | "timeout";

interface HttpErrorMapping {
  readonly status: ContentfulStatusCode;
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Extra fields merged into the response body alongside
   * `{ error, message, requestId }`. Use for tagged errors that need to
   * surface structured detail to the client — e.g. `AmbiguousEntityError`
   * carrying a `groups` array so the UI can render a disambiguation
   * picker (#2412). Field names must not collide with `error`,
   * `message`, or `requestId` — they would be shadowed silently.
   */
  readonly body?: Readonly<Record<string, unknown>>;
}

/**
 * Set of all `_tag` values in the `AtlasError` union.
 * Derived from the compile-time verified `ATLAS_ERROR_TAG_LIST` in errors.ts —
 * adding a new error variant without updating the list causes a type error.
 */
const ATLAS_ERROR_TAGS: ReadonlySet<string> = new Set(ATLAS_ERROR_TAG_LIST);

/**
 * Type guard for objects with a `_tag` string and `message` string.
 */
function isTaggedError(error: unknown): error is { readonly _tag: string; readonly message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as Record<string, unknown>)._tag === "string" &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

/**
 * Narrow a tagged error to a known `AtlasError`.
 * Returns true only when `_tag` is one of the known tags in `ATLAS_ERROR_TAGS`.
 */
function isAtlasError(error: { readonly _tag: string }): error is AtlasError {
  return ATLAS_ERROR_TAGS.has(error._tag);
}

/**
 * Compile-time exhaustiveness guard for inner switches.
 *
 * After every variant of an error's `code` union is handled, TS narrows
 * `error` to `never` at the post-switch position; reading `.code` directly
 * on `error` would surface as "property does not exist on type 'never'".
 * Passing `error` through this helper keeps the assertion local while
 * preserving the original failure mode — a new `*ErrorCode` variant added
 * to a `Data.TaggedError` payload without a switch case fails this line
 * at compile time.
 */
function assertNever(error: never): never {
  throw new Error(`Unreachable: unhandled error variant ${JSON.stringify(error)}`);
}

/**
 * Map a known Atlas error to an HTTP status code, error code, and optional headers.
 *
 * Exhaustive over `AtlasError` — the compiler will error if a new variant
 * is added to the union without a corresponding case here.
 *
 * Status code assignments are designed to match the HTTP semantics of each
 * error category and align with existing route behavior.
 */
export function mapTaggedError(error: AtlasError): HttpErrorMapping {
  switch (error._tag) {
    // ── 400 Bad Request — malformed input ────────────────────────
    case "EmptyQueryError":
    case "ParseError":
      return { status: 400, code: "bad_request", message: error.message };
    // #2748 — Telegram install rejected at the input or upstream-
    // verification layer. Both are admin-correctable (re-paste the id,
    // add the bot, fix the token) so 400 is the right surface. The
    // message carries Telegram's verbatim `description` for
    // `TelegramReachabilityError`; the route does not translate.
    case "TelegramChatIdInvalidError":
    case "TelegramReachabilityError":
      return { status: 400, code: "bad_request", message: error.message };
    // #2749 — Discord install rejected at the input or upstream-
    // verification layer. Both are admin-correctable (re-paste the id,
    // re-run the bot install link, fix the token) so 400 is the right
    // surface. The message carries Discord's verbatim `message` field
    // for `DiscordReachabilityError`; the route does not translate.
    case "DiscordGuildIdInvalidError":
    case "DiscordReachabilityError":
      return { status: 400, code: "bad_request", message: error.message };
    // #2752 — Teams install rejected at the input or upstream-
    // verification layer. Both are admin-correctable (re-paste the
    // GUID, set the tenant up in Microsoft Entra ID) so 400 is the right
    // surface. `TeamsReachabilityError`'s message preserves Microsoft's
    // verbatim error text when present; the route does not translate.
    case "TeamsTenantIdInvalidError":
    case "TeamsReachabilityError":
      return { status: 400, code: "bad_request", message: error.message };
    // #2753 — WhatsApp install rejected at the input or upstream-
    // verification layer. Both are admin-correctable (re-paste the id,
    // confirm the number is in the operator's Meta Business Account,
    // refresh the access token) so 400 is the right surface. The
    // message carries Meta's verbatim `error.message` for
    // `WhatsAppReachabilityError`; the route does not translate.
    case "WhatsAppPhoneNumberIdInvalidError":
    case "WhatsAppReachabilityError":
      return { status: 400, code: "bad_request", message: error.message };
    // #2754 — Google Chat install rejected at the input or Pub/Sub
    // round-trip layer. Both are admin-correctable (re-paste the
    // workspace_id, install the Atlas Marketplace listing, grant
    // pubsub.publisher on the topic) so 400 is the right surface.
    // `GchatReachabilityError`'s message preserves Google's verbatim
    // error text when present; the route does not translate. (5xx
    // upstream failures are classified as `GchatApiUnavailableError`
    // below so retry semantics stay correct.)
    case "GchatWorkspaceIdInvalidError":
    case "GchatReachabilityError":
      return { status: 400, code: "bad_request", message: error.message };
    // #2742 — catalog `config_schema` violation. Surface per-field
    // detail in the response body so the admin UI's form can highlight
    // the wrong inputs without a follow-up roundtrip. Field names are
    // catalog-declared keys; `formErrors` covers top-level issues that
    // don't bind to one field.
    case "ConfigSchemaError":
      return {
        status: 400,
        code: "bad_request",
        message: error.message,
        body: {
          catalogSlug: error.catalogSlug,
          // Cast back to plain arrays at the response boundary so
          // OpenAPI schema clients see regular `string[]`.
          fieldErrors: Object.fromEntries(
            Object.entries(error.fieldErrors).map(([k, v]) => [k, [...v]]),
          ),
          formErrors: [...error.formErrors],
        },
      };
    // #2744 — caller-provided `installId` failed validation (datasource
    // installs only). Body carries `installId` + `reason` so the admin
    // UI can render "id contains invalid characters" vs "id is reserved"
    // without parsing the message.
    case "InvalidInstallIdError":
      return {
        status: 400,
        code: "bad_request",
        message: error.message,
        body: { installId: error.installId, reason: error.reason },
      };
    // #2989 — backup not in a verifiable/restorable state (status not
    // completed/verified), or the restore confirmation token is missing/
    // expired. Both are admin-correctable (wait for the backup, pick
    // another, or request a fresh token) so 400 is the right surface.
    // Replaces the platform-backups routes' `message.includes(...)`
    // classification with structural `_tag` mapping. The message carries
    // the offending status / token detail verbatim — both are admin-safe
    // (no secrets, no connection strings).
    case "BackupInvalidStateError":
    case "BackupRestoreTokenError":
      return { status: 400, code: "bad_request", message: error.message };

    // ── 403 Forbidden — policy/permission violations ─────────────
    case "ForbiddenPatternError":
    case "WhitelistError":
    case "EnterpriseGateError":
    case "ApprovalRequiredError":
    case "RLSError":
      return { status: 403, code: "forbidden", message: error.message };

    // ── 404 Not Found ────────────────────────────────────────────
    case "ConnectionNotFoundError":
      return { status: 404, code: "not_found", message: error.message };
    // #2989 — backup id has no matching row (never existed, or purged
    // between a restore request and its confirm). Replaces the
    // platform-backups routes' `message.includes("not found")` check.
    case "BackupNotFoundError":
      return { status: 404, code: "not_found", message: error.message };

    // ── 409 Conflict — operation rejected because of resource state ─
    case "UnsafeRegionMigrationResetError":
      return { status: 409, code: "conflict", message: error.message };
    case "AmbiguousEntityError":
      return {
        status: 409,
        code: "entity_ambiguous",
        message: error.message,
        body: {
          groups: [...error.groups],
          entityName: error.entityName,
          entityType: error.entityType,
        },
      };
    // #2708 — a lazy-OAuth integration install (Salesforce #2658, Jira
    // #2659, Linear #2750) had its refresh-token rotation fail
    // permanently; the install is flagged `reconnect_needed` in
    // `workspace_plugins.config` and the admin must re-run OAuth. 409
    // (not 502) because the request is well-formed but the resource is
    // in a state the user controls. Reuses the `"conflict"` wire code
    // rather than adding `"reconnect_required"` to the closed
    // `HttpErrorCode` vocabulary — the message + the error's `platform`
    // field in logs disambiguate. One tag for all three platforms (the
    // per-platform tags collapsed into `IntegrationReconnectRequiredError`).
    case "IntegrationReconnectRequiredError":
      return {
        status: 409,
        code: "conflict",
        message: error.message,
      };
    // #2742 — pillar-singleton violation. Maps to 409 so the admin UI
    // surfaces "already installed; disconnect first to reinstall"
    // rather than the generic upstream-error toast.
    case "AlreadyInstalledError":
      return {
        status: 409,
        code: "conflict",
        message: error.message,
        body: {
          catalogSlug: error.catalogSlug,
          pillar: error.pillar,
        },
      };
    // #2742 — install row missing for `(workspace, catalog)`. Distinct
    // from `CatalogNotFoundError` (catalog itself is missing) — both
    // map to 404 but the body fields differ so the admin UI can render
    // the right toast.
    case "InstallNotFoundError":
      return {
        status: 404,
        code: "not_found",
        message: error.message,
        body: { catalogSlug: error.catalogSlug },
      };
    case "CatalogNotFoundError":
      return {
        status: 404,
        code: "not_found",
        message: error.message,
        body: { catalogSlug: error.catalogSlug },
      };

    // ── 422 Unprocessable Entity — plugin rejected ───────────────
    case "PluginRejectedError":
    case "CustomValidatorError":
      return { status: 422, code: "unprocessable_entity", message: error.message };

    // ── 429 Too Many Requests ────────────────────────────────────
    case "RateLimitExceededError": {
      const retryAfterSec = Math.ceil((error.retryAfterMs ?? 60_000) / 1000);
      return {
        status: 429,
        code: "rate_limited",
        message: error.message,
        headers: { "Retry-After": String(retryAfterSec) },
      };
    }
    case "ConcurrencyLimitError":
    case "PoolExhaustedError":
      return { status: 429, code: "rate_limited", message: error.message };
    // F-77 — per-conversation budget. Distinct wire code so the chat UI
    // surfaces a "start a new conversation" affordance rather than
    // suggesting retry on the same conversationId, which will stay over
    // budget until a new one is created.
    case "ConversationBudgetExceededError":
      return {
        status: 429,
        code: "conversation_budget_exceeded",
        message: error.message,
      };
    // #2953 — chat-integration cap reached for the workspace's plan tier.
    // 429 + `plan_limit_exceeded` matches the connections cap
    // (`admin-connections.ts` returns the same code/status manually). The
    // seats cap is also 429 but via Better Auth's `APIError`
    // (`lib/auth/invitations.ts`), so its envelope differs. Body carries
    // the cap that was hit.
    case "ChatIntegrationLimitError":
      return {
        status: 429,
        code: "plan_limit_exceeded",
        message: error.message,
        body: { limit: error.limit },
      };
    // #2953 — the chat-integration count could not be determined (DB error
    // / missing row), so the cap check failed closed. This is a transient
    // infra fault, NOT a plan-cap hit: 503 + `billing_check_failed` (same
    // code the token-budget check surfaces) so the user sees "try again",
    // not a misleading "upgrade your plan".
    case "BillingCheckFailedError":
      return {
        status: 503,
        code: "billing_check_failed",
        message: error.message,
      };
    // WS1 (#3984 / #3986) — a tier-gated feature whose minimum plan ranks above the
    // workspace's current tier. 403 + `plan_upgrade_required` matches the
    // integration install endpoints' upgrade envelope
    // (`PlanUpgradeRequiredBody`) so the admin UI's upgrade toast renders
    // identically. Body carries both plan fields. Distinct from the 503
    // above (a lookup fault) and from `EnterpriseError`'s 403
    // `enterprise_required` (the deployment-level license gate).
    case "FeatureEntitlementError":
      return {
        status: 403,
        code: "plan_upgrade_required",
        message: error.message,
        body: {
          required_plan: error.requiredPlan,
          current_plan: error.currentPlan,
        },
      };

    // ── 502 Bad Gateway — upstream DB error ──────────────────────
    case "QueryExecutionError":
      return { status: 502, code: "upstream_error", message: error.message };
    // Platform OAuth — upstream Platform refused the code exchange. The
    // route surfaces an actionable, translated message; the raw
    // `upstreamError` stays in logs only.
    case "PlatformOAuthExchangeError":
      return { status: 502, code: "upstream_error", message: error.message };
    // #2748 — Telegram Bot API unreachable at the network layer (DNS,
    // TLS, timeout). Mirrors `PlatformOAuthExchangeError`'s upstream
    // posture — the message is admin-safe (no token, no internal host).
    case "TelegramApiUnavailableError":
      return { status: 502, code: "upstream_error", message: error.message };
    // #2749 — Discord API unreachable at the network layer (DNS, TLS,
    // timeout). Same upstream posture as Telegram's; the message is
    // admin-safe (bot token rides in the `Authorization` header so it
    // doesn't surface in fetch error messages the way Telegram's
    // URL-embedded token can).
    case "DiscordApiUnavailableError":
      return { status: 502, code: "upstream_error", message: error.message };
    // #2752 — Microsoft tenant discovery endpoint unreachable at the
    // network layer (DNS, TLS, timeout). Same upstream posture as Telegram/
    // Discord; the message is admin-safe (operator-side TEAMS_APP_ID /
    // TEAMS_APP_PASSWORD never reach the discovery endpoint, so they
    // can't leak in fetch error messages).
    case "TeamsApiUnavailableError":
      return { status: 502, code: "upstream_error", message: error.message };
    // #2753 — Meta Graph API unreachable at the network layer (DNS, TLS,
    // timeout). Same upstream posture as Telegram / Discord / Teams; the
    // message is admin-safe (the operator-shared META_BUSINESS_ACCESS_TOKEN
    // rides in `Authorization: Bearer`, not in the URL path, so it
    // can't surface in fetch error messages).
    case "WhatsAppApiUnavailableError":
      return { status: 502, code: "upstream_error", message: error.message };
    // #2754 — Google's OAuth2 token endpoint or Pub/Sub API unreachable
    // at the network layer (DNS, TLS, timeout), or upstream 5xx. Same
    // upstream posture as Telegram / Discord / Teams / WhatsApp; the
    // message is admin-safe (the service-account private key is signed
    // into the JWT bearer assertion but never appears in fetch error
    // messages, and we redact the bearer access token defensively).
    case "GchatApiUnavailableError":
      return { status: 502, code: "upstream_error", message: error.message };

    // ── 503 Service Unavailable ──────────────────────────────────
    case "NoDatasourceError":
      return { status: 503, code: "service_unavailable", message: error.message };
    // #2593 — consumer-side fail-closed when EE-enabled but the Tag's
    // no-op default is still bound. Distinct wire code so SaaS monitoring
    // can correlate user-facing 503s with the `enterprise.load_failed`
    // structured log from `ConditionalEELayer`.
    case "EnterpriseUnavailableError":
      return {
        status: 503,
        code: "enterprise_load_failed",
        message: error.message,
      };

    // ── 504 Gateway Timeout ──────────────────────────────────────
    case "QueryTimeoutError":
    case "ActionTimeoutError":
    case "SchedulerTaskTimeoutError":
      return { status: 504, code: "timeout", message: error.message };

    // ── Scheduler ──────────────────────────────────────────────
    case "SchedulerExecutionError":
      return { status: 500, code: "upstream_error", message: error.message };
    case "DeliveryError":
      return { status: 502, code: "upstream_error", message: error.message };

    // ── Content Mode (#1515) ───────────────────────────────────
    // Surfaced from `ContentModeRegistry`. Phase 1 has no route callers;
    // these cases are wired in advance so phase 2 migrations don't leak
    // as generic 500s. Keep messages generic — the `cause` on
    // `PublishPhaseError` may wrap raw `pg` DatabaseError values containing
    // parameters or constraint detail; correlate via `requestId` instead.
    case "PublishPhaseError":
      // `phase: "count"` surfaces from read endpoints (e.g. GET /api/v1/mode
      // via `ContentModeRegistry.countAllDrafts`) where "publish" in the
      // user-visible message would be misleading. Promote and tombstone
      // phases retain the publish-framed message.
      return {
        status: 500,
        code: "upstream_error",
        message:
          error.phase === "count"
            ? "Failed to count pending drafts"
            : `Publish phase "${error.phase}" failed for table "${error.table}"`,
      };
    case "UnknownTableError":
      return {
        status: 500,
        code: "upstream_error",
        message: `Unknown content-mode table "${error.table}"`,
      };
    // #3506 — a datasource could not be profiled into a queryable semantic
    // layer (no tables, threshold breach, or unsupported dbType). The caller
    // (CLI today, an MCP datasource tool in the flagship) supplied a
    // connection that can't be made queryable, so 422 is the right surface.
    case "ProfilingFailedError":
      return {
        status: 422,
        code: "unprocessable_entity",
        message: error.message,
      };
    case "ExoticReadFilterUnavailableError":
      return {
        status: 500,
        code: "upstream_error",
        message: `No read filter registered for exotic table "${error.table}"`,
      };

    // ── EE-domain errors (safety net — see #2593) ──────────────────
    // These tags also flow through per-route `domainErrors: [...]`
    // (which wins on `classifyError` precedence via the `instanceof`
    // check). The cases below catch the *unwired* path: a route that
    // yields `RolesPolicy` / `ApprovalGate` / etc. without listing the
    // corresponding `domainError` mapping would otherwise surface as a
    // generic 500. With these cases in place, the failure channel
    // already in the typed Effect surfaces as a proper 4xx envelope
    // even when the per-route opt-in is missing.
    //
    // **Wire-code drift.** This safety-net path uses the `HttpErrorCode`
    // vocabulary (e.g. `"conflict"` for `ApprovalError(expired)` →
    // 410), whereas the per-route `domainError(...)` path uses the
    // literal `error.code` (e.g. `"expired"`). Status codes match; wire
    // codes differ. Acceptable because the safety net only runs for
    // unwired routes — every current route is wired correctly, so the
    // drift is a hypothetical that surfaces only on a future regression.
    // A `4xx-with-different-wire-code` is strictly better than a 500.
    //
    // Status assignments mirror the canonical per-route maps in
    // `shared-{retention,residency,domains}.ts` and the inline maps in
    // `admin-{roles,approval,branding,compliance,model-config}.ts`.
    case "RetentionError":
      return {
        status: error.code === "not_found" ? 404 : 400,
        code: error.code === "not_found" ? "not_found" : "bad_request",
        message: error.message,
      };
    case "RoleError":
      switch (error.code) {
        case "not_found":
          return { status: 404, code: "not_found", message: error.message };
        case "conflict":
          return { status: 409, code: "conflict", message: error.message };
        case "builtin_protected":
          return { status: 403, code: "forbidden", message: error.message };
        case "validation":
          return { status: 400, code: "bad_request", message: error.message };
      }
      // Exhaustiveness guard — TS narrows error.code to `never` here
      // once every variant above is handled. A new code added to
      // `RoleErrorCode` will fail this line at compile time.
      return assertNever(error);
    case "ApprovalError":
      switch (error.code) {
        case "not_found":
          return { status: 404, code: "not_found", message: error.message };
        case "conflict":
          return { status: 409, code: "conflict", message: error.message };
        case "expired":
          // 410 Gone is non-`HttpErrorCode`-vocabulary; reuse `conflict`
          // for wire consistency with `shared-residency.ts:already_assigned`.
          return { status: 410, code: "conflict", message: error.message };
        case "validation":
          return { status: 400, code: "bad_request", message: error.message };
      }
      return assertNever(error);
    case "ResidencyError":
      switch (error.code) {
        case "not_configured":
        case "workspace_not_found":
          return { status: 404, code: "not_found", message: error.message };
        case "invalid_region":
          return { status: 400, code: "bad_request", message: error.message };
        case "already_assigned":
          return { status: 409, code: "conflict", message: error.message };
        case "no_internal_db":
          return { status: 503, code: "service_unavailable", message: error.message };
      }
      return assertNever(error);
    case "BrandingError":
      return {
        status: error.code === "not_found" ? 404 : 400,
        code: error.code === "not_found" ? "not_found" : "bad_request",
        message: error.message,
      };
    case "DomainError":
      switch (error.code) {
        case "domain_not_found":
          return { status: 404, code: "not_found", message: error.message };
        case "invalid_domain":
          return { status: 400, code: "bad_request", message: error.message };
        case "duplicate_domain":
          return { status: 409, code: "conflict", message: error.message };
        case "railway_error":
          return { status: 502, code: "upstream_error", message: error.message };
        case "no_internal_db":
        case "railway_not_configured":
          return { status: 503, code: "service_unavailable", message: error.message };
        case "data_integrity":
          // 5xx — sanitize like `classifyError`'s domain-error path does
          // for 5xx codes. The detail goes to the log via `requestId`.
          return { status: 500, code: "upstream_error", message: error.message };
      }
      return assertNever(error);
    case "ComplianceError":
      switch (error.code) {
        case "not_found":
          return { status: 404, code: "not_found", message: error.message };
        case "conflict":
          return { status: 409, code: "conflict", message: error.message };
        case "validation":
          return { status: 400, code: "bad_request", message: error.message };
      }
      return assertNever(error);
    case "ReportError":
      return {
        status: error.code === "not_available" ? 404 : 400,
        code: error.code === "not_available" ? "not_found" : "bad_request",
        message: error.message,
      };
    case "ModelConfigError":
      switch (error.code) {
        case "not_found":
          return { status: 404, code: "not_found", message: error.message };
        case "test_failed":
          return { status: 422, code: "unprocessable_entity", message: error.message };
        case "validation":
          return { status: 400, code: "bad_request", message: error.message };
      }
      return assertNever(error);
    case "ModelConfigDecryptError":
      // No `code` field — single mapping. 422 mirrors the inline
      // `Effect.catchTag("ModelConfigDecryptError", …)` handling in
      // `admin-model-config.ts` (the "re-enter the key" envelope).
      // Message stays generic — `configId` and `cause` are forensic-only.
      return {
        status: 422,
        code: "unprocessable_entity",
        message: "The stored API key could not be decrypted. Re-enter the key on the AI Provider page.",
      };
  }
}

// ── Common error classification ─────────────────────────────────────

/**
 * Check if an error is an EnterpriseError (from @atlas/ee).
 *
 * Uses duck-typing (`name === "EnterpriseError"` + string `code`) to avoid a
 * hard import of `@atlas/ee` in the bridge module. The actual `code` value is
 * read from the error and used in the HTTP response, so future code additions
 * (e.g. `"license_expired"`) are forward-compatible.
 *
 * Coupling: ee/src/index.ts `EnterpriseError` sets `this.name = "EnterpriseError"`.
 * If that class is renamed, this guard silently stops matching — a cross-package
 * test in hono.test.ts verifies the coupling.
 */
function isEnterpriseError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    err.name === "EnterpriseError" &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

/**
 * Try to map an error to an HTTPException using the shared vocabulary:
 * HTTPException passthrough → EnterpriseError → domain error mappings → AtlasError.
 *
 * Returns the HTTPException to throw, or `undefined` if the error is unrecognized.
 */
function classifyError(
  error: unknown,
  requestId: string,
  domainErrors?: DomainErrorMapping[],
): HTTPException | undefined {
  // 1. HTTPException — re-throw unchanged (framework validation, auth failures)
  if (error instanceof HTTPException) return error;

  // 2. EnterpriseError → 403
  if (isEnterpriseError(error)) {
    return new HTTPException(403, {
      res: Response.json(
        { error: error.code, message: error.message, requestId },
        { status: 403 },
      ),
    });
  }

  // 3. Domain error mappings (EE module errors with { code } property)
  if (domainErrors) {
    for (const [errorClass, statusMap] of domainErrors) {
      if (error instanceof errorClass) {
        const code = error.code;
        if (statusMap[code] === undefined) {
          log.error({ err: error, code, requestId }, `Unmapped domain error code "${code}" for ${errorClass.name}, defaulting to 500`);
        }
        const status = (statusMap[code] ?? 500) as ContentfulStatusCode;
        // Sanitize messages for 5xx domain errors — they may contain infrastructure
        // details (Railway URLs, project IDs, internal hostnames) that should not
        // be exposed to clients. 4xx errors are user-facing and pass through.
        if (status >= 500) {
          log.error({ err: error, code, requestId }, `Infrastructure domain error (${errorClass.name})`);
        }
        const message = status >= 500
          ? `Service error (ref: ${requestId.slice(0, 8)})`
          : error.message;
        return new HTTPException(status, {
          res: Response.json(
            { error: code, message, requestId },
            { status },
          ),
        });
      }
    }
  }

  // 4. Known Atlas tagged error → mapped HTTP status
  if (isTaggedError(error) && isAtlasError(error)) {
    const mapped = mapTaggedError(error);
    // Reserved keys (`error`, `message`, `requestId`) come last so a
    // `body` field that accidentally collides with one of them can't
    // forge the response envelope.
    const responseBody = {
      ...(mapped.body ?? {}),
      error: mapped.code,
      message: mapped.message,
      requestId,
    };
    return new HTTPException(mapped.status, {
      res: Response.json(
        responseBody,
        { status: mapped.status, headers: mapped.headers },
      ),
    });
  }

  return undefined;
}

// ── Bridge ──────────────────────────────────────────────────────────

export interface RunEffectOptions {
  /** Human-readable action label for error messages and logs. */
  label?: string;
  /** Domain error class → HTTP status code mappings for EE module errors. */
  domainErrors?: DomainErrorMapping[];
}

/**
 * Run an Effect program inside a Hono route handler.
 *
 * On success, returns the program's value so the handler can build its
 * own response.  On failure, throws an `HTTPException` with a JSON body
 * containing `{ error, message, requestId }` — Hono's error handler
 * returns this to the client.
 *
 * Five failure modes are handled (in priority order):
 * 1. **HTTPException** → re-thrown unchanged (framework validation, auth)
 * 2. **EnterpriseError** → 403 (EE feature gate)
 * 3. **Domain error** → mapped via `domainErrors` option (EE module errors)
 * 4. **Known tagged error** (Atlas `_tag`) → mapped HTTP status via `mapTaggedError`
 * 5. **Unmapped / defect** → logged + 500 with requestId
 *
 * Also handles fiber interruption (→ 500).
 *
 * @param c - Hono context (used for `requestId` extraction)
 * @param program - Fully-provided Effect program (`R = never`)
 * @param options - Label and optional domain error mappings
 */
export async function runEffect<A, E>(
  c: Context,
  program:
    | Effect.Effect<A, E, RequestContext | AuthContext | EnterpriseSubsystem>
    | Effect.Effect<A, E, never>,
  options?: RunEffectOptions,
): Promise<A> {
  // Per-request contextLayer (RequestContext + AuthContext) is provided
  // at the program level, then the program runs against the shared
  // module-level EnterpriseRuntime (#2594). Pre-#2594 the bridge merged
  // contextLayer + EnterpriseLayer per request — Layer.merge produces a
  // fresh reference each time so Effect's per-Scope memoization couldn't
  // amortize the EE-Layer's lazy `await import("@atlas/ee/layers")` or
  // any other Layer.sync construction. With the ManagedRuntime, the
  // EE-Layer constructs ONCE on first use and every request reuses the
  // services; contextLayer remains per-request because it carries the
  // request's `requestId` / `authResult` (lightweight Layer.succeed).
  const contextLayer = buildContextLayer(c);
  const contextProvided: Effect.Effect<A, E, EnterpriseSubsystem> = contextLayer
    ? (program as Effect.Effect<
        A,
        E,
        RequestContext | AuthContext | EnterpriseSubsystem
      >).pipe(Effect.provide(contextLayer))
    : (program as Effect.Effect<A, E, EnterpriseSubsystem>);

  const exit = await getEnterpriseRuntime().runPromiseExit(contextProvided);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  const label = options?.label ?? "process request";

  // ── Expected failure (typed error in the E channel) ──────────
  const failureOpt = Cause.failureOption(exit.cause);

  if (Option.isSome(failureOpt)) {
    const error = failureOpt.value;

    // Try shared error classification (HTTPException, EnterpriseError, domain, Atlas)
    const classified = classifyError(error, requestId, options?.domainErrors);
    if (classified) throw classified;

    // Unknown tagged error — include _tag in log for debugging
    if (isTaggedError(error)) {
      const errObj = error instanceof Error ? error : new Error(String(error));
      log.error({ err: errObj, requestId, tag: error._tag }, `Unmapped tagged error "${error._tag}" in ${label}`);
    } else {
      const errObj = error instanceof Error ? error : new Error(String(error));
      log.error({ err: errObj, requestId }, `Unmapped error in ${label}`);
    }

    throw new HTTPException(500, {
      res: Response.json(
        { error: "internal_error", message: `Failed to ${label}.`, requestId },
        { status: 500 },
      ),
    });
  }

  // ── Fiber interruption ────────────────────────────────────────
  if (Cause.isInterruptedOnly(exit.cause)) {
    log.warn({ requestId }, `Fiber interrupted in ${label}`);
    throw new HTTPException(500, {
      res: Response.json(
        { error: "interrupted", message: `Request to ${label} was interrupted.`, requestId },
        { status: 500 },
      ),
    });
  }

  // ── Defect (unexpected throw) ─────────────────────────────────
  const defects = Arr.fromIterable(Cause.defects(exit.cause));
  const primary = defects.length > 0 ? defects[0] : undefined;

  // Try shared classification on the primary defect — domain errors thrown
  // inside Effect.tryPromise surface as defects, not typed failures.
  if (primary !== undefined) {
    const classified = classifyError(primary, requestId, options?.domainErrors);
    if (classified) throw classified;
  }

  const errObj = primary instanceof Error ? primary : new Error(String(primary ?? "unknown defect"));

  if (defects.length > 1) {
    log.error(
      {
        err: errObj,
        requestId,
        defectCount: defects.length,
        defects: defects.map((d) => (d instanceof Error ? d.message : String(d))),
      },
      `${defects.length} defects in ${label} (logging primary)`,
    );
  } else {
    log.error({ err: errObj, requestId }, `Defect in ${label}`);
  }

  throw new HTTPException(500, {
    res: Response.json(
      { error: "internal_error", message: `Failed to ${label}.`, requestId },
      { status: 500 },
    ),
  });
}

// ── Context bridge ───────────────────────────────────────────────────

/**
 * Build a Layer that bridges Hono request context → Effect Context.
 *
 * Reads `requestId`, `atlasMode`, and `authResult` from `c.get()` and provides
 * `RequestContext` + `AuthContext` as Effect services. This allows
 * Effect programs to `yield* RequestContext` or `yield* AuthContext`
 * instead of relying on runtime `c.get()` calls.
 *
 * Returns undefined if no request context is available (e.g. before middleware runs).
 */
function buildContextLayer(
  c: Context,
): Layer.Layer<RequestContext | AuthContext> | undefined {
  const requestId = (c.get("requestId") as string | undefined);
  if (!requestId) return undefined;

  // Read resolved mode set by auth middleware (defaults to "published" if not set)
  const atlasMode = (c.get("atlasMode") as import("@useatlas/types/auth").AtlasMode | undefined) ?? "published";

  const requestLayer = makeRequestContextLayer(requestId, undefined, atlasMode);

  // Trust-device identifier is set by auth middleware from the request cookie.
  // Forensic-only — surfaced via AuthContext for parity with the AsyncLocalStorage
  // RequestContext path consumed by `logAdminAction`. Undefined when no cookie.
  const trustDeviceIdentifier = c.get("trustDeviceIdentifier") as string | undefined;

  // authResult may not be set (e.g. public routes, before auth middleware)
  const authResult = c.get("authResult") as
    | { authenticated: true; mode: string; user?: { activeOrganizationId?: string } & Record<string, unknown> }
    | undefined;

  if (authResult) {
    const authLayer = makeAuthContextLayer(
      authResult.mode as import("@useatlas/types/auth").AuthMode,
      authResult.user as import("@useatlas/types/auth").AtlasUser | undefined,
      trustDeviceIdentifier,
    );
    return Layer.merge(requestLayer, authLayer);
  }

  // No auth — provide RequestContext with a fallback AuthContext (mode: "none",
  // no user) so programs that yield* AuthContext always get a valid service
  // rather than a cryptic "service not found" at runtime.
  const noAuthLayer = makeAuthContextLayer("none", undefined, trustDeviceIdentifier);
  return Layer.merge(requestLayer, noAuthLayer);
}

// ── Convenience wrapper ─────────────────────────────────────────────

/**
 * Run an async handler inside the Effect bridge.
 *
 * Convenience wrapper around `runEffect` + `Effect.tryPromise` for route handlers
 * that haven't been converted to full Effect programs yet. The handler body stays
 * as async/await — thrown errors are caught and classified by `runEffect`.
 *
 * Automatically bridges Hono request context → Effect Context so that any
 * Effect programs called transitively can access `RequestContext` and `AuthContext`.
 *
 * @example
 * ```ts
 * router.openapi(route, async (c) => runHandler(c, "list users", async () => {
 *   const users = await listUsers();
 *   return c.json({ users }, 200);
 * }));
 * ```
 */
export function runHandler<T>(
  c: Context,
  label: string,
  handler: () => Promise<T>,
  options?: Pick<RunEffectOptions, "domainErrors">,
): Promise<T> {
  const program = Effect.tryPromise({
    try: handler,
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

  // Context + enterprise provision happens once inside runEffect — no need
  // to provide them here too. The wrapper used to re-provide contextLayer
  // before delegating; that double-provide was redundant and would now
  // also need to layer in EnterpriseLayer to type-check, so we hand the
  // raw program through and let runEffect's single provide handle it.
  return runEffect(c, program, { label, domainErrors: options?.domainErrors });
}
