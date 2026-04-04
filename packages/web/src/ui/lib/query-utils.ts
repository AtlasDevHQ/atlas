"use client";

import type { z } from "zod";
import { useAtlasConfig } from "@/ui/context";
import { extractFetchError, type FetchError } from "@/ui/lib/fetch-error";

/**
 * Options for `adminQueryFn`.
 */
interface AdminQueryFnOptions<T> {
  /** Zod schema for response validation. When provided, the parsed response is type-safe. */
  schema?: z.ZodType<T>;
  /** Transform raw JSON before returning. Ignored when `schema` is provided. */
  transform?: (json: unknown) => T;
}

/**
 * Creates a `queryFn` for use with TanStack Query's `useQuery`.
 *
 * Accepts an API path and config (`apiUrl`, `isCrossOrigin`) to build a fetch
 * function. Handles JSON parsing, optional Zod validation, and structured error
 * extraction via `extractFetchError`.
 *
 * Usage:
 * ```ts
 * const config = useQueryConfig();
 * const { data } = useQuery({
 *   queryKey: queryKeys.admin.settings(),
 *   queryFn: adminQueryFn("/api/v1/admin/settings", config),
 * });
 * ```
 */
export function adminQueryFn<T>(
  path: string,
  config: { apiUrl: string; isCrossOrigin: boolean },
  opts?: AdminQueryFnOptions<T>,
) {
  return async ({ signal }: { signal: AbortSignal }): Promise<T> => {
    const credentials: RequestCredentials = config.isCrossOrigin ? "include" : "same-origin";
    const res = await fetch(`${config.apiUrl}${path}`, { credentials, signal });

    if (!res.ok) {
      const err = await extractFetchError(res);
      throw err;
    }

    const json: unknown = await res.json();

    if (opts?.schema) {
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        console.warn(`adminQueryFn schema validation failed for ${path}:`, parsed.error.issues);
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
  };
}

/**
 * Extracts the `{ apiUrl, isCrossOrigin }` subset of `AtlasUIConfig` for use
 * with `adminQueryFn`. Isolates query utilities from the full config shape.
 */
export function useQueryConfig() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  return { apiUrl, isCrossOrigin };
}
