import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface TourStore {
  /** Persisted: has the user completed (or skipped) the tour previously? */
  completed: boolean;
  /** Whether the overlay is rendering right now. */
  isActive: boolean;
  /** Zero-based index into the active step list. */
  currentStep: number;
  setCompleted: (completed: boolean) => void;
  setActive: (isActive: boolean) => void;
  setStep: (currentStep: number) => void;
  reset: () => void;
}

const LEGACY_KEY = "atlas-tour-completed";

function readLegacyCompleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LEGACY_KEY) === "true";
  } catch {
    return false;
  }
}

function clearLegacyKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // intentionally ignored: best-effort migration cleanup
  }
}

export const useTourStore = create<TourStore>()(
  persist(
    (set) => ({
      completed: false,
      isActive: false,
      currentStep: 0,
      setCompleted: (completed) => set({ completed }),
      setActive: (isActive) => set({ isActive }),
      setStep: (currentStep) => set({ currentStep }),
      reset: () => set({ completed: false, isActive: true, currentStep: 0 }),
    }),
    {
      name: "atlas:tour",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ completed: s.completed }),
      // Carry the boolean from the hand-rolled key written before the
      // store existed so users who already finished the tour don't
      // see it replay after upgrade.
      onRehydrateStorage: () => (state) => {
        if (state && !state.completed && readLegacyCompleted()) {
          state.completed = true;
        }
        clearLegacyKey();
      },
    },
  ),
);
