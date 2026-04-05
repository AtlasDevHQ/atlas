"use client";

import { useAtlasContext } from "../context";
import { useHealthQuery } from "./use-health-query";
import type { AuthMode } from "../lib/types";

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
  const { apiKey, authClient } = useAtlasContext();
  const managedSession = authClient.useSession();

  // Shared health query — deduped with AtlasChatInner via ["atlas", "health"] key.
  const healthQuery = useHealthQuery();

  const authMode = healthQuery.data?.authMode ?? null;
  const error = healthQuery.error instanceof Error ? healthQuery.error : null;

  // If health check failed after all retries, fall back to "none"
  const effectiveAuthMode = healthQuery.isError ? ("none" as AuthMode) : authMode;

  const isAuthenticated = (() => {
    if (effectiveAuthMode === null) return false;
    if (effectiveAuthMode === "none") return true;
    if (effectiveAuthMode === "simple-key" || effectiveAuthMode === "byot") return !!apiKey;
    if (effectiveAuthMode === "managed") return !!managedSession.data?.user;
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
    authMode: effectiveAuthMode,
    isAuthenticated,
    session: managedSession.data ?? null,
    isLoading: effectiveAuthMode === null || (effectiveAuthMode === "managed" && !!managedSession.isPending),
    error,
    login,
    signup,
    logout,
  };
}
