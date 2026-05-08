import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { z } from "zod";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

const RegionsResponseSchema = z.object({
  configured: z.boolean(),
  availableRegions: z.array(z.unknown()),
});

export type SignupRegionState =
  | { status: "loading" }
  | { status: "ready"; showRegion: boolean };

interface SignupRegionStore {
  state: SignupRegionState;
  init: () => Promise<void>;
}

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export const useSignupRegionStore = create<SignupRegionStore>()(
  persist(
    (set, get) => ({
      state: { status: "loading" },
      init: async () => {
        if (get().state.status === "ready") return;
        try {
          const res = await fetch(`${getApiBase()}/api/v1/onboarding/regions`, {
            credentials: isCrossOrigin() ? "include" : "same-origin",
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const raw: unknown = await res.json();
          const data = RegionsResponseSchema.parse(raw);
          const showRegion = data.configured && data.availableRegions.length > 0;
          set({ state: { status: "ready", showRegion } });
        } catch (err) {
          // Hide the region step by default — mirrors the region page's auto-skip
          // when the API is unreachable or returns configured=false.
          console.warn(
            "[signup] region availability probe failed:",
            err instanceof Error ? err.message : String(err),
          );
          set({ state: { status: "ready", showRegion: false } });
        }
      },
    }),
    {
      name: "atlas:signup:show-region",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ state: s.state }),
    },
  ),
);
