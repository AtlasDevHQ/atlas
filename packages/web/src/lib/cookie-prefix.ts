/**
 * Resolve the web proxy's Better Auth session-cookie name prefix.
 *
 * Mirrors the API's `resolveCookiePrefix` (`@atlas/api/lib/env-profile`). The
 * frontend can't import `@atlas/api`, so the value is read from
 * `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX` at the call site and defaulted here. The
 * default `"atlas"` matches the API's `production` profile so an unconfigured
 * (self-hosted) deploy agrees on both sides without extra wiring.
 *
 * A blank/whitespace value is treated as unset (same as the API resolver) so
 * it can never produce an empty `".session_token"` cookie name. The result is
 * trimmed for symmetry with the API resolver.
 *
 * MUST stay in lockstep with the API prefix — see `EnvProfile.cookiePrefix`
 * for the prod↔staging isolation rationale.
 */
export function resolveWebCookiePrefix(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "atlas";
}
