"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AtlasAuthClient } from "../context";

export type { AtlasAuthClient };

export interface AtlasProviderProps {
  /** Atlas API server URL (e.g. "https://api.example.com" or "" for same-origin). */
  apiUrl: string;
  /** API key for simple-key auth mode. Sent as Bearer token. Accessible in context by all hooks. */
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

/** No-op auth client for non-managed auth modes. Warns when auth operations are attempted. */
const noopAuthClient: AtlasAuthClient = {
  signIn: {
    email: async () => {
      console.warn("[Atlas] signIn called but no authClient was provided to AtlasProvider");
      return { error: { message: "Auth client not configured" } };
    },
  },
  signUp: {
    email: async () => {
      console.warn("[Atlas] signUp called but no authClient was provided to AtlasProvider");
      return { error: { message: "Auth client not configured" } };
    },
  },
  signOut: async () => {
    console.warn("[Atlas] signOut called but no authClient was provided to AtlasProvider");
  },
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
 * better-auth client to all Atlas hooks. Derives isCrossOrigin from apiUrl
 * to configure credential handling for cross-origin requests.
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
