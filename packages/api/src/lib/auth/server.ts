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

  const instance = betterAuth({
    // getInternalDB() returns a pg.Pool typed as InternalPool.
    // Cast needed because Better Auth expects its own pool/adapter type.
    database: getInternalDB() as unknown as Parameters<typeof betterAuth>[0]["database"],
    secret,
    baseURL,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    socialProviders,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    plugins: buildPlugins(),
    trustedOrigins:
      process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [],
    advanced: cookieDomain ? {
      defaultCookieAttributes: {
        domain: `.${cookieDomain}`,
      },
    } : undefined,
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
