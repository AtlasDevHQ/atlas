/**
 * SaaS-first per-workspace auto-promote / decay scheduler for learned query
 * patterns (PRD #3617 B-2, #3636; workspace opt-in #4582).
 *
 * One platform fiber, forked once at boot (`makeSchedulerLive`), iterates the
 * workspaces that opted into auto-promotion — the workspace-scoped
 * `ATLAS_LEARN_PROMOTE_DECAY_ENABLED` trust dial, off by default. Self-hosted's
 * single implicit workspace is the degenerate case of the same per-workspace
 * tick, not a different model. The per-workspace ITERATION mirrors the
 * semantic-expert scheduler (#4516); ENABLEMENT mirrors
 * `ATLAS_AUTONOMOUS_IMPROVE_ENABLED` — but unlike the expert fiber (which keeps
 * a platform master switch), this fiber drops its platform enable-gate entirely
 * and gates only per-workspace. Each workspace's tick:
 *   - PROMOTES its pending `query_pattern` rows that clear a tunable gate
 *     (confidence + repetition + latency budget + recency) from pending →
 *     approved, so the learning loop maintains itself without an admin.
 *   - DECAYS (DEMOTES, never deletes) its auto-promoted rows unseen past a
 *     tunable window back to pending, so the injected set stays fresh.
 *
 * The decision is the pure {@link decidePromoteDecay} function, unchanged — its
 * #3636 invariants (recency gate; decay never touches a human approval; human
 * review clears the auto-promoted flag; rejected rows stay frozen) are preserved.
 * This module owns only the I/O: resolving the opted-in workspaces, fetching
 * each workspace's candidates, applying the result, and invalidating the
 * retrieval cache for affected workspaces.
 *
 * The retired platform-scoped, env-only, restart-required master switch
 * (`ATLAS_LEARN_PROMOTE_DECAY_ENABLED` at platform scope, boot-consumed) is
 * gone: the fiber now always runs and gates per-workspace at runtime, so a
 * workspace opting in takes effect on the next tick with no redeploy. The gate
 * TUNING and the fiber CADENCE stay platform-scoped operator policy — only the
 * on/off dial is per-workspace.
 *
 * `semantic_amendment` rows are deliberately out of scope — they rewrite YAML on
 * approval and keep human review (mirrors the expert auto-approve carve-out).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { isSaasModeForGuard } from "@atlas/api/lib/settings";
// Type-only import — erased at compile time, so it does NOT eagerly load
// db/internal and the dynamic import + mock seam in the tick stays intact.
// Reusing the row type keeps `toCandidate` from drifting from the SQL.
import type { PromoteDecayCandidateRow } from "@atlas/api/lib/db/internal";
import {
  decidePromoteDecay,
  type PromoteDecayCandidate,
  type PromoteDecayThresholds,
} from "@atlas/api/lib/learn/promote-decay";
import {
  isPromoteDecayEnabledForWorkspace,
  getPromoteDecaySchedulerIntervalMs,
  getPromoteDecayThresholds,
  DEFAULT_PROMOTE_DECAY_INTERVAL_MS,
} from "@atlas/api/lib/learn/learn-settings";

// The ATLAS_LEARN_* reads live in the single learn-settings resolver (#3722).
// Re-export the fiber's cadence + gate resolvers from this module's public
// surface so layers.ts (the boot fiber) and the scheduler test keep importing
// them from here unchanged.
export {
  isPromoteDecayEnabledForWorkspace,
  getPromoteDecaySchedulerIntervalMs,
  getPromoteDecayThresholds as resolvePromoteDecayThresholds,
  DEFAULT_PROMOTE_DECAY_INTERVAL_MS,
};

/**
 * The workspace-scoped opt-in key, exported so the SaaS enumeration query below
 * and `settings.ts` stay in lockstep. A guard test in the scheduler test
 * cross-checks this constant against the real registry (`getSettingDefinition`)
 * so a rename can't silently make the enumeration match ZERO workspaces —
 * auto-promotion never running for any tenant, with no other failure signal.
 */
export const PROMOTE_DECAY_ENABLED_KEY = "ATLAS_LEARN_PROMOTE_DECAY_ENABLED";

const log = createLogger("promote-decay-scheduler");

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Upper bound on rows evaluated per workspace per tick — a runaway-table
 *  backstop. The scheduler logs when the cap is hit so a silently-truncated
 *  tick is visible. Because the scan is freshest-first (#4582), hitting the cap
 *  defers the oldest-touched rows, never the fresh ones a tenant is re-running. */
const CANDIDATE_LIMIT = 10000;

/** Summary of a single tick — the sum across every workspace it iterated. */
export interface PromoteDecayTickResult {
  /** Workspaces the tick iterated (1 on the self-hosted degenerate path, 0 when
   *  nothing opted in). */
  workspacesConsidered: number;
  candidates: number;
  promoted: number;
  demoted: number;
  errors: number;
}

/** Per-workspace counters — folded into the tick total. */
interface WorkspaceCounters {
  candidates: number;
  promoted: number;
  demoted: number;
  errors: number;
}

/** Project a DB candidate row (snake_case) onto the pure-decision input shape
 *  (camelCase) — the one place the two representations are bridged. The raw row
 *  types `type`/`status` as bare `string` (Postgres text); the SELECT in
 *  `getPromoteDecayCandidates` filters `type = 'query_pattern'` and
 *  `status IN ('pending','approved')`, so narrowing them to the wire unions here
 *  is the single, documented `string → union` coercion. */
function toCandidate(row: PromoteDecayCandidateRow): PromoteDecayCandidate {
  return {
    id: row.id,
    type: row.type as PromoteDecayCandidate["type"],
    status: row.status as PromoteDecayCandidate["status"],
    confidence: row.confidence,
    repetitionCount: row.repetition_count,
    avgDurationMs: row.avg_duration_ms,
    lastSeenAt: row.last_seen_at,
    autoPromoted: row.auto_promoted,
  };
}

/**
 * Resolve the workspaces this tick should process.
 *
 * SaaS-first (#4582): on SaaS, iterate the workspaces that opted in (the
 * workspace-scoped `ATLAS_LEARN_PROMOTE_DECAY_ENABLED` knob, off by default). On
 * self-hosted the whole deployment is one implicit workspace (NULL org) — the
 * degenerate case — opted in iff that workspace's knob resolves true (the env
 * var or a platform override, since there is no per-workspace DB row to set).
 *
 * NOTE: this deploy-mode branch SELECTS an iteration strategy (enumerate
 * per-workspace vs. one degenerate workspace); the per-tick opt-in + id-keyed
 * apply steps are what make running on SaaS org-safe by construction.
 */
async function resolvePromoteDecayWorkspaces(): Promise<Array<string | null>> {
  if (!isSaasModeForGuard()) {
    return isPromoteDecayEnabledForWorkspace(null) ? [null] : [];
  }
  return listPromoteDecayOrgIds();
}

/**
 * Enumerate the workspaces that opted into auto-promotion. Reads the settings
 * table directly (one row per workspace override) joined to `organization` so a
 * stale override for a deleted workspace is dropped.
 *
 * "opted in" means "has an explicit workspace-scoped DB override set to true" —
 * this deliberately does NOT route through getSetting()'s env/default tier: an
 * env var or platform default cannot opt a *specific* tenant into promotion. So
 * a platform-level `ATLAS_LEARN_PROMOTE_DECAY_ENABLED=true` on SaaS enrolls
 * nobody by design; enrollment is always a per-workspace admin action (mirrors
 * the autonomous-improve enumeration, #4516).
 */
async function listPromoteDecayOrgIds(): Promise<string[]> {
  const { hasInternalDB, internalQuery } = await import("@atlas/api/lib/db/internal");
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<{ org_id: string }>(
    `SELECT DISTINCT s.org_id AS org_id
       FROM settings s
       JOIN organization o ON o.id = s.org_id
      WHERE s.key = $1 AND s.value IN ('true', '1') AND s.org_id IS NOT NULL`,
    [PROMOTE_DECAY_ENABLED_KEY],
  );
  return rows.map((r) => r.org_id);
}

/**
 * Run a single promote/decay tick across all opted-in workspaces.
 *
 * 1. Bail if there's no internal DB (self-hosted without one).
 * 2. Resolve the opted-in workspace set; bail if empty.
 * 3. Resolve the gate thresholds ONCE (platform-scoped operator policy, uniform
 *    across workspaces — only the on/off opt-in is per-workspace).
 * 4. For each workspace, run its tick independently — a per-workspace failure is
 *    logged and never aborts the sweep.
 *
 * Never throws — errors are logged and surfaced in `result.errors`.
 */
export async function runPromoteDecayTick(): Promise<PromoteDecayTickResult> {
  const result: PromoteDecayTickResult = {
    workspacesConsidered: 0,
    candidates: 0,
    promoted: 0,
    demoted: 0,
    errors: 0,
  };

  try {
    const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
    if (!hasInternalDB()) {
      log.debug("No internal DB — skipping promote/decay tick");
      return result;
    }

    const workspaces = await resolvePromoteDecayWorkspaces();
    if (workspaces.length === 0) {
      log.debug("Promote/decay tick: no opted-in workspaces");
      return result;
    }

    // Gate thresholds are platform-scoped operator policy, uniform across the
    // workspaces the tick iterates. Resolve once and reuse — only the on/off
    // opt-in is per-workspace, never the gate tuning.
    const thresholds = getPromoteDecayThresholds();

    // Sequential, not Promise.all: a background sweep over a normally-small set —
    // serializing keeps the per-workspace DB work from bursting the internal
    // pool alongside live traffic (matches the expert scheduler).
    //
    // `workspacesFailed` counts only workspaces whose ENTIRE tick threw here
    // (candidate fetch / decision / import failed) — distinct from the inner
    // promote/demote/cache errors, which are logged at error level and folded
    // into `result.errors`. When every considered workspace fails this way the
    // cause is systemic (schema drift, internal-DB outage, a decision regression),
    // so the tick summary escalates to error rather than reporting "complete" —
    // a per-workspace warn alone would bury a whole-feature outage (panel review).
    let workspacesFailed = 0;
    for (const orgId of workspaces) {
      result.workspacesConsidered++;
      try {
        const ws = await runWorkspacePromoteDecayTick(orgId, thresholds);
        result.candidates += ws.candidates;
        result.promoted += ws.promoted;
        result.demoted += ws.demoted;
        result.errors += ws.errors;
      } catch (err) {
        result.errors++;
        workspacesFailed++;
        log.warn(
          { err: errorMessage(err), orgId },
          "Promote/decay tick failed for workspace — will retry next tick",
        );
      }
    }

    const summary = {
      workspacesConsidered: result.workspacesConsidered,
      candidates: result.candidates,
      promoted: result.promoted,
      demoted: result.demoted,
      errors: result.errors,
    };
    if (workspacesFailed > 0 && workspacesFailed === result.workspacesConsidered) {
      log.error(
        summary,
        "Promote/decay tick: every considered workspace failed — auto-promotion is not running (systemic error, not a per-workspace hiccup)",
      );
    } else {
      log.info(summary, "Promote/decay tick complete");
    }
  } catch (err) {
    log.error({ err: errorMessage(err) }, "Promote/decay tick failed");
    result.errors++;
  }

  return result;
}

/**
 * Run one workspace's promote/decay tick.
 *
 * `orgId` is the workspace owner — a real id on SaaS, `null` on the self-hosted
 * degenerate path. Fetches that workspace's candidates (freshest-first, capped),
 * applies the pure decision against the shared gate, promotes/demotes the id
 * sets, and evicts the retrieval cache for every affected workspace.
 *
 * Promote and demote settle INDEPENDENTLY. A `Promise.all` would reject as soon
 * as either side throws and unwind, losing the OTHER side's already-committed
 * count AND skipping cache invalidation for its just-flipped rows, leaving stale
 * agent context until the 5-min TTL lapses (#3636 review). Each batch DB write
 * is its own transaction, so a success on one side is durable regardless of the
 * other.
 */
async function runWorkspacePromoteDecayTick(
  orgId: string | null,
  thresholds: PromoteDecayThresholds,
): Promise<WorkspaceCounters> {
  const counters: WorkspaceCounters = { candidates: 0, promoted: 0, demoted: 0, errors: 0 };

  const { getPromoteDecayCandidates, promoteLearnedPatterns, demoteLearnedPatterns } = await import(
    "@atlas/api/lib/db/internal"
  );

  const candidates = await getPromoteDecayCandidates(orgId, CANDIDATE_LIMIT);
  counters.candidates = candidates.length;
  if (candidates.length === CANDIDATE_LIMIT) {
    log.warn(
      { orgId, limit: CANDIDATE_LIMIT },
      "Promote/decay candidate scan hit its cap for workspace — freshest rows kept, oldest-touched beyond the cap deferred to a later tick",
    );
  }
  if (candidates.length === 0) return counters;

  const { promote, demote } = decidePromoteDecay(candidates.map(toCandidate), thresholds, Date.now());

  const affected = new Set<string | null>();
  const [promoteRes, demoteRes] = await Promise.allSettled([
    promoteLearnedPatterns(promote),
    demoteLearnedPatterns(demote),
  ]);
  if (promoteRes.status === "fulfilled") {
    counters.promoted = promoteRes.value.count;
    for (const affectedOrg of promoteRes.value.orgIds) affected.add(affectedOrg);
  } else {
    counters.errors++;
    log.error(
      { err: errorMessage(promoteRes.reason), orgId, ids: promote.length },
      "Auto-promote batch failed",
    );
  }
  if (demoteRes.status === "fulfilled") {
    counters.demoted = demoteRes.value.count;
    for (const affectedOrg of demoteRes.value.orgIds) affected.add(affectedOrg);
  } else {
    counters.errors++;
    log.error(
      { err: errorMessage(demoteRes.reason), orgId, ids: demote.length },
      "Auto-demote batch failed",
    );
  }

  // A promotion/demotion changes which patterns the agent sees, so evict the
  // 5-min retrieval cache for every affected workspace (mirrors the admin
  // approve/reject path). Imported here, not at module top, to avoid a cycle
  // through the settings → internal → pattern-cache graph. Wrapped on its own so
  // a cache-import/invalidation failure is logged distinctly rather than
  // masquerading as a tick-wide failure that discards the committed counts.
  if (affected.size > 0) {
    try {
      const { invalidatePatternCache } = await import("@atlas/api/lib/learn/pattern-cache");
      for (const affectedOrg of affected) invalidatePatternCache(affectedOrg);
    } catch (err) {
      counters.errors++;
      log.error(
        { err: errorMessage(err), orgId },
        "Promote/decay cache invalidation failed — rows were flipped but cache stays stale until TTL",
      );
    }
  }

  return counters;
}
