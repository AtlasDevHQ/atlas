"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { useAtlasConfig } from "@/ui/context";
import { extractFetchError, type FetchError } from "@/ui/lib/fetch-error";

// Re-export from @/ui/lib/fetch-error (canonical location) for backward
// compatibility. New code should import directly from @/ui/lib/fetch-error.
export { type FetchError, friendlyError } from "@/ui/lib/fetch-error";

/**
 * Shared fetch hook for admin pages.
 * Delegates to TanStack Query's `useQuery` for automatic deduplication,
 * stale-while-revalidate, window-focus refetch, and garbage collection.
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

  // Manual error override — exposed via setError for backward compatibility.
  const [errorOverride, setErrorOverride] = useState<FetchError | null>(null);

  const query = useQuery<T, FetchError>({
    queryKey: ["admin-fetch", path, ...(opts?.deps ?? [])],
    queryFn: async ({ signal }) => {
      // Clear any manual error override when a real fetch starts.
      setErrorOverride(null);

      const res = await fetch(`${apiUrl}${path}`, { credentials, signal });
      if (!res.ok) {
        throw await extractFetchError(res);
      }
      const json: unknown = await res.json();

      if (opts?.schema) {
        const parsed = opts.schema.safeParse(json);
        if (!parsed.success) {
          console.warn(`useAdminFetch schema validation failed for ${path}:`, parsed.error.issues);
          const err: FetchError = {
            message: `Unexpected response format from ${path}. Try refreshing the page.`,
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
    // When there's an error (including failed refetch), return null instead of stale data.
    data: error ? null : (query.data ?? null),
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
