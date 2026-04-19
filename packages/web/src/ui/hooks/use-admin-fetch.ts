"use client";

import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { useAtlasConfig } from "@/ui/context";
import { extractFetchError, type FetchError } from "@/ui/lib/fetch-error";
import { ADMIN_FETCH_QUERY_KEY } from "@/ui/hooks/admin-query-keys";

// Re-export from @/ui/lib/fetch-error (canonical location) for backward
// compatibility. New code should import directly from @/ui/lib/fetch-error.
export { type FetchError, friendlyError } from "@/ui/lib/fetch-error";

/**
 * Shared fetch hook for admin pages.
 * Delegates to TanStack Query's `useQuery` for automatic deduplication,
 * stale-while-revalidate (30s from QueryProvider), window-focus refetch,
 * and garbage collection.
 *
 * Preserves the original return shape: `{ data, loading, error, setError, refetch }`.
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
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Ref to avoid stale closure if isCrossOrigin changes at runtime.
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;

  // Manual error override — exposed via setError for backward compatibility.
  const [errorOverride, setErrorOverride] = useState<FetchError | null>(null);

  const query = useQuery<T, FetchError>({
    queryKey: [ADMIN_FETCH_QUERY_KEY, path, ...(opts?.deps ?? [])],
    queryFn: async ({ signal }) => {
      // Clear any manual error override when a real fetch starts.
      setErrorOverride(null);

      let res: Response;
      try {
        res = await fetch(`${apiUrl}${path}`, {
          credentials: credentialsRef.current,
          signal,
        });
      } catch (err) {
        // Network failure (DNS, offline, CORS) — normalize to FetchError and log.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`useAdminFetch ${path}:`, msg);
        const fetchErr: FetchError = { message: msg || "Request failed" };
        throw fetchErr;
      }

      if (!res.ok) {
        throw await extractFetchError(res);
      }
      const json: unknown = await res.json();

      if (opts?.schema) {
        const parsed = opts.schema.safeParse(json);
        if (!parsed.success) {
          console.warn(`useAdminFetch schema validation failed for ${path}:`, parsed.error.issues);
          // `code: "schema_mismatch"` lets `friendlyError()` swap in copy
          // tailored to a server/client version drift — refreshing won't fix
          // it, so the default "try again" guidance in the bare message is
          // actively misleading.
          const err: FetchError = {
            message: `Server returned an unexpected response from ${path}. This is likely a version mismatch — contact your administrator or try again later.`,
            code: "schema_mismatch",
          };
          throw err;
        }
        return parsed.data;
      }

      if (opts?.transform) {
        return opts.transform(json);
      }

      return json as T;
    },
  });

  // Derive the return value to match the original interface exactly.
  const error = errorOverride ?? query.error ?? null;

  return {
    // Override TanStack Query's default (keep stale data on error) to match
    // the original hook contract where errors always clear data.
    data: error ? null : (query.data ?? null),
    // isPending = no cached data + fetch in flight. Unlike the old hook, this
    // is NOT true during background refetches when cached data exists.
    loading: query.isPending,
    error,
    setError: setErrorOverride,
    refetch: query.refetch,
  };
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
