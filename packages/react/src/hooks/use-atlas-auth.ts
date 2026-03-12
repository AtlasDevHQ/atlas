"use client";

import { useState, useEffect } from "react";
import { useAtlasContext } from "./provider";
import { AUTH_MODES, type AuthMode } from "../lib/types";

export interface UseAtlasAuthReturn {
  /** Auth mode detected from the server's /api/health endpoint. `null` while the initial health check is in flight. */
  authMode: AuthMode | null;
  /** Whether the user is authenticated (based on auth mode, API key, or session). */
  isAuthenticated: boolean;
  /** Session data for managed auth mode. */
  session: { user?: { email?: string } } | null;
  /** Whether auth state is still being resolved (health check or managed session loading). */
  isLoading: boolean;
  /** Error from health check or auth operations. `null` when healthy. */
  error: Error | null;
  /** Sign in with email/password (managed auth). */
  login: (email: string, password: string) => Promise<{ error?: string }>;
  /** Sign up with email/password/name (managed auth). */
  signup: (email: string, password: string, name: string) => Promise<{ error?: string }>;
  /** Sign out (managed auth). */
  logout: () => Promise<{ error?: string }>;
}

export function useAtlasAuth(): UseAtlasAuthReturn {
  const { apiUrl, apiKey, authClient, isCrossOrigin } = useAtlasContext();
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const managedSession = authClient.useSession();

  useEffect(() => {
    let cancelled = false;

    async function fetchHealth(attempt: number): Promise<void> {
      try {
        const res = await fetch(`${apiUrl}/api/health`, {
          credentials: isCrossOrigin ? "include" : "same-origin",
        });
        if (!res.ok) {
          console.warn(`[Atlas] Health check returned HTTP ${res.status} (attempt ${attempt})`);
          if (attempt < 2 && !cancelled) {
            await new Promise((r) => setTimeout(r, 2000));
            return fetchHealth(attempt + 1);
          }
          if (!cancelled) {
            setError(new Error(`Health check failed with HTTP ${res.status}`));
            setAuthMode("none");
          }
          return;
        }
        const data = await res.json();
        const mode = data?.checks?.auth?.mode;
        if (!cancelled) {
          if (typeof mode === "string" && AUTH_MODES.includes(mode as AuthMode)) {
            setAuthMode(mode as AuthMode);
          } else {
            console.warn("[Atlas] Health check returned no valid auth mode:", data);
            setAuthMode("none");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Atlas] Health check failed (attempt ${attempt}):`, message);
        if (attempt < 2 && !cancelled) {
          await new Promise((r) => setTimeout(r, 2000));
          return fetchHealth(attempt + 1);
        }
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(message));
          setAuthMode("none");
        }
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
    try {
      const result = await authClient.signIn.email({ email, password });
      return { error: result.error?.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      console.warn("[Atlas] login error:", message);
      return { error: message };
    }
  };

  const signup = async (email: string, password: string, name: string) => {
    try {
      const result = await authClient.signUp.email({ email, password, name });
      return { error: result.error?.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Signup failed";
      console.warn("[Atlas] signup error:", message);
      return { error: message };
    }
  };

  const logout = async () => {
    try {
      await authClient.signOut();
      return {};
    } catch (err) {
      const message = err instanceof Error ? err.message : "Logout failed";
      console.warn("[Atlas] logout error:", message);
      return { error: message };
    }
  };

  return {
    authMode,
    isAuthenticated,
    session: managedSession.data ?? null,
    isLoading: authMode === null || (authMode === "managed" && !!managedSession.isPending),
    error,
    login,
    signup,
    logout,
  };
}
