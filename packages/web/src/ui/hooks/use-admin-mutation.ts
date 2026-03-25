"use client";

import { useState, useCallback, useRef } from "react";
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
  /** Called on success when the server returns a JSON body. Not called for 204 No Content. */
  onSuccess?: (data: TResponse) => void;
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
 * Handles saving/error state, credentials, JSON serialization,
 * structured error extraction from response bodies, and per-item
 * loading tracking. Reads apiUrl and credentials from AtlasUIContext.
 */
export function useAdminMutation<TResponse = unknown>(
  options?: UseAdminMutationOptions,
): UseAdminMutationReturn<TResponse> {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  // Stable refs for options that shouldn't trigger re-renders
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // useCallback for stable references — hook API contract, not performance
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

  const mutate = useCallback(
    async (callOpts?: MutateOptions<TResponse>): Promise<MutateResult<TResponse>> => {
      const opts = optionsRef.current;
      const path = callOpts?.path ?? opts?.path;
      const method = callOpts?.method ?? opts?.method ?? "POST";
      const itemId = callOpts?.itemId;

      if (!path) {
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
          setError(msg);
          return { ok: false, error: msg };
        }

        // Parse response (handle 204 No Content)
        const contentType = res.headers.get("content-type");
        if (res.status === 204 || !contentType?.includes("application/json")) {
          data = undefined;
        } else {
          data = (await res.json()) as TResponse;
        }

        // Call invalidates (refetch functions)
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

      // Call onSuccess outside try/catch so callback bugs don't
      // get misreported as mutation failures.
      // Only called when data is present — 204/non-JSON callers use result.ok instead.
      if (data !== undefined) {
        callOpts?.onSuccess?.(data);
      }

      return { ok: true, data };
    },
    [apiUrl, credentials],
  );

  return { mutate, saving, error, clearError, reset, isMutating };
}
