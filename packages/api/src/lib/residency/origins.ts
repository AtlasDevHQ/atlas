/**
 * Per-region origin derivation (#3706).
 *
 * SaaS used to stamp the public API origin (`ATLAS_PUBLIC_API_URL`) and the web
 * origin (the `ATLAS_CORS_ORIGIN` default + the passkey rpID) on every regional
 * service. They are not secret and not runtime-tunable (boot-ordering), but they
 * are derivable from two things this instance already knows: its region identity
 * (`ATLAS_API_REGION`, via {@link getApiRegion}) and the `residency.regions[].apiUrl`
 * map baked into `atlas.config.ts`.
 *
 * These helpers supply the *default* only. An explicit env value
 * (`ATLAS_PUBLIC_API_URL`, `ATLAS_CORS_ORIGIN`, `BETTER_AUTH_TRUSTED_ORIGINS`,
 * `ATLAS_RPID`) always overrides — the derivation never shadows an operator's
 * stamped value. Self-hosted deploys configure no residency map, so
 * {@link getApiRegion} returns `null` and every helper here returns `null`,
 * leaving the historical env/default behavior untouched.
 */

import { getConfig } from "@atlas/api/lib/config";
import { getApiRegion } from "@atlas/api/lib/residency/misrouting";

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * This instance's public API origin from the residency map — the API host
 * itself (`api.useatlas.dev` / `api-eu.useatlas.dev` / `api-apac.useatlas.dev` /
 * `api.staging.useatlas.dev`). Returns `null` when no region is configured
 * (self-hosted) or the region has no `apiUrl` declared.
 */
export function deriveRegionApiUrl(): string | null {
  const region = getApiRegion();
  if (!region) return null;
  const apiUrl = getConfig()?.residency?.regions?.[region]?.apiUrl;
  return apiUrl ? trimTrailingSlashes(apiUrl) : null;
}

/**
 * This instance's web app origin, derived from the region's API origin by
 * swapping the leading `api` DNS label for `app`:
 *
 *   - `api.useatlas.dev`         → `https://app.useatlas.dev`
 *   - `api-eu.useatlas.dev`      → `https://app.useatlas.dev`
 *   - `api-apac.useatlas.dev`    → `https://app.useatlas.dev`
 *   - `api.staging.useatlas.dev` → `https://app.staging.useatlas.dev`
 *
 * A single web service serves every region, so all prod regions collapse onto
 * one app origin (`app.useatlas.dev`); staging keeps its own
 * (`app.staging.useatlas.dev`). Replacing the *entire* first label (not just an
 * `api` → `app` substring) is what folds `api-eu` / `api-apac` back to the
 * canonical `app` host.
 *
 * Returns `null` when no API origin is derivable, the API origin isn't a
 * parseable absolute URL, or its first DNS label isn't an `api` label (we don't
 * guess for hosts that don't follow the `api[-region].<domain>` convention).
 */
export function deriveRegionWebOrigin(): string | null {
  const apiUrl = deriveRegionApiUrl();
  if (!apiUrl) return null;

  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    // deriveRegionApiUrl sources this from the residency map; a malformed
    // apiUrl is an operator config error, not a runtime input. Degrade to null
    // (callers fall back to env/default) rather than throw at request time.
    return null;
  }

  const labels = url.hostname.split(".");
  const first = labels[0];
  if (first !== "api" && !first.startsWith("api-")) return null;
  labels[0] = "app";
  url.hostname = labels.join(".");
  return trimTrailingSlashes(url.origin);
}
