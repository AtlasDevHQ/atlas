"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AtlasAuthClient, ActionAuthValue } from "@useatlas/types";

export type { AtlasAuthClient, ActionAuthValue } from "@useatlas/types";

/** No-op auth client for non-managed auth modes. Warns when auth operations are attempted. */
export const noopAuthClient: AtlasAuthClient = {
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

// ── Main Atlas context ─────────────────────────────────────────────

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

const AtlasContext = createContext<AtlasContextValue | null>(null);

/**
 * Access the Atlas context. Throws if used outside `<AtlasProvider>` or `<AtlasChat>`.
 *
 * Provides: `apiUrl`, `apiKey`, `authClient`, `isCrossOrigin`.
 */
export function useAtlasContext(): AtlasContextValue {
  const ctx = useContext(AtlasContext);
  if (!ctx) throw new Error("useAtlasContext must be used within <AtlasProvider>");
  return ctx;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: true,
        gcTime: 5 * 60 * 1000,
      },
    },
  });
}

/**
 * Atlas context provider. Wraps your app and supplies API URL, auth credentials,
 * and an optional better-auth client to all Atlas hooks and components.
 *
 * Includes its own `QueryClientProvider` for TanStack Query.
 */
export function AtlasProvider({
  apiUrl,
  apiKey,
  authClient = noopAuthClient,
  children,
}: AtlasProviderProps) {
  const [queryClient] = useState(makeQueryClient);
  const isCrossOrigin =
    typeof window !== "undefined" &&
    apiUrl !== "" &&
    !apiUrl.startsWith(window.location.origin);

  return (
    <QueryClientProvider client={queryClient}>
      <AtlasContext.Provider value={{ apiUrl, apiKey, authClient, isCrossOrigin }}>
        {children}
      </AtlasContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * @internal Used by `AtlasChat` to provide the context directly (it manages its own QueryClient).
 */
export { AtlasContext };

// ── ActionAuth — internal context for passing auth to action cards ──

const ActionAuthContext = createContext<ActionAuthValue | null>(null);

/** Returns auth helpers for action API calls, or null when no provider is present. */
export function useActionAuth(): ActionAuthValue | null {
  return useContext(ActionAuthContext);
}

export function ActionAuthProvider({
  getHeaders,
  getCredentials,
  children,
}: ActionAuthValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ getHeaders, getCredentials }),
    [getHeaders, getCredentials],
  );
  return (
    <ActionAuthContext.Provider value={value}>
      {children}
    </ActionAuthContext.Provider>
  );
}
