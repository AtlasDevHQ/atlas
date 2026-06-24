"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { AtlasProvider } from "@/ui/context";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { PUBLIC_ROUTE_PREFIXES } from "@/lib/public-routes";

// Resolved at render time inside the effect (not a module-load const): Next
// inlines `process.env.NEXT_PUBLIC_*` everywhere identically, so this is free,
// and it matches how the rest of the workspace UI resolves auth mode at runtime
// (`useAtlasTransport`) rather than at import.
function getAuthMode(): string {
  return process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";
}

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
      getAuthMode() !== "managed" ||
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
      // Only navigate once the cookie is provably cleared. The httpOnly cookie
      // can only be dropped by the server round-trip — there is no client-side
      // fallback — so if signOut fails the cookie is still set, and a hard nav
      // to /login would be bounced straight back to / by the proxy. A fresh
      // mount then resets `recovering` and re-fires → an infinite hard-nav loop
      // that re-traps the user (a trap of our own making). So on failure we
      // DON'T navigate: stay put (the API is degraded — /login wouldn't load
      // either), `recovering` stays true so we don't re-fire this mount, and a
      // user reload re-attempts once the API is reachable again.
      let cleared = false;
      try {
        // The /sign-out handler returns `{ success: true }` and clears the
        // cookie even for an already-invalid session, so the trap path succeeds.
        // signOut can still fail two ways — on BOTH the cookie is uncleared, and
        // we surface each (per "never silently swallow errors"):
        //   (a) the server answered with an HTTP error (e.g. 5xx) — the Better
        //       Auth client RESOLVES with `{ error }` (better-fetch returns
        //       `{ data: null, error }` since `catchAllError` is unset here);
        //   (b) a true transport failure (API down / DNS / CORS preflight) — the
        //       platform `fetch()` rejects and the throw propagates (no
        //       `catchAllError`, no catch in the client proxy) → the `catch`.
        const result = await authClient.signOut();
        if (result?.error) {
          console.warn(
            "[atlas] stale-session signOut returned an HTTP error; cookie not cleared, staying put to avoid a redirect loop (reload once the API is reachable):",
            result.error.message ?? String(result.error),
          );
        } else {
          cleared = true;
        }
      } catch (err) {
        console.warn(
          "[atlas] stale-session signOut threw (transport failure); cookie not cleared, staying put to avoid a redirect loop (reload once the API is reachable):",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!cleared) {
        // Release the one-shot so a later effect re-run can retry. AuthGuard
        // never unmounts across client navigations, so latching `recovering`
        // on after a transient failure would permanently disable recovery for
        // the whole tab — a user with a stale cookie would stay trapped even
        // after the API recovers (#3939 review). Resetting is loop-safe: the
        // effect only re-runs on a dep change, and while the API is down
        // get-session errors too, so the `session.error` gate above suppresses
        // recovery until it resolves cleanly again.
        recovering.current = false;
        return;
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
