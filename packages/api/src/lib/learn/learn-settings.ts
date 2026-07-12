/**
 * Single resolver seam for every `ATLAS_LEARN_*` tuning knob (#3722).
 *
 * Before this module the 7 learn knobs were read at scattered call sites in
 * `pattern-cache.ts` and `promote-decay-scheduler.ts`, with the workspace-vs-
 * platform scope policy (and the defaults) duplicated across both files and a
 * cross-module constant import just to share `DEFAULT_LATENCY_BUDGET_MS`. This
 * module owns all of it: the literal registry reads, the defaults, and the one
 * documented statement of which knob is read at which scope and why.
 *
 * ## Scope policy (the SSOT this module exists to centralize)
 *
 * **Workspace-scoped** (read per-request via `getSettingAuto(key, orgId)`, so a
 * tenant tunes them from Admin → Settings with no redeploy; tier chain is
 * `workspace override > platform override > env var > default`):
 *   - `ATLAS_LEARN_RETRIEVAL_TURNS`
 *   - `ATLAS_LEARN_CONFIDENCE_THRESHOLD`
 *   - `ATLAS_LEARN_LATENCY_BUDGET_MS`
 *
 * **Workspace-scoped auto-promotion opt-in** — the SaaS-first trust dial (#4582):
 *   - `ATLAS_LEARN_PROMOTE_DECAY_ENABLED` — whether auto-promotion runs for a
 *     workspace, off by default. Moved OUT of platform scope (#4582): the single
 *     platform fiber now iterates the workspaces that opted in, so this is a
 *     per-workspace, hot-reloaded dial, not a boot-consumed master switch.
 *     Mirrors `ATLAS_AUTONOMOUS_IMPROVE_ENABLED`. Read two ways: the self-hosted
 *     degenerate workspace resolves it through `getSettingAuto(key, null)`
 *     (the `isPromoteDecayEnabledForWorkspace` resolver below); the SaaS tick
 *     enumerates opted-in workspaces straight from the `settings` table
 *     (`listPromoteDecayOrgIds` in the scheduler) so an env/platform default
 *     can't opt a specific tenant in.
 *
 * **Platform-scoped** (read with `getSetting(key)` — no orgId — because the
 * auto-promote/decay job is a single process-global fiber forked once at boot by
 * `makeSchedulerLive`, so its CADENCE and GATE TUNING are operator policy,
 * uniform across the workspaces the tick iterates):
 *   - `ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS` (boot-consumed, requiresRestart)
 *   - `ATLAS_LEARN_PROMOTE_MIN_REPETITIONS`
 *   - `ATLAS_LEARN_DECAY_UNSEEN_DAYS`
 *
 * **Two keys are read at BOTH scopes — intentionally, not a smell:**
 *   - `ATLAS_LEARN_CONFIDENCE_THRESHOLD` gates retrieval eligibility (workspace)
 *     AND auto-promotion eligibility (platform). One knob means "eligible to
 *     inject" and "eligible to auto-promote" never drift apart.
 *   - `ATLAS_LEARN_LATENCY_BUDGET_MS` is the retrieval down-weight budget
 *     (workspace) AND the nightly promotion latency ceiling (platform). A
 *     workspace override therefore affects only retrieval-time down-weighting,
 *     never the promotion gate.
 *
 * ## #3382 reader-guard contract
 *
 * `scripts/check-settings-readers.sh` matches readers by a literal
 * `getSetting("KEY")` / `getSettingAuto("KEY")` on a single line. Keep every
 * read below in that shape — never a looped/computed key — or the guard will
 * report the key as having no runtime reader.
 */

import { getSetting, getSettingAuto } from "@atlas/api/lib/settings";
import type { PromoteDecayThresholds } from "@atlas/api/lib/learn/promote-decay";

// ---------------------------------------------------------------------------
// Defaults — the fallback tier for every learn knob lives here (and only here).
// ---------------------------------------------------------------------------

/** Default trailing user turns assembled into the retrieval query. */
export const DEFAULT_RETRIEVAL_TURNS = 3;

/** Default minimum confidence for a learned pattern to be eligible. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Default latency budget (ms) for perf-weighted retrieval. A pattern whose
 * rolling-mean wall-clock stays at or under this gets no penalty; slower
 * patterns are down-weighted (never excluded). Also the default budget for the
 * nightly auto-promote gate. PRD #3617 B-2.
 */
export const DEFAULT_LATENCY_BUDGET_MS = 5000;

/** Default interval for the nightly promote/decay job: 24 hours. */
export const DEFAULT_PROMOTE_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Gate defaults for the nightly promote/decay job (mirror the registry). */
const DEFAULT_PROMOTE_CONFIDENCE = DEFAULT_CONFIDENCE_THRESHOLD;
const DEFAULT_PROMOTE_MIN_REPETITIONS = 5;
const DEFAULT_DECAY_UNSEEN_DAYS = 30;

// ---------------------------------------------------------------------------
// Workspace-scoped retrieval knobs
// ---------------------------------------------------------------------------

/**
 * Resolve the retrieval-turn count for an org, falling back to the default.
 * Workspace-scoped settings-registry read (see module scope policy).
 */
export function getRetrievalTurns(orgId?: string | null): number {
  const raw = getSettingAuto("ATLAS_LEARN_RETRIEVAL_TURNS", orgId ?? undefined);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_RETRIEVAL_TURNS;
}

/**
 * Resolve the pattern confidence threshold for an org, falling back to the
 * default. Workspace-scoped settings-registry read (see module scope policy).
 */
export function getConfidenceThreshold(orgId?: string | null): number {
  const raw = getSettingAuto("ATLAS_LEARN_CONFIDENCE_THRESHOLD", orgId ?? undefined);
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * Resolve the latency budget (ms) for an org, falling back to the default.
 * Workspace-scoped settings-registry read (see module scope policy). Non-positive
 * / invalid values fall back to the default rather than disabling the budget, so
 * a typo can't silently turn off down-weighting.
 */
export function getLatencyBudgetMs(orgId?: string | null): number {
  const raw = getSettingAuto("ATLAS_LEARN_LATENCY_BUDGET_MS", orgId ?? undefined);
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LATENCY_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Workspace-scoped auto-promotion opt-in (#4582)
// ---------------------------------------------------------------------------

/**
 * Whether auto-promotion is enabled for a workspace (#4582). Workspace-scoped
 * and hot-reloaded: a workspace admin flips it from Admin → Settings and it
 * takes effect on the next scheduler tick with no restart. Resolution is the
 * standard tier chain — workspace override > platform override > env >
 * default(false) — so on self-hosted the single implicit workspace opts in via
 * the env var (or a platform override) with no per-workspace row to set, and on
 * SaaS each workspace opts in with its own DB override.
 *
 * This replaces the retired platform-scoped, boot-consumed master switch: the
 * trust dial now belongs to the workspace, mirroring
 * `ATLAS_AUTONOMOUS_IMPROVE_ENABLED`. Keep the literal key on the call line so
 * `scripts/check-settings-readers.sh` (R1) sees a runtime reader.
 */
export function isPromoteDecayEnabledForWorkspace(orgId?: string | null): boolean {
  const v = getSettingAuto("ATLAS_LEARN_PROMOTE_DECAY_ENABLED", orgId ?? undefined);
  return v === "true" || v === "1";
}

// ---------------------------------------------------------------------------
// Platform-scoped promote/decay knobs (fiber cadence + gate tuning)
// ---------------------------------------------------------------------------

/**
 * Parse a raw setting value, falling back to `fallback` on a missing /
 * non-finite / out-of-range value (a typo can't silently widen a gate). `min`
 * is the inclusive lower bound the value must clear.
 */
function parseNumeric(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Tick interval in milliseconds. Platform-scoped, boot-consumed: platform DB
 * override > env > default 24h.
 */
export function getPromoteDecaySchedulerIntervalMs(): number {
  const raw = getSetting("ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS");
  if (!raw) return DEFAULT_PROMOTE_DECAY_INTERVAL_MS;
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_PROMOTE_DECAY_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

/**
 * Resolve the promote/decay gate from the settings registry at platform scope
 * (read once per tick, no orgId). The confidence threshold and latency budget
 * reuse the same keys that gate retrieval — see the dual-scope note in the
 * module doc comment.
 */
export function getPromoteDecayThresholds(): PromoteDecayThresholds {
  const decayUnseenDays = parseNumeric(
    getSetting("ATLAS_LEARN_DECAY_UNSEEN_DAYS"),
    DEFAULT_DECAY_UNSEEN_DAYS,
    1,
  );
  return {
    confidenceThreshold: parseNumeric(
      getSetting("ATLAS_LEARN_CONFIDENCE_THRESHOLD"),
      DEFAULT_PROMOTE_CONFIDENCE,
      0,
    ),
    minRepetitions: parseNumeric(
      getSetting("ATLAS_LEARN_PROMOTE_MIN_REPETITIONS"),
      DEFAULT_PROMOTE_MIN_REPETITIONS,
      1,
    ),
    latencyBudgetMs: parseNumeric(
      getSetting("ATLAS_LEARN_LATENCY_BUDGET_MS"),
      DEFAULT_LATENCY_BUDGET_MS,
      1,
    ),
    decayUnseenMs: decayUnseenDays * 24 * 60 * 60 * 1000,
  };
}
