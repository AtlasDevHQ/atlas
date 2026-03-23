"use client";

import { useState, useCallback, useRef } from "react";
import { useAtlasConfig } from "@/ui/context";
import type { FetchError } from "./use-admin-fetch";

/** HTTP methods supported by admin mutations. */
type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

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
  /** Called on success with the parsed JSON response body. */
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
  /** Execute a mutation. Resolves with the parsed response on success, undefined on failure. */
  mutate: (options?: MutateOptions<TResponse>) => Promise<TResponse | undefined>;
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
 * Extract a user-facing error message from a failed fetch response.
 * Attempts to parse JSON body for `message` and `requestId` fields.
 */
async function extractError(res: Response): Promise<FetchError> {
  let message = `HTTP ${res.status}`;
  let requestId: string | undefined;
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const obj = body as Record<string, unknown>;
      if (typeof obj.message === "string") message = obj.message;
      if (typeof obj.requestId === "string") requestId = obj.requestId;
    }
  } catch {
    // intentionally ignored: body wasn't JSON — keep the status-only message
  }
  return { message, status: res.status, ...(requestId && { requestId }) };
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
    async (callOpts?: MutateOptions<TResponse>): Promise<TResponse | undefined> => {
      const opts = optionsRef.current;
      const path = callOpts?.path ?? opts?.path;
      const method = callOpts?.method ?? opts?.method ?? "POST";
      const itemId = callOpts?.itemId;

      if (!path) {
        const msg = "useAdminMutation: no path provided";
        setError(msg);
        return undefined;
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
          const fetchError = await extractError(res);
          setError(fetchError.message);
          return undefined;
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
        setError(msg || "Request failed");
        return undefined;
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
      // get misreported as mutation failures
      if (data !== undefined) {
        callOpts?.onSuccess?.(data);
      }

      return data;
    },
    [apiUrl, credentials],
  );

  return { mutate, saving, error, clearError, reset, isMutating };
}
