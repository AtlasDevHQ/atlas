"use client";

import { createContext, useContext } from "react";

export interface DashboardCardEntry {
  dashboardId: string;
  cardId: string;
}

interface DashboardBridgeContextValue {
  /** Current notebook cell ID (set by the cell renderer). */
  cellId: string | null;
  /** Map of cellId → dashboard card info for cells already added to a dashboard. */
  dashboardCards: Record<string, DashboardCardEntry>;
  /** Callback to record that a cell was added to a dashboard. */
  onDashboardCardAdded: (cellId: string, entry: DashboardCardEntry) => void;
}

const DashboardBridgeContext = createContext<DashboardBridgeContextValue | null>(null);

export const DashboardBridgeProvider = DashboardBridgeContext.Provider;

/** Returns the dashboard bridge context if inside a notebook cell, or null in chat/shared views. */
export function useDashboardBridge(): DashboardBridgeContextValue | null {
  return useContext(DashboardBridgeContext);
}
