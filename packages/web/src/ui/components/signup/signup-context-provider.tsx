"use client";

import { useEffect } from "react";
import { useSignupRegionStore } from "@/lib/stores/signup-region-store";

export type { SignupRegionState as SignupContextState } from "@/lib/stores/signup-region-store";

/**
 * Renders once per signup session at the layout level so the residency probe
 * fires a single time — every route then reads the same value via the store
 * and the step indicator never reflows between pages. The result is cached in
 * sessionStorage (via zustand persist) so a hard reload mid-flow stays
 * consistent.
 */
export function SignupContextProvider({ children }: { children: React.ReactNode }) {
  const init = useSignupRegionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  return <>{children}</>;
}

export function useSignupContext() {
  return useSignupRegionStore((s) => s.state);
}
