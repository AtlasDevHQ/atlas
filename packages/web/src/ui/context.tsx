"use client";

import { createContext, useContext, useMemo, useCallback, type ReactNode } from "react";
import type { AtlasAuthClient, ActionAuthValue } from "@useatlas/types";

export type { AtlasAuthClient, ActionAuthValue } from "@useatlas/types";

export interface AtlasConfig {
  apiUrl: string;
  isCrossOrigin: boolean;
  authClient: AtlasAuthClient;
}

interface AtlasContextValue extends AtlasConfig {
  /** Auth helpers for action API calls (derived from config). */
  actionAuth: ActionAuthValue;
}

const AtlasContext = createContext<AtlasContextValue | null>(null);

export function useAtlasConfig(): AtlasConfig {
  const ctx = useContext(AtlasContext);
  if (!ctx) throw new Error("useAtlasConfig must be used within <AtlasProvider>");
  return ctx;
}

/** Returns auth helpers for action API calls. */
export function useActionAuth(): ActionAuthValue | null {
  const ctx = useContext(AtlasContext);
  return ctx?.actionAuth ?? null;
}

export function AtlasProvider({
  config,
  children,
}: {
  config: AtlasConfig;
  children: ReactNode;
}) {
  const getHeaders = useCallback((): Record<string, string> => ({}), []);
  const getCredentials = useCallback(
    (): "include" | "omit" | "same-origin" =>
      config.isCrossOrigin ? "include" : "same-origin",
    [config.isCrossOrigin],
  );

  const value = useMemo<AtlasContextValue>(
    () => ({
      ...config,
      actionAuth: { getHeaders, getCredentials },
    }),
    [config, getHeaders, getCredentials],
  );

  return (
    <AtlasContext.Provider value={value}>
      {children}
    </AtlasContext.Provider>
  );
}
