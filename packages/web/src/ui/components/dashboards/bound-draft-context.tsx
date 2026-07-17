"use client";

/**
 * Bound-draft context (#4555, ADR-0034 Decision 2) — bridge between the
 * dashboard view + chat drawer and the deeply-nested `<DraftEditUndoCard>`
 * rendered inside a tool part.
 *
 * The bound editor's destructive ops (removeCard / updateCardSql) now land
 * directly in the caller's draft and surface a one-click Undo. That undo card
 * is rendered several React layers down inside a chat tool part, so rather than
 * thread the `dashboardId` + a refetch callback through every layer, the
 * provider sets them once at the drawer / page level and the card reads them.
 *
 * (Replaces the retired `stage-context.tsx` — the staging accept/discard model
 * it served is gone; the draft is the single edit mechanism.)
 */

import { createContext, useContext } from "react";

export interface BoundDraftContextValue {
  dashboardId: string;
  /**
   * Called after a destructive edit is undone — the dashboard view re-fetches
   * its draft cards so the canvas reflects the restored state.
   */
  onDraftChanged: () => void;
  /**
   * #4322 — the History tab renders past bound sessions read-only. A destructive
   * edit replayed in a finished session is inert history, not a live decision:
   * `DraftEditUndoCard` drops its Undo affordance and shows a static receipt when
   * this is set. Defaults to false (the live drawer + dashboard page).
   */
  readOnly?: boolean;
}

const BoundDraftContext = createContext<BoundDraftContextValue | null>(null);

export function BoundDraftProvider({
  value,
  children,
}: {
  value: BoundDraftContextValue;
  children: React.ReactNode;
}) {
  return <BoundDraftContext.Provider value={value}>{children}</BoundDraftContext.Provider>;
}

export function useBoundDraftContext(): BoundDraftContextValue {
  const ctx = useContext(BoundDraftContext);
  if (!ctx) {
    // Surfacing a clear error message during dev is friendlier than the
    // generic "read undefined" trace from `null.dashboardId`.
    throw new Error(
      "useBoundDraftContext() must be called inside <BoundDraftProvider>. Draft-edit undo cards only render inside the bound dashboard drawer.",
    );
  }
  return ctx;
}
