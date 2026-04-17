/**
 * Click-threshold auto-promotion policy for `query_suggestions`.
 *
 * # State matrix (canonical explainer)
 *
 * A suggestion row carries two orthogonal state axes:
 *
 *   | Axis            | Values                         | Purpose                      |
 *   |-----------------|--------------------------------|------------------------------|
 *   | approval_status | pending / approved / hidden    | Moderation lifecycle         |
 *   | status          | draft / published / archived   | Mode-system participation    |
 *
 * The axes are independent. An approved suggestion may still be `draft`
 * (awaiting publish) or `published`. A draft suggestion may be any
 * `approval_status`. Migration 0029 enforces the enum sets via CHECK
 * constraints.
 *
 * # Auto-promote decision
 *
 * A row defaults to `approval_status = 'pending'` / `status = 'draft'`.
 * When enough distinct users click a `pending` row within the cold
 * window, it becomes eligible for the admin queue. This module owns the
 * decision as a pure function so tests can cover threshold arithmetic,
 * window boundary, and the no-duplicate-promotion invariant without
 * touching the database.
 */

import type {
  SuggestionApprovalStatus,
  SuggestionStatus,
} from "@useatlas/types";

// Re-export so callers have a single import site for the policy + its types.
export type { SuggestionApprovalStatus, SuggestionStatus };

/**
 * Runtime tuples matching the types above. Kept in the api package
 * rather than `@useatlas/types` because the scaffold template installs
 * `@useatlas/types` from the registry — exporting new runtime values
 * there would require a coordinated publish before scaffold CI
 * succeeds. Type aliases are erased at compile time and have no such
 * constraint.
 */
export const SUGGESTION_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "hidden",
] as const satisfies readonly SuggestionApprovalStatus[];

export const SUGGESTION_STATUSES = [
  "draft",
  "published",
  "archived",
] as const satisfies readonly SuggestionStatus[];

/** Config driving the auto-promote decision. */
export interface AutoPromoteConfig {
  /**
   * Distinct-user click threshold. Promotion fires only on the exact
   * transition from `priorDistinctUserClicks < threshold` to
   * `nextDistinctUserClicks >= threshold`. Subsequent clicks with a
   * prior count already at/above threshold are no-ops.
   */
  readonly autoPromoteClicks: number;
  /** Cold window in days. Clicks older than this don't count toward eligibility. */
  readonly coldWindowDays: number;
}

/** Input to the auto-promote check. */
export interface AutoPromoteInput {
  readonly approvalStatus: SuggestionApprovalStatus;
  /** Distinct-user clicks before the current click landed. */
  readonly priorDistinctUserClicks: number;
  /** Distinct-user clicks after the current click landed. */
  readonly nextDistinctUserClicks: number;
  /**
   * Earliest distinct-user click timestamp within the cold window. Used
   * to enforce the window: if the oldest contributing click is older
   * than the window, this suggestion aged out and should not auto-promote.
   * Pass `null` when no prior click history exists (no-op — promotion
   * still fires if `nextDistinctUserClicks >= threshold`).
   */
  readonly oldestDistinctClickAt: Date | null;
}

export type AutoPromoteReason =
  | "below_threshold"
  | "already_promoted"
  | "already_reviewed"
  | "outside_window";

export type AutoPromoteDecision =
  | { readonly promoted: true }
  | { readonly promoted: false; readonly reason: AutoPromoteReason };

/**
 * Decide whether this click crossed the auto-promote threshold.
 *
 * Returns `{ promoted: true }` only on the **exact** transition from
 * below-threshold to at/above-threshold. Subsequent calls with a prior
 * count already >= threshold return `{ promoted: false, reason: "already_promoted" }`
 * — the "no duplicate promotion" invariant.
 *
 * A row whose `approval_status` is already `approved` or `hidden` cannot
 * be auto-promoted back to `pending` — that would re-surface content the
 * admin already reviewed.
 *
 * The `oldestDistinctClickAt` input guards against stale activity: if
 * the oldest contributing click is outside the cold window, the cluster
 * of engagement has aged out and should not trigger promotion.
 */
export function checkAutoPromote(
  input: AutoPromoteInput,
  config: AutoPromoteConfig,
  now: Date,
): AutoPromoteDecision {
  if (input.approvalStatus !== "pending") {
    return { promoted: false, reason: "already_reviewed" };
  }

  const threshold = config.autoPromoteClicks;

  if (input.priorDistinctUserClicks >= threshold) {
    return { promoted: false, reason: "already_promoted" };
  }

  if (input.nextDistinctUserClicks < threshold) {
    return { promoted: false, reason: "below_threshold" };
  }

  if (input.oldestDistinctClickAt !== null) {
    const windowMs = config.coldWindowDays * 24 * 60 * 60 * 1000;
    const ageMs = now.getTime() - input.oldestDistinctClickAt.getTime();
    if (ageMs > windowMs) {
      return { promoted: false, reason: "outside_window" };
    }
  }

  return { promoted: true };
}

// ---------------------------------------------------------------------------
// Defaults — shared between config schema (Zod defaults) and the queue route
// (fallback when config has not loaded). Keeping them in one place prevents
// the two sites from drifting.
// ---------------------------------------------------------------------------

/** Default distinct-user click threshold for auto-promotion. */
export const DEFAULT_AUTO_PROMOTE_CLICKS = 3;

/** Default cold window in days for eligibility and the resolver library tier. */
export const DEFAULT_COLD_WINDOW_DAYS = 90;
