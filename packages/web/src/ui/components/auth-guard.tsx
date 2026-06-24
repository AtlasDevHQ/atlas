"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { AtlasProvider } from "@/ui/context";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { PUBLIC_ROUTE_PREFIXES } from "@/lib/public-routes";

const AUTH_MODE = process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";

/** Routes that don't require authentication. */
const publicPrefixes = [...PUBLIC_ROUTE_PREFIXES, "/login", "/signup", "/wizard"];

function isPublicRoute(pathname: string): boolean {
  return publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Client-side auth guard and app-wide context provider.
 *
 * Wraps all pages in AtlasProvider (apiUrl, isCrossOrigin, authClient)
 * so any component can call useAtlasConfig() without per-layout wrappers.
 *
 * Recovers unauthenticated users to /login in managed auth mode.
 *
 * --- Stale-session-cookie trap recovery (#3933, F2) ---
 *
 * The proxy (`proxy.ts`) does an OPTIMISTIC, presence-only session-cookie
 * check: ANY cookie-bearing user is admitted to protected routes and bounced
 * away from /login + /signup, without validating the cookie (no per-request DB
 * hit — the API is the real auth boundary). When that cookie is expired /
 * invalid / rotated, the user is trapped: every authed call 401s ("Failed to
 * load conversations. Please reload" — a reload can't fix auth), and the proxy
 * bounces /login straight back to /.
 *
 * `authClient.useSession()` does a REAL validation round-trip, so once it
 * resolves with no user on a protected route in managed mode, the cookie is
 * provably stale (the proxy only admitted us here WITH a cookie present). The
 * fix is to break the loop by CLEARING the cookie, not just redirecting: a
 * bare `router.replace("/login")` (the pre-#3933 behavior) left the stale
 * cookie in place, so the proxy bounced it right back to / and the user stayed
 * trapped. `authClient.signOut()` expires the cookie server-side (the cookie is
 * httpOnly — client JS can't drop it; Better Auth's /sign-out calls
 * `deleteSessionCookie` OUTSIDE its session-token guard — see sign-out.mjs — so
 * the cookie is expired even when the token resolves to a dead/rotated session),
 * after which a HARD nav to /login lands cleanly (the proxy now sees no cookie).
 * This is the cheap 401-recovery backstop from the #3925 cold-start audit (§F2).
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const session = authClient.useSession();
  const isSignedIn = !!session.data?.user;
  // One-shot: signOut is async and the hard nav below unmounts everything, but
  // a re-render could re-fire the effect before either lands. Guard so we clear
  // the cookie and navigate exactly once per trapped episode.
  const recovering = useRef(false);

  useEffect(() => {
    if (
      AUTH_MODE !== "managed" ||
      session.isPending ||
      // A transient get-session error (API down / network) is NOT a stale
      // cookie — recovering would needlessly destroy a possibly-valid session
      // and, since the proxy's local cookie check still bounces /login → /,
      // could loop. Only recover on a clean resolution to "no session".
      // Presence check, not truthiness, so the gate is robust to BA's error
      // shape (a structured object today, never an empty-object sentinel).
      session.error != null ||
      isSignedIn ||
      isPublicRoute(pathname)
    ) {
      return;
    }
    if (recovering.current) return;
    recovering.current = true;

    void (async () => {
      try {
        // Clears the (stale) httpOnly session cookie server-side. The handler
        // returns `{ success: true }` even for an already-invalid session, so it
        // does not throw on the trap path. signOut can still fail two ways, both
        // handled here, and on BOTH the cookie is NOT cleared (so the proxy would
        // bounce /login → / and re-arm the trap — hence we surface each, per
        // "never silently swallow errors", while still bouncing so the user isn't
        // frozen on /):
        //   (a) the server answered with an HTTP error (e.g. 5xx) — the Better Auth
        //       client RESOLVES with `{ error }` (better-fetch returns
        //       `{ data: null, error }` since `catchAllError` is unset here), so
        //       inspect the returned `result.error`;
        //   (b) a true transport failure (API down / DNS / CORS preflight) — the
        //       platform `fetch()` rejects and the throw propagates (no
        //       `catchAllError`, no catch in the client proxy) → the `catch`.
        const result = await authClient.signOut();
        if (result?.error) {
          console.warn(
            "[atlas] stale-session signOut returned an HTTP error; cookie may still be set, redirecting to /login anyway:",
            result.error.message ?? String(result.error),
          );
        }
      } catch (err) {
        console.warn(
          "[atlas] stale-session signOut threw (transport failure); redirecting to /login anyway:",
          err instanceof Error ? err.message : String(err),
        );
      }
      // Hard nav (not router.replace): the cleared cookie must be in effect so
      // the proxy admits /login instead of bouncing back to /. Mirrors the
      // user-menu sign-out flow.
      window.location.assign("/login");
    })();
  }, [session.isPending, session.error, isSignedIn, pathname]);

  return (
    <AtlasProvider config={{ apiUrl: getApiUrl(), isCrossOrigin: isCrossOrigin(), authClient }}>
      {children}
    </AtlasProvider>
  );
}
