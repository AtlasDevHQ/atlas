/**
 * Decide where to send a user after `signIn.email` returns success.
 *
 * Better Auth's twoFactor plugin replaces the session payload with
 * `{ twoFactorRedirect: true }` when the user has TOTP enrolled and the
 * device lacks a valid trust cookie — the response is HTTP 200 with no
 * session cookie set. Without this branch the user lands on `/`
 * sessionless and bounces straight back to `/login`.
 *
 * The `invitationId` arg threads the org-invitation deep-link through
 * the auth flow: when the recipient lands on /login from an invite
 * email's accept page, the URL carries `?invitationId=…`, and we route
 * back to /accept-invitation/{id} once the session lands. The 2FA
 * branch wins over the invitation branch — accept-invitation requires
 * a complete session, and 2FA finishes that.
 *
 * Strict `=== true` check (not truthy) so a stringified `"true"` from a
 * future Better Auth wire-shape change can't fall through unnoticed.
 */
export function getPostSignInRoute(data: unknown, invitationId?: string | null): string {
  const acceptPath = invitationId
    ? `/accept-invitation/${encodeURIComponent(invitationId)}`
    : null;
  if (
    data !== null &&
    typeof data === "object" &&
    "twoFactorRedirect" in data &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  ) {
    return acceptPath
      ? `/login/two-factor?callbackURL=${encodeURIComponent(acceptPath)}`
      : "/login/two-factor";
  }
  return acceptPath ?? "/";
}

/**
 * Should a post-sign-in destination be reached via `router.push` (SPA nav)
 * instead of `navigatePostAuth` (hard nav)?
 *
 * `true` only for the /login/two-factor branch. The `twoFactorRedirect`
 * response doesn't set a session_token cookie — only a short-lived two-
 * factor cookie identifying the pending user. A hard nav to /login/two-
 * factor would hit proxy.ts as "no session", and /login/two-factor isn't
 * in the exact-match authRoutes list, so the proxy would 307 to /login
 * and the user would never reach the challenge.
 *
 * Prefix match (not exact equality) because the invited+2FA path appends
 * `?callbackURL=…` — and that was the exact bug Codex caught on PR #2888.
 *
 * Every other branch (`/`, `/accept-invitation/…`) is an exit out of the
 * auth gate where a real session cookie exists, so hard nav is correct
 * (and necessary, to dodge Router Cache poisoning).
 */
export function requiresRouterPushAfterSignIn(next: string): boolean {
  return next === "/login/two-factor" || next.startsWith("/login/two-factor?");
}
