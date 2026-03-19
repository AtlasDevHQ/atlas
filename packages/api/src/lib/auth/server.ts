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
import { stripe as stripePlugin } from "@better-auth/stripe";
import Stripe from "stripe";
import { getInternalDB, hasInternalDB, internalQuery, updateWorkspacePlanTier, type PlanTier } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { isEnterpriseEnabled } from "../../../../../ee/src/index";
import { ac, owner as ownerRole, admin as adminRole, member as memberRole } from "@atlas/api/lib/auth/org-permissions";
import { getStripePlans } from "@atlas/api/lib/billing/plans";

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
    admin({ defaultRole: "member", adminRoles: ["admin"] }),
    organization({
      ac,
      roles: { owner: ownerRole, admin: adminRole, member: memberRole },
      async sendInvitationEmail(data) {
        log.warn(
          { email: data.email, orgName: data.organization.name, inviterId: data.inviter.user.id },
          "Organization invitation created but email delivery is not configured — share the invite link manually",
        );
      },
    }),
  ];

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
                if (orgId && (plan.name === "team" || plan.name === "enterprise")) {
                  try {
                    await updateWorkspacePlanTier(orgId, plan.name as PlanTier);
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
              async onSubscriptionDeleted({ subscription }) {
                const orgId = subscription.referenceId;
                if (orgId) {
                  try {
                    await updateWorkspacePlanTier(orgId, "free");
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
      user: {
        create: {
          before: async (user) => {
            try {
              if (adminEmail && user.email?.toLowerCase().trim() === adminEmail) {
                log.info({ email: user.email }, "Bootstrap: promoting signup to admin (ATLAS_ADMIN_EMAIL match)");
                return { data: { ...user, role: "admin" } };
              }

              if (!adminEmail) {
                if (!hasInternalDB()) return;
                const rows = await internalQuery<{ id: string }>(
                  `SELECT id FROM "user" WHERE role = 'admin' LIMIT 1`,
                );
                if (rows.length === 0) {
                  log.info({ email: user.email }, "Bootstrap: no admin exists — promoting first signup to admin");
                  return { data: { ...user, role: "admin" } };
                }
              }

            } catch (err) {
              log.error({ err }, "Bootstrap admin check failed — defaulting to normal role assignment");
            }
          },
          after: async (user) => {
            // Domain-based SSO auto-provisioning: if the user's email domain
            // matches an enabled SSO provider, auto-add them to that org.
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

              // Auto-add as member — awaited so failures are caught by the
              // surrounding try/catch and logged as warnings.
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
                { err: err instanceof Error ? err.message : String(err), userId: user.id },
                "SSO auto-provisioning failed — user created but not auto-joined to org",
              );
            }
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
