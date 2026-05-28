/**
 * Env-profile — typed, non-secret deployment-environment constants.
 *
 * Atlas runs in several deployment shapes (production SaaS regions,
 * single-region staging, self-hosted, dev). Non-secret per-env config
 * (cookie strategy, default region labels, feature defaults) was previously
 * a sprawl of `process.env.X ?? "default"` reads + manual Railway-side
 * stamping. This module centralises those decisions behind a single
 * `ATLAS_DEPLOY_ENV` switch and a typed table — adding a new profile is
 * a table edit, not a global grep.
 *
 * **In scope:** non-secret runtime defaults that vary by deployment shape.
 * **Out of scope:** secrets (API keys, encryption keys), per-instance
 * values (which specific region this API serves), customer-tenant config.
 * Those stay as env vars / settings registry rows.
 *
 * Starts minimal — only `cookieDomainStrategy` for the cross-env cookie
 * leak fix (#2933). Expand the `EnvProfile` interface incrementally as
 * we migrate more per-env reads onto this seam.
 */

/**
 * Deployment-shape discriminator. Read from `ATLAS_DEPLOY_ENV`; unset
 * defaults to `production` (existing prod behavior — no migration risk).
 *
 * - `production` — customer-facing SaaS region (us / eu / apac all share this profile)
 * - `staging` — pre-prod soak environment (single region, staging.useatlas.dev family)
 * - `development` — local dev / Playwright / CI
 */
export type DeployEnv = "production" | "staging" | "development";

/**
 * Strategy for the `Domain` attribute on auth session cookies.
 *
 * - `parent`: derive parent domain (e.g. `useatlas.dev`) and set
 *   `Domain=.<parent>`. Cookie spans every subdomain of the parent.
 *   Required only when JavaScript on another subdomain needs to read
 *   the cookie via `document.cookie` (HttpOnly cookies don't need it).
 *   For pure cross-origin fetch-with-credentials, this is unnecessary
 *   AND causes cookie leaks between deployments that share the parent
 *   (e.g. prod `api.useatlas.dev` and staging `staging.api.useatlas.dev`
 *   both derive `.useatlas.dev`, so sessions leak across).
 *
 * - `host-only`: omit the `Domain` attribute. Cookie is bound to the
 *   exact host that set it (e.g. `staging.api.useatlas.dev` only).
 *   Cross-origin fetch from a sibling subdomain still works as long
 *   as the request targets that exact host with `credentials: "include"`
 *   and `SameSite=None; Secure`. No cookie leakage to other subdomains.
 */
export type CookieDomainStrategy = "parent" | "host-only";

export interface EnvProfile {
  readonly cookieDomainStrategy: CookieDomainStrategy;
}

const PROFILES: Record<DeployEnv, EnvProfile> = {
  // Prod keeps the existing parent-domain strategy. Switching it to
  // host-only would require verifying every prod surface that might
  // read cookies cross-subdomain (admin, status pages, future internal
  // tools). Out of scope for #2933 — that's a separate audit.
  production: {
    cookieDomainStrategy: "parent",
  },
  // Staging deliberately picks host-only to isolate from prod's
  // `.useatlas.dev` cookie space. The staging URL family
  // (staging.api.useatlas.dev, app-staging.useatlas.dev) shares the
  // same parent as prod, so any non-host-only choice leaks.
  staging: {
    cookieDomainStrategy: "host-only",
  },
  // Dev deploys typically use localhost or single-host setups where
  // cross-subdomain cookies aren't relevant. Host-only is the safe
  // default that won't surprise anyone running `bun run dev`.
  development: {
    cookieDomainStrategy: "host-only",
  },
};

/**
 * Resolve the active deployment env from `ATLAS_DEPLOY_ENV`.
 *
 * Unset → `production` (preserves existing behavior for self-hosted
 * and unconfigured deploys). Unknown value → log + fall back to
 * `production` rather than throwing — the cookie strategy isn't
 * worth a hard-fail boot for a typo'd env var.
 */
export function resolveDeployEnv(env: NodeJS.ProcessEnv = process.env): DeployEnv {
  const raw = env.ATLAS_DEPLOY_ENV?.trim().toLowerCase();
  if (!raw) return "production";
  if (raw === "production" || raw === "staging" || raw === "development") {
    return raw;
  }
  return "production";
}

/**
 * Return the typed profile for the current deployment env.
 *
 * Cheap (single map lookup) — call at the call site rather than
 * caching at module scope so tests can `process.env.ATLAS_DEPLOY_ENV =
 * "staging"` before importing dependents.
 */
export function getEnvProfile(env: NodeJS.ProcessEnv = process.env): EnvProfile {
  return PROFILES[resolveDeployEnv(env)];
}
