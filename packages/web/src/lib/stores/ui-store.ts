import { create } from "zustand";

interface UiState {
  mobileSidebarOpen: boolean;
  schemaExplorerOpen: boolean;
  promptLibraryOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
  setSchemaExplorerOpen: (open: boolean) => void;
  setPromptLibraryOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  mobileSidebarOpen: false,
  schemaExplorerOpen: false,
  promptLibraryOpen: false,
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  setSchemaExplorerOpen: (open) => set({ schemaExplorerOpen: open }),
  setPromptLibraryOpen: (open) => set({ promptLibraryOpen: open }),
}));
