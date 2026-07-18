/**
 * Org-bucketed hit/miss accounting for the Query Cache (#4549).
 *
 * Why this lives OUTSIDE the backend: `CacheBackend.get(key)` structurally
 * cannot attribute a MISS to a Workspace — on a miss the key isn't in the
 * backend, so there is no scope tag to read. The org IS known at the single
 * agent read site (`lib/tools/sql.ts`), so per-org accounting is recorded
 * there, into this module-level registry. Two deliberate consequences:
 *
 * - **Two-counter split.** The backend keeps its own global `hits`/`misses`
 *   (its self-report, required by the `CacheBackend.stats()` contract and
 *   meaningful for external backends like Redis). This registry is an
 *   ADDITIONAL app-maintained per-org layer, not a replacement — the two are
 *   never reconciled against each other.
 * - **Counters survive backend recreation.** The registry sits above the
 *   cache module's `_state`, so a resize, plugin backend swap, or
 *   unset→owned transition never resets the numbers an admin is watching.
 *   Cleared only via `resetCacheStatsRegistry` (test isolation;
 *   `_resetCache()` invokes it) — there is no admin-facing reset verb.
 *
 * Each bucket carries a since-labeled lifetime rate plus a last-hour rate via
 * a two-generation sliding window (two integer pairs per bucket — no ring
 * buffer): the current hour's counts and the previous hour's, rotated lazily
 * on access. The windowed readout weights the previous generation by how much
 * of the current hour remains — the standard sliding-window-counter
 * approximation. There is deliberately NO reset verb: "the window moves after
 * a flush" is emergent (post-flush queries miss, the window rate drops).
 */

/** Sliding-window width: one hour. */
const WINDOW_MS = 3_600_000;

/**
 * Bucket key for accesses with no Workspace (auth mode "none" /
 * single-tenant). They still roll into the fleet aggregate.
 */
const NO_ORG = "__no_org__";

interface Bucket {
  /** Epoch ms of this bucket's first recorded access (labels the lifetime rate). */
  since: number;
  lifetimeHits: number;
  lifetimeMisses: number;
  /** Window generation: `floor(now / WINDOW_MS)` at last rotation. */
  gen: number;
  curHits: number;
  curMisses: number;
  prevHits: number;
  prevMisses: number;
}

/** Per-caller stats readout. `null` rates mean "no activity to rate". */
export interface OrgCacheStats {
  /** Epoch ms of the first recorded access, or `null` when never active (warming). */
  since: number | null;
  hits: number;
  misses: number;
  /** Lifetime hit rate, or `null` when no accesses were recorded. */
  hitRate: number | null;
  /** Sliding last-hour hit rate, or `null` when the window saw no activity. */
  windowHitRate: number | null;
  /** Approximate access count inside the sliding window (rounded). */
  windowTotal: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Lazily rotate a bucket's two-generation window to the generation `now`
 * falls in. Adjacent generation → current counts become the previous hour;
 * a gap of 2+ generations means the previous hour saw nothing.
 */
function rotate(b: Bucket, now: number): void {
  const gen = Math.floor(now / WINDOW_MS);
  if (gen === b.gen) return;
  if (gen === b.gen + 1) {
    b.prevHits = b.curHits;
    b.prevMisses = b.curMisses;
  } else {
    b.prevHits = 0;
    b.prevMisses = 0;
  }
  b.curHits = 0;
  b.curMisses = 0;
  b.gen = gen;
}

/**
 * Record one cache access for `orgId` (undefined → the no-org bucket).
 * Called from the agent read site in `lib/tools/sql.ts` — never from inside
 * a backend. `now` is injectable for deterministic tests only.
 */
export function recordCacheAccess(orgId: string | undefined, hit: boolean, now: number = Date.now()): void {
  const key = orgId ?? NO_ORG;
  let b = buckets.get(key);
  if (!b) {
    b = {
      since: now,
      lifetimeHits: 0,
      lifetimeMisses: 0,
      gen: Math.floor(now / WINDOW_MS),
      curHits: 0,
      curMisses: 0,
      prevHits: 0,
      prevMisses: 0,
    };
    buckets.set(key, b);
  }
  rotate(b, now);
  b.lifetimeHits += hit ? 1 : 0;
  b.lifetimeMisses += hit ? 0 : 1;
  b.curHits += hit ? 1 : 0;
  b.curMisses += hit ? 0 : 1;
}

/**
 * Weighted window counts for one bucket: the previous generation contributes
 * proportionally to how much of the current hour is still ahead.
 */
function windowCounts(b: Bucket, now: number): { windowHits: number; windowMisses: number } {
  rotate(b, now);
  const weight = 1 - (now % WINDOW_MS) / WINDOW_MS;
  return {
    windowHits: b.curHits + b.prevHits * weight,
    windowMisses: b.curMisses + b.prevMisses * weight,
  };
}

function toStats(since: number | null, hits: number, misses: number, windowHits: number, windowMisses: number): OrgCacheStats {
  const total = hits + misses;
  const windowTotal = windowHits + windowMisses;
  // Rate and rounded total key off the SAME threshold so the invariant
  // "windowHitRate === null ⟺ windowTotal === 0" holds even at the decay
  // tail, where the weighted total is in (0, 0.5) and rounds to 0.
  const windowTotalRounded = Math.round(windowTotal);
  return {
    since,
    hits,
    misses,
    hitRate: total > 0 ? hits / total : null,
    windowHitRate: windowTotalRounded > 0 ? windowHits / windowTotal : null,
    windowTotal: windowTotalRounded,
  };
}

/**
 * One Workspace's bucket (undefined → the no-org bucket). A never-active org
 * reads as `{ since: null, … }` — the "warming" state, distinct from
 * 0-hit-rate-looks-broken.
 */
export function getOrgCacheStats(orgId: string | undefined, now: number = Date.now()): OrgCacheStats {
  const b = buckets.get(orgId ?? NO_ORG);
  if (!b) return toStats(null, 0, 0, 0, 0);
  const { windowHits, windowMisses } = windowCounts(b, now);
  return toStats(b.since, b.lifetimeHits, b.lifetimeMisses, windowHits, windowMisses);
}

/**
 * Fleet aggregate across every bucket (platform-admin view): summed lifetime
 * counts, weighted-summed window counts, `since` = the earliest bucket's.
 */
export function getFleetCacheStats(now: number = Date.now()): OrgCacheStats {
  let since: number | null = null;
  let hits = 0;
  let misses = 0;
  let windowHits = 0;
  let windowMisses = 0;
  for (const b of buckets.values()) {
    since = since === null ? b.since : Math.min(since, b.since);
    hits += b.lifetimeHits;
    misses += b.lifetimeMisses;
    const w = windowCounts(b, now);
    windowHits += w.windowHits;
    windowMisses += w.windowMisses;
  }
  return toStats(since, hits, misses, windowHits, windowMisses);
}

/** Clear every bucket. For test isolation only (called by `_resetCache`). */
export function resetCacheStatsRegistry(): void {
  buckets.clear();
}
