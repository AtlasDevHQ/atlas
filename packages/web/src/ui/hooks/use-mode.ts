"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import type { AtlasMode } from "@/ui/lib/types";

const COOKIE_NAME = "atlas-mode";
const ADMIN_ROLES = new Set(["admin", "owner", "platform_admin"]);

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function readCookie(): AtlasMode {
  if (typeof document === "undefined") return "published";
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const value = match?.split("=")[1];
  return value === "developer" ? "developer" : "published";
}

function writeCookie(mode: AtlasMode): void {
  // SameSite=Lax + path=/ so the cookie is available across all routes
  // and sent on same-site navigations. Max-Age = 1 year.
  document.cookie = `${COOKIE_NAME}=${mode}; path=/; max-age=31536000; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// External store for cookie value (triggers re-renders on change)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let snapshot: AtlasMode = typeof document !== "undefined" ? readCookie() : "published";

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): AtlasMode {
  return snapshot;
}

function getServerSnapshot(): AtlasMode {
  return "published";
}

function notify(mode: AtlasMode): void {
  snapshot = mode;
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Read/write the `atlas-mode` cookie from the client.
 *
 * - `mode`: current resolved mode (`developer` or `published`)
 * - `setMode`: update the cookie (only works for admins)
 * - `isAdmin`: whether the current user has an admin-level role
 *
 * Non-admin users always see `published` regardless of cookie value.
 * Calling `setMode("developer")` as a non-admin is a no-op.
 */
export function useMode(): {
  mode: AtlasMode;
  setMode: (next: AtlasMode) => void;
  isAdmin: boolean;
} {
  const role = useUserRole();
  const isAdmin = role !== undefined && ADMIN_ROLES.has(role);

  const cookieValue = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Non-admins always see published
  const mode: AtlasMode = isAdmin ? cookieValue : "published";

  const setMode = useCallback(
    (next: AtlasMode) => {
      if (!isAdmin) return;
      writeCookie(next);
      notify(next);
    },
    [isAdmin],
  );

  return { mode, setMode, isAdmin };
}
