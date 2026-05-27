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
