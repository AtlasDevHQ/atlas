"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AtlasAuthClient } from "../context";

export type { AtlasAuthClient };

export interface AtlasProviderProps {
  /** Atlas API server URL (e.g. "https://api.example.com" or "" for same-origin). */
  apiUrl: string;
  /** API key for simple-key auth mode. Sent as Bearer token. */
  apiKey?: string;
  /** Custom auth client for managed auth mode (better-auth compatible). */
  authClient?: AtlasAuthClient;
  children: ReactNode;
}

export interface AtlasContextValue {
  apiUrl: string;
  apiKey: string | undefined;
  authClient: AtlasAuthClient;
  isCrossOrigin: boolean;
}

/** No-op auth client for non-managed auth modes. */
const noopAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({ error: { message: "Not supported" } }) },
  signUp: { email: async () => ({ error: { message: "Not supported" } }) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const AtlasContext = createContext<AtlasContextValue | null>(null);

/** Access the AtlasProvider context. Throws if used outside <AtlasProvider>. */
export function useAtlasContext(): AtlasContextValue {
  const ctx = useContext(AtlasContext);
  if (!ctx) throw new Error("useAtlasContext must be used within <AtlasProvider>");
  return ctx;
}

/**
 * Lightweight provider for headless Atlas hooks.
 *
 * Wraps your app and supplies API URL, auth credentials, and an optional
 * better-auth client to all Atlas hooks.
 */
export function AtlasProvider({
  apiUrl,
  apiKey,
  authClient = noopAuthClient,
  children,
}: AtlasProviderProps) {
  const isCrossOrigin =
    typeof window !== "undefined" &&
    apiUrl !== "" &&
    !apiUrl.startsWith(window.location.origin);

  return (
    <AtlasContext.Provider value={{ apiUrl, apiKey, authClient, isCrossOrigin }}>
      {children}
    </AtlasContext.Provider>
  );
}
