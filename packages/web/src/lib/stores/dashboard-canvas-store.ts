import { create } from "zustand";
import type { ChartType } from "@useatlas/types";

export interface ProposedCard {
  title: string;
  sql: string;
  chartConfig: { type: ChartType; categoryColumn: string; valueColumns: string[] };
  layout?: { x: number; y: number; w: number; h: number };
}

export interface ProposedDashboardSpec {
  title: string;
  description?: string;
  cards: ProposedCard[];
}

interface CanvasState {
  open: boolean;
  spec: ProposedDashboardSpec | null;
  /** Bump whenever the agent re-emits, so subscribers re-execute even if the spec is structurally equal. */
  version: number;
  setSpec: (spec: ProposedDashboardSpec) => void;
  close: () => void;
}

export const useDashboardCanvasStore = create<CanvasState>()((set) => ({
  open: false,
  spec: null,
  version: 0,
  setSpec: (spec) => set((s) => ({ open: true, spec, version: s.version + 1 })),
  close: () => set({ open: false }),
}));
