"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { z } from "zod";
import { useAtlasConfig } from "@/ui/context";
import { extractFetchError, type FetchError } from "@/ui/lib/fetch-error";

// Re-export from @/ui/lib/fetch-error (canonical location) for backward
// compatibility. New code should import directly from @/ui/lib/fetch-error.
export { type FetchError, friendlyError } from "@/ui/lib/fetch-error";

/**
 * Shared fetch hook for admin pages.
 * Handles loading/error state, structured error body extraction (message + requestId),
 * cancellation on unmount, and credentials.
 *
 * Prefer `schema` (Zod) for runtime validation over `transform`.
 * `schema` and `transform` are mutually exclusive — if both provided, `schema` wins.
 */
export function useAdminFetch<T>(
  path: string,
  opts?: {
    deps?: unknown[];
    transform?: (json: unknown) => T;
    schema?: z.ZodType<T>;
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
        const e = await extractFetchError(res);
        if (!signal?.aborted) setError(e);
        return;
      }
      const json: unknown = await res.json();
      let result: T;
      if (opts?.schema) {
        const parsed = opts.schema.safeParse(json);
        if (!parsed.success) {
          if (!signal?.aborted) {
            const msg = `Invalid API response for ${path}: ${parsed.error.message}`;
            console.warn(msg);
            setError({ message: msg });
          }
          return;
        }
        result = parsed.data as T;
      } else if (opts?.transform) {
        result = opts.transform(json);
      } else {
        result = json as T;
      }
      if (!signal?.aborted) setData(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!signal?.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`useAdminFetch ${path}:`, msg);
        setError({ message: msg || "Request failed" });
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
