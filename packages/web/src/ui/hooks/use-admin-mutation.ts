"use client";

import { useState, useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtlasConfig } from "@/ui/context";
import { extractFetchError } from "@/ui/lib/fetch-error";

/** HTTP methods supported by admin mutations. */
type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Discriminated result returned by `mutate()`.
 * Discriminates on `ok`: true means the request succeeded (data is
 * undefined for 204 No Content or non-JSON responses), false means
 * an error occurred.
 */
export type MutateResult<T> =
  | { ok: true; data: T | undefined }
  | { ok: false; error: string };

/** Options for a single mutate() call. */
interface MutateOptions<TResponse = unknown> {
  /** Override the path from the hook-level default. */
  path?: string;
  /** HTTP method. Defaults to hook-level method or "POST". */
  method?: MutationMethod;
  /** JSON request body. */
  body?: Record<string, unknown>;
  /** Track this mutation under an ID for per-item loading state. */
  itemId?: string;
  /**
   * Called on any 2xx response. Data is `undefined` for 204 No Content or non-JSON
   * responses — consumers that need the parsed body should narrow or use the
   * `MutateResult` returned from `mutate()`.
   */
  onSuccess?: (data: TResponse | undefined) => void;
}

/** Hook-level configuration. */
interface UseAdminMutationOptions {
  /** Default API path (e.g. "/api/v1/admin/branding"). Can be overridden per-call. */
  path?: string;
  /** Default HTTP method. Defaults to "POST". */
  method?: MutationMethod;
  /** Refetch functions to call after a successful mutation. */
  invalidates?: (() => void) | (() => void)[];
}

/** Return value of useAdminMutation. */
interface UseAdminMutationReturn<TResponse> {
  /** Execute a mutation. Resolves with a discriminated `{ ok, data }` or `{ ok, error }` result. */
  mutate: (options?: MutateOptions<TResponse>) => Promise<MutateResult<TResponse>>;
  /** True while any non-item-scoped mutation is in flight. */
  saving: boolean;
  /** Last mutation error message, or null. Cleared on next mutate() call. */
  error: string | null;
  /** Clear the error manually. */
  clearError: () => void;
  /** Reset both error and saving state (e.g. when a dialog reopens). */
  reset: () => void;
  /** Check whether a per-item mutation is in flight. */
  isMutating: (itemId: string) => boolean;
}

/**
 * Hook for admin page mutations (POST, PUT, PATCH, DELETE).
 *
 * Uses TanStack Query's `useMutation` internally. On success, invalidates
 * all `["admin-fetch"]` queries so `useAdminFetch` consumers automatically
 * refetch. Preserves the original return shape for backward compatibility.
 */
export function useAdminMutation<TResponse = unknown>(
  options?: UseAdminMutationOptions,
): UseAdminMutationReturn<TResponse> {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const queryClient = useQueryClient();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  // Ref to read latest hook-level options inside mutationFn without recreating the mutation.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearError = useCallback(() => setError(null), []);

  const reset = useCallback(() => {
    setError(null);
    setSaving(false);
    setInFlight(new Set());
  }, []);

  const isMutating = useCallback(
    (itemId: string) => inFlight.has(itemId),
    [inFlight],
  );

  const mutation = useMutation<TResponse | undefined, Error, MutateOptions<TResponse> | undefined>({
    mutationFn: async (callOpts) => {
      const opts = optionsRef.current;
      const path = callOpts?.path ?? opts?.path;
      const method = callOpts?.method ?? opts?.method ?? "POST";

      if (!path) {
        throw new Error("useAdminMutation: no path provided");
      }

      const headers: Record<string, string> = {};
      let body: string | undefined;
      if (callOpts?.body) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(callOpts.body);
      }

      const res = await fetch(`${apiUrl}${path}`, {
        method,
        credentials,
        headers,
        body,
      });

      if (!res.ok) {
        const fetchError = await extractFetchError(res);
        const msg = fetchError.requestId
          ? `${fetchError.message} (Request ID: ${fetchError.requestId})`
          : fetchError.message;
        throw new Error(msg);
      }

      // Parse response (handle 204 No Content)
      const contentType = res.headers.get("content-type");
      if (res.status === 204 || !contentType?.includes("application/json")) {
        return undefined;
      }
      return (await res.json()) as TResponse;
    },
    onSuccess: () => {
      // Invalidate all admin-fetch queries so useAdminFetch consumers get fresh data.
      // This is intentionally broad — can be narrowed to specific keys if needed.
      queryClient.invalidateQueries({ queryKey: ["admin-fetch"] });
    },
  });

  // Ref for stable mutate callback — useMutation returns a new object each render.
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  const mutate = useCallback(
    async (callOpts?: MutateOptions<TResponse>): Promise<MutateResult<TResponse>> => {
      const opts = optionsRef.current;
      const itemId = callOpts?.itemId;

      if (!callOpts?.path && !opts?.path) {
        const msg = "useAdminMutation: no path provided";
        setError(msg);
        return { ok: false, error: msg };
      }

      // Track loading state
      if (itemId) {
        setInFlight((prev) => new Set(prev).add(itemId));
      } else {
        setSaving(true);
      }
      setError(null);

      let data: TResponse | undefined;
      try {
        data = await mutationRef.current.mutateAsync(callOpts);

        // Call legacy invalidates (refetch callbacks from callers).
        // These are redundant with queryClient.invalidateQueries in onSuccess
        // but kept for backward compatibility during migration.
        const invalidates = opts?.invalidates;
        if (invalidates) {
          if (Array.isArray(invalidates)) {
            for (const fn of invalidates) fn();
          } else {
            invalidates();
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorMessage = msg || "Request failed";
        setError(errorMessage);
        return { ok: false, error: errorMessage };
      } finally {
        if (itemId) {
          setInFlight((prev) => {
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
        } else {
          setSaving(false);
        }
      }

      // Call onSuccess outside try/catch so callback bugs don't get misreported
      // as mutation failures. Fires on all 2xx responses — passes `undefined`
      // for 204 / non-JSON so dialog-closing callers aren't stuck when the
      // server returns No Content.
      callOpts?.onSuccess?.(data);

      return { ok: true, data };
    },
    [], // Stable — reads all mutable state via refs
  );

  return { mutate, saving, error, clearError, reset, isMutating };
}
