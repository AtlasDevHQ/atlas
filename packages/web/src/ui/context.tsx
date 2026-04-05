"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AtlasAuthClient, ActionAuthValue } from "@useatlas/types";

export type { AtlasAuthClient, ActionAuthValue } from "@useatlas/types";

export interface AtlasConfig {
  apiUrl: string;
  isCrossOrigin: boolean;
  authClient: AtlasAuthClient;
}

const AtlasContext = createContext<AtlasConfig | null>(null);

export function useAtlasConfig(): AtlasConfig {
  const ctx = useContext(AtlasContext);
  if (!ctx) throw new Error("useAtlasConfig must be used within <AtlasProvider>");
  return ctx;
}

export function AtlasProvider({
  config,
  children,
}: {
  config: AtlasConfig;
  children: ReactNode;
}) {
  return (
    <AtlasContext.Provider value={config}>
      {children}
    </AtlasContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  ActionAuth — internal context for passing auth to action cards     */
/* ------------------------------------------------------------------ */

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
