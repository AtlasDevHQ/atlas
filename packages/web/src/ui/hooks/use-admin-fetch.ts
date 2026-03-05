"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAtlasConfig } from "@/ui/context";

export interface FetchError {
  message: string;
  status?: number;
}

/** Map HTTP status codes to user-friendly messages for admin pages. */
export function friendlyError(err: FetchError): string {
  if (err.status === 401) return "Not authenticated. Please sign in.";
  if (err.status === 403)
    return "Access denied. Admin role required to view this page.";
  if (err.status === 404) return "This feature is not enabled on this server.";
  return err.message;
}

/**
 * Shared fetch hook for admin pages.
 * Handles loading/error state, cancellation on unmount, and credentials.
 */
export function useAdminFetch<T>(
  path: string,
  opts?: {
    deps?: unknown[];
    transform?: (json: unknown) => T;
  },
) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        credentials: credentialsRef.current,
        signal,
      });
      if (!res.ok) {
        const e: FetchError = { message: `HTTP ${res.status}`, status: res.status };
        if (!signal?.aborted) setError(e);
        return;
      }
      const json = await res.json();
      const result = opts?.transform ? opts.transform(json) : (json as T);
      if (!signal?.aborted) setData(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!signal?.aborted) {
        setError({
          message: err instanceof Error ? err.message : "Request failed",
        });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiUrl, path, ...(opts?.deps ?? [])]);

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, setError, refetch };
}

/**
 * Returns `{ has, start, stop }` for tracking in-progress mutations by ID.
 */
export function useInProgressSet() {
  const [set, setSet] = useState<Set<string>>(new Set());
  return {
    has: (id: string) => set.has(id),
    start: (id: string) => setSet((prev) => new Set(prev).add(id)),
    stop: (id: string) =>
      setSet((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
  };
}

/**
 * Returns fetch options with correct credentials for admin API calls.
 */
export function useAdminFetchOpts() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  return { apiUrl, fetchOpts: { credentials } as RequestInit };
}
