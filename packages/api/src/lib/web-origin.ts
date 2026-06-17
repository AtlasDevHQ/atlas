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
 * of `BETTER_AUTH_TRUSTED_ORIGINS`, then to the region-derived web origin
 * (#3706 — `ATLAS_API_REGION` + the `residency.regions[].apiUrl` map, with the
 * `api` host label swapped to `app`), so SaaS no longer has to stamp the web
 * origin on each regional service. Returns `null` when none of these is
 * available — callers should treat that as "render inline HTML here" rather
 * than emit a malformed redirect.
 */

import { deriveRegionWebOrigin } from "@atlas/api/lib/residency/origins";

export function getWebOrigin(): string | null {
  const cors = process.env.ATLAS_CORS_ORIGIN?.split(",")[0]?.trim();
  if (cors && cors !== "*") return cors.replace(/\/+$/, "");

  const trusted = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")[0]?.trim();
  if (trusted) return trusted.replace(/\/+$/, "");

  return deriveRegionWebOrigin();
}
