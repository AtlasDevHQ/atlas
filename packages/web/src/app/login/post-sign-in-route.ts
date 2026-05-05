/**
 * Decide where to send a user after `signIn.email` returns success.
 *
 * Better Auth's twoFactor plugin replaces the session payload with
 * `{ twoFactorRedirect: true }` when the user has TOTP enrolled and the
 * device lacks a valid trust cookie — the response is HTTP 200 with no
 * session cookie set. Without this branch the user lands on `/`
 * sessionless and bounces straight back to `/login`.
 *
 * Strict `=== true` check (not truthy) so a stringified `"true"` from a
 * future Better Auth wire-shape change can't fall through unnoticed.
 */
export function getPostSignInRoute(data: unknown): string {
  if (
    data !== null &&
    typeof data === "object" &&
    "twoFactorRedirect" in data &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  ) {
    return "/login/two-factor";
  }
  return "/";
}
