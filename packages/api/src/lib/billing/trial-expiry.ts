/**
 * Effective trial expiry — the single date the UI and trial emails render.
 *
 * Enforcement (`enforcement.ts` → `isTrialExpired`) cuts a trial workspace
 * off at `trial_ends_at`, falling back to `createdAt + TRIAL_DAYS` when
 * `trial_ends_at` is NULL (pre-backfill workspaces, #3434). The web banner
 * and billing page previously required `trial_ends_at` to be set, so a
 * NULL-trial_ends_at workspace was silently cut off on day 14 with no
 * countdown ever shown.
 *
 * This helper is the shared statement of that fallback. The API computes
 * `plan.trialEndsAtEffective` from it so the frontend never re-derives the
 * rule. The arithmetic deliberately mirrors `isTrialExpired` in
 * enforcement.ts (which is intentionally left untouched — parallel work
 * owns that file; the duplication is pinned by trial-expiry.test.ts).
 */

import { TRIAL_DAYS } from "./plans";

const MS_PER_DAY = 86_400_000;

/** The fields of `WorkspaceRow` the expiry computation reads. */
export interface TrialExpiryInput {
  trial_ends_at: string | Date | null;
  createdAt: string | Date;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * The date enforcement will treat as the end of the trial:
 * `trial_ends_at` when set and parseable, else `createdAt + TRIAL_DAYS`.
 * Returns null only when neither input parses — enforcement treats that
 * case as "not expired" (NaN comparisons are false), and callers should
 * render nothing rather than a bogus date.
 */
export function effectiveTrialEndsAt(workspace: TrialExpiryInput): Date | null {
  if (workspace.trial_ends_at !== null) {
    const endMs = toMs(workspace.trial_ends_at);
    if (Number.isFinite(endMs)) return new Date(endMs);
  }
  const createdMs = toMs(workspace.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return new Date(createdMs + TRIAL_DAYS * MS_PER_DAY);
}

/**
 * Whether the trial is expired at `now` given its effective end. A null
 * effective end is "not expired" — the same answer enforcement's NaN date
 * comparison produces.
 */
export function isTrialExpiredAt(effectiveEnd: Date | null, now: Date = new Date()): boolean {
  if (effectiveEnd === null) return false;
  return effectiveEnd.getTime() < now.getTime();
}
