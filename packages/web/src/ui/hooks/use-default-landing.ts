"use client";

import { useEffect, useRef, useState } from "react";
import { isDefaultLanding, type DefaultLanding } from "@useatlas/types";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

export type { DefaultLanding };

interface UseDefaultLandingResult {
  /** Resolved preference. Until `loading` flips to false, treat as unknown. */
  defaultLanding: DefaultLanding;
  /** True while the initial fetch is in flight. */
  loading: boolean;
}

/**
 * Fetches the calling user's preference once on mount. `enabled = false`
 * skips the fetch — pass false while the session is still resolving so we
 * don't 401 the endpoint and silently fall through to the chat default.
 *
 * 404 is intentional — non-managed deployments don't have the column. Any
 * other HTTP failure also falls through to chat (matching the migration's
 * NOT NULL DEFAULT 'chat'); the response body's `requestId` is logged so
 * operators can trace it.
 */
export function useDefaultLanding(enabled: boolean): UseDefaultLandingResult {
  const [defaultLanding, setDefaultLanding] = useState<DefaultLanding>("chat");
  const [loading, setLoading] = useState(enabled);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    let cancelled = false;
    const credentials: RequestCredentials = isCrossOrigin() ? "include" : "same-origin";

    fetch(`${getApiUrl()}/api/v1/me/preferences`, { credentials })
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { requestId?: string };
          console.warn(
            "[preferences] GET /me/preferences returned",
            res.status,
            "requestId:",
            body.requestId,
          );
          return null;
        }
        return (await res.json()) as { defaultLanding?: unknown };
      })
      .then((body) => {
        if (cancelled || !body) return;
        if (isDefaultLanding(body.defaultLanding)) {
          setDefaultLanding(body.defaultLanding);
        }
      })
      .catch((err: unknown) => {
        console.warn(
          "[preferences] failed to load defaultLanding:",
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { defaultLanding, loading };
}
