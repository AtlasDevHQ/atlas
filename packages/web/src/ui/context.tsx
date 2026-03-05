"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Duck-typed interface that matches better-auth's client shape.
 * Components like ManagedAuthCard call signIn/signUp/signOut and useSession().
 */
export interface AtlasAuthClient {
  signIn: {
    email: (opts: { email: string; password: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  signUp: {
    email: (opts: { email: string; password: string; name: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  signOut: () => Promise<unknown>;
  useSession: () => { data?: { user?: { email?: string } } | null; isPending?: boolean };
}

export interface AtlasUIConfig {
  apiUrl: string;
  isCrossOrigin: boolean;
  authClient: AtlasAuthClient;
}

const AtlasUIContext = createContext<AtlasUIConfig | null>(null);

export function useAtlasConfig(): AtlasUIConfig {
  const ctx = useContext(AtlasUIContext);
  if (!ctx) throw new Error("useAtlasConfig must be used within <AtlasUIProvider>");
  return ctx;
}

export function AtlasUIProvider({
  config,
  children,
}: {
  config: AtlasUIConfig;
  children: ReactNode;
}) {
  return (
    <AtlasUIContext.Provider value={config}>
      {children}
    </AtlasUIContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  ActionAuth — internal context for passing auth to action cards     */
/* ------------------------------------------------------------------ */

export interface ActionAuthValue {
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}

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
