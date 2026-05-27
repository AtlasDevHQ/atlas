/**
 * Resolve the web app's origin for cross-host redirects from API routes.
 *
 * The API and web app live on separate hostnames in SaaS (api.useatlas.dev →
 * app.useatlas.dev). OAuth callback success pages and invitation emails need
 * an absolute redirect so the user lands in the admin UI rather than 404ing
 * on the API host.
 *
 * Source of truth: first entry of `ATLAS_CORS_ORIGIN` (the CORS allowlist —
 * `app.useatlas.dev` is always first in SaaS). Falls back to the first entry
 * of `BETTER_AUTH_TRUSTED_ORIGINS`. Returns `null` when neither is set —
 * callers should treat that as "render inline HTML here" rather than emit
 * a malformed redirect.
 */
export function getWebOrigin(): string | null {
  const cors = process.env.ATLAS_CORS_ORIGIN?.split(",")[0]?.trim();
  if (cors && cors !== "*") return cors.replace(/\/+$/, "");

  const trusted = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")[0]?.trim();
  if (trusted) return trusted.replace(/\/+$/, "");

  return null;
}
