/**
 * Better Auth server instance — lazy singleton.
 *
 * The betterAuth() instance is created on first call to getAuthInstance(),
 * so no Better Auth initialization (database connections, table migrations)
 * happens unless managed mode is actively used. Although this module is
 * loaded into the module graph via static imports (managed.ts → middleware.ts),
 * the actual betterAuth() constructor is deferred until the first managed-mode
 * request invokes getAuthInstance(). The catch-all route additionally uses
 * dynamic import() for the better-auth/next-js adapter, keeping that
 * subpackage out of the bundle for non-managed deployments.
 */

import { betterAuth } from "better-auth";
import { bearer, admin, organization } from "better-auth/plugins";
// @better-auth/api-key must match the better-auth core version.
// Both are pinned to ^1.5.1 in package.json — update together.
import { apiKey } from "@better-auth/api-key";
import { scim } from "@better-auth/scim";
import { stripe as stripePlugin } from "@better-auth/stripe";
import Stripe from "stripe";
import { getInternalDB, hasInternalDB, internalQuery, updateWorkspacePlanTier, updateWorkspaceStatus, type PlanTier } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { isEnterpriseEnabled } from "@atlas/ee/index";
import { ac, owner as ownerRole, admin as adminRole, member as memberRole } from "@atlas/api/lib/auth/org-permissions";
import { adminAccessControl, adminRole as adminUserRole, platformAdminRole } from "@atlas/api/lib/auth/admin-permissions";
import { getStripePlans, resolvePlanTierFromPriceId } from "@atlas/api/lib/billing/plans";
import { invalidatePlanCache, checkResourceLimit } from "@atlas/api/lib/billing/enforcement";

/**
 * Build the socialProviders config from environment variables.
 * Only providers with both CLIENT_ID and CLIENT_SECRET set are enabled.
 * Returns undefined if no providers are configured.
 */
function buildSocialProviders(): Record<string, { clientId: string; clientSecret: string; tenantId?: string }> | undefined {
  const providers: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> = {};

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }

  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    providers.microsoft = {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId: process.env.MICROSOFT_TENANT_ID || "common",
    };
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

const log = createLogger("auth:server");
const billingLog = createLogger("billing");

/**
 * Built-in rate-limit ceilings for Better Auth endpoints. Chosen to slow
 * online brute force and email-verification abuse while tolerating
 * legitimate retry patterns (user fat-fingers password 2–3 times, clicks
 * "resend" a couple of times). Global `max` is the fallback for endpoints
 * without a custom rule; specific surfaces below are tighter.
 *
 * Windows are in seconds. Env vars can override the global window/max at
 * boot — see {@link resolveAuthRateLimitConfig} — but the per-endpoint
 * rules below are constants because relaxing them is almost always a
 * misconfiguration (signup at 100/min eliminates enumeration protection).
 */
const AUTH_RATE_LIMIT_DEFAULTS = {
  window: 60,
  max: 100,
  signInEmail: { window: 60, max: 10 },
  signUpEmail: { window: 60, max: 5 },
  forgetPassword: { window: 60, max: 5 },
  resetPassword: { window: 60, max: 5 },
  sendVerificationEmail: { window: 60, max: 5 },
  verifyEmail: { window: 60, max: 10 },
} as const;

export interface ResolvedAuthRateLimitConfig {
  enabled: boolean;
  window: number;
  max: number;
  storage: "memory" | "database";
  modelName: string;
  customRules: Record<string, { window: number; max: number }>;
}

/**
 * Resolve Better Auth rate-limit configuration from the environment.
 *
 * Better Auth's built-in default is `enabled: true in production, false
 * in development`, and its in-memory store does not share state across
 * processes (Railway autoscale, Vercel serverless, multi-replica Docker).
 * Atlas's threat model (signin brute-force, signup enumeration, password-
 * reset spam) does not line up with either default, so this function:
 *
 * 1. Defaults `enabled: true` regardless of NODE_ENV. Test envs can opt
 *    out with `ATLAS_AUTH_RATE_LIMIT_ENABLED=false`.
 * 2. Uses the DB-backed store when the internal DB is available — shared
 *    counters across replicas. Falls back to `memory` for single-node
 *    self-hosted deployments without an internal DB.
 * 3. Sets tight per-endpoint rules on the surfaces an attacker actually
 *    targets (signin, signup, password-reset, verification-email resend).
 *    The global window/max is the fallback ceiling for other auth paths.
 */
export function resolveAuthRateLimitConfig(
  env: NodeJS.ProcessEnv,
  internalDbAvailable: boolean,
): ResolvedAuthRateLimitConfig {
  const enabled = env.ATLAS_AUTH_RATE_LIMIT_ENABLED?.trim().toLowerCase() !== "false";

  // Surface invalid env values at boot. Operators who set
  // ATLAS_AUTH_RATE_LIMIT_MAX=0 (expecting "disable") or =100x (typo)
  // silently fell back to the default before this warn — a
  // misconfiguration that's easy to miss because it fails toward the
  // safer value. Name the var so grep and log aggregation surface it.
  const parsePositiveInt = (raw: string | undefined, fallback: number, varName: string): number => {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    log.warn(
      { var: varName, value: raw, fallback },
      "Invalid env value — not a positive number. Falling back to the default.",
    );
    return fallback;
  };

  return {
    enabled,
    window: parsePositiveInt(
      env.ATLAS_AUTH_RATE_LIMIT_WINDOW,
      AUTH_RATE_LIMIT_DEFAULTS.window,
      "ATLAS_AUTH_RATE_LIMIT_WINDOW",
    ),
    max: parsePositiveInt(
      env.ATLAS_AUTH_RATE_LIMIT_MAX,
      AUTH_RATE_LIMIT_DEFAULTS.max,
      "ATLAS_AUTH_RATE_LIMIT_MAX",
    ),
    storage: internalDbAvailable ? "database" : "memory",
    modelName: "rateLimit",
    customRules: {
      "/sign-in/email": { ...AUTH_RATE_LIMIT_DEFAULTS.signInEmail },
      "/sign-up/email": { ...AUTH_RATE_LIMIT_DEFAULTS.signUpEmail },
      "/forget-password": { ...AUTH_RATE_LIMIT_DEFAULTS.forgetPassword },
      "/reset-password": { ...AUTH_RATE_LIMIT_DEFAULTS.resetPassword },
      "/send-verification-email": { ...AUTH_RATE_LIMIT_DEFAULTS.sendVerificationEmail },
      "/verify-email": { ...AUTH_RATE_LIMIT_DEFAULTS.verifyEmail },
    },
  };
}

/**
 * Build the Better Auth `emailAndPassword` config block.
 *
 * Pins the F-05 invariant: whenever `requireEmailVerification` is true,
 * `autoSignIn` MUST be false. Sign-in is blocked until the user clicks
 * the verification link anyway, but an accidental `autoSignIn: true` in
 * a future refactor would silently turn signup into a login oracle
 * (attacker signs up with a victim's email → gets a session regardless
 * of whether the account existed). The unit tests pin this exactly.
 */
export function buildEmailAndPasswordConfig(requireEmailVerification: boolean): {
  enabled: true;
  requireEmailVerification: boolean;
  autoSignIn: boolean;
} {
  return {
    enabled: true,
    requireEmailVerification,
    autoSignIn: !requireEmailVerification,
  };
}

/**
 * Build the Better Auth `advanced` config block.
 *
 * Pins `ipAddress.ipAddressHeaders = ["x-atlas-client-ip"]` — this is
 * the single knob the rate limiter reads. Adding `x-forwarded-for` to
 * the list would make every request's IP client-spoofable and silently
 * reopens F-06. The tests assert this list is exactly the one custom
 * header we set in `withClientIpHeader`.
 *
 * `cookieDomain` is optional; when present the returned block also sets
 * the shared-subdomain cookie attribute for SaaS deployments.
 */
export function buildAdvancedConfig(cookieDomain: string | undefined): {
  ipAddress: { ipAddressHeaders: string[] };
  defaultCookieAttributes?: { domain: string };
} {
  return {
    ipAddress: {
      ipAddressHeaders: ["x-atlas-client-ip"],
    },
    ...(cookieDomain
      ? { defaultCookieAttributes: { domain: `.${cookieDomain}` } }
      : {}),
  };
}

/**
 * Default Better Auth `session.cookieCache.maxAge`, in seconds.
 *
 * F-07 — the earlier value of 5 minutes meant `auth.api.banUser(...)` and
 * `revokeSession(...)` took up to 5 minutes to kick a compromised or
 * banned user out of authenticated routes, because the cookie cache
 * short-circuited the DB lookup that surfaces the ban/revocation. 30s
 * preserves the perf win of cookie cache (one DB read per 30s per
 * session, not per request) while bounding the revocation window to
 * seconds rather than minutes.
 *
 * Operators with measurably hot session lookups can raise this via
 * `ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC` — the resolver clamps the
 * value to `[SESSION_COOKIE_CACHE_MIN_SEC, SESSION_COOKIE_CACHE_MAX_SEC]`
 * so a typo like `=3000000` can't silently restore a multi-hour
 * revocation blind spot.
 */
export const SESSION_COOKIE_CACHE_DEFAULT_SEC = 30;
export const SESSION_COOKIE_CACHE_MIN_SEC = 5;
export const SESSION_COOKIE_CACHE_MAX_SEC = 300;

/**
 * Resolve Better Auth `session.cookieCache.maxAge` (seconds) from env.
 *
 * Defaults to {@link SESSION_COOKIE_CACHE_DEFAULT_SEC} (30s). Values
 * outside `[SESSION_COOKIE_CACHE_MIN_SEC, SESSION_COOKIE_CACHE_MAX_SEC]`
 * are logged and clamped — we never silently fall back to the old
 * 5-minute value, and we never allow a zero/negative value that would
 * effectively disable cookie cache (a perf footgun that looks innocuous
 * in an env file).
 *
 * Returning a plain number keeps the call site in `betterAuth({ session })`
 * trivial and test-pinnable without mocking Better Auth internals.
 */
export function resolveSessionCookieCacheMaxAge(env: NodeJS.ProcessEnv): number {
  const raw = env.ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC;
  if (raw === undefined || raw.trim() === "") return SESSION_COOKIE_CACHE_DEFAULT_SEC;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn(
      { var: "ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC", value: raw, fallback: SESSION_COOKIE_CACHE_DEFAULT_SEC },
      "Invalid env value — not a positive number. Falling back to the default.",
    );
    return SESSION_COOKIE_CACHE_DEFAULT_SEC;
  }

  const floored = Math.floor(parsed);
  if (floored < SESSION_COOKIE_CACHE_MIN_SEC) {
    log.warn(
      { var: "ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC", value: raw, min: SESSION_COOKIE_CACHE_MIN_SEC },
      "Value below minimum — clamping up. Cookie cache below 5s gives up most of its perf benefit.",
    );
    return SESSION_COOKIE_CACHE_MIN_SEC;
  }
  if (floored > SESSION_COOKIE_CACHE_MAX_SEC) {
    log.warn(
      { var: "ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC", value: raw, max: SESSION_COOKIE_CACHE_MAX_SEC },
      "Value above maximum — clamping down. F-07: cookie cache beyond 5 minutes delays ban/revoke beyond acceptable bounds.",
    );
    return SESSION_COOKIE_CACHE_MAX_SEC;
  }
  return floored;
}

/**
 * Resolve whether email verification is required from the environment.
 *
 * Defaults to `true` for security hardening. Multi-tenant deployments
 * must leave it on — verification closes the signup-enumeration oracle
 * (OWASP A07 authentication failures) and prevents unverified accounts
 * from triggering email-keyed workflows (SSO domain auto-provision,
 * invitation claim, bootstrap admin race).
 *
 * Self-hosted single-tenant deployments that run without an email
 * provider can opt out with `ATLAS_REQUIRE_EMAIL_VERIFICATION=false`.
 * Accepts `false`, `0`, `no`, `off` (case-insensitive) as opt-out.
 */
export function resolveRequireEmailVerification(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ATLAS_REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase();
  if (raw === undefined) return true;
  return !["false", "0", "no", "off"].includes(raw);
}

/**
 * Send the email verification message via Atlas's email delivery layer.
 *
 * Kept thin so the Better Auth `sendVerificationEmail` callback stays
 * simple and tests can mock this single function without standing up
 * the whole provider chain.
 *
 * Delivery failures are logged but never thrown — blocking the signup
 * or signin handler on a transient SMTP outage is worse UX than letting
 * the user retry via `/send-verification-email`, and Better Auth already
 * returns the same 200 response for new and existing emails regardless
 * of whether send succeeds (OWASP enumeration protection hinges on
 * response parity, not delivery).
 *
 * @internal — exported for testing.
 */
export async function _sendVerificationEmail(opts: { to: string; url: string }): Promise<void> {
  // All failure paths (dynamic import rejection, provider SDK throwing,
  // template assembly) must be caught here. The Better Auth callback
  // fires this function as fire-and-forget (with an outer `.catch(...)`
  // for belt-and-suspenders) for timing-attack mitigation, and a
  // floating rejection would either print to stderr with no correlation
  // or, on `--unhandled-rejections=strict`, terminate the process —
  // re-introducing the enumeration oracle through a 500 side channel.
  try {
    const { sendEmail } = await import("@atlas/api/lib/email/delivery");
    const result = await sendEmail({
      to: opts.to,
      subject: "Verify your Atlas email address",
      html: `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #222;">
    <p>Welcome to Atlas. Click the link below to verify your email address:</p>
    <p><a href="${encodeAttributeValue(opts.url)}" style="color:#0ea5e9;">Verify email</a></p>
    <p style="color:#666; font-size:13px;">If you did not try to create an account, you can safely ignore this message.</p>
    <p>— Atlas</p>
  </body>
</html>`,
    });
    if (!result.success) {
      log.warn(
        { to: opts.to, provider: result.provider, error: result.error },
        "Email verification delivery did not complete — user may need to retry via /send-verification-email",
      );
    }
  } catch (err) {
    log.warn(
      { to: opts.to, err: err instanceof Error ? err.message : String(err) },
      "Email verification dispatch crashed — signup response is still 200 to preserve enumeration protection; user may need to retry via /send-verification-email",
    );
  }
}

/**
 * Minimal HTML attribute-value escape for the verification URL. Better
 * Auth URLs are well-formed, but a `"` in the token would break the
 * `<a href="...">` attribute and — absent this — could produce a
 * malformed email that some clients render inert. Replaces the five
 * XML-special characters; anything else passes through as-is.
 */
function encodeAttributeValue(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build the Better Auth plugins array.
 *
 * Stripe plugin is conditionally included when STRIPE_SECRET_KEY is set.
 * This keeps all Stripe dependencies out of the module graph for
 * self-hosted deployments that don't use billing.
 */
function buildPlugins() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin types are complex union types that vary by plugin combination
  const plugins: any[] = [
    bearer(),
    apiKey(),
    admin({
      defaultRole: "member",
      ac: adminAccessControl,
      roles: {
        admin: adminUserRole,
        platform_admin: platformAdminRole,
      },
    }),
    organization({
      ac,
      roles: { owner: ownerRole, admin: adminRole, member: memberRole },
      async sendInvitationEmail(data) {
        log.warn(
          { email: data.email, orgName: data.organization.name, inviterId: data.inviter.user.id },
          "Organization invitation created but email delivery is not configured — share the invite link manually",
        );

        // Trigger onboarding milestone for the inviter
        try {
          const { onTeamMemberInvited } = await import("@atlas/api/lib/email/hooks");
          onTeamMemberInvited({
            userId: data.inviter.user.id,
            email: data.inviter.user.email,
            orgId: data.organization.id,
          });
        } catch (err) {
          log.debug(
            { err: err instanceof Error ? err.message : String(err) },
            "Onboarding hook not available — non-blocking",
          );
        }
      },
    }),
  ];

  // SCIM directory sync — enterprise only.
  // No try/catch: if the plugin fails to initialize (missing dep, bad config),
  // the auth server must fail to start rather than silently running without
  // SCIM while the admin UI suggests it is available.
  if (isEnterpriseEnabled()) {
    plugins.push(
      scim({
        storeSCIMToken: "encrypted",
        async beforeSCIMTokenGenerated(data) {
          // Only admins can generate SCIM tokens — enforced via Better Auth hook.
          // The admin check is done upstream by the admin route preamble;
          // this hook acts as a defense-in-depth guard.
          // Cast needed: the admin plugin adds `role` to the user object but the
          // SCIM plugin's hook type only includes base user fields.
          const user = data.user as Record<string, unknown> | undefined;
          if (user?.role !== "admin" && user?.role !== "platform_admin") {
            throw new Error("Only admin users can generate SCIM tokens.");
          }
        },
      }),
    );
    log.info("SCIM directory sync plugin enabled (enterprise)");
  }

  // Stripe billing — only when STRIPE_SECRET_KEY is set (SaaS mode)
  if (process.env.STRIPE_SECRET_KEY) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      log.error(
        "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing — "
        + "Stripe plugin will NOT be enabled. Set STRIPE_WEBHOOK_SECRET to enable billing.",
      );
    } else {
      try {
        const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);

        plugins.push(
          stripePlugin({
            stripeClient,
            stripeWebhookSecret: webhookSecret,
            createCustomerOnSignUp: true,
            subscription: {
              enabled: true,
              plans: getStripePlans(),
              async onSubscriptionComplete({ subscription, plan }) {
                const orgId = subscription.referenceId;
                if (orgId && (plan.name === "starter" || plan.name === "pro" || plan.name === "business")) {
                  try {
                    await updateWorkspacePlanTier(orgId, plan.name as PlanTier);
                    invalidatePlanCache(orgId);
                    log.info({ orgId, plan: plan.name }, "Subscription activated — plan tier synced");
                  } catch (err) {
                    log.error(
                      { err: err instanceof Error ? err.message : String(err), orgId, plan: plan.name },
                      "Failed to sync plan tier on subscription activation — Stripe will retry webhook",
                    );
                    throw err;
                  }
                }
              },
              async onSubscriptionCancel({ subscription }) {
                const orgId = subscription.referenceId;
                if (orgId) {
                  try {
                    await updateWorkspacePlanTier(orgId, "free");
                    invalidatePlanCache(orgId);
                    log.info({ orgId }, "Subscription canceled — downgraded to free tier");
                  } catch (err) {
                    log.error(
                      { err: err instanceof Error ? err.message : String(err), orgId },
                      "Failed to downgrade plan on subscription cancel — Stripe will retry webhook",
                    );
                    throw err;
                  }
                }
              },
              async onSubscriptionUpdate({ event, subscription }) {
                const orgId = subscription.referenceId;
                if (!orgId) return;

                // Resolve the new plan tier from the Stripe subscription's price ID
                const stripeSubscription = event.data.object as Stripe.Subscription;
                const priceId = stripeSubscription.items?.data?.[0]?.price?.id;
                if (!priceId) {
                  billingLog.warn(
                    { orgId, subscriptionId: subscription.id },
                    "Subscription updated but no price ID found on Stripe subscription items — skipping plan sync",
                  );
                  return;
                }

                const newTier = resolvePlanTierFromPriceId(priceId);
                if (!newTier) {
                  billingLog.warn(
                    { orgId, priceId },
                    "Subscription updated with unrecognized price ID — cannot map to Atlas plan tier",
                  );
                  return;
                }

                try {
                  await updateWorkspacePlanTier(orgId, newTier);
                  invalidatePlanCache(orgId);
                  billingLog.info(
                    { orgId, newTier, priceId },
                    "Subscription updated — plan tier synced",
                  );
                } catch (err) {
                  billingLog.error(
                    { err: err instanceof Error ? err.message : String(err), orgId, newTier, priceId },
                    "Failed to sync plan tier on subscription update — Stripe will retry webhook",
                  );
                  throw err;
                }
              },
              async onSubscriptionDeleted({ subscription }) {
                const orgId = subscription.referenceId;
                if (orgId) {
                  try {
                    await updateWorkspacePlanTier(orgId, "free");
                    invalidatePlanCache(orgId);
                    log.info({ orgId }, "Subscription deleted — downgraded to free tier");
                  } catch (err) {
                    log.error(
                      { err: err instanceof Error ? err.message : String(err), orgId },
                      "Failed to downgrade plan on subscription delete — Stripe will retry webhook",
                    );
                    throw err;
                  }
                }
              },
            },
            async onEvent(event: Stripe.Event) {
              if (event.type === "invoice.payment_failed") {
                const invoice = event.data.object as Stripe.Invoice;
                const customerId = typeof invoice.customer === "string"
                  ? invoice.customer
                  : invoice.customer?.id;
                // In Stripe API 2025+, subscription lives under parent.subscription_details
                const parentSub = invoice.parent?.subscription_details?.subscription;
                const subscriptionId = typeof parentSub === "string"
                  ? parentSub
                  : parentSub?.id;
                const attemptCount = invoice.attempt_count ?? 0;

                billingLog.warn(
                  { customerId, subscriptionId, attemptCount, invoiceId: invoice.id },
                  "Invoice payment failed (attempt %d)",
                  attemptCount,
                );

                // After 3+ failed attempts, suspend the workspace.
                // Stripe typically retries 3 times over ~3 weeks with Smart Retries.
                if (attemptCount >= 3 && subscriptionId) {
                  try {
                    // Look up the org by subscription's referenceId in Better Auth's subscription table
                    const rows = await internalQuery<{ referenceId: string }>(
                      `SELECT "referenceId" FROM subscription WHERE "stripeSubscriptionId" = $1 LIMIT 1`,
                      [subscriptionId],
                    );
                    const orgId = rows[0]?.referenceId;
                    if (orgId) {
                      await updateWorkspaceStatus(orgId, "suspended");
                      invalidatePlanCache(orgId);
                      billingLog.warn(
                        { orgId, subscriptionId, attemptCount },
                        "Workspace suspended after %d failed payment attempts",
                        attemptCount,
                      );
                    } else {
                      billingLog.warn(
                        { subscriptionId },
                        "Cannot suspend workspace — no subscription found for Stripe subscription ID",
                      );
                    }
                  } catch (err) {
                    billingLog.error(
                      { err: err instanceof Error ? err.message : String(err), subscriptionId, attemptCount },
                      "Failed to suspend workspace after repeated payment failures",
                    );
                    // Do not re-throw — the onEvent handler should not cause Stripe to retry
                    // the entire webhook. The payment failure is already recorded by Stripe.
                  }
                }
              }
            },
          }),
        );

        log.info("Stripe billing plugin enabled");
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to initialize Stripe billing plugin — billing features will be unavailable",
        );
      }
    }
  }

  return plugins;
}

/**
 * Intentionally typed as the base Auth type (without plugin extensions).
 * The codebase only uses .handler, .api.getSession, and .$context — all of
 * which exist on the base type. Plugin-specific API methods (e.g.
 * createApiKey) are handled through Better Auth's HTTP handler, not called
 * directly on this instance.
 *
 * The `as unknown as AuthInstance` cast below exists because
 * @better-auth/api-key and the admin plugin return plugin types that make
 * the concrete Auth<Options> nominally incompatible with
 * Auth<BetterAuthOptions>. This is safe because the base type is a
 * structural subset of the actual instance.
 */
type AuthInstance = ReturnType<typeof betterAuth>;

let _instance: AuthInstance | null = null;

/**
 * Decision returned by {@link computeBootstrapRole} describing whether the
 * signing-up user should be promoted to `platform_admin` during the
 * Better Auth `user.create.before` hook.
 */
export type BootstrapRoleDecision =
  | { promote: false; reason: string }
  | { promote: true; role: "platform_admin"; reason: string };

/**
 * Inputs to {@link computeBootstrapRole}. Split out so tests can drive every
 * branch without a live database.
 *
 * - `adminEmail` — normalized (lowercased + trimmed) value of `ATLAS_ADMIN_EMAIL`
 *   or `undefined` when unset.
 * - `allowFirstSignupAdmin` — `true` when `ATLAS_ALLOW_FIRST_SIGNUP_ADMIN=true`.
 *   Required for the no-admin-exists fallback to fire.
 * - `internalDbAvailable` — `true` when the internal DB is configured; the
 *   fallback is a no-op without it (we can't query the user table).
 * - `countExistingAdmins` — lazy probe that runs only when the fallback is
 *   otherwise allowed.
 */
export interface BootstrapRoleEnv {
  adminEmail: string | undefined;
  allowFirstSignupAdmin: boolean;
  internalDbAvailable: boolean;
  countExistingAdmins: () => Promise<number>;
}

/**
 * Decide whether to promote a signing-up user to `platform_admin`.
 *
 * Two paths promote:
 *   1. The user's email (case-insensitive, trimmed) matches `ATLAS_ADMIN_EMAIL`.
 *   2. `ATLAS_ADMIN_EMAIL` is unset, `ATLAS_ALLOW_FIRST_SIGNUP_ADMIN=true`, the
 *      internal DB is available, and no admin user exists yet.
 *
 * Path 2 is gated behind the explicit opt-in because before 1.2.3 it could be
 * weaponized into a one-request platform takeover on any fresh deployment that
 * hadn't set `ATLAS_ADMIN_EMAIL` yet (see #1728 / F-02).
 */
export async function computeBootstrapRole(
  user: { email: string | null | undefined },
  env: BootstrapRoleEnv,
): Promise<BootstrapRoleDecision> {
  const userEmail = user.email?.toLowerCase().trim();

  if (env.adminEmail && userEmail && userEmail === env.adminEmail) {
    return {
      promote: true,
      role: "platform_admin",
      reason: "ATLAS_ADMIN_EMAIL match",
    };
  }

  if (!env.adminEmail && env.allowFirstSignupAdmin && env.internalDbAvailable) {
    const existing = await env.countExistingAdmins();
    if (existing === 0) {
      return {
        promote: true,
        role: "platform_admin",
        reason: "first-signup fallback (ATLAS_ALLOW_FIRST_SIGNUP_ADMIN=true, no admin exists)",
      };
    }
    return { promote: false, reason: "an admin already exists — fallback skipped" };
  }

  if (!env.adminEmail) {
    return {
      promote: false,
      reason: "ATLAS_ADMIN_EMAIL is unset and ATLAS_ALLOW_FIRST_SIGNUP_ADMIN is not enabled",
    };
  }

  return { promote: false, reason: "email does not match ATLAS_ADMIN_EMAIL" };
}

/**
 * SSO domain-based auto-provisioning: if the user's email domain matches an
 * enabled SSO provider, auto-add them to that org (respecting the member seat
 * limit, failing open on billing infrastructure errors).
 *
 * @internal — exported for testing.
 */
export async function _autoProvisionSsoMember(user: { id: string; email: string | null }): Promise<void> {
  try {
    if (!isEnterpriseEnabled() || !hasInternalDB() || !user.email) return;

    const domain = user.email.split("@")[1]?.toLowerCase();
    if (!domain) return;

    const providers = await internalQuery<{ org_id: string }>(
      `SELECT org_id FROM sso_providers WHERE domain = $1 AND enabled = true LIMIT 1`,
      [domain],
    );
    if (providers.length === 0) return;

    const orgId = providers[0].org_id;

    // Check if already a member (idempotent)
    const existing = await internalQuery<{ id: string }>(
      `SELECT id FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [user.id, orgId],
    );
    if (existing.length > 0) return;

    // Check member limit before auto-provisioning.
    // Note: check-then-act is not atomic. Under concurrent signups the member
    // limit can be briefly exceeded by a small margin. Acceptable for a billing
    // soft-limit — reconciliation catches overages at next check.
    try {
      const memberRows = await internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`,
        [orgId],
      );
      const currentCount = memberRows[0]?.count ?? 0;
      const limitCheck = await checkResourceLimit(orgId, "seats", currentCount);
      if (!limitCheck.allowed) {
        // checkResourceLimit fails closed on infra errors (returns
        // allowed: false, limit: 0). Detect this sentinel and fail open —
        // blocking SSO login is worse than transient over-provisioning.
        if (limitCheck.limit === 0) {
          log.warn(
            { userId: user.id, orgId },
            "SSO auto-provisioning: billing check returned limit=0 (infra error?) — allowing provisioning",
          );
        } else {
          log.warn(
            { userId: user.id, email: user.email, domain, orgId, limit: limitCheck.limit },
            "SSO auto-provisioning skipped — organization at member limit (%d/%d)",
            currentCount,
            limitCheck.limit,
          );
          return;
        }
      }
    } catch (err) {
      // Handles unexpected failures in the COUNT query or unanticipated
      // exceptions from checkResourceLimit. Fail open: blocking SSO login
      // is worse than transient over-provisioning.
      log.warn(
        { err: err instanceof Error ? err.message : String(err), errName: err instanceof Error ? err.name : "unknown", userId: user.id, orgId },
        "SSO auto-provisioning: member limit check failed — allowing provisioning",
      );
    }

    // Auto-add as member
    await getInternalDB().query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES (gen_random_uuid(), $1, $2, 'member', now())`,
      [orgId, user.id],
    );

    log.info(
      { userId: user.id, email: user.email, domain, orgId },
      "SSO auto-provisioning: user added to organization via domain match",
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId: user.id, email: user.email },
      "SSO auto-provisioning failed — user created but not auto-joined to org",
    );
  }
}

export function getAuthInstance(): AuthInstance {
  if (_instance) return _instance;

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Managed auth mode requires this environment variable.",
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least 32 characters (got ${secret.length}). Use a cryptographically random string.`,
    );
  }

  const adminEmail = process.env.ATLAS_ADMIN_EMAIL?.toLowerCase().trim();

  // Resolve ATLAS_ALLOW_FIRST_SIGNUP_ADMIN once at boot. Accept the common
  // truthy spellings (true/1/yes/on, case-insensitive, trimmed) — operators
  // who type "TRUE" or "1" should not silently get the off path. Warn on
  // non-empty values we don't recognize so misconfiguration is visible.
  const rawAllowFlag = process.env.ATLAS_ALLOW_FIRST_SIGNUP_ADMIN?.trim();
  const allowFirstSignupAdmin =
    rawAllowFlag !== undefined && ["true", "1", "yes", "on"].includes(rawAllowFlag.toLowerCase());
  if (rawAllowFlag && !allowFirstSignupAdmin) {
    log.warn(
      { value: rawAllowFlag },
      "ATLAS_ALLOW_FIRST_SIGNUP_ADMIN is set to an unrecognized value — treating as off. Valid: true, 1, yes, on (case-insensitive).",
    );
  } else if (allowFirstSignupAdmin) {
    log.warn(
      "ATLAS_ALLOW_FIRST_SIGNUP_ADMIN is enabled — the first signup when no admin exists will be promoted to platform_admin. Set ATLAS_ADMIN_EMAIL for production deployments.",
    );
  }

  // Derive parent domain for cross-subdomain cookies (e.g. "useatlas.dev" from
  // BETTER_AUTH_URL="https://api.useatlas.dev"). Only enabled when CORS origin
  // is set (i.e. cross-origin deployment). Without this, cookies are scoped to
  // the API subdomain and won't be sent from the frontend subdomain.
  const corsOrigin = process.env.ATLAS_CORS_ORIGIN;
  let cookieDomain: string | undefined;
  if (corsOrigin && process.env.BETTER_AUTH_URL) {
    try {
      const host = new URL(process.env.BETTER_AUTH_URL).hostname;
      const parts = host.split(".");
      if (parts.length >= 2) {
        cookieDomain = parts.slice(-2).join(".");
      }
    } catch { /* ignore malformed URL */ }
  }

  // Resolve base URL: explicit env var > Vercel auto-detect > undefined (Better Auth auto-detect).
  // On Vercel, VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL are always set.
  // Without a baseURL, Better Auth logs a noisy warning on every cold start.
  const baseURL =
    process.env.BETTER_AUTH_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : undefined);

  const socialProviders = buildSocialProviders();
  if (socialProviders) {
    log.info({ providers: Object.keys(socialProviders) }, "Social login providers configured");
  }

  // F-05 + F-06 — resolve security-sensitive auth config at boot so the
  // values are visible in the singleton's memory and, on failure, the
  // server fails at startup rather than on the first attacker request.
  const internalDbAvailable = hasInternalDB();
  const requireEmailVerification = resolveRequireEmailVerification(process.env);
  const rateLimitConfig = resolveAuthRateLimitConfig(process.env, internalDbAvailable);

  if (!requireEmailVerification) {
    log.warn(
      "ATLAS_REQUIRE_EMAIL_VERIFICATION is disabled — signups do not require email confirmation and "
        + "Better Auth's signup-enumeration protection is off (existing emails return a distinct "
        + "USER_ALREADY_EXISTS error). Leave this enabled for any multi-tenant deployment.",
    );
  }
  if (!rateLimitConfig.enabled) {
    log.warn(
      "ATLAS_AUTH_RATE_LIMIT_ENABLED=false — /api/auth/* endpoints are not rate-limited. "
        + "Only use this in isolated test environments.",
    );
  } else {
    log.info(
      { storage: rateLimitConfig.storage, window: rateLimitConfig.window, max: rateLimitConfig.max },
      "Better Auth rate limiting enabled",
    );
  }

  const instance = betterAuth({
    // getInternalDB() returns a pg.Pool typed as InternalPool.
    // Cast needed because Better Auth expects its own pool/adapter type.
    database: getInternalDB() as unknown as Parameters<typeof betterAuth>[0]["database"],
    secret,
    baseURL,
    // F-05: closes the signup-enumeration oracle and blocks unverified
    // accounts from claiming SSO auto-provision / invitation workflows.
    // See `buildEmailAndPasswordConfig` for the `autoSignIn` invariant.
    emailAndPassword: buildEmailAndPasswordConfig(requireEmailVerification),
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        // Do not await. Better Auth's enumeration protection depends on
        // the signup/signin handler returning the same 200 response in
        // the same time window regardless of whether the email exists;
        // awaiting SMTP would extend the attacker's timing oracle and
        // create a DoS vector (email provider outage => signup blocked).
        //
        // `.catch()` is belt-and-suspenders — `_sendVerificationEmail`
        // already wraps everything in try/catch, but an unhandled
        // rejection from any future refactor would either spam stderr
        // with no correlation or (with --unhandled-rejections=strict)
        // crash the process and reintroduce the enumeration oracle as
        // a 500-vs-200 side channel.
        _sendVerificationEmail({ to: user.email, url }).catch((err) => {
          log.warn(
            { to: user.email, err: err instanceof Error ? err.message : String(err) },
            "Verification email dispatch threw — signup response is still 200 to preserve enumeration protection",
          );
        });
      },
      autoSignInAfterVerification: true,
    },
    socialProviders,
    // F-07 — cookieCache.maxAge bounds the revocation window. Previously
    // 5 * 60 (5 minutes), which meant `auth.api.banUser(...)` and
    // `revokeSession(...)` didn't take effect for up to 5 minutes because
    // the signed cookie short-circuited the DB lookup. Default is now 30s,
    // overridable within [5, 300] via ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: resolveSessionCookieCacheMaxAge(process.env) },
    },
    plugins: buildPlugins(),
    trustedOrigins:
      process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [],
    // F-06 — explicit rate limits on /api/auth/*. Built-in defaults are
    // NODE_ENV-gated and in-memory-only; see resolveAuthRateLimitConfig.
    rateLimit: rateLimitConfig,
    // F-06: the `advanced` block wires Better Auth's rate limiter to
    // read only the trusted `x-atlas-client-ip` header that our
    // middleware injects. See `buildAdvancedConfig` for the invariant.
    advanced: buildAdvancedConfig(cookieDomain),
    databaseHooks: {
      member: {
        create: {
          after: async (member: { role: string; userId: string; organizationId: string }) => {
            // When a user becomes org "owner", promote their user-level role
            // to "admin" so Better Auth's admin plugin APIs (list users,
            // manage roles, etc.) work. Without this, org owners have
            // user.role="member" and Better Auth blocks admin operations.
            try {
              if (member.role !== "owner") return;
              if (!hasInternalDB()) return;

              // Don't downgrade platform_admin → admin
              const rows = await internalQuery<{ role: string | null }>(
                `SELECT role FROM "user" WHERE id = $1 LIMIT 1`,
                [member.userId],
              );
              const currentRole = rows[0]?.role;
              if (currentRole === "admin" || currentRole === "platform_admin") return;

              await getInternalDB().query(
                `UPDATE "user" SET role = 'admin' WHERE id = $1`,
                [member.userId],
              );
              log.info(
                { userId: member.userId, orgId: member.organizationId },
                "Promoted org owner to user-level admin",
              );
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err), userId: member.userId },
                "Failed to promote org owner to admin — Better Auth admin APIs may return 403",
              );
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            // Auto-set the active org on login when the user has exactly one
            // org and the session doesn't already have one. Uses the `before`
            // hook so Better Auth writes the activeOrganizationId directly
            // into the session row (no post-hoc UPDATE needed).
            try {
              if (session.activeOrganizationId) return;
              if (!hasInternalDB()) return;

              const orgs = await internalQuery<{ organizationId: string }>(
                `SELECT "organizationId" FROM member WHERE "userId" = $1 LIMIT 2`,
                [session.userId],
              );
              if (orgs.length !== 1) return;

              log.info(
                { userId: session.userId, orgId: orgs[0].organizationId },
                "Auto-set active organization for new session",
              );
              return {
                data: {
                  ...session,
                  activeOrganizationId: orgs[0].organizationId,
                },
              };
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err), userId: session.userId },
                "Failed to auto-set active org — user may need to switch manually",
              );
            }
          },
          after: async (session) => {
            // Emit a login usage event for active-user tracking.
            // Fire-and-forget — never blocks or fails sign-in.
            try {
              let orgId = session.activeOrganizationId;

              // The `before` hook may have set activeOrganizationId but
              // Better Auth may not propagate the mutation to `after`.
              // Fall back to querying the member table for single-org users.
              if (!orgId) {
                try {
                  const { internalQuery, hasInternalDB } = await import("@atlas/api/lib/db/internal");
                  if (hasInternalDB()) {
                    const rows = await internalQuery<{ organizationId: string }>(
                      `SELECT "organizationId" FROM member WHERE "userId" = $1 LIMIT 2`,
                      [session.userId],
                    );
                    if (rows.length === 1) orgId = rows[0].organizationId;
                  }
                } catch {
                  // intentionally best-effort — skip if lookup fails
                }
              }

              if (!orgId) return; // No workspace context — skip

              const { emitLoginEvent } = await import("@atlas/api/lib/metering");
              void emitLoginEvent(String(orgId), String(session.userId));
            } catch (err) {
              // intentionally best-effort — never block sign-in on metering
              log.debug(
                { err: err instanceof Error ? err.message : String(err), userId: session.userId },
                "Login event emission skipped",
              );
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const internalDbAvailable = hasInternalDB();
            try {
              const decision = await computeBootstrapRole(user, {
                adminEmail,
                allowFirstSignupAdmin,
                internalDbAvailable,
                countExistingAdmins: async () => {
                  const rows = await internalQuery<{ id: string }>(
                    `SELECT id FROM "user" WHERE role IN ('admin', 'platform_admin') LIMIT 1`,
                  );
                  return rows.length;
                },
              });

              if (decision.promote) {
                // Fallback path uses warn so operators running with the opt-in
                // flag see a nudge toward the safer ATLAS_ADMIN_EMAIL config.
                const logFn = decision.reason.startsWith("first-signup fallback") ? log.warn : log.info;
                logFn.call(
                  log,
                  { email: user.email, reason: decision.reason },
                  "Bootstrap: promoting signup to platform_admin",
                );
                return { data: { ...user, role: decision.role } };
              }

            } catch (err) {
              // Include the full env state in the log so operators who expected
              // their signup to be promoted (ATLAS_ADMIN_EMAIL match or opt-in
              // fallback) can see WHY it fell through. Without this context, a
              // DB outage or schema drift during legitimate bootstrap would
              // silently lock out the operator with one opaque log line.
              log.error(
                {
                  err: err instanceof Error ? err.message : String(err),
                  email: user.email,
                  hasAdminEmail: !!adminEmail,
                  allowFirstSignupAdmin,
                  internalDbAvailable,
                },
                "Bootstrap admin check failed — defaulting to normal role assignment. Check DB connectivity and env configuration.",
              );
            }
          },
          after: async (user) => {
            // Onboarding welcome email — fire-and-forget after signup.
            // Deferred with setTimeout to allow Better Auth to create the org/membership first.
            if (user.email) {
              const userEmail = user.email;
              setTimeout(async () => {
                try {
                  const { onUserSignup } = await import("@atlas/api/lib/email/hooks");
                  // Look up the user's first org membership
                  const memberships = await internalQuery<{ organizationId: string }>(
                    `SELECT "organizationId" FROM member WHERE "userId" = $1 LIMIT 1`,
                    [user.id],
                  );
                  const orgId = memberships[0]?.organizationId;
                  if (!orgId) {
                    log.warn({ userId: user.id }, "No org membership found after signup — welcome email deferred to fallback scheduler");
                    return;
                  }
                  onUserSignup({ userId: user.id, email: userEmail, orgId });
                } catch (err) {
                  log.warn(
                    { userId: user.id, err: err instanceof Error ? err.message : String(err) },
                    "Failed to trigger welcome email — non-blocking",
                  );
                }
              }, 2000);
            }

            await _autoProvisionSsoMember(user);
          },
        },
      },
    },
  }) as unknown as AuthInstance;

  _instance = instance;
  return instance;
}

export function resetAuthInstance(): void {
  _instance = null;
}

/** @internal — test-only. Inject a mock auth instance. */
export function _setAuthInstance(mock: AuthInstance | null): void {
  _instance = mock;
}

export type Auth = AuthInstance;
