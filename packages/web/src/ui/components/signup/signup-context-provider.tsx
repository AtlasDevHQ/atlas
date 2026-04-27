"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { z } from "zod";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

const RegionsResponseSchema = z.object({
  configured: z.boolean(),
  availableRegions: z.array(z.unknown()),
});

export type SignupContextState =
  | { status: "loading" }
  | { status: "ready"; showRegion: boolean };

const Context = createContext<SignupContextState>({ status: "loading" });

const CACHE_KEY = "atlas:signup:show-region";

function readCache(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    // sessionStorage can throw in private browsing or sandboxed contexts;
    // fall through to a re-fetch.
    return null;
  }
}

function writeCache(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CACHE_KEY, value ? "true" : "false");
  } catch {
    // Best-effort cache; ignore quota / privacy errors.
  }
}

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return isCrossOrigin() ? "include" : "same-origin";
}

/**
 * Renders once per signup session at the layout level so the residency probe
 * fires a single time — every route then reads the same value via context and
 * the step indicator never reflows between pages. The result is cached in
 * sessionStorage so even a hard reload mid-flow stays consistent.
 */
export function SignupContextProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SignupContextState>(() => {
    const cached = readCache();
    return cached === null ? { status: "loading" } : { status: "ready", showRegion: cached };
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBase()}/api/v1/onboarding/regions`, { credentials: getCredentials() })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((raw) => RegionsResponseSchema.parse(raw))
      .then((data) => {
        if (cancelled) return;
        const showRegion = data.configured && data.availableRegions.length > 0;
        writeCache(showRegion);
        setState({ status: "ready", showRegion });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Hide the region step by default — mirrors the region page's auto-skip
        // when the API is unreachable or returns configured=false.
        console.warn(
          "[signup] region availability probe failed:",
          err instanceof Error ? err.message : String(err),
        );
        setState({ status: "ready", showRegion: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <Context.Provider value={state}>{children}</Context.Provider>;
}

/**
 * Read the layout-provided signup context. Returns a discriminated union so
 * callers must acknowledge the loading state before reading `showRegion`.
 */
export function useSignupContext(): SignupContextState {
  return useContext(Context);
}
