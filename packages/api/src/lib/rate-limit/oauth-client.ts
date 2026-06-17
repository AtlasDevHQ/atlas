/**
 * Per-OAuth-client rate limiter for the hosted MCP endpoint (#2071).
 *
 * Scopes the bucket by `(workspaceId, clientId)` so that one greedy MCP
 * client (e.g. an experimental Claude Desktop install polling every
 * 100ms) cannot starve siblings registered against the same workspace.
 * `userId` is part of the context shape so the caller chain
 * (middleware audit emission) has it without re-plumbing — the limiter
 * itself never reads it. DCR clients are single-user today; a future
 * shared-client flow can light up secondary aggregation against
 * `userId` from the audit trail without a re-keying migration.
 *
 * Window choice: **sliding window**, mirroring
 * `lib/db/source-rate-limit.ts` so the data-plane limiter (per-source)
 * and the agent-plane limiter (per-client) share one operator concept.
 * Token buckets would buy burst credits at the cost of a calibration
 * step (refill rate vs burst capacity vs window) the operator-facing
 * envelope doesn't surface today. Out of scope for #2071. The
 * operator-facing tradeoff is summarized in
 * `apps/docs/content/docs/guides/mcp-hosted.mdx`.
 *
 * Per-tool weighting: every dispatch costs at least 1, with `executeSQL`
 * and `explore` charged 5× because their downstream cost (a DB query
 * with row+column transfer; a sandboxed shell command) is genuinely
 * heavier than a semantic-layer YAML read. Weights live in
 * {@link TOOL_WEIGHTS} so the eval harness (#2025) and the operator-
 * facing docs read the same table the limiter does. New tools default
 * to weight 1 — register an explicit weight when adding a tool whose
 * cost profile mismatches that default.
 *
 * State is in-process and per-region. Cross-region reconciliation is
 * deferred to follow-up work (#2071 § "Out of scope") — a determined
 * attacker can hit all three regions simultaneously, but each region's
 * bucket independently caps the abuse blast-radius below what an
 * unscoped global would. The accept criteria in this PR target the
 * single-region case, which is the production hot path today.
 */

import { getSettingAuto } from "@atlas/api/lib/settings";

const WINDOW_MS = 60_000;
export { WINDOW_MS };

/** The shipping default — low enough to catch a runaway agent, high enough for normal use. */
export const DEFAULT_REQUESTS_PER_MINUTE = 60;

/**
 * Per-tool weight table. A bucket of N units admits roughly N
 * `listEntities` calls or roughly `N / TOOL_WEIGHTS.executeSQL`
 * `executeSQL` calls. Keep aligned with the tools registered in
 * `packages/mcp/src/tools.ts` and `packages/mcp/src/semantic-tools.ts`.
 */
export const TOOL_WEIGHTS = {
  executeSQL: 5,
  explore: 5,
  runMetric: 3,
  listEntities: 1,
  describeEntity: 1,
  searchGlossary: 1,
} as const satisfies Readonly<Record<string, number>>;

const DEFAULT_TOOL_WEIGHT = 1;

export function toolWeight(toolName: string): number {
  return (TOOL_WEIGHTS as Record<string, number>)[toolName] ?? DEFAULT_TOOL_WEIGHT;
}

export interface ClientRateLimit {
  readonly requestsPerMinute: number;
}

export interface ClientRateLimitContext {
  readonly orgId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly toolName: string;
}

/**
 * Discriminated union: `retryAfterSec` is present **only** on the denied
 * branch, so callers cannot accidentally treat `verdict.retryAfterSec === 0`
 * as a "go" sentinel (the original flat-record ambiguity). Branch on
 * `verdict.allowed` and let the type checker prevent the misuse.
 */
export type ClientRateLimitVerdict =
  | {
      readonly allowed: true;
      readonly limit: number;
      readonly weight: number;
      readonly remaining: number;
    }
  | {
      readonly allowed: false;
      readonly limit: number;
      readonly weight: number;
      readonly remaining: number;
      /** Whole-second value safe to drop into an HTTP `Retry-After` header. */
      readonly retryAfterSec: number;
    };

/**
 * Forensic-pivot dimension for rate-limit denials. `bucket_overflow`
 * is the per-client weighted-bucket exhaustion path; `loader_failure`
 * is the fail-closed override-DB-outage path (see middleware.ts and
 * `ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED`). Lifted to a shared type so
 * audit metadata, OTel attribute schemas, and operator-facing docs
 * import the same source of truth — adding a new reason has one place
 * to update, not two stringly-typed call sites.
 */
export type RateLimitDenialReason = "bucket_overflow" | "loader_failure";

// ── State ──────────────────────────────────────────────────────────

interface BucketEntry {
  ts: number;
  weight: number;
}

const limits = new Map<string, ClientRateLimit>();
const buckets = new Map<string, BucketEntry[]>();

/**
 * Soft cap on the `limits` cache map. DCR-issued client IDs can be
 * high-cardinality on a long-running region; without an upper bound the
 * cache grows monotonically (every `(orgId, clientId)` ever seen by
 * `resolveRateLimitFor` gets a row, including the default-resolved
 * fall-through, and is never evicted). LRU keeps memory bounded while
 * preserving warm-cache behavior for the active set. Eviction happens
 * on insert when the map exceeds the cap. `Map` iterates in insertion
 * order, so the *first* entry returned by `keys().next()` is the
 * least-recently-inserted; we mirror that into "least-recently-used"
 * by deleting and re-setting the entry on every read in
 * {@link checkClientRateLimit}.
 *
 * Buckets self-clean on read: when the in-window entry list filters
 * down to zero the key is removed from the map, so the bucket map's
 * natural ceiling is the count of clients with at least one in-window
 * request. No separate cap is needed for `buckets` — but the read-time
 * delete is load-bearing.
 *
 * Override via `ATLAS_MCP_RATE_LIMIT_MAX_KEYS` (positive integer; values
 * below 100 are clamped to 100 so a typo can't reduce the cache to a
 * thrashing window). The default sizes a single region for ~1k active
 * agents with healthy headroom for short-lived client churn.
 */
const DEFAULT_LIMITS_CACHE_MAX_KEYS = 10_000;

function resolveLimitsCacheMaxKeys(): number {
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_MCP_RATE_LIMIT_MAX_KEYS");
  if (raw === undefined) return DEFAULT_LIMITS_CACHE_MAX_KEYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMITS_CACHE_MAX_KEYS;
  return Math.max(100, parsed);
}

function setLimitsEntry(key: string, value: ClientRateLimit): void {
  if (limits.has(key)) limits.delete(key);
  limits.set(key, value);
  const cap = resolveLimitsCacheMaxKeys();
  while (limits.size > cap) {
    const oldest = limits.keys().next();
    if (oldest.done) break;
    limits.delete(oldest.value);
  }
}

function touchLimitsEntry(key: string): ClientRateLimit | undefined {
  // Re-insert on read so Map's insertion-order iteration acts as a
  // recency queue — keeps the active set warm even when the cache is
  // near its cap. A read miss is a no-op (no entry to refresh).
  const value = limits.get(key);
  if (value === undefined) return undefined;
  limits.delete(key);
  limits.set(key, value);
  return value;
}

/**
 * Cache + bucket key. Uses U+003A `:` as the separator because `orgId`
 * (CUID) and `clientId` (DCR-issued, RFC 7591 ASCII) cannot contain a
 * colon by construction. The prior NUL-byte separator (`\x00`) caused
 * git to flag the whole file as binary, blocking textual diff review.
 */
function bucketKey(orgId: string, clientId: string): string {
  return `${orgId}:${clientId}`;
}

// ── Clock — overridable for deterministic tests ────────────────────

let _clockOverride: number | null = null;
function now(): number {
  return _clockOverride ?? Date.now();
}

/** @internal — test seam. Pin the limiter clock to a fixed ms. Pass null to release. */
export function _setClockForTests(value: number | null): void {
  _clockOverride = value;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Override the per-minute quota for one (orgId, clientId) pair. Pass
 * `null` to remove a previously-set override (a future check then
 * falls through to {@link DEFAULT_REQUESTS_PER_MINUTE}).
 */
export function setClientRateLimit(
  orgId: string,
  clientId: string,
  limit: ClientRateLimit | null,
): void {
  const key = bucketKey(orgId, clientId);
  if (limit === null) {
    limits.delete(key);
    return;
  }
  if (!Number.isInteger(limit.requestsPerMinute) || limit.requestsPerMinute < 1) {
    throw new Error(
      `requestsPerMinute must be a positive integer, got ${limit.requestsPerMinute}`,
    );
  }
  setLimitsEntry(key, limit);
}

/**
 * Synchronous fast-path check + record. Records the request's weight
 * into the sliding window when allowed; leaves the window untouched
 * when denied (so a denied request does not push back the recovery
 * time). The DB-resolution step (admin override lookup) lives in
 * {@link resolveRateLimitFor} below this function so the hot per-frame
 * path stays sync.
 */
export function checkClientRateLimit(
  ctx: ClientRateLimitContext,
): ClientRateLimitVerdict {
  const t = now();
  const key = bucketKey(ctx.orgId, ctx.clientId);
  const limit = touchLimitsEntry(key)?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const weight = toolWeight(ctx.toolName);

  // Filter stale entries on read — no setInterval required.
  const cutoff = t - WINDOW_MS;
  let entries = buckets.get(key);
  if (entries) {
    entries = entries.filter((e) => e.ts > cutoff);
  } else {
    entries = [];
  }

  const used = entries.reduce((sum, e) => sum + e.weight, 0);
  if (used + weight > limit) {
    // Recovery is when the *oldest* entry slides past the window. Round
    // up so the integer Retry-After value is never under-spec'd.
    const oldest = entries[0]?.ts ?? t;
    const retryAfterMs = Math.max(1000, oldest + WINDOW_MS - t);
    if (entries.length === 0) {
      // No live entries to keep — drop the key so the map self-cleans.
      // Without this the buckets map would grow by one key per denied
      // single-weight-exceeds-limit dispatch from a fresh client.
      buckets.delete(key);
    } else {
      buckets.set(key, entries);
    }
    return {
      allowed: false,
      // Cap at WINDOW_MS in seconds: the recovery time can never exceed
      // one window, so emitting a higher Retry-After would tell the
      // agent to back off longer than necessary. Using `WINDOW_MS / 1000`
      // (not the literal `60`) keeps the cap aligned if the window is
      // ever resized.
      retryAfterSec: Math.min(WINDOW_MS / 1000, Math.ceil(retryAfterMs / 1000)),
      limit,
      weight,
      remaining: Math.max(0, limit - used),
    } satisfies ClientRateLimitVerdict;
  }

  entries.push({ ts: t, weight });
  buckets.set(key, entries);
  return {
    allowed: true,
    limit,
    weight,
    remaining: Math.max(0, limit - used - weight),
  } satisfies ClientRateLimitVerdict;
}

// ── DB-backed override resolution (cached) ─────────────────────────

/**
 * Loader for an admin-set per-minute quota. Returns `null` when no row
 * exists — the bucket then falls through to {@link DEFAULT_REQUESTS_PER_MINUTE}.
 *
 * The middleware layer wires this to a Postgres lookup against
 * `oauth_client_rate_limits`; tests pass an in-memory stub.
 */
export type RateLimitLoader = (
  orgId: string,
  clientId: string,
) => Promise<number | null>;

/**
 * Resolve and cache the effective per-minute quota for one
 * (orgId, clientId). After the first resolution the value lives in
 * `limits` and the synchronous {@link checkClientRateLimit} sees it
 * without a DB roundtrip.
 *
 * Returns the resolved quota so callers can log it for observability.
 */
export async function resolveRateLimitFor(
  orgId: string,
  clientId: string,
  loader: RateLimitLoader,
): Promise<number> {
  const key = bucketKey(orgId, clientId);
  const cached = touchLimitsEntry(key);
  if (cached) return cached.requestsPerMinute;

  const fromDb = await loader(orgId, clientId);
  const resolved =
    fromDb !== null && Number.isFinite(fromDb) && fromDb > 0
      ? fromDb
      : DEFAULT_REQUESTS_PER_MINUTE;
  // Always cache — including the default — so subsequent checks skip
  // the DB. Admin PATCH calls invalidate via setClientRateLimit. The
  // helper threads through the LRU bound so we don't pile up entries
  // for one-shot DCR clients.
  setLimitsEntry(key, { requestsPerMinute: resolved });
  return resolved;
}

// ── Read-only peek (UI surfacing — #2216) ──────────────────────────

/**
 * In-window weighted-request total + ceiling for a `(orgId, clientId)`.
 * Surfaced by `/api/v1/me/mcp-usage` so the Settings → AI Agents page
 * can show "this agent has used 35/60 weighted requests this minute"
 * before the bucket trips a 429.
 *
 * The shape carries three numbers the limiter has on hand
 * (`currentMinuteWeightedRequests`, `ceiling`, `resetAt`); the route
 * layer derives `percentUsed` from these so the limiter stays free
 * of presentation concerns. `resetAt` is absolute milliseconds (epoch)
 * so the UI can render either an ETA countdown or a wall-clock time
 * without re-deriving from `Date.now()` — both surfaces would
 * otherwise have to share an extra clock skew assumption that isn't
 * present today.
 */
export interface ClientUsageView {
  /** Sum of weights for entries inside the current sliding window. */
  readonly currentMinuteWeightedRequests: number;
  /** Resolved per-minute quota — cached override if present, otherwise default. */
  readonly ceiling: number;
  /**
   * Epoch-ms moment the oldest in-window entry rolls out of the window.
   * With no entries, equals the current clock so callers render
   * "available now" instead of subtracting from a stale anchor.
   */
  readonly resetAt: number;
}

/**
 * Side-effect-free read of the live bucket. Used by the Settings → AI
 * Agents page (#2216) and any future operator surface that wants to
 * display "live usage" without debiting the bucket.
 *
 * Two invariants the route layer relies on:
 *
 *   1. **No bucket mutation.** Filtering expired entries is left to
 *      the next {@link checkClientRateLimit} on the same key — peeking
 *      must not insert an empty array (that would defeat the bucket
 *      map's natural self-cleaning property and grow the map by one
 *      entry per unique polling client).
 *
 *   2. **No LRU promotion.** A polling Settings tab firing every 10s
 *      must NOT keep stale `(orgId, clientId)` overrides warm in the
 *      LRU. Reads go through the raw `Map.get` so the recency queue
 *      tracks actual rate-limit checks, not informational peeks.
 *
 * Both invariants are pinned by `usage-read.test.ts`.
 */
export function getClientUsage(
  orgId: string,
  clientId: string,
): ClientUsageView {
  const t = now();
  const key = bucketKey(orgId, clientId);

  // Raw `.get` — no `touchLimitsEntry` (peek must not promote the LRU).
  const ceiling = limits.get(key)?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;

  const cutoff = t - WINDOW_MS;
  const stored = buckets.get(key);
  // `.filter` returns a new array — the original entries on the map
  // (if any) are not modified. The next `checkClientRateLimit` will
  // run the same filter and persist the cleanup.
  const inWindow = stored ? stored.filter((e) => e.ts > cutoff) : [];

  const currentMinuteWeightedRequests = inWindow.reduce(
    (sum, e) => sum + e.weight,
    0,
  );
  const oldest = inWindow[0];
  const resetAt = oldest ? oldest.ts + WINDOW_MS : t;

  return { currentMinuteWeightedRequests, ceiling, resetAt };
}

// ── Test helpers ───────────────────────────────────────────────────

/** @internal — test-only. Drop all bucket and override state. */
export function _resetClientRateLimitsForTests(): void {
  limits.clear();
  buckets.clear();
}

/** @internal — test-only. Surface map sizes so eviction tests can pin
 *  the LRU bound + bucket self-clean contracts. */
export function _getRateLimitMapSizesForTests(): {
  readonly limits: number;
  readonly buckets: number;
} {
  return { limits: limits.size, buckets: buckets.size };
}

/** @internal — test-only. True if a `(orgId, clientId)` pair has a
 *  cached limit override in the LRU. Lets tests assert eviction order
 *  without a separate snapshot helper. */
export function _hasCachedLimitForTests(orgId: string, clientId: string): boolean {
  return limits.has(bucketKey(orgId, clientId));
}
