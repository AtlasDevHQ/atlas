"use client";

import { useState, useEffect } from "react";
import { useAtlasContext } from "./provider";
import { AUTH_MODES, type AuthMode } from "../lib/types";

export interface UseAtlasAuthReturn {
  /** Detected auth mode from the server. `null` while loading. */
  authMode: AuthMode | null;
  /** Whether the user is authenticated (based on auth mode, API key, or session). */
  isAuthenticated: boolean;
  /** Session data for managed auth mode. */
  session: { user?: { email?: string } } | null;
  /** Whether auth state is still being resolved. */
  isPending: boolean;
  /** Sign in with email/password (managed auth). */
  login: (email: string, password: string) => Promise<{ error?: string }>;
  /** Sign up with email/password/name (managed auth). */
  signup: (email: string, password: string, name: string) => Promise<{ error?: string }>;
  /** Sign out (managed auth). */
  logout: () => Promise<void>;
}

export function useAtlasAuth(): UseAtlasAuthReturn {
  const { apiUrl, apiKey, authClient, isCrossOrigin } = useAtlasContext();
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const managedSession = authClient.useSession();

  useEffect(() => {
    let cancelled = false;

    async function fetchHealth(attempt: number): Promise<void> {
      try {
        const res = await fetch(`${apiUrl}/api/health`, {
          credentials: isCrossOrigin ? "include" : "same-origin",
        });
        if (!res.ok) {
          if (attempt < 2 && !cancelled) {
            await new Promise((r) => setTimeout(r, 2000));
            return fetchHealth(attempt + 1);
          }
          if (!cancelled) setAuthMode("none");
          return;
        }
        const data = await res.json();
        const mode = data?.checks?.auth?.mode;
        if (!cancelled) {
          if (typeof mode === "string" && AUTH_MODES.includes(mode as AuthMode)) {
            setAuthMode(mode as AuthMode);
          } else {
            setAuthMode("none");
          }
        }
      } catch {
        if (attempt < 2 && !cancelled) {
          await new Promise((r) => setTimeout(r, 2000));
          return fetchHealth(attempt + 1);
        }
        if (!cancelled) setAuthMode("none");
      }
    }

    fetchHealth(1);
    return () => { cancelled = true; };
  }, [apiUrl, isCrossOrigin]);

  const isAuthenticated = (() => {
    if (authMode === null) return false;
    if (authMode === "none") return true;
    if (authMode === "simple-key" || authMode === "byot") return !!apiKey;
    if (authMode === "managed") return !!managedSession.data?.user;
    return false;
  })();

  const login = async (email: string, password: string) => {
    const result = await authClient.signIn.email({ email, password });
    return { error: result.error?.message };
  };

  const signup = async (email: string, password: string, name: string) => {
    const result = await authClient.signUp.email({ email, password, name });
    return { error: result.error?.message };
  };

  const logout = async () => {
    await authClient.signOut();
  };

  return {
    authMode,
    isAuthenticated,
    session: managedSession.data ?? null,
    isPending: authMode === null || (authMode === "managed" && !!managedSession.isPending),
    login,
    signup,
    logout,
  };
}
