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
import { getInternalDB, hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { ac, owner as ownerRole, admin as adminRole, member as memberRole } from "@atlas/api/lib/auth/org-permissions";

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
    plugins: [
      bearer(),
      apiKey(),
      admin({ defaultRole: "member", adminRoles: ["admin", "owner"] }),
      organization({
        ac,
        roles: { owner: ownerRole, admin: adminRole, member: memberRole },
        async sendInvitationEmail(data) {
          // Log the invitation for now. Email delivery can be wired up via
          // a plugin (e.g. email-digest) or env-configured SMTP later.
          log.warn(
            { email: data.email, orgName: data.organization.name, inviterId: data.inviter.user.id },
            "Organization invitation created but email delivery is not configured — share the invite link manually",
          );
        },
      }),
    ],
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
