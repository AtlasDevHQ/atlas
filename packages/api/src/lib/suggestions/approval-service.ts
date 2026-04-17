/**
 * SuggestionApprovalService — click-threshold auto-promotion.
 *
 * The `query_suggestions` table holds two orthogonal state axes (see
 * migration 0029 and the admin queue page for the full explainer):
 *
 *   approval_status : pending | approved | hidden    (moderation lifecycle)
 *   status          : draft   | published | archived (1.2.0 mode lifecycle)
 *
 * A row defaults to `approval_status = 'pending'` / `status = 'draft'`.
 * This slice (#1476) owns the **auto-promote** decision: when the count
 * of distinct users who clicked a pending suggestion crosses the
 * configured threshold within the cold window, the entry becomes
 * eligible for the admin queue. Approve/hide mutations land in slice
 * #1477.
 *
 * The decision is expressed as a pure function so tests can cover the
 * threshold arithmetic, window boundary, and no-duplicate-promote
 * invariant without touching the database.
 */

export type ApprovalStatus = "pending" | "approved" | "hidden";
export type SuggestionStatus = "draft" | "published" | "archived";

/** Config driving the auto-promote decision. */
export interface AutoPromoteConfig {
  /** Distinct-user click threshold. When prior < threshold <= next, promotion fires. */
  readonly autoPromoteClicks: number;
  /** Cold window in days. Clicks older than this don't count toward eligibility. */
  readonly coldWindowDays: number;
}

/** Input to the auto-promote check. */
export interface AutoPromoteInput {
  readonly approvalStatus: ApprovalStatus;
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
