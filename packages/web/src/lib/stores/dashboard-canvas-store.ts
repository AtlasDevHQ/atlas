import { create } from "zustand";
import type { ProposedDashboardSpec } from "@useatlas/types";

export type { ProposedDashboardSpec, ProposedCard } from "@useatlas/types";

type CanvasView =
  | { kind: "closed" }
  | { kind: "open"; spec: ProposedDashboardSpec; version: number };

interface CanvasState {
  view: CanvasView;
  setSpec: (spec: ProposedDashboardSpec) => void;
  close: () => void;
}

export const useDashboardCanvasStore = create<CanvasState>()((set) => ({
  view: { kind: "closed" },
  setSpec: (spec) =>
    set((s) => ({
      view: {
        kind: "open",
        spec,
        version: s.view.kind === "open" ? s.view.version + 1 : 1,
      },
    })),
  close: () => set({ view: { kind: "closed" } }),
}));
