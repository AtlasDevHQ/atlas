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
 * env var that still overrides the profile default (the `resolve*(...)`
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
 *
 * **Phase 2 (#2937)** folded in four runtime defaults Phase 1 had deferred.
 * Each keeps its legacy env-var override, so self-hosted operators see no
 * behavior change:
 *   - `ATLAS_SEED_DEMO` — was boot-script-only (`scripts/start.sh`, read
 *     before TypeScript starts). Now resolved via {@link resolveSeedDemo};
 *     the boot scripts shell out to `scripts/resolve-seed-demo.ts` and fall
 *     back to the legacy raw `= "true"` check only if the resolver can't run,
 *     so the Railway "Atlas Demo" template can never silently stop seeding.
 *   - `ATLAS_RATE_LIMIT_RPM` — settings-registry-managed. The registry entry
 *     keeps NO static `default` (a static default would shadow the profile in
 *     `getSetting`'s precedence — same pattern as `ATLAS_PROVIDER`); the
 *     deploy-env default is applied downstream by `getRpmLimit()` (auth/
 *     middleware.ts) via {@link resolveRateLimitRpm}, preserving the
 *     DB-override > env-var > profile-default precedence. The SaaS boot guard
 *     (`saas-guards.ts :: RateLimitGuardLive`) deliberately still reads the
 *     raw env var — its operator contract is "the var MUST be set at deploy
 *     time", independent of any profile fallback.
 *   - `ATLAS_MCP_MAX_SESSIONS` — was a raw `process.env` read in the hosted
 *     MCP route. Now resolved via {@link resolveMcpMaxSessions}.
 *   - `STAGING_MAIL_SINK` — was a raw read in the staging clamp. Now resolved
 *     via {@link resolveMailSink}.
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
   * session cookie is named `${cookiePrefix}.session_token`. Session cookies are
   * host-only (ADR-0024 §5 — no `Domain=.useatlas.dev`), so prod's cookie is
   * already scoped to `api.useatlas.dev` and never reaches a staging host. The
   * distinct prefix per deployment env stays a defensive second guard: a
   * different name means each env's optimistic proxy gate
   * (`packages/web/src/proxy.ts` → `getSessionCookie`) and Better Auth ignore
   * the other env's cookie even if one ever did reach the wrong host, instead of
   * being fooled by its mere presence.
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

  /**
   * Per-user requests-per-minute rate-limit default, or `null` for "no
   * managed default" (the limiter stays disabled until an operator opts in).
   *
   * `null` for `production` + `development` preserves the long-standing
   * self-hosted behavior: an unconfigured deploy (which resolves to the
   * `production` profile) has NO rate limit, matching the registry entry that
   * carried no static default. SaaS prod regions stamp `ATLAS_RATE_LIMIT_RPM`
   * explicitly (and the SaaS boot guard refuses to start without it), so this
   * default is never reached there. `staging` carries a real value so a
   * self-hosted-shaped staging soak gets a sane limit without stamping the
   * env var; in SaaS-mode staging the env var is required by the boot guard
   * and shadows this anyway.
   *
   * Legacy override: `ATLAS_RATE_LIMIT_RPM` env var (and, in self-hosted, a
   * platform/workspace DB override) — both take precedence via
   * {@link resolveRateLimitRpm} wired through `getRpmLimit()`.
   */
  readonly rateLimitRpm: number | null;

  /**
   * Maximum concurrent hosted-MCP sessions before new connections are
   * rejected (after an idle sweep). Identical across profiles today — the
   * historical default was a flat `100` regardless of deployment shape — but
   * encoded here so a future env can diverge (e.g. a smaller dev cap) in one
   * place.
   *
   * Legacy override: `ATLAS_MCP_MAX_SESSIONS` env var (a positive integer;
   * anything malformed falls back to this default). Resolved via
   * {@link resolveMcpMaxSessions}.
   */
  readonly mcpMaxSessions: number;

  /**
   * Email sink address the staging outbound clamp redirects every recipient
   * to (so a staging soak exercises real delivery without emailing real
   * addresses). Intentionally IDENTICAL across all three profiles: the clamp
   * only consults it on the `staging` deploy *region* (`clampOutbound`), but a
   * deploy could in principle run that region with `ATLAS_DEPLOY_ENV` left at
   * the default `production` — keeping the value identical means such a
   * region↔env mismatch still redirects to the sink rather than leaking real
   * mail. Only the staging clamp path ever reads it.
   *
   * Legacy override: `STAGING_MAIL_SINK` env var (trimmed; empty / whitespace
   * falls back to this default — see {@link resolveMailSink}).
   */
  readonly mailSink: string;

  /**
   * Whether the deployed container seeds the canonical demo dataset on boot.
   * `false` for every profile today: demo seeding is opt-in via the explicit
   * `ATLAS_SEED_DEMO=true` env var the Railway "Atlas Demo" template sets, and
   * neither prod, staging, nor dev should auto-seed without it. Encoded here
   * so a future env can default to seeding without stamping the var.
   *
   * Legacy override: `ATLAS_SEED_DEMO` env var, matched EXACTLY against
   * `"true"` to mirror the boot script's `[ "$ATLAS_SEED_DEMO" = "true" ]`
   * check — see {@link resolveSeedDemo}.
   */
  readonly seedDemo: boolean;
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
    // null = no managed default → self-hosted (which resolves here when
    // ATLAS_DEPLOY_ENV is unset) keeps the limiter off unless the operator
    // sets ATLAS_RATE_LIMIT_RPM. SaaS prod stamps the env var explicitly.
    rateLimitRpm: null,
    mcpMaxSessions: 100,
    mailSink: "staging-mail@useatlas.dev",
    seedDemo: false,
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
    // A real limit so a self-hosted-shaped staging soak is protected without
    // stamping the env var; matches the SaaS boot-smoke fixture / guard's
    // suggested 300. In SaaS-mode staging the env var is required and shadows it.
    rateLimitRpm: 300,
    mcpMaxSessions: 100,
    mailSink: "staging-mail@useatlas.dev",
    seedDemo: false,
  },
  // Dev mirrors staging — local signup should be instant; onboarding
  // emails would spam the developer or hit a real Resend account.
  development: {
    requireEmailVerification: false,
    onboardingEmailsEnabled: false,
    // Local dev sets NEXT_PUBLIC_ATLAS_COOKIE_PREFIX=atlas-dev (see .env.example)
    // so the web proxy and API agree.
    cookiePrefix: "atlas-dev",
    // Dev leaves the limiter off by default — local loops would trip a limit.
    rateLimitRpm: null,
    mcpMaxSessions: 100,
    mailSink: "staging-mail@useatlas.dev",
    seedDemo: false,
  },
};

// Construction-time guard: the resolvers validate the *override* path but
// return the table value unchecked on the *default* path (e.g. resolveMailSink
// returns `profile.mailSink` as-is, resolveMcpMaxSessions returns
// `profile.mcpMaxSessions` as-is). The field types (`number`, `string`) permit
// semantically-illegal values (`0`, `""`) the resolvers exist to prevent, so a
// typo in PROFILES above would otherwise produce a silently-illegal default no
// override-path test would catch. Fail loudly at import instead. Runs once.
for (const [env, profile] of Object.entries(PROFILES)) {
  if (profile.rateLimitRpm !== null && !(Number.isInteger(profile.rateLimitRpm) && profile.rateLimitRpm >= 1)) {
    throw new Error(`env-profile: ${env}.rateLimitRpm must be null or a positive integer, got ${profile.rateLimitRpm}`);
  }
  if (!(Number.isInteger(profile.mcpMaxSessions) && profile.mcpMaxSessions >= 1)) {
    throw new Error(`env-profile: ${env}.mcpMaxSessions must be a positive integer, got ${profile.mcpMaxSessions}`);
  }
  if (profile.mailSink.trim() === "") {
    throw new Error(`env-profile: ${env}.mailSink must be a non-empty address`);
  }
}

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

/**
 * Resolve the per-user rate-limit RPM honoring the `ATLAS_RATE_LIMIT_RPM`
 * env-var override: a set env var wins verbatim (including `""`, the
 * operator's explicit "disable"); otherwise the deploy-env profile default
 * applies (`null` → `undefined`, i.e. no managed default).
 *
 * Returns a `string | undefined` rather than a number so it slots in as the
 * fallback to `getSetting("ATLAS_RATE_LIMIT_RPM")` in `getRpmLimit()` without
 * reshaping the existing parse path — and so the DB-override > env-var >
 * profile-default precedence stays intact (`getSetting` already returns a DB
 * override or the env var when present; this only fills the `undefined` gap).
 *
 * NOTE: the SaaS boot guard (`saas-guards.ts :: RateLimitGuardLive`) reads the
 * raw env var directly, NOT this resolver — its contract is that the var must
 * be set at deploy time, so it must not be satisfiable by a profile fallback.
 */
export function resolveRateLimitRpm(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.ATLAS_RATE_LIMIT_RPM;
  if (raw !== undefined) return raw;
  const def = getEnvProfile(env).rateLimitRpm;
  return def === null ? undefined : String(def);
}

/**
 * Resolve the hosted-MCP max concurrent sessions honoring the
 * `ATLAS_MCP_MAX_SESSIONS` env-var override: a positive integer wins;
 * anything malformed (non-numeric, `< 1`, empty/whitespace) falls back to the
 * deploy-env profile default.
 *
 * Pure (no logging) so it can live in this dependency-free module — the hosted
 * MCP route keeps a `log.warn` for the malformed-override case at its call site
 * (`packages/mcp/src/hosted.ts`), where a logger is available.
 */
export function resolveMcpMaxSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ATLAS_MCP_MAX_SESSIONS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return getEnvProfile(env).mcpMaxSessions;
}

/**
 * Resolve the staging email-sink address honoring the `STAGING_MAIL_SINK`
 * env-var override, then the deploy-env profile default. Uses `||` (not `??`)
 * after a `.trim()` on purpose: an explicitly-empty or whitespace-only
 * override must fall back to the default rather than blank the recipient (a
 * blank `to` would bounce silently in the transport or let mail escape). The
 * staging outbound clamp (`lib/staging/clamp.ts`) is the only caller.
 */
export function resolveMailSink(env: NodeJS.ProcessEnv = process.env): string {
  return env.STAGING_MAIL_SINK?.trim() || getEnvProfile(env).mailSink;
}

/**
 * Resolve whether the deployed container should seed the demo dataset.
 *
 * The override grammar mirrors the boot script's `[ "$ATLAS_SEED_DEMO" = "true" ]`
 * EXACTLY: when `ATLAS_SEED_DEMO` is set to ANY value, only the literal
 * `"true"` enables (every other set value — `"false"`, `"0"`, `"1"`, … — means
 * "do not seed", and never falls through to the profile). Only when the var is
 * unset does the deploy-env profile default apply. This keeps behavior
 * identical to the legacy shell check (all profiles default `false` today, and
 * unset → no seed).
 */
export function resolveSeedDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ATLAS_SEED_DEMO;
  if (raw !== undefined) return raw === "true";
  return getEnvProfile(env).seedDemo;
}
