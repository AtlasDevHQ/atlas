/**
 * Trial state — the single authoritative derivation of a workspace's trial
 * axes (#4127, split from the #3801 architecture review).
 *
 * CONTEXT.md distinguishes two independent axes for a `trial`-tier Workspace,
 * and this module is the one place both are defined:
 *
 *   - **metered vs full** (the claim axis, ADR-0018 / #3651): a Workspace
 *     provisioned over MCP is *unclaimed* until a human completes the web
 *     claim interstitial, which flips the owner's `emailVerified` bit. An
 *     unclaimed trial is **metered** — Atlas-token Q&A is withheld while
 *     setup and MCP querying stay open. Enforced by the claim-gate
 *     (`claim-gate.ts`); abandoned unclaimed Workspaces are reaped after the
 *     grace window lapses (`reap-unclaimed-grace.ts`).
 *   - **expired vs solvent** (the solvency axis, Gate 0): the trial clock —
 *     `trial_ends_at`, falling back to `createdAt + TRIAL_DAYS` for
 *     pre-backfill workspaces (#3434) — has lapsed. Enforced by
 *     `checkPlanLimits` (`enforcement.ts`) on every surface.
 *
 * Before this module the predicates were re-derived independently by four
 * readers (claim-gate, enforcement, the grace reaper, trial-eligibility),
 * with "unclaimed trial" existing in two shapes — TS in the claim-gate, SQL
 * in the reaper — that could silently drift. The TS form is
 * {@link deriveTrialState}; the SQL form is generated from fragments
 * ({@link trialTierSql}, {@link unclaimedOwnerExistsSql}) colocated with the
 * TS predicate and pinned against it by `trial-state.test.ts`, so drift is
 * caught rather than silent.
 *
 * #4127 folded the predicates but left the CLOCK in four places — a canonical
 * stamper with only one caller, a reader that re-derived the same rule, and
 * two hand-inlined `now + TRIAL_DAYS` stampers. #4354 closed that: the write
 * side ({@link fullTrialEndsAtFrom}, now the ONLY stamper — `assignSaasTrial`,
 * the boot backfill, and `extendTrialOnClaim` all write what it returns) and
 * the read side ({@link effectiveTrialEndsAt}, the date Gate 0 enforces) share
 * one arithmetic fragment, so a stamped trial cannot be dated differently from
 * the trial enforcement expires. `trial-state.test.ts` pins write-against-read
 * over a table of fixed clocks and structurally forbids re-inlining the
 * arithmetic anywhere else.
 */

import type { PlanTier, WorkspaceRow } from "@atlas/api/lib/db/internal";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { TRIAL_DAYS, TRIAL_GRACE_HOURS } from "./plans";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Tier membership — which tiers carry a trial clock / can be metered
// ---------------------------------------------------------------------------

/**
 * Membership predicate for the trial tier — the only tier that carries a
 * trial clock and the only tier the claim-gate meters. TS twin of
 * {@link trialTierSql}; paid, free, and locked tiers are never metered and
 * never "trial-expired".
 */
export function isTrialTier(tier: PlanTier): boolean {
  return tier === "trial";
}

/**
 * Guard for the SQL-fragment builders: their argument is interpolated raw
 * into SQL text, so it must be a static identifier (`o`, `o.id`) or a bind
 * placeholder (`$1`) written at a call site — never request-derived data.
 * Throws (rather than sanitizing silently) on anything else, per the
 * prefer-errors rule; every legitimate ref matches.
 */
function assertStaticSqlRef(ref: string): void {
  if (!/^(\$\d+|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?)$/.test(ref)) {
    throw new Error(
      `trial-state SQL fragment ref ${JSON.stringify(ref)} is not a static identifier or bind placeholder`,
    );
  }
}

/**
 * SQL twin of {@link isTrialTier} over `alias` (e.g. `trialTierSql("o")` →
 * `o.plan_tier = 'trial'`). Keeping tier membership in one fragment means a
 * future second meterable tier changes the claim-gate, the reaper, and the
 * claim-time clock extension together or not at all. `alias` must be a
 * static identifier ({@link assertStaticSqlRef}).
 */
export function trialTierSql(alias: string): string {
  assertStaticSqlRef(alias);
  return `${alias}.plan_tier = 'trial'`;
}

// ---------------------------------------------------------------------------
// The trial clock (expired/solvent axis) — effective end, expiry, countdown
// ---------------------------------------------------------------------------

/** The fields of `WorkspaceRow` the trial-clock computations read. */
export interface TrialExpiryInput {
  trial_ends_at: string | Date | null;
  createdAt: string | Date;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * THE trial-clock fragment: the epoch-ms instant a full {@link TRIAL_DAYS}
 * clock started at `startMs` runs out. Every trial-clock computation in the
 * codebase — read side and write side — bottoms out here (#4354):
 *
 *   - write: {@link fullTrialEndsAtFrom}, the one stamper, consumed by
 *     `assignSaasTrial`, the boot backfill, and `extendTrialOnClaim`;
 *   - read: {@link effectiveTrialEndsAt}'s `createdAt` fallback (#3434), the
 *     date Gate 0 actually enforces.
 *
 * Sharing the fragment is the point: if the write side could drift from the
 * read side, every new trial would be silently mis-dated and enforcement
 * would expire it on the wrong day. Pure epoch-ms arithmetic — deliberately
 * NOT calendar-day arithmetic, so the horizon is timezone- and DST-invariant
 * (a trial stamped across a DST boundary still lasts exactly
 * `TRIAL_DAYS * 24h`).
 */
function fullTrialEndMsFrom(startMs: number): number {
  return startMs + TRIAL_DAYS * MS_PER_DAY;
}

/**
 * The date enforcement treats as the end of the trial: `trial_ends_at` when
 * set and parseable, else `createdAt + TRIAL_DAYS` (#3434). Returns null only
 * when neither input parses — expiry treats that as "not expired" and
 * display callers render nothing rather than a bogus date. The API computes
 * `plan.trialEndsAtEffective` from this so the frontend never re-derives the
 * rule.
 */
export function effectiveTrialEndsAt(workspace: TrialExpiryInput): Date | null {
  if (workspace.trial_ends_at !== null) {
    const endMs = toMs(workspace.trial_ends_at);
    if (Number.isFinite(endMs)) return new Date(endMs);
  }
  const createdMs = toMs(workspace.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return new Date(fullTrialEndMsFrom(createdMs));
}

/**
 * Whether the trial clock has lapsed at `now` given its effective end. A null
 * effective end is "not expired" — there is no clock to have run out.
 */
export function isTrialExpiredAt(effectiveEnd: Date | null, now: Date = new Date()): boolean {
  if (effectiveEnd === null) return false;
  return effectiveEnd.getTime() < now.getTime();
}

/**
 * Whole days until the effective trial end, floored at 0 (a lapsed trial
 * reports 0, never a negative). Null when neither date input parses.
 * Tier-agnostic — callers gate on {@link isTrialTier}, or read
 * {@link TrialState.daysRemaining}, which is null off-trial.
 */
export function trialDaysRemaining(
  workspace: TrialExpiryInput,
  now: Date = new Date(),
): number | null {
  const effectiveEnd = effectiveTrialEndsAt(workspace);
  if (effectiveEnd === null) return null;
  return Math.max(0, Math.ceil((effectiveEnd.getTime() - now.getTime()) / MS_PER_DAY));
}

/**
 * ISO timestamp of the full {@link TRIAL_DAYS} clock end measured from
 * `nowMs` — the `trial_ends_at` a trial carries once its clock has started
 * (web signup at org creation, or MCP signup at claim time).
 *
 * The ONLY trial-clock stamper (#4354): `assignSaasTrial`, the boot backfill
 * (`backfill-saas-trial.ts`), and `extendTrialOnClaim` all write what this
 * returns, and it shares {@link fullTrialEndMsFrom} with the reader
 * {@link effectiveTrialEndsAt} that Gate 0 enforces — so the stamped date and
 * the enforced date cannot drift. Don't re-inline the arithmetic at a call
 * site; `trial-state.test.ts` pins write-against-read.
 */
export function fullTrialEndsAtFrom(nowMs: number): string {
  return new Date(fullTrialEndMsFrom(nowMs)).toISOString();
}

/**
 * ISO timestamp of the unclaimed-grace horizon measured from `nowMs`. In
 * practice a stamped `trial_ends_at` at or below this horizon is a
 * {@link TRIAL_GRACE_HOURS} grace window rather than a full
 * {@link TRIAL_DAYS} clock — the guard that makes the claim-time clock
 * extension (`extendTrialOnClaim`) idempotent. Not an absolute: a full
 * clock re-enters the horizon in its final {@link TRIAL_GRACE_HOURS}, so a
 * re-verification firing there re-extends — an accepted edge, inherited
 * from the original #3651 guard.
 */
export function unclaimedGraceHorizonFrom(nowMs: number): string {
  return new Date(nowMs + TRIAL_GRACE_HOURS * MS_PER_HOUR).toISOString();
}

// ---------------------------------------------------------------------------
// The owner read (claimed/unclaimed axis) — one join, two query shapes
// ---------------------------------------------------------------------------

/** Owner-verification shape resolved per org — the claim axis's ground truth. */
export interface OwnerVerification {
  emailVerified: boolean;
  email: string | null;
}

/**
 * The workspace-owner join core: the `member.role = 'owner'` row(s) of
 * `orgRef`, joined to their `user` row. Shared source for both shapes of the
 * owner read — the row-returning lookup ({@link getOwnerVerification}) and
 * the set-based EXISTS arm ({@link unclaimedOwnerExistsSql}) — so the TS and
 * SQL forms of "the owner" cannot drift.
 */
function ownerJoinSql(orgRef: string): string {
  assertStaticSqlRef(orgRef);
  return `FROM member m
        JOIN "user" u ON u.id = m."userId"
       WHERE m."organizationId" = ${orgRef}
         AND m.role = 'owner'`;
}

/**
 * SQL form of the UNCLAIMED predicate: the workspace has an owner whose
 * `emailVerified` bit is still false — the `!claimed` axis of
 * {@link deriveTrialState} as a correlated EXISTS over `orgRef`.
 *
 * The set form is deliberately conservative on the rare multi-owner
 * workspace: ANY unverified owner matches, whereas the row lookup keys on the
 * earliest-created owner (the original creator). Both agree on the
 * single-owner case every MCP-provisioned trial actually is. `orgRef` must
 * be a static identifier or bind placeholder ({@link assertStaticSqlRef}).
 */
export function unclaimedOwnerExistsSql(orgRef: string): string {
  return `EXISTS (
        SELECT 1
          ${ownerJoinSql(orgRef)}
           AND u."emailVerified" = false
      )`;
}

/**
 * Resolve the workspace owner's `emailVerified` bit (and email, for the
 * claim-URL prefill). The owner is the `member.role = 'owner'` row; on the
 * rare multi-owner workspace the earliest-created membership wins (the
 * original creator). Returns `null` when no owner row exists.
 *
 * Throws on query failure — the caller owns the failure posture (the
 * claim-gate fails CLOSED, surfacing a retryable 503).
 */
export async function getOwnerVerification(orgId: string): Promise<OwnerVerification | null> {
  const rows = await internalQuery<{ emailVerified: boolean; email: string | null }>(
    `SELECT u."emailVerified" AS "emailVerified", u.email AS email
       ${ownerJoinSql("$1")}
      ORDER BY m."createdAt" ASC
      LIMIT 1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return { emailVerified: !!row.emailVerified, email: row.email ?? null };
}

// ---------------------------------------------------------------------------
// The composite derivation
// ---------------------------------------------------------------------------

/**
 * The authoritative trial state of a workspace — both CONTEXT.md axes plus
 * the countdown, derived in one place.
 */
export interface TrialState {
  readonly tier: PlanTier;
  /**
   * The claim axis's raw bit: the owner has verified their email (completed
   * the web claim interstitial). An ownerless workspace is vacuously claimed
   * — there is no one to send to the claim page.
   */
  readonly claimed: boolean;
  /**
   * Unclaimed trial (metered/full axis, ADR-0018): Atlas-token Q&A is
   * withheld until claim. Always false off the trial tier.
   */
  readonly metered: boolean;
  /**
   * Trial clock lapsed (expired/solvent axis, Gate 0). Always false off the
   * trial tier — non-trial tiers carry no trial clock. Independent of
   * `metered`: an unclaimed-AND-expired trial is both, and Gate 0's expiry
   * block wins by gate ordering (`agent-query-gates.ts`).
   */
  readonly expired: boolean;
  /** Whole days left on the trial clock (floored at 0); null off-trial. */
  readonly daysRemaining: number | null;
}

/**
 * Derive the full trial state for `workspace` given its owner's verification
 * (`null` when no owner row exists). Pure — callers own the two lookups
 * (`getCachedWorkspace`, {@link getOwnerVerification}) and their failure
 * postures.
 */
export function deriveTrialState(
  workspace: Pick<WorkspaceRow, "plan_tier"> & TrialExpiryInput,
  owner: OwnerVerification | null,
  now: Date = new Date(),
): TrialState {
  const tier = workspace.plan_tier;
  const trial = isTrialTier(tier);
  const claimed = owner === null || owner.emailVerified;
  return {
    tier,
    claimed,
    metered: trial && !claimed,
    expired: trial && isTrialExpiredAt(effectiveTrialEndsAt(workspace), now),
    daysRemaining: trial ? trialDaysRemaining(workspace, now) : null,
  };
}
