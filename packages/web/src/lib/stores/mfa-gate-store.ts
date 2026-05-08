import { create } from "zustand";

interface MfaGateState {
  enrollmentUrl: string;
}

interface MfaGateStore {
  state: MfaGateState | null;
  setState: (state: MfaGateState | null) => void;
  clear: () => void;
}

export const useMfaGateStore = create<MfaGateStore>()((set) => ({
  state: null,
  setState: (state) => set({ state }),
  clear: () => set({ state: null }),
}));
