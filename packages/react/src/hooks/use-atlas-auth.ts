"use client";

import { useQuery } from "@tanstack/react-query";
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

interface HealthData {
  authMode: AuthMode;
  brandColor?: string;
}

export function useAtlasAuth(): UseAtlasAuthReturn {
  const { apiUrl, apiKey, authClient, isCrossOrigin } = useAtlasContext();
  const managedSession = authClient.useSession();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Health check via TanStack Query — shared cache with AtlasChatInner.
  const healthQuery = useQuery<HealthData>({
    queryKey: ["atlas", "health"],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/health`, { credentials, signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[Atlas] Health check failed:", msg);
        throw new Error(`Health check failed: ${msg}`, { cause: err });
      }

      if (!res.ok) {
        console.warn(`[Atlas] Health check returned HTTP ${res.status}`);
        throw new Error(`Health check failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      const mode = data?.checks?.auth?.mode;
      if (typeof mode === "string" && AUTH_MODES.includes(mode as AuthMode)) {
        return { authMode: mode as AuthMode, brandColor: data?.brandColor };
      }
      console.warn("[Atlas] Health check returned no valid auth mode:", data);
      return { authMode: "none" as AuthMode };
    },
    // Match original retry behavior: 3 total attempts, 2s delay
    retry: 2,
    retryDelay: 2000,
  });

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
