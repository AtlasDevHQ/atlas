/**
 * Env-profile — typed, non-secret deployment-environment defaults.
 *
 * Atlas runs in several deployment shapes (production SaaS regions,
 * single-region staging, self-hosted, dev). Many non-secret runtime
 * toggles have the same "correct" value for an entire env class
 * (require-email-verification is always off in staging+dev, always on
 * in prod; onboarding-emails are always off outside prod), yet were
 * previously stamped per-service in Railway as individual env vars.
 * This module centralises those decisions behind a single
 * `ATLAS_DEPLOY_ENV` switch and a typed table.
 *
 * **Migration pattern:** each profile field is paired with a legacy
 * env var that still overrides the profile default (`getProfileValue(...)`
 * helpers prefer the env var when set). This lets operators flip a
 * single deployment without changing code, and lets us migrate per-field
 * incrementally — `ATLAS_REQUIRE_EMAIL_VERIFICATION=false` on a prod
 * service still works even after the profile says `true`.
 *
 * **In scope:** non-secret runtime toggles that vary by deployment shape.
 * **Out of scope:**
 *   - Secrets (API keys, encryption keys, DB URLs).
 *   - Per-instance values (which specific region serves this api).
 *   - Per-tenant config.
 *   - Boot-script-only env vars read before TypeScript starts (e.g.
 *     `ATLAS_SEED_DEMO` — read by `examples/docker/scripts/start.sh`).
 *   - Settings-registry-managed values (rate limits, MCP session caps —
 *     they have their own env-var fallback semantics; layering
 *     env-profile in would require refactoring the registry).
 */

/**
 * Deployment-shape discriminator. Read from `ATLAS_DEPLOY_ENV`; unset
 * defaults to `production` — preserves existing behavior for self-hosted
 * and unconfigured deploys without a migration step.
 *
 * - `production` — customer-facing SaaS region (us / eu / apac all share this profile)
 * - `staging` — pre-prod soak environment (single region under `staging.useatlas.dev`)
 * - `development` — local dev / Playwright / CI
 */
export type DeployEnv = "production" | "staging" | "development";

export interface EnvProfile {
  /**
   * Whether new signups must verify their email before the session
   * becomes active. When false, Better Auth's `autoSignIn` kicks in
   * and signup hands the user a session immediately.
   *
   * Legacy override: `ATLAS_REQUIRE_EMAIL_VERIFICATION` env var (any
   * value of `false`/`0`/`no`/`off` disables verification; everything
   * else enables).
   */
  readonly requireEmailVerification: boolean;

  /**
   * Whether Atlas-originated onboarding emails (welcome, day-N nudge,
   * etc.) fire from the scheduler. Independent of the email-delivery
   * backend being configured — when false, the scheduler tick skips
   * the queue entirely.
   *
   * Legacy override: `ATLAS_ONBOARDING_EMAILS_ENABLED` env var (only
   * the literal `"true"` enables; anything else, including unset,
   * disables).
   */
  readonly onboardingEmailsEnabled: boolean;

  /**
   * Better Auth session-cookie name prefix (`advanced.cookiePrefix`). The
   * session cookie is named `${cookiePrefix}.session_token`. A distinct
   * prefix per deployment env is what isolates prod from staging: both live
   * under the shared `.useatlas.dev` parent (staging is `*.staging.useatlas.dev`,
   * a *subdomain* of the prod cookie domain), so prod's broadly-scoped
   * `.useatlas.dev` cookie reaches staging hosts regardless of how staging's
   * own cookie domain is scoped — the prefix, not the domain, is what isolates.
   * A different name means each env's optimistic proxy gate
   * (`packages/web/src/proxy.ts` → `getSessionCookie`) and Better Auth ignore
   * the other env's cookie instead of being fooled by its mere presence.
   *
   * MUST stay in lockstep with the web proxy's `getSessionCookie` read, which
   * CANNOT import this module (the frontend never imports `@atlas/api`). The
   * web side reads `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX`, defaulting to `"atlas"`
   * to match the `production` profile so unconfigured self-hosted deploys stay
   * consistent. Whenever this value changes for a deployment, set
   * `NEXT_PUBLIC_ATLAS_COOKIE_PREFIX` on its web service to the same string.
   *
   * Operator override: `ATLAS_COOKIE_PREFIX` env var (non-empty wins).
   *
   * NOTE: changing the prefix for an already-deployed env renames the cookie,
   * invalidating every active session there once (users re-login).
   */
  readonly cookiePrefix: string;
}

const PROFILES: Record<DeployEnv, EnvProfile> = {
  // Prod ships real signup verification and real onboarding email
  // campaigns. Behavior matches the pre-env-profile baseline (env vars
  // were always set this way on prod).
  production: {
    requireEmailVerification: true,
    onboardingEmailsEnabled: true,
    // `"atlas"` is also the web proxy's default (NEXT_PUBLIC_ATLAS_COOKIE_PREFIX
    // unset → "atlas"), so self-hosted deploys — which run this profile — stay
    // in lockstep without any extra wiring.
    cookiePrefix: "atlas",
  },
  // Staging dogfoods signup without making the maintainer wait on
  // real verification emails (no Resend on staging anyway — DPA guard
  // satisfied by a dummy key). Onboarding nudges off so dogfood signups
  // don't trigger automated email sequences.
  staging: {
    requireEmailVerification: false,
    onboardingEmailsEnabled: false,
    // Distinct from prod so prod's `.useatlas.dev` cookie (delivered to
    // `*.staging.useatlas.dev` because staging is a subdomain of it) is ignored
    // here. web-staging must set NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-staging.
    cookiePrefix: "atlas-staging",
  },
  // Dev mirrors staging — local signup should be instant; onboarding
  // emails would spam the developer or hit a real Resend account.
  development: {
    requireEmailVerification: false,
    onboardingEmailsEnabled: false,
    // Local dev sets NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-dev (see .env.example)
    // so the web proxy and API agree.
    cookiePrefix: "atlas-dev",
  },
};

/**
 * Resolve the active deployment env from `ATLAS_DEPLOY_ENV`. Unset →
 * `production`. Unknown value → log + fall back to `production` rather
 * than throwing — a typo in the discriminator isn't worth a hard-fail
 * boot.
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
 * Return the typed profile for the current deployment env. Cheap (map
 * lookup) — call at the call site rather than caching at module scope
 * so tests can `process.env.ATLAS_DEPLOY_ENV = "staging"` before
 * importing dependents.
 */
export function getEnvProfile(env: NodeJS.ProcessEnv = process.env): EnvProfile {
  return PROFILES[resolveDeployEnv(env)];
}

/**
 * Resolve `requireEmailVerification` honoring the legacy env-var
 * override pattern: if `ATLAS_REQUIRE_EMAIL_VERIFICATION` is set,
 * its parsed value wins; otherwise the profile default applies.
 *
 * Override values: `false`/`0`/`no`/`off` (case-insensitive) → false.
 * Anything else (including unrecognized values like `"yes"`) → true.
 */
export function resolveRequireEmailVerification(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ATLAS_REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase();
  if (raw !== undefined) {
    return !["false", "0", "no", "off"].includes(raw);
  }
  return getEnvProfile(env).requireEmailVerification;
}

/**
 * Resolve `onboardingEmailsEnabled` honoring the legacy env-var
 * override: if `ATLAS_ONBOARDING_EMAILS_ENABLED` is set, only the
 * literal `"true"` enables (matches the pre-migration semantics —
 * we don't widen the override grammar here). Otherwise the profile
 * default applies.
 *
 * Callers that also require an internal DB (`hasInternalDB()`) should
 * AND that check themselves — this resolver only encodes the env-vs-
 * profile decision, not the wiring prerequisites.
 */
export function resolveOnboardingEmailsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ATLAS_ONBOARDING_EMAILS_ENABLED;
  if (raw !== undefined) {
    return raw === "true";
  }
  return getEnvProfile(env).onboardingEmailsEnabled;
}

/**
 * Resolve the Better Auth session-cookie prefix honoring the operator
 * override: a non-empty `ATLAS_COOKIE_PREFIX` wins; otherwise the profile
 * default applies. See {@link EnvProfile.cookiePrefix} for the prod↔staging
 * isolation rationale and the required web-side (`NEXT_PUBLIC_ATLAS_COOKIE_PREFIX`)
 * lockstep.
 */
export function resolveCookiePrefix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ATLAS_COOKIE_PREFIX?.trim();
  if (raw) return raw;
  return getEnvProfile(env).cookiePrefix;
}
