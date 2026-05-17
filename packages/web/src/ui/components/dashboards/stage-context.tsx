"use client";

/**
 * Stage context (#2365) — bridge between the dashboard view + chat drawer
 * and the deeply-nested `<StageChangeCard>` rendered inside a tool part.
 *
 * Without this context, every tool-part would have to thread the
 * `dashboardId` + a refetch callback through three or four React layers.
 * The context lives in a small file with no logic — provider sets the
 * dashboard id once at the bound chat drawer / page level, consumer
 * reads it from the stage card.
 */

import { createContext, useContext } from "react";

export interface StageContextValue {
  dashboardId: string;
  /**
   * Called whenever a stage is accepted or discarded — the dashboard
   * view re-fetches both its data (the draft cards) and the pending
   * stage list so the ghost overlay updates.
   */
  onStagesChanged: () => void;
}

const StageContext = createContext<StageContextValue | null>(null);

export function StageProvider({
  value,
  children,
}: {
  value: StageContextValue;
  children: React.ReactNode;
}) {
  return <StageContext.Provider value={value}>{children}</StageContext.Provider>;
}

export function useStageContext(): StageContextValue {
  const ctx = useContext(StageContext);
  if (!ctx) {
    // Surfacing a clear error message during dev is friendlier than the
    // generic "read undefined" trace from `null.dashboardId`.
    throw new Error(
      "useStageContext() must be called inside <StageProvider>. Stage cards only render inside the bound dashboard drawer.",
    );
  }
  return ctx;
}
