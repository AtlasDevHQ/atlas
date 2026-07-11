"use client";

import { createContext, useContext } from "react";

export interface DashboardCardEntry {
  dashboardId: string;
  cardId: string;
}

interface DashboardBridgeContextValue {
  /** The result's owning cell/message ID (set by the renderer that provides the bridge). */
  cellId: string | null;
  /** Map of cellId → dashboard card info for results already added to a dashboard. */
  dashboardCards: Record<string, DashboardCardEntry>;
  /** Callback to record that a result was added to a dashboard. */
  onDashboardCardAdded: (cellId: string, entry: DashboardCardEntry) => void;
}

const DashboardBridgeContext = createContext<DashboardBridgeContextValue | null>(null);

export const DashboardBridgeProvider = DashboardBridgeContext.Provider;

/**
 * Returns the dashboard bridge context when a surface provides it, or `null`
 * otherwise. The chat transcript renders SQL result cards without a provider,
 * so this returns `null` there — the add-to-dashboard dialog still works; only
 * the "already on a dashboard" tracking is inert. (The notebook surface, which
 * used to supply this provider, was retired — ADR-0035, #4587.)
 */
export function useDashboardBridge(): DashboardBridgeContextValue | null {
  return useContext(DashboardBridgeContext);
}
