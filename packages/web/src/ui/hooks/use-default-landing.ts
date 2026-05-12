"use client";

/**
 * Per-user default-landing preference (#2022).
 *
 * Reads `default_landing` from `/api/v1/me/preferences` so the chat page can
 * decide whether to keep the user on `/` or redirect them into the admin
 * console. The page treats `loading: true` as a "don't render yet" state so
 * the chat surface doesn't flash before the redirect lands.
 *
 * Returns `chat` when the endpoint is unavailable (404 in non-managed auth
 * modes — the migration is in MANAGED_AUTH_MIGRATIONS) so self-hosted-local
 * deployments default to the chat surface without further plumbing.
 */

import { useEffect, useRef, useState } from "react";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

export type DefaultLanding = "chat" | "admin";

interface UseDefaultLandingResult {
  /** Resolved preference. Until `loading` flips to false, treat as unknown. */
  defaultLanding: DefaultLanding;
  /** True while the initial fetch is in flight. */
  loading: boolean;
}

/**
 * Fetches the calling user's preference once on mount. `enabled = false`
 * skips the fetch — pass false on pages that don't need the preference,
 * or while the session is still resolving.
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
        if (!res.ok) {
          // 404 in non-managed modes is expected — the preference column
          // doesn't exist outside managed auth. Fall through to the chat
          // default rather than surfacing the error.
          return null;
        }
        return (await res.json()) as { defaultLanding?: unknown };
      })
      .then((body) => {
        if (cancelled || !body) return;
        if (body.defaultLanding === "admin" || body.defaultLanding === "chat") {
          setDefaultLanding(body.defaultLanding);
        }
      })
      .catch((err: unknown) => {
        // Network/parse failures fall through to chat — the same safe
        // default the migration's NOT NULL DEFAULT 'chat' enforces.
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
