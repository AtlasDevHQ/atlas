import { create } from "zustand";

interface UiState {
  commandMenuOpen: boolean;
  setCommandMenuOpen: (open: boolean) => void;
  toggleCommandMenu: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  commandMenuOpen: false,
  setCommandMenuOpen: (open) => set({ commandMenuOpen: open }),
  toggleCommandMenu: () => set((s) => ({ commandMenuOpen: !s.commandMenuOpen })),
}));
