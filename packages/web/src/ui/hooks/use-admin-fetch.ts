"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAtlasConfig } from "@/ui/context";

export interface FetchError {
  message: string;
  status?: number;
  requestId?: string;
}

/** Map HTTP status codes to user-friendly messages for admin pages. Appends request ID for log correlation when available. */
export function friendlyError(err: FetchError): string {
  let msg: string;
  if (err.status === 401) msg = "Not authenticated. Please sign in.";
  else if (err.status === 403)
    msg = "Access denied. Admin role required to view this page.";
  else if (err.status === 404)
    msg = "This feature is not enabled on this server.";
  else if (err.status === 503)
    msg = "A required service is unavailable. Check server configuration.";
  else msg = err.message;
  if (err.requestId) msg += ` (Request ID: ${err.requestId})`;
  return msg;
}

/**
 * Shared fetch hook for admin pages.
 * Handles loading/error state, structured error body extraction (message + requestId),
 * cancellation on unmount, and credentials.
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
        let message = `HTTP ${res.status}`;
        let requestId: string | undefined;
        try {
          const body: unknown = await res.json();
          if (
            typeof body === "object" &&
            body !== null
          ) {
            const obj = body as Record<string, unknown>;
            if (typeof obj.message === "string") message = obj.message;
            if (typeof obj.requestId === "string") requestId = obj.requestId;
          }
        } catch {
          // intentionally ignored: body wasn't JSON — keep the status-only message
        }
        const e: FetchError = { message, status: res.status, ...(requestId && { requestId }) };
        if (!signal?.aborted) setError(e);
        return;
      }
      const json = await res.json();
      const result = opts?.transform ? opts.transform(json) : (json as T);
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
