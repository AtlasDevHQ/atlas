/**
 * Hard navigation out of an "auth state just changed" boundary
 * (sign-in / sign-up OTP verified / accept-invitation accepted / 2FA
 * verified). Uses `window.location.assign` instead of Next.js's
 * `router.push` to bypass the client-side Router Cache.
 *
 * Why this matters: Next.js's Router Cache is keyed by URL and survives
 * across auth state changes. Link prefetches that fired BEFORE the user
 * signed in (the auth page chrome links / and other guarded routes)
 * went through `proxy.ts`, got a 307 → /login, and that redirect is
 * cached. After the user signs in, a `router.push("/")` consults the
 * cache and replays the stale 307 — bouncing the just-authenticated
 * user back to /login. A hard nav is the documented Next.js workaround;
 * we centralize it here so tests have one mock point and the rationale
 * lives next to the call sites that need it.
 *
 * Don't use this for in-app navigation between two pages that share an
 * authenticated session — `router.push` keeps the SPA experience.
 */
export function navigatePostAuth(url: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(url);
}
