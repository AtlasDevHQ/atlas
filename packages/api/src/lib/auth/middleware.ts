/**
 * Auth middleware — central dispatcher + rate limiting.
 *
 * Calls detectAuthMode() and routes to the appropriate validator.
 * Exports in-memory sliding-window rate limiting (checkRateLimit, getClientIP).
 *
 * Stale rate-limit entries are evicted by a periodic Effect fiber in the
 * SchedulerLayer (lib/effect/layers.ts), not a module-level setInterval.
 */

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { validateApiKey } from "@atlas/api/lib/auth/simple-key";
import { validateManaged } from "@atlas/api/lib/auth/managed";
import { validateBYOT } from "@atlas/api/lib/auth/byot";
import { createLogger } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";
import { Effect } from "effect";
import { isSSOEnforcedForDomain, extractEmailDomain } from "@atlas/ee/auth/sso";
import { logAdminActionAwait, type AdminActionEntry } from "@atlas/api/lib/audit";
import type { AuthMode } from "@useatlas/types";

const log = createLogger("auth");

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000; // 60 seconds

/** Map of rate-limit key → array of request timestamps (ms). */
const windows = new Map<string, number[]>();

let lastWarnedRpmValue: string | undefined;
let lastWarnedChatRpmValue: string | undefined;

function getRpmLimit(): number {
  const raw = getSetting("ATLAS_RATE_LIMIT_RPM");
  if (raw === undefined || raw === "") return 0; // disabled
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (raw !== lastWarnedRpmValue) {
      log.warn({ value: raw }, "Invalid ATLAS_RATE_LIMIT_RPM; rate limiting disabled");
      lastWarnedRpmValue = raw;
    }
    return 0;
  }
  return Math.floor(n);
}

/**
 * Per-bucket RPM ceiling.
 *
 * `default` mirrors `ATLAS_RATE_LIMIT_RPM` — covers cheap reads (audit-log
 * scrolling, conversation list, etc).
 *
 * `chat` reads `ATLAS_RATE_LIMIT_RPM_CHAT` when set, otherwise derives
 * `max(5, RPM/4)` from the default. The carve-out keeps a 25-step LLM
 * call from depleting the same budget that serves trivial reads (F-74).
 *
 * Returning 0 means "disabled" (matching the existing semantics on the
 * default bucket); when the global limit is disabled the chat bucket is
 * also disabled regardless of override.
 */
function getRpmLimitForBucket(bucket: RateLimitBucket): number {
  const baseLimit = getRpmLimit();
  if (bucket === "default") return baseLimit;
  if (baseLimit === 0) return 0;

  const raw = getSetting("ATLAS_RATE_LIMIT_RPM_CHAT");
  if (raw === undefined || raw === "") {
    // Default: cap at 1/4 of the global RPM, with a floor of 5/min so a
    // very low ATLAS_RATE_LIMIT_RPM doesn't push the chat ceiling to 0.
    return Math.max(5, Math.floor(baseLimit / 4));
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== lastWarnedChatRpmValue) {
      log.warn(
        { value: raw },
        "Invalid ATLAS_RATE_LIMIT_RPM_CHAT; falling back to derived default max(5, RPM/4)",
      );
      lastWarnedChatRpmValue = raw;
    }
    return Math.max(5, Math.floor(baseLimit / 4));
  }
  return Math.floor(n);
}

/** Bucket categories for `checkRateLimit`. */
export type RateLimitBucket = "default" | "chat";

// `\x00` is illegal in user ids, IPs, and the "anon" fallback used by
// chat.ts — so the chat-bucket prefix can never collide with a
// caller-derived key. Keeps F-74 isolation true even against
// pathological identity strings.
const BUCKET_PREFIX: Record<RateLimitBucket, string> = {
  default: "",
  chat: "\x00chat:",
};

/**
 * Extract client IP from request headers.
 *
 * Both `X-Forwarded-For` and `X-Real-IP` are only trusted when
 * `ATLAS_TRUST_PROXY` is `"true"` or `"1"`. Without this, an attacker
 * can spoof these headers to bypass per-IP rate limits.
 */
export function getClientIP(req: Request): string | null {
  const trustProxy = process.env.ATLAS_TRUST_PROXY;
  if (trustProxy === "true" || trustProxy === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }
  return null;
}

/**
 * Sliding-window rate limit check.
 *
 * Returns `{ allowed: true }` when the request should proceed, or
 * `{ allowed: false, retryAfterMs }` when the caller should back off.
 * Always allows when ATLAS_RATE_LIMIT_RPM is unset or "0".
 *
 * The optional `bucket` parameter selects between two independent
 * sliding windows keyed on the same caller identity (user id or IP):
 *
 *   - `"default"` (omitted) — the original cheap-read bucket. Ceiling
 *     comes from `ATLAS_RATE_LIMIT_RPM`.
 *   - `"chat"` — the chat-stream carve-out (F-74). Ceiling comes from
 *     `ATLAS_RATE_LIMIT_RPM_CHAT`, defaulting to `max(5, RPM/4)`. A 25-step
 *     chat run debiting the chat bucket no longer drains the cheap-read
 *     allowance for the same caller.
 *
 * Note: this still limits API *requests*, not agent steps. Per-conversation
 * step accounting (F-77) is enforced separately on the chat handler.
 */
export function checkRateLimit(
  key: string,
  options?: { bucket?: RateLimitBucket },
): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const bucket = options?.bucket ?? "default";
  const limit = getRpmLimitForBucket(bucket);
  if (limit === 0) return { allowed: true };

  const bucketedKey = BUCKET_PREFIX[bucket] + key;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let timestamps = windows.get(bucketedKey);
  if (!timestamps) {
    timestamps = [];
    windows.set(bucketedKey, timestamps);
  }

  // Evict stale entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length < limit) {
    timestamps.push(now);
    return { allowed: true };
  }

  // Blocked — oldest entry determines when a slot opens
  const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

/** Clear all rate limit state. For tests. */
export function resetRateLimits(): void {
  windows.clear();
  lastWarnedRpmValue = undefined;
  lastWarnedChatRpmValue = undefined;
}

/**
 * Evict rate-limit keys with no recent timestamps.
 * Called periodically by the SchedulerLayer fiber.
 */
export function rateLimitCleanupTick(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of windows) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      windows.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth dispatcher
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test-only validator overrides
// ---------------------------------------------------------------------------

let _managedOverride: ((req: Request) => Promise<AuthResult>) | null = null;
let _byotOverride: ((req: Request) => Promise<AuthResult>) | null = null;

/** @internal — test-only. Override validateManaged/validateBYOT for isolation. */
export function _setValidatorOverrides(overrides: {
  managed?: ((req: Request) => Promise<AuthResult>) | null;
  byot?: ((req: Request) => Promise<AuthResult>) | null;
}): void {
  _managedOverride = overrides.managed ?? null;
  _byotOverride = overrides.byot ?? null;
}

type SSOEnforcementResult = { enforced: boolean; ssoRedirectUrl?: string } | null;

let _ssoEnforcementOverride:
  | ((emailDomain: string) => Promise<SSOEnforcementResult>)
  | null = null;

/** @internal — test-only. Override the SSO enforcement lookup so tests can
 * exercise the 403/500 branches without touching the internal Postgres DB. */
export function _setSSOEnforcementOverride(
  override: ((emailDomain: string) => Promise<SSOEnforcementResult>) | null,
): void {
  _ssoEnforcementOverride = override;
}

let _auditEnforcementBlockOverride:
  | ((entry: AdminActionEntry) => void | Promise<void>)
  | null = null;

/** @internal — test-only. Capture (or fail) the `sso.enforcement_block`
 * audit emission without going through `logAdminActionAwait`. Lets tests
 * assert on the audit shape and exercise the fail-closed branch without
 * touching a real internal Postgres. May return a rejected Promise to
 * simulate an audit-write failure. */
export function _setAuditEnforcementBlockOverride(
  override: ((entry: AdminActionEntry) => void | Promise<void>) | null,
): void {
  _auditEnforcementBlockOverride = override;
}

/**
 * Categorize an auth error for diagnostic logging.
 * Helps operators quickly identify whether a failure is a database issue,
 * network problem, configuration error, or a programming bug.
 */
function categorizeAuthError(err: unknown): string {
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
    return "programming-error";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg)) {
    return "network-error";
  }
  if (/relation.*does not exist|database|SQLITE|pg_|connect|pool/i.test(msg)) {
    return "database-error";
  }
  if (/secret|config|env|missing|undefined|not set/i.test(msg)) {
    return "config-error";
  }
  return "unknown";
}

/**
 * Auth modes whose authenticated path must run through SSO enforcement.
 *
 * Derived from `AuthMode` rather than hand-typed so that adding a new
 * mode forces an explicit decision at this site. By default the new
 * mode joins the enforced set automatically — bypass is opt-in via
 * the explicit `Exclude` list. `none` has no user identity to enforce
 * against; `simple-key` is the documented break-glass when SSO breaks
 * (e.g. IdP outage during incident response). Hand-typing the
 * enforced set as a literal union — what the original F-56 code did —
 * is what let `byot` silently bypass SSO when it was added.
 */
type SSOEnforceableMode = Exclude<AuthMode, "none" | "simple-key">;

/**
 * Bound on how long the audit-row write may block the auth path.
 *
 * The audit row is the security control (see `checkSSOEnforcement`),
 * so we await its commit before returning the 403 — but the internal
 * Postgres pool has no `connectionTimeoutMillis` / `statement_timeout`
 * defaults, which means an unreachable-but-routable DB or a stuck pool
 * could otherwise stall every blocked SSO login for the full TCP
 * keepalive window. Cap it: if the write hasn't committed within this
 * deadline, throw and let the surrounding catch fail closed with 500.
 */
const AUDIT_WRITE_TIMEOUT_MS = 5_000;

/**
 * Check SSO enforcement for a user's email domain.
 *
 * Fires for any authenticated path with a resolvable email-domain label
 * — managed and byot today; future modes inherit enforcement unless
 * explicitly added to `SSO_BYPASS_MODES`. Returns an `AuthResult`
 * rejection (403) if enforcement matches; null otherwise. Fails closed
 * on lookup errors AND on audit-write errors (500). When blocking,
 * commits a `sso.enforcement_block` admin-action row before returning
 * the 403 so compliance queries can pivot on the bypass-attempt domain
 * regardless of which auth mode tried it.
 *
 * The audit row IS the security control: a forensic record that
 * someone tried to bypass SSO. `logAdminActionAwait` writes via
 * `internalQuery` (no circuit breaker, unlike fire-and-forget
 * `logAdminAction` / `internalExecute`) so it surfaces failures
 * rather than dropping the row. We additionally cap the wait at
 * `AUDIT_WRITE_TIMEOUT_MS` — if the row can't commit promptly we
 * 500 fail-closed instead of stalling auth on an unreachable
 * internal Postgres. Either failure mode lands in the catch below.
 *
 * Not invoked for `simple-key`: API-key auth has no email domain
 * (`simple-key.ts` labels keys as `api-key-<first 4 chars of raw key>`)
 * and is the documented break-glass bypass when SSO breaks (e.g. IdP
 * outage during incident response).
 */
async function checkSSOEnforcement(
  userLabel: string,
  authMode: SSOEnforceableMode,
): Promise<AuthResult | null> {
  try {
    const domain = extractEmailDomain(userLabel);
    if (!domain) return null;

    const enforcement = _ssoEnforcementOverride
      ? await _ssoEnforcementOverride(domain)
      : await Effect.runPromise(isSSOEnforcedForDomain(domain));
    if (!enforcement || !enforcement.enforced) return null;

    log.warn(
      { domain, userId: userLabel, authMode },
      "Login blocked — SSO enforcement active for domain",
    );
    // Audit write is fail-closed: a throw lands in the catch below and
    // becomes a 500 AuthResult. Better to 500 than to silently 403 with
    // no forensic row.
    await emitEnforcementBlockAudit({ domain, userLabel, authMode });
    return {
      authenticated: false,
      mode: authMode,
      status: 403,
      error: "SSO is required for this workspace. Please sign in via your identity provider.",
      ssoRedirectUrl: enforcement.ssoRedirectUrl,
    };
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), authMode },
      "SSO enforcement check failed — blocking login (fail-closed)",
    );
    return {
      authenticated: false,
      mode: authMode,
      status: 500 as const,
      error: "Unable to verify SSO enforcement status. Please retry or contact your administrator.",
    };
  }
}

async function emitEnforcementBlockAudit(args: {
  domain: string;
  userLabel: string;
  authMode: SSOEnforceableMode;
}): Promise<void> {
  const entry: AdminActionEntry = {
    actionType: "sso.enforcement_block",
    targetType: "sso",
    targetId: args.domain,
    status: "failure",
    metadata: { authMode: args.authMode, userLabel: args.userLabel },
  };
  const writer = _auditEnforcementBlockOverride ?? logAdminActionAwait;
  await Promise.race([
    writer(entry),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`audit write timed out after ${AUDIT_WRITE_TIMEOUT_MS}ms`)),
        AUDIT_WRITE_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Authenticate an incoming request based on the detected auth mode. */
export async function authenticateRequest(req: Request): Promise<AuthResult> {
  const mode = detectAuthMode();

  switch (mode) {
    case "none":
      return { authenticated: true, user: undefined, mode: "none" };

    case "simple-key":
      // simple-key is the documented break-glass bypass for SSO enforcement
      // (listed in SSO_BYPASS_MODES above). The API-key user label is
      // `api-key-<first 4 chars of raw key>` (set in `simple-key.ts`); it
      // has no `@`, so even if checkSSOEnforcement ran here it would no-op
      // via extractEmailDomain. Skipping the call keeps intent explicit.
      // Other auth modes (managed, byot) run the check below — see F-56.
      return validateApiKey(req);

    case "managed":
      return runWithSSOEnforcement(mode, () => (_managedOverride ?? validateManaged)(req));

    case "byot":
      return runWithSSOEnforcement(mode, () => (_byotOverride ?? validateBYOT)(req));
  }
}

/**
 * Run a validator and gate the authenticated result through SSO enforcement.
 *
 * Single entry point for every `SSOEnforceableMode` — managed and byot
 * share the same gate (F-56), and any future enforced mode joins
 * automatically. Centralizes the categorize-and-500 fallback so all
 * enforced modes report uniformly when their validator throws.
 */
async function runWithSSOEnforcement(
  mode: SSOEnforceableMode,
  validator: () => Promise<AuthResult>,
): Promise<AuthResult> {
  try {
    const result = await validator();
    if (result.authenticated && result.user) {
      const enforcementCheck = await checkSSOEnforcement(result.user.label, mode);
      if (enforcementCheck) return enforcementCheck;
    }
    return result;
  } catch (err) {
    const category = categorizeAuthError(err);
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), mode, category },
      "Auth validator error (%s)",
      category,
    );
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
      log.error({ err, mode }, "BUG: Unexpected programming error in auth validator");
    }
    return {
      authenticated: false,
      mode,
      status: 500,
      error: "Authentication service error",
    };
  }
}
