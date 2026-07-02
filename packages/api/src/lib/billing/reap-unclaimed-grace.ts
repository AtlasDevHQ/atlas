/**
 * Unclaimed-grace reaper (#3652, ADR-0018) — bounds the free pre-claim
 * window of a self-serve trial Workspace provisioned over MCP.
 *
 * `start_trial` (the anonymous onboarding caller) provisions a Workspace onto
 * `plan_tier='trial'` but narrows `trial_ends_at` to the short
 * {@link TRIAL_GRACE_HOURS} unclaimed-grace window rather than the full
 * {@link TRIAL_DAYS} — the 14-day clock only starts when a human *claims* the
 * account on the web (verify email → set credential → accept ToS). Until then
 * the owner's `emailVerified` bit is `false` and the Workspace is metered.
 *
 * This sweep reaps the abandoned ones: an UNCLAIMED Workspace whose grace
 * window has lapsed is demoted to the `'locked'` churn tier (#3421, zero
 * entitlements), so Gate 0 (`checkPlanLimits`) then blocks it on EVERY surface
 * including MCP with `subscription_required` — setup tools included. Abandoned
 * and spam signups self-clean instead of sitting on a free-MCP-querying window.
 *
 * What it must NEVER touch — pinned by `reap-unclaimed-grace.test.ts`:
 *   - A CLAIMED trial (owner `emailVerified = true`). Those run their full
 *     14-day clock and are handled by normal trial-expiry — the EXISTS arm
 *     below only matches an UNVERIFIED owner, so a claimed trial is invisible
 *     to this sweep regardless of its `trial_ends_at`.
 *   - A within-grace unclaimed Workspace (`trial_ends_at` still in the future).
 *   - A Workspace under an active operator plan-override window (#3427) — the
 *     same precedence the Stripe-webhook sync and `reconcilePlanTiers` honor.
 *
 * SaaS-only: a no-op off-SaaS (`deployMode !== 'saas'`) and when no internal DB
 * is configured — same self-contained gate shape as `backfillSaasTrial`. Wired
 * onto the existing scheduler as a periodic fiber in
 * `packages/api/src/lib/effect/layers.ts`, gated again on SaaS deploy mode.
 *
 * Idempotent and safe to run concurrently across instances: the reap is a
 * plain guarded `UPDATE`; an already-locked row no longer matches
 * `plan_tier = 'trial'`, so a second pass (or a peer instance) finds zero
 * candidates.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";
import { getSetting } from "@atlas/api/lib/settings";
import { trialTierSql, unclaimedOwnerExistsSql } from "./trial-state";

const log = createLogger("billing.reap-unclaimed-grace");

/**
 * Default sweep cadence: hourly. The grace window is measured in hours
 * (TRIAL_GRACE_HOURS), so an hourly sweep keeps the abandoned-signup horizon
 * tight without adding meaningful load (one guarded UPDATE per pass).
 */
export const DEFAULT_UNCLAIMED_GRACE_REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sweep interval in milliseconds — settings-registry-backed (#4130).
 *
 * Resolves ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS through getSetting()
 * (platform DB override > env > registry default of 1). Platform-scoped:
 * the reaper is a single process-global fiber forked once at boot by
 * `makeSchedulerLive` (lib/effect/layers.ts), so there is no per-workspace
 * tick. Boot-consumed — retuning needs a restart (`requiresRestart` in the
 * registry), not a redeploy.
 */
export function getUnclaimedGraceReapIntervalMs(): number {
  const raw = getSetting("ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS");
  if (!raw) return DEFAULT_UNCLAIMED_GRACE_REAP_INTERVAL_MS;
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_UNCLAIMED_GRACE_REAP_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

export interface ReapResult {
  /** Number of unclaimed past-grace Workspaces demoted to 'locked' this pass. */
  readonly reapedCount: number;
  /** IDs of the reaped Workspaces. Empty when none qualified. */
  readonly orgIds: ReadonlyArray<string>;
}

const SKIPPED: ReapResult = { reapedCount: 0, orgIds: [] };

/**
 * Injectable boundary so the per-org cache eviction can be verified without
 * `mock.module` (mirrors the DI seam in `claim-gate.ts` / `provision-trial.ts`).
 */
export interface ReapDeps {
  /** Evict one org from this replica's plan cache. */
  invalidatePlanCache: (orgId: string) => void;
}

/**
 * Run one reaping pass.
 *
 * Returns `SKIPPED` synchronously when deploy mode isn't SaaS or no internal DB
 * is configured. Errors during the UPDATE are logged and swallowed — a failed
 * sweep must not crash the scheduler fiber; the next interval retries.
 */
export async function reapUnclaimedGraceWorkspaces(
  overrides: Partial<ReapDeps> = {},
): Promise<ReapResult> {
  const invalidate = overrides.invalidatePlanCache ?? invalidatePlanCache;
  if (getConfig()?.deployMode !== "saas") return SKIPPED;
  if (!hasInternalDB()) return SKIPPED;

  try {
    // Demote unclaimed past-grace trials to the 'locked' churn tier. The
    // guards, in order:
    //   - trial tier (`trial-state`)      — only a live trial can be reaped;
    //     an already-locked/paid row is skipped (idempotent, concurrency-safe).
    //   - `trial_ends_at IS NOT NULL` + `< NOW()` — a STAMPED grace window has
    //     lapsed. A within-grace Workspace (future `trial_ends_at`) is left
    //     alone, and a NULL-clock trial is never reaped (unlike Gate 0's
    //     `createdAt + TRIAL_DAYS` fallback — the reaper only eats a trial
    //     that carries a stamped clock).
    //   - operator-override guard         — never clobber an active
    //     `plan_override_until` grant (#3427), matching `reconcilePlanTiers`.
    //   - EXISTS unverified owner (`trial-state`) — UNCLAIMED. A claimed trial
    //     (owner `emailVerified = true`) never matches, so it is never touched.
    // The tier + unclaimed clauses are generated from fragments colocated
    // (and test-pinned, `trial-state.test.ts`) with the TS claim-gate
    // predicate in `trial-state`, so SQL/TS drift is caught rather than
    // silent (#4127).
    const reaped = await internalQuery<{ id: string }>(
      `UPDATE organization o
          SET plan_tier = 'locked'
        WHERE ${trialTierSql("o")}
          AND o.trial_ends_at IS NOT NULL
          AND o.trial_ends_at < NOW()
          AND (o.plan_override_until IS NULL OR o.plan_override_until <= NOW())
          AND ${unclaimedOwnerExistsSql("o.id")}
        RETURNING id`,
    );
    const orgIds = reaped.map((r) => r.id);

    // Evict the reaped orgs from this replica's plan cache so a request hitting
    // this instance sees the lock immediately rather than after TTL (≤60s).
    // Per-replica only (#3432) — peers self-heal on TTL expiry, same contract
    // as `reconcilePlanTiers`.
    for (const id of orgIds) invalidate(id);

    if (orgIds.length > 0) {
      log.info(
        { reapedCount: orgIds.length, orgIds },
        "Reaped unclaimed past-grace trial Workspaces — demoted to 'locked' (Gate 0 now blocks on all surfaces)",
      );
    }
    return { reapedCount: orgIds.length, orgIds };
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "Unclaimed-grace reaper failed — candidates remain on 'trial' until the next interval retries",
    );
    return SKIPPED;
  }
}
