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

import { betterAuth, type Session, type User } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, organization, jwt, customSession } from "better-auth/plugins";
import { twoFactor } from "better-auth/plugins/two-factor";
import { emailOTP } from "better-auth/plugins/email-otp";
// @better-auth/* plugins must match the better-auth core version line.
// All pinned to ^1.6.x in package.json — update together (the peer-dep
// constraint is exact-version per minor on the @better-auth/* side).
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { stripe as stripePlugin, type StripeOptions } from "@better-auth/stripe";
import { authorizeStripeReference } from "@atlas/api/lib/auth/stripe-authorize-reference";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  ATLAS_OAUTH_WORKSPACE_CLAIM,
  ATLAS_OAUTH_WORKSPACES_CLAIM,
  readActiveOrgId,
} from "@atlas/api/lib/auth/oauth-claims";
import { listUserWorkspaceIds } from "@atlas/api/lib/auth/oauth-workspace-grants";
import { recordOAuthTokenRefresh } from "@atlas/api/lib/auth/oauth-refresh-audit";
import Stripe from "stripe";
import { getInternalDB, getWorkspaceDetails, hasInternalDB, internalQuery, updateWorkspacePlanTier, updateWorkspaceStatus, type InternalPool, type PlanTier } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import {
  resolveRequireEmailVerification as envProfileResolveRequireEmailVerification,
  resolveCookiePrefix,
} from "@atlas/api/lib/env-profile";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
// rpID resolution lives in its own pure module so `startup.ts` can validate it
// eagerly without importing better-auth (#3045). Re-exported here so the auth
// surface (and its tests) keep a single import site.
import { resolvePasskeyRpId } from "@atlas/api/lib/auth/rpid";
export { resolvePasskeyRpId, DEFAULT_RP_ID } from "@atlas/api/lib/auth/rpid";
import {
  assertInvitationRoleAllowed,
  dispatchInvitationEmail,
  enforceInvitationSeatLimit,
  recordInvitationCancelled,
  recordInvitationCreated,
} from "@atlas/api/lib/auth/invitations";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { onVerificationCreated } from "@atlas/api/lib/auth/trusted-device-hook";
import { isEnterpriseEnabled } from "@atlas/api/lib/effect/enterprise-config";
import { ac, owner as ownerRole, admin as adminRole, member as memberRole } from "@atlas/api/lib/auth/org-permissions";
import { blockNativeMemberRoleUpdate, blockNativeMemberRemoval } from "@atlas/api/lib/auth/org-member-guards";
import { resolveEffectiveRole } from "@atlas/api/lib/auth/effective-role";
import { enforceBanOnSessionCreate } from "@atlas/api/lib/auth/admin-user-ops";
import { getStripePlans, resolvePlanTierFromPriceId, TRIAL_DAYS } from "@atlas/api/lib/billing/plans";
import { userHasConsumedTrial } from "@atlas/api/lib/billing/trial-eligibility";
import { getStripeClient } from "@atlas/api/lib/billing/stripe-client";
import { invalidatePlanCache, checkResourceLimit } from "@atlas/api/lib/billing/enforcement";
import {
  classifyStripeEvent,
  recordStripeEvent,
  type StripeLedgerEvent,
} from "@atlas/api/lib/billing/stripe-event-ledger";
import { getConfig } from "@atlas/api/lib/config";
import { SaasCrm } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { Effect } from "effect";

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
 * Role gate for SCIM token generation. SCIM tokens are bearer tokens an
 * external IdP uses to provision/deprovision users in the workspace, so
 * minting one is an admin-level action.
 *
 * Mirrors the canonical `ADMIN_ROLES` triple used by every other admin
 * gate (middleware.ts:adminAuth, admin-auth.ts:requireAdminAuth,
 * admin-router.ts:createAdminRouter). #2242 — pre-fix this set was
 * {admin, platform_admin} which bombed org owners with "Only admin users
 * can generate SCIM tokens" even though they could manage SCIM
 * connections at `/api/v1/admin/scim/*`.
 *
 * Note: SCIM token-generation lives on Better Auth's catch-all
 * (`POST /api/auth/scim/generate-token`), NOT under `createAdminRouter()`
 * — so the `beforeSCIMTokenGenerated` hook that calls this predicate IS
 * the role gate, not a defense-in-depth guard.
 *
 * Hardcoded literal (not imported from `@useatlas/types/auth:ADMIN_ROLES`)
 * because this file is template-synced to create-atlas; see the same
 * pattern in `api/routes/middleware.ts`.
 */
export function canMintSCIMToken(role: unknown): boolean {
  return role === "admin" || role === "owner" || role === "platform_admin";
}

/**
 * Effective authorization for SCIM token generation (#2890).
 *
 * The `beforeSCIMTokenGenerated` hook only receives the user object, whose
 * raw `user.role` post-#2890 only ever carries `platform_admin` — tenant
 * admin-ness now lives in `member.role`. A raw-role check ({@link
 * canMintSCIMToken}) alone would therefore deny every org owner/admin, who
 * are exactly the people that set up SCIM. Resolve the effective grant:
 * `platform_admin` via user.role, OR an `admin`/`owner` member row in any of
 * the user's orgs (the same intent the `ADMIN_ROLES` triple encodes).
 *
 * Fails CLOSED on a member-table lookup error — minting an IdP provisioning
 * token is high-privilege, so a transient DB blip denies rather than grants.
 * Without an internal DB (single-tenant self-hosted with no member table)
 * falls back to the raw-role predicate.
 */
export async function canGenerateSCIMToken(role: unknown, userId: string | undefined): Promise<boolean> {
  if (role === "platform_admin") return true;
  if (!userId || !hasInternalDB()) return canMintSCIMToken(role);
  try {
    const rows = await internalQuery<{ ok: number }>(
      `SELECT 1 AS ok FROM member WHERE "userId" = $1 AND role IN ('admin', 'owner') LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  } catch (err) {
    log.warn(
      { err: errorMessage(err), userId },
      "SCIM token authorization member lookup failed — denying (fail closed)",
    );
    return false;
  }
}

// #2890 removed `promoteOrgOwnerToAdmin`. The org plugin already inserts the
// creator as a member with `member.role='owner'` (Better Auth `creatorRole`
// default), which is the single source of truth for tenant admin-ness —
// `resolveEffectiveRole` surfaces it as the effective role for both Atlas's
// admin console and the client. Writing a redundant `user.role='admin'` on
// org create was the exact middle state that issue dropped; the admin-plugin
// ACL no longer even defines `admin`, so a write would be dead data.

/**
 * Flip a newly-created SaaS workspace from the DB default `plan_tier='free'`
 * onto `'trial'` with `trial_ends_at = NOW() + TRIAL_DAYS` — or onto
 * `'locked'` when the creating user has already consumed a trial (#3426,
 * one trial per user — see {@link userHasConsumedTrial} for the recorded
 * policy). Self-hosted orgs stay on `'free'` — the deploy-mode guard is
 * the only thing separating "Atlas as the free self-hosted product" from
 * "Atlas as the hosted SaaS trial". Without this hook, every SaaS
 * workspace lands on the free-tier definition and `/admin/model-config`
 * renders the literal `"user-configured"` sentinel from `plans.ts`.
 *
 * Wired into `organizationHooks.afterCreateOrganization` in
 * {@link buildPlugins}.
 * Better Auth runs hooks sequentially via the composed `async` wrapper —
 * each hook catches its own errors so a failure in either doesn't poison
 * org creation.
 *
 * Idempotent: SELECT-then-UPDATE pattern with a guard that re-asserts
 * `plan_tier = 'free'` in the WHERE clause. Re-invocations on an already-
 * promoted org are a no-op. A platform-admin override that pre-seeded the
 * org with a non-default tier is also preserved.
 *
 * Exported for direct unit testing — the org plugin closes over its
 * options, so the only way to assert this hook's contract from outside
 * the plugin is to test the function in isolation.
 *
 * @internal
 */
export async function assignSaasTrial(args: {
  user: { id: string };
  organization: { id: string };
}): Promise<void> {
  const { user, organization: org } = args;
  try {
    if (!hasInternalDB()) return;
    if (getConfig()?.deployMode !== "saas") return;

    // Re-check current tier before writing. A pre-seeded non-default tier
    // (test fixtures, platform-admin provisioning) wins — we don't clobber
    // it back to 'trial'. The WHERE clause on the UPDATE is belt-and-
    // suspenders so a TOCTOU race between SELECT and UPDATE can't downgrade
    // a paid org.
    const existing = await internalQuery<{ plan_tier: PlanTier }>(
      `SELECT plan_tier FROM organization WHERE id = $1 LIMIT 1`,
      [org.id],
    );
    if (existing[0]?.plan_tier !== "free") return;

    // One trial per user (#3426): a creator who already owns a trialed
    // workspace gets NO fresh trial — the new org lands directly on the
    // zero-entitlement 'locked' churn tier (#3421), where enforcement
    // blocks gated actions exactly like an ended subscription and the
    // billing page offers the upgrade path. The org IS still created (no
    // hard org cap — that would block legitimate paid multi-org
    // customers). `trial_ends_at = NOW()` stamps the trial as consumed so
    // `getCheckoutSessionParams`' double-trial suppression also withholds
    // the Stripe-side trial at first checkout.
    if (await userHasConsumedTrial(user.id, org.id)) {
      await internalQuery(
        `UPDATE organization SET plan_tier = 'locked', trial_ends_at = $1
         WHERE id = $2 AND plan_tier = 'free'`,
        [new Date().toISOString(), org.id],
      );
      log.info(
        { userId: user.id, orgId: org.id },
        "Workspace creator already consumed a SaaS trial — new workspace starts locked (one trial per user, #3426)",
      );
      return;
    }

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    await internalQuery(
      `UPDATE organization SET plan_tier = 'trial', trial_ends_at = $1
       WHERE id = $2 AND plan_tier = 'free'`,
      [trialEndsAt.toISOString(), org.id],
    );
    log.info(
      { userId: user.id, orgId: org.id, trialEndsAt: trialEndsAt.toISOString() },
      "Assigned SaaS trial to new workspace",
    );
  } catch (err) {
    // log.error (not warn) — sustained failures indicate a regression in
    // the hook contract (Better Auth option rename, DB connectivity loss,
    // etc.). Org creation continues; the
    // workspace just stays on plan_tier='free' until the next signup
    // hook fires or an operator runs the backfill manually.
    log.error(
      { err: errorMessage(err), userId: user.id, orgId: org.id },
      "Failed to assign SaaS trial — workspace stays on plan_tier='free'",
    );
  }
}

/**
 * Twenty CRM dispatch for a Better Auth signup. Enqueues a `signup`
 * lead into `crm_outbox` via the `SaasCrm` Tag; the scheduler-backed
 * flusher (`lib/effect/layers.ts:makeSchedulerLive`) picks it up and
 * calls `TwentyClient.upsertPerson` — first/last source semantics live
 * inside `upsertPerson`, not here. Self-hosted resolves to the no-op
 * `SaasCrm` Layer and produces no Twenty traffic.
 *
 * A Twenty outage MUST NOT 500 the signup endpoint. Two layers of
 * defense:
 *  - inner `.pipe(Effect.either)` absorbs `upsertLead`'s typed `Error`
 *    channel (e.g. a `crm_outbox` Postgres blip), with a structured
 *    `log.warn` so the failure surfaces in this module's logs — does
 *    NOT rely on the EE-side `tapError` for the audit trail.
 *  - outer `try/catch` absorbs runtime defects (a stuck `runPromise`,
 *    an unhandled rejection from a future Layer change).
 *
 * Exported for direct unit testing — Better Auth closes over its
 * options inside `buildAuthOptions`, so the only way to assert the
 * contract from outside the plugin wiring is to test the helper in
 * isolation. Mirrors `captureDemoLead` in `lib/demo.ts`.
 *
 * @internal
 */
export async function dispatchSignupCrmLead(args: {
  user: { id: string; email?: string | null; name?: string | null };
}): Promise<void> {
  const { user } = args;
  const email = user.email?.toLowerCase().trim();
  if (!email) return;

  const name = user.name?.trim() || undefined;

  try {
    await runEnterprise(
      Effect.gen(function* () {
        const crm = yield* SaasCrm;
        const result = yield* crm
          .upsertLead({
            source: "signup",
            email,
            ...(name ? { name } : {}),
          })
          .pipe(Effect.either);
        if (result._tag === "Left") {
          log.warn(
            {
              userId: user.id,
              err: errorMessage(result.left),
              event: "signup_crm.enqueue_failed",
            },
            "SaasCrm.upsertLead enqueue failed during signup — swallowed to keep auth response unblocked",
          );
        }
      }),
    );
  } catch (err) {
    log.warn(
      {
        userId: user.id,
        err: errorMessage(err),
        event: "signup_crm.dispatch_defect",
      },
      "Unexpected SaasCrm dispatch error during signup — swallowed to keep auth response unblocked",
    );
  }
}

/**
 * Twenty CRM dispatch for a Stripe subscription that has actually been
 * paid (#2737). Enqueues a `stamp-conversion` row into `crm_outbox` via
 * the `SaasCrm` Tag; the scheduler-backed flusher routes the row through
 * `TwentyClient.upsertPerson` which stamps `atlasStripeCustomerId` on
 * the matching Twenty Person (and creates a new Person with
 * `atlasFirstSource = "CONVERSION"` if none exists).
 *
 * **Call sites:** invoked from two Better Auth Stripe hooks:
 *  - `onSubscriptionComplete` — only when `subscription.status` is
 *    already `"active"` (a paid plan without a trial, or a trial that
 *    completed instantly). Trialing subscriptions are skipped here.
 *  - `onSubscriptionUpdate` — when the underlying Stripe event is
 *    `customer.subscription.updated` and `previous_attributes.status`
 *    transitions from `"trialing"` to `"active"` (i.e. the customer
 *    just paid their first post-trial invoice).
 *
 * **Webhook latency:** enqueue + return immediately. The Twenty side
 * runs out-of-band via the flusher. A Twenty outage MUST NOT 500 the
 * Stripe webhook — Stripe retries on non-2xx for 3 weeks and a failed
 * ack here can stack other webhook deliveries behind it. Two layers of
 * defense, mirroring `dispatchSignupCrmLead`:
 *  - inner `.pipe(Effect.either)` absorbs the typed `Error` channel
 *    (e.g. a `crm_outbox` Postgres blip).
 *  - outer `try/catch` absorbs runtime defects.
 *
 * **Email source:** `subscription.referenceId` is the orgId — enforced
 * since #3416 by the plugin's org mode (`organization.enabled` in
 * {@link buildStripePluginOptions}) with every client call passing
 * `customerType: "organization"`, gated by `authorizeReference`. It is
 * not the user's email. We retrieve the Stripe
 * customer (whose `email` is the address used at checkout) to attribute
 * the stamp back to the same Person record demoed/signed up under that
 * email. A Stripe customer with no email logs and skips — the row would
 * otherwise dead-letter on the very first dispatch.
 *
 * @internal
 */
export async function dispatchConversionCrmStamp(args: {
  stripeClient: Stripe;
  stripeCustomerId: string;
  orgId?: string | null;
}): Promise<void> {
  const { stripeClient, stripeCustomerId, orgId } = args;

  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripeClient.customers.retrieve(stripeCustomerId);
  } catch (err) {
    log.warn(
      {
        stripeCustomerId,
        orgId,
        err: errorMessage(err),
        event: "conversion_crm.customer_retrieve_failed",
      },
      "Stripe customers.retrieve failed during conversion stamp — swallowed to keep webhook ack unblocked",
    );
    return;
  }
  if (customer.deleted) {
    log.warn(
      {
        stripeCustomerId,
        orgId,
        event: "conversion_crm.customer_deleted",
      },
      "Stripe customer is deleted at conversion-stamp time — skipping Twenty stamp",
    );
    return;
  }
  const email = customer.email?.toLowerCase().trim();
  if (!email) {
    log.warn(
      {
        stripeCustomerId,
        orgId,
        event: "conversion_crm.customer_no_email",
      },
      "Stripe customer has no email — cannot attribute conversion stamp to a Twenty Person",
    );
    return;
  }

  try {
    await runEnterprise(
      Effect.gen(function* () {
        const crm = yield* SaasCrm;
        const result = yield* crm
          .stampConversion({ email, stripeCustomerId })
          .pipe(Effect.either);
        if (result._tag === "Left") {
          log.warn(
            {
              orgId,
              stripeCustomerId,
              err: errorMessage(result.left),
              event: "conversion_crm.enqueue_failed",
            },
            "SaasCrm.stampConversion enqueue failed — swallowed to keep webhook ack unblocked",
          );
        }
      }),
    );
  } catch (err) {
    log.warn(
      {
        orgId,
        stripeCustomerId,
        err: errorMessage(err),
        event: "conversion_crm.dispatch_defect",
      },
      "Unexpected SaasCrm dispatch error during conversion stamp — swallowed to keep webhook ack unblocked",
    );
  }
}

/**
 * Decide whether a Stripe webhook hook should call
 * `dispatchConversionCrmStamp`. Pure function, no I/O, no logging —
 * the only meaningful decision logic in #2737's two trigger points is
 * the gating, so it's worth pinning in isolation.
 *
 * Returns a discriminated directive:
 *  - `dispatch` — caller should `await dispatchConversionCrmStamp(...)`.
 *  - `log-and-skip` — caller should emit a structured `log.warn` with
 *    the `reason` and skip. Used only when the customer id is missing
 *    (a structural anomaly worth a breadcrumb).
 *  - `skip` — caller should silently do nothing. Used for the routine
 *    "still trialing" / "not a trial-to-active transition" branches.
 *
 * Trigger semantics:
 *  - `"complete"` — `onSubscriptionComplete`. Stamp only if the
 *    subscription is already `"active"` at completion (no-trial plan
 *    or instant-completion path). Trialing subs defer to the update
 *    trigger below.
 *  - `"update"` — `onSubscriptionUpdate`. Stamp on the trial → active
 *    transition (`previous_attributes.status === "trialing"` and
 *    current `status === "active"`).
 *
 * @internal
 */
export type ConversionStampDirective =
  | { readonly kind: "dispatch"; readonly stripeCustomerId: string }
  | { readonly kind: "log-and-skip"; readonly reason: "no-stripe-customer-id" }
  | { readonly kind: "skip"; readonly reason: "trialing" | "non-active" | "non-transition" };

export function planConversionStamp(args: {
  readonly trigger: "complete";
  readonly subscription: { readonly status?: string | null; readonly stripeCustomerId?: string | null };
} | {
  readonly trigger: "update";
  readonly subscription: { readonly stripeCustomerId?: string | null };
  readonly event: { readonly type: string; readonly data: { readonly previous_attributes?: { readonly status?: string | null } | null; readonly object: { readonly status?: string | null } } };
}): ConversionStampDirective {
  if (args.trigger === "complete") {
    if (!args.subscription.stripeCustomerId) {
      return { kind: "log-and-skip", reason: "no-stripe-customer-id" };
    }
    if (args.subscription.status === "active") {
      return { kind: "dispatch", stripeCustomerId: args.subscription.stripeCustomerId };
    }
    if (args.subscription.status === "trialing") {
      return { kind: "skip", reason: "trialing" };
    }
    return { kind: "skip", reason: "non-active" };
  }
  // trigger === "update"
  if (args.event.type !== "customer.subscription.updated") {
    return { kind: "skip", reason: "non-transition" };
  }
  if (!args.subscription.stripeCustomerId) {
    return { kind: "skip", reason: "non-transition" };
  }
  const previousStatus = args.event.data.previous_attributes?.status;
  const currentStatus = args.event.data.object.status;
  if (previousStatus === "trialing" && currentStatus === "active") {
    return { kind: "dispatch", stripeCustomerId: args.subscription.stripeCustomerId };
  }
  return { kind: "skip", reason: "non-transition" };
}

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
  requestPasswordReset: { window: 60, max: 5 },
  resetPassword: { window: 60, max: 5 },
  sendVerificationEmail: { window: 60, max: 5 },
  verifyEmail: { window: 60, max: 10 },
  // Money-moving Stripe plugin endpoints (#3417). The deleted hand-rolled
  // portal route carried its own 5/hour per-workspace limiter; the plugin
  // endpoints that replaced it would otherwise fall through to the global
  // 100/min ceiling — enough to spam Stripe with portal/checkout session
  // creation. 10/hour per client matches the old budget with headroom for
  // legitimate retry loops.
  subscriptionBilling: { window: 3600, max: 10 },
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
      // Better Auth 1.4+ renamed /forget-password → /request-password-reset.
      // The earlier key was a no-op (no endpoint at that path); a future
      // version bump must not silently de-rate-limit this surface.
      "/request-password-reset": { ...AUTH_RATE_LIMIT_DEFAULTS.requestPasswordReset },
      "/reset-password": { ...AUTH_RATE_LIMIT_DEFAULTS.resetPassword },
      "/send-verification-email": { ...AUTH_RATE_LIMIT_DEFAULTS.sendVerificationEmail },
      "/verify-email": { ...AUTH_RATE_LIMIT_DEFAULTS.verifyEmail },
      // @better-auth/stripe money-moving endpoints — each call can create
      // a Stripe checkout/portal session or mutate the subscription.
      "/subscription/upgrade": { ...AUTH_RATE_LIMIT_DEFAULTS.subscriptionBilling },
      "/subscription/billing-portal": { ...AUTH_RATE_LIMIT_DEFAULTS.subscriptionBilling },
      "/subscription/cancel": { ...AUTH_RATE_LIMIT_DEFAULTS.subscriptionBilling },
      "/subscription/restore": { ...AUTH_RATE_LIMIT_DEFAULTS.subscriptionBilling },
    },
  };
}

/**
 * Default reset-password token TTL (seconds). Better Auth's own default is
 * also 1 hour, but pinning it explicitly here means a future Better Auth
 * version bump can't silently widen the window — a single-use token that
 * lives 24 hours is fine; one that lives a week is a credential lying
 * around in the user's inbox.
 */
export const RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC = 60 * 60;

/**
 * Build the Better Auth `emailAndPassword` config block.
 *
 * Pins the F-05 invariant: whenever `requireEmailVerification` is true,
 * `autoSignIn` MUST be false. Sign-in is blocked until the user clicks
 * the verification link anyway, but an accidental `autoSignIn: true` in
 * a future refactor would silently turn signup into a login oracle
 * (attacker signs up with a victim's email → gets a session regardless
 * of whether the account existed). The unit tests pin this exactly.
 *
 * `sendResetPassword` and `revokeSessionsOnPasswordReset` are wired here
 * so password-reset behavior travels with the rest of email/password
 * config — the test suite pins both so a future refactor can't silently
 * drop the email send (reopening F-09 — silent password-reset) or the
 * session revocation (a stolen reset link would leave the attacker's
 * old session live alongside the legitimate user's new one).
 */
export interface BuildEmailAndPasswordConfigDeps {
  requireEmailVerification: boolean;
  sendResetPassword: (data: { user: User; url: string; token: string }) => Promise<void>;
  resetPasswordTokenExpiresIn?: number;
}

export function buildEmailAndPasswordConfig(deps: BuildEmailAndPasswordConfigDeps): {
  enabled: true;
  requireEmailVerification: boolean;
  autoSignIn: boolean;
  sendResetPassword: (data: { user: User; url: string; token: string }) => Promise<void>;
  resetPasswordTokenExpiresIn: number;
  revokeSessionsOnPasswordReset: true;
} {
  return {
    enabled: true,
    requireEmailVerification: deps.requireEmailVerification,
    autoSignIn: !deps.requireEmailVerification,
    sendResetPassword: deps.sendResetPassword,
    resetPasswordTokenExpiresIn: deps.resetPasswordTokenExpiresIn ?? RESET_PASSWORD_TOKEN_EXPIRES_IN_SEC,
    // Always revoke other sessions on a successful reset. A reset is the
    // recovery path for "I think someone else has my password" — leaving
    // any other live session is the wrong default. Better Auth defaults
    // this to false; opt in here.
    revokeSessionsOnPasswordReset: true,
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
 *
 * `cookiePrefix` names the session cookie (`${cookiePrefix}.session_token`)
 * and is resolved per deployment env (`resolveCookiePrefix`). It MUST match
 * the web proxy's `getSessionCookie({ cookiePrefix })` read — see
 * {@link import("@atlas/api/lib/env-profile").EnvProfile.cookiePrefix}.
 */
export function buildAdvancedConfig(
  cookieDomain: string | undefined,
  cookiePrefix: string,
): {
  ipAddress: { ipAddressHeaders: string[] };
  cookiePrefix: string;
  defaultCookieAttributes?: { domain: string };
} {
  return {
    ipAddress: {
      ipAddressHeaders: ["x-atlas-client-ip"],
    },
    cookiePrefix,
    ...(cookieDomain
      ? { defaultCookieAttributes: { domain: `.${cookieDomain}` } }
      : {}),
  };
}

/**
 * Derive the parent domain for cross-subdomain session cookies, scoped as
 * tightly as the deployment allows.
 *
 * The cookie must be valid for both the API host (`BETTER_AUTH_URL`) and the
 * web app host (`webOrigin`), so the correct domain is the **longest dotted
 * suffix common to the two** — e.g.
 *   - prod:    `api.useatlas.dev` + `app.useatlas.dev` → `useatlas.dev`
 *   - staging: `api.staging.useatlas.dev` + `app.staging.useatlas.dev`
 *              → `staging.useatlas.dev` (NOT `useatlas.dev`)
 *
 * `webOrigin` is the single canonical app origin (`getWebOrigin()` — the first
 * `ATLAS_CORS_ORIGIN` entry). We deliberately do NOT fold in the rest of the
 * CORS allowlist: an unrelated allowlisted origin (an embed/partner site on a
 * different registrable domain) would otherwise collapse the common suffix to
 * nothing, drop the cookie domain, and scope the session cookie to the API
 * host only — so the app host can't see it after login and users stick at
 * `/login`.
 *
 * The previous `host.split(".").slice(-2)` heuristic always collapsed to the
 * last two labels, so staging resolved to `useatlas.dev` — the same slot as
 * prod — which is exactly the cross-env cookie bleed this fixes.
 *
 * Returns `undefined` (host-only cookies) when either input is absent
 * (single-origin / self-hosted), when a URL is malformed, when the common
 * suffix is fewer than 2 labels (different sites), or when it looks like a
 * bare IPv4 (cookie domains can't be IPs).
 *
 * NOTE: there is no public-suffix-list awareness. Two *different* registrable
 * domains under a 2-label public suffix (`a.co.uk` + `b.co.uk`) resolve to
 * `co.uk`; browsers reject that via the PSL so the cookie simply fails to set
 * (no leak), and Atlas's API + app are always the same registrable domain.
 * Same-tenant multi-label TLDs (`api.acme.co.uk` + `app.acme.co.uk` →
 * `acme.co.uk`) work correctly.
 */
export function deriveCookieDomain(
  authUrl: string | undefined,
  webOrigin: string | undefined,
): string | undefined {
  if (!authUrl || !webOrigin) return undefined;

  let authHost: string;
  let webHost: string;
  try {
    authHost = new URL(authUrl).hostname;
    webHost = new URL(webOrigin).hostname;
  } catch {
    return undefined;
  }

  // Longest common dotted suffix of the two hosts, compared from the right.
  const a = authHost.split(".").reverse();
  const b = webHost.split(".").reverse();
  const common: string[] = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len && a[i] === b[i]; i++) {
    common.push(a[i]);
  }
  if (common.length < 2) return undefined;
  if (common.every((label) => /^\d+$/.test(label))) return undefined; // bare IPv4

  return common.reverse().join(".");
}

/**
 * Default Better Auth `session.cookieCache.maxAge`, in seconds.
 *
 * F-07 — the earlier value of 5 minutes meant a ban / session revoke
 * (`banUserDirect` / `revokeUserSessionsDirect`, #3159) took up to 5 minutes to
 * kick a compromised or banned user out of authenticated routes, because the
 * cookie cache short-circuited the DB lookup that surfaces the ban/revocation. 30s
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
 *
 * Per-env defaults live in {@link import("@atlas/api/lib/env-profile").EnvProfile}
 * — `production` defaults to `true`, `staging`/`development` default to
 * `false`. The env var still overrides the profile default when set.
 */
export function resolveRequireEmailVerification(env: NodeJS.ProcessEnv): boolean {
  // Delegate to the env-profile resolver — same env-var-override
  // semantics, plus a per-env default that lets us drop the explicit
  // `ATLAS_REQUIRE_EMAIL_VERIFICATION=false` on staging/dev.
  return envProfileResolveRequireEmailVerification(env);
}

/**
 * Brand for a validated Better Auth secret. The only way to produce one is
 * via {@link parseAuthSecret}, which enforces the length floor. This keeps
 * the "secret must be ≥32 characters" invariant in one place — passing a
 * raw `string` to {@link buildAuthOptions} is a compile error, so a future
 * code path that forgot to validate the env var can't silently ship a
 * short secret.
 */
export type AuthSecret = string & { readonly __brand: "AuthSecret" };

/**
 * Validate and brand the value of `BETTER_AUTH_SECRET`. Throws on missing
 * or short input — neither is recoverable at runtime, so failing early
 * beats a cryptographic weakness masquerading as a config quirk.
 */
/**
 * Published placeholder secrets that must never reach a production deploy
 * (#3342 L-6). The `.env.example` value passes the ≥32-char floor, and it
 * doubles as the at-rest encryption-key fallback — a deploy that shipped it
 * would have a publicly-known session-signing AND data-encryption key.
 */
const KNOWN_DEFAULT_AUTH_SECRETS: ReadonlySet<string> = new Set([
  "atlas-dev-secret-do-not-use-in-production!!",
]);

export function parseAuthSecret(raw: string | undefined): AuthSecret {
  if (!raw) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Managed auth mode requires this environment variable.",
    );
  }
  if (raw.length < 32) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least 32 characters (got ${raw.length}). Use a cryptographically random string.`,
    );
  }
  if (KNOWN_DEFAULT_AUTH_SECRETS.has(raw)) {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.ATLAS_DEPLOY_MODE === "saas"
    ) {
      throw new Error(
        "BETTER_AUTH_SECRET is set to the published .env.example placeholder — refusing to start in production. " +
          "Generate a dedicated secret (e.g. `openssl rand -base64 33`).",
      );
    }
    log.warn(
      "BETTER_AUTH_SECRET is the published .env.example placeholder — fine for local dev, refused in production",
    );
  }
  return raw as AuthSecret;
}

/**
 * Bootstrap-admin policy for the `user.create.before` hook. Encoded as a
 * tagged union so the three mutually-exclusive modes can't be silently
 * combined (prior flat `adminEmail` + `allowFirstSignupAdmin` pair allowed
 * nonsensical states like both-set or neither-set-but-flag-on).
 */
export type BootstrapAdminConfig =
  | { mode: "email"; email: string }
  | { mode: "first-signup" }
  | { mode: "none" };

/**
 * Resolve {@link BootstrapAdminConfig} from the raw env values. Centralizes
 * the precedence rules so {@link getAuthInstance} doesn't need to juggle
 * two flags.
 */
export function resolveBootstrapAdminConfig(
  adminEmail: string | undefined,
  allowFirstSignupAdmin: boolean,
): BootstrapAdminConfig {
  if (adminEmail) return { mode: "email", email: adminEmail };
  if (allowFirstSignupAdmin) return { mode: "first-signup" };
  return { mode: "none" };
}

/**
 * Send a verification OTP email via Atlas's email delivery layer.
 *
 * Fire-and-forget contract: the Better Auth `emailOTP` plugin invokes
 * this with `waitUntil`-style
 * fire-and-forget semantics, so a thrown rejection here would either
 * spam stderr with no correlation or — under
 * `--unhandled-rejections=strict` — crash the process mid-signup. Wrap
 * everything so the auth response stays 200 regardless of provider
 * health.
 *
 * The OTP itself is generated and validated by Better Auth's plugin —
 * we never see the value before this callback fires, and we never store
 * it (the plugin handles persistence with `storeOTP: "hashed"`). All we
 * do is render the email and dispatch.
 *
 * @internal — exported for testing.
 */
export async function _sendVerificationOTP(opts: { to: string; otp: string }): Promise<void> {
  try {
    const { sendTransactionalEmail } = await import("@atlas/api/lib/email/delivery");
    // Durable send (#2942): if the in-process retry path is exhausted on
    // a sustained provider outage, the message lands in email_outbox and
    // the flusher re-sends it — rather than being lost. The response
    // stays 200 either way (enumeration-safe, fire-and-forget).
    const result = await sendTransactionalEmail(
      {
        to: opts.to,
        subject: "Your Atlas verification code",
      html: `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #222;">
    <p>Welcome to Atlas. Your verification code is:</p>
    <p style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 28px; font-weight: 600; letter-spacing: 0.2em; padding: 16px 24px; background: #f4f4f5; border-radius: 8px; display: inline-block;">${opts.otp}</p>
    <p style="color:#666; font-size:13px;">This code expires in 10 minutes. If you did not try to create an account, you can safely ignore this message.</p>
    <p>— Atlas</p>
  </body>
</html>`,
      },
      // 10m TTL matches the "expires in 10 minutes" copy above — the
      // flusher won't deliver a dead code after a long outage (#2942).
      { emailType: "verification-otp", ttlMs: 10 * 60_000 },
    );
    if (!result.success) {
      log.warn(
        { to: opts.to, provider: result.provider, error: result.error },
        "Verification OTP delivery did not complete — user may need to retry via /api/auth/email-otp/send-verification-otp",
      );
    }
  } catch (err) {
    log.warn(
      { to: opts.to, err: errorMessage(err) },
      "Verification OTP dispatch crashed — signup response is still 200 to preserve enumeration protection; user may need to retry the resend control",
    );
  }
}

/**
 * Send the password reset email via Atlas's email delivery layer.
 *
 * Symmetric with {@link _sendVerificationEmail} — same fire-and-forget
 * contract, same `try/catch` discipline, same enumeration-safe response
 * parity. The Better Auth `requestPasswordReset` handler returns the
 * exact same 200 response whether or not the email exists; awaiting
 * SMTP here would extend the attacker's timing oracle and chain the
 * email provider's uptime to the auth response.
 *
 * @internal — exported for testing.
 */
export async function _sendPasswordResetEmail(opts: {
  to: string;
  url: string;
}): Promise<void> {
  try {
    const { sendTransactionalEmail } = await import("@atlas/api/lib/email/delivery");
    // Durable send (#2942): password reset is the sole self-serve
    // recovery path, so a sustained provider outage must not silently
    // drop it. sendTransactionalEmail enqueues to email_outbox when the
    // in-process retry path is exhausted; the flusher re-sends later. The
    // request still returns 200 regardless (enumeration-safe, F-09).
    const result = await sendTransactionalEmail(
      {
        to: opts.to,
        subject: "Reset your Atlas password",
        html: `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #222;">
    <p>We received a request to reset the password for your Atlas account.</p>
    <p><a href="${encodeAttributeValue(opts.url)}" style="color:#0ea5e9;">Reset your password</a></p>
    <p style="color:#666; font-size:13px;">This link expires in one hour and can be used only once. If you did not request a password reset, you can safely ignore this message — your password will not change.</p>
    <p>— Atlas</p>
  </body>
</html>`,
      },
      // 1h TTL matches the "expires in one hour" copy above — the flusher
      // won't deliver a dead reset link after a long outage (#2942).
      { emailType: "password-reset", ttlMs: 60 * 60_000 },
    );
    if (!result.success) {
      log.warn(
        { to: opts.to, provider: result.provider, error: result.error },
        "Password reset email delivery did not complete — user may need to request another reset",
      );
    }
  } catch (err) {
    log.warn(
      { to: opts.to, err: errorMessage(err) },
      "Password reset email dispatch crashed — request response stays 200 to preserve enumeration protection",
    );
  }
}

/**
 * Rewrite a Better Auth verify-email / password-reset URL so its
 * `callbackURL` query param is absolute against the frontend origin.
 *
 * Better Auth links look like `${baseURL}/api/auth/verify-email?token=...&callbackURL=...`
 * where `baseURL` is the API host (`api.useatlas.dev`). After validating
 * the token, the handler 302s to whatever `callbackURL` resolves to. Browsers
 * resolve a relative `callbackURL` (`/login`, `/`) against the response
 * origin — which is the API — so users land on `https://api.useatlas.dev/login`
 * and 404. Rewriting to an absolute URL pinned to the frontend origin (taken
 * from `BETTER_AUTH_TRUSTED_ORIGINS[0]`) makes the redirect bounce to the
 * web app no matter what the client passed at signup or resend time.
 *
 * Safety: only relative paths are rewritten. Absolute URLs pass through
 * untouched so Better Auth's own `trustedOrigins` host check stays the
 * authority on cross-origin allowance. Protocol-relative inputs
 * (`//evil.com/x`) would resolve to an attacker host under `new URL(rel, base)`,
 * so we re-check the resolved `origin` matches the expected frontend
 * origin and fall back to the original URL if not — keeping us out of the
 * open-redirect business while leaving Better Auth to reject the bad
 * callback at its own layer.
 *
 * @internal — exported for testing.
 */
export function rewriteVerificationCallbackURL(rawUrl: string, frontendOrigin: string): string {
  if (!frontendOrigin) {
    // BETTER_AUTH_TRUSTED_ORIGINS is unset or empty. Loud warn here would
    // fire per email; the boot-time warn in `buildAuthOptions` is the
    // single-source signal — silent here is intentional.
    return rawUrl;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    // Better Auth constructed `rawUrl` itself — an unparseable value is a
    // real bug (baseURL misconfig, upstream API change). Surface it so
    // operators can see why links silently break, but still fall back to
    // the original to preserve the auth response (enumeration-safe).
    log.warn(
      { rawUrl, err: errorMessage(err) },
      "Better Auth verification URL was unparseable — passing through unchanged",
    );
    return rawUrl;
  }
  const callbackRaw = parsed.searchParams.get("callbackURL") ?? "/";

  try {
    // intentionally ignored: a throw here means callbackRaw is relative,
    // which is exactly the path we want to rewrite — fall through.
    new URL(callbackRaw);
    return rawUrl;
  } catch {
    // relative path — continue to the resolve+origin-check step below
  }

  let resolved: URL;
  let expectedOrigin: string;
  try {
    resolved = new URL(callbackRaw, frontendOrigin);
    expectedOrigin = new URL(frontendOrigin).origin;
  } catch (err) {
    // `frontendOrigin` came from BETTER_AUTH_TRUSTED_ORIGINS[0]; if it
    // doesn't parse, that's a deployment-config bug. Warn so the operator
    // sees it across every email send instead of silently 404ing users.
    log.warn(
      { frontendOrigin, callbackRaw, err: errorMessage(err) },
      "BETTER_AUTH_TRUSTED_ORIGINS[0] is not a parseable URL — verification link callback rewrite skipped",
    );
    return rawUrl;
  }
  // Protocol-relative or `?callbackURL=//evil.com/x` would resolve to a
  // different origin under `new URL(rel, base)`. Refuse to propagate it —
  // the original URL still carries the suspicious value, and Better Auth's
  // trustedOrigins check will catch it downstream.
  if (resolved.origin !== expectedOrigin) {
    return rawUrl;
  }

  parsed.searchParams.set("callbackURL", resolved.toString());
  return parsed.toString();
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

// ---------------------------------------------------------------------------
// OAuth 2.1 provider configuration (#2024)
// ---------------------------------------------------------------------------

/**
 * Scopes advertised by the OAuth 2.1 authorization server. Standard OIDC
 * scopes plus Atlas-specific MCP scopes for the hosted MCP endpoint.
 *
 * The MCP authorization spec (2025-03-26) requires the resource server to
 * declare scopes in `/.well-known/oauth-protected-resource`; the `mcp:*`
 * scopes here are the ones Atlas-shaped MCP clients (Claude Desktop,
 * ChatGPT, Cursor, etc.) request when connecting to a hosted MCP endpoint.
 *
 * Order matters for the consent UI — declare the high-frequency scopes
 * first so the rendered list matches user expectations.
 */
export const ATLAS_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  // mcp:read = query workspace data through the MCP endpoint. Required
  // for any agent that wants to use Atlas as a data source.
  "mcp:read",
  // mcp:write = reserved for future write paths (run mutations, edit
  // semantic layer). Currently the hosted MCP surface is read-only, so
  // a token without mcp:write still works for every shipping MCP tool.
  // Declared so clients can request it now and the gate flips when we
  // add write tools.
  "mcp:write",
] as const;

/**
 * Resolve the list of valid OAuth audiences from the environment.
 *
 * The MCP spec wants each MCP endpoint to be its own resource (with an
 * audience URI) so a token issued to the SaaS US region cannot replay
 * against the EU region. Per-region API hosts provide that natively.
 *
 * The audience the issuer accepts MUST equal what the resource server
 * advertises and what the verifier checks. All three sites resolve to
 * `<base>/mcp` (region-scoped, NOT workspace-scoped — see well-known.ts
 * `buildResourceUri` for the rationale and the spec citation).
 *
 * Resolution priority:
 *   1. ATLAS_OAUTH_VALID_AUDIENCES — comma-separated explicit list.
 *      Used verbatim, no `/mcp` suffix appended (operator owns the
 *      values and may want non-MCP audiences too).
 *   2. ATLAS_PUBLIC_API_URL — same env var well-known.ts and hosted.ts
 *      prefer; we suffix `/mcp` here so the issuer accepts the verifier's
 *      expected audience.
 *   3. BETTER_AUTH_URL — last fallback, `/mcp` suffix appended.
 *
 * Empty string in the env var → no override → fall back to (2)/(3).
 *
 * #2068 — when the resolved base is one of the canonical SaaS regional
 * `api*.useatlas.dev` hosts (`api`, `api-eu`, `api-apac`), the
 * brand-mirror `mcp*.useatlas.dev/mcp` audience is appended so tokens
 * minted post-cutover (advertised on the new canonical hostname)
 * verify here, AND tokens minted just before the cutover (against the
 * regional `<region>.api.useatlas.dev/mcp` host) keep verifying.
 * Self-hosted operators on arbitrary hostnames are unaffected — the
 * mirror only synthesises for `*.useatlas.dev`.
 */
export function resolveOAuthValidAudiences(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.ATLAS_OAUTH_VALID_AUDIENCES?.trim();
  if (explicit) {
    return explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const base =
    env.ATLAS_PUBLIC_API_URL?.trim() || env.BETTER_AUTH_URL?.trim();
  if (!base) return [];
  const trimmed = base.replace(/\/+$/, "");
  const audiences = [`${trimmed}/mcp`];
  const brand = brandMcpAudience(trimmed);
  if (brand) audiences.push(brand);
  return audiences;
}

/**
 * Map a SaaS regional `api*.useatlas.dev` host to its brand
 * counterpart, OR a SaaS brand `mcp*.useatlas.dev` host to its
 * regional counterpart (#2068). The mapping is symmetric so the
 * audience-synthesis invariant doesn't depend on which hostname an
 * operator chose for `ATLAS_PUBLIC_API_URL`:
 *
 *   `api.useatlas.dev`      → `mcp.useatlas.dev`
 *   `api-eu.useatlas.dev`   → `mcp-eu.useatlas.dev`
 *   `api-apac.useatlas.dev` → `mcp-apac.useatlas.dev`
 *   `mcp.useatlas.dev`      → `api.useatlas.dev`
 *   `mcp-eu.useatlas.dev`   → `api-eu.useatlas.dev`
 *   `mcp-apac.useatlas.dev` → `api-apac.useatlas.dev`
 *
 * Anything else (self-hosted, dev, custom-domain SaaS, `apiv2`,
 * `api.eu.useatlas.dev`, etc.) returns null — synthesising a
 * `.useatlas.dev` mirror for an unrelated host would be wrong. The
 * match is anchored on hostname only, so a `BETTER_AUTH_URL` with an
 * unusual port or path still maps cleanly.
 *
 * Symmetry rationale: pre-#2068 every site used the regional host as
 * the canonical base; post-#2068 docs/CLI/registry use the brand. An
 * operator who flips `ATLAS_PUBLIC_API_URL` to the brand (reasonable —
 * it's what the CLI default writes) must still see both audiences
 * synthesised so pre-cutover tokens bound to the regional audience
 * keep verifying. Closing that footgun is cheaper than documenting it
 * as a deployment invariant.
 */
function brandMcpAudience(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: a non-URL `ATLAS_PUBLIC_API_URL` falls
    // back to BETTER_AUTH_URL one layer up; if that fails too, the
    // outer caller returns an empty audience list. Surfacing the
    // parse failure here would double-log on every request.
    return null;
  }
  // Strict match: `api.useatlas.dev` / `api-<region>.useatlas.dev` /
  // `mcp.useatlas.dev` / `mcp-<region>.useatlas.dev`. `apiv2`,
  // `api.eu.useatlas.dev`, etc. are intentionally excluded — we only
  // mirror the documented regional surfaces.
  const matched = url.hostname.match(/^(api|mcp)(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const flipped = matched[1] === "api" ? "mcp" : "api";
  const regionSuffix = matched[2] ?? "";
  return `https://${flipped}${regionSuffix}.useatlas.dev/mcp`;
}

/**
 * Resolve `allowUnauthenticatedClientRegistration` from the environment.
 *
 * MCP clients (Claude Desktop, ChatGPT, third-party agents) bootstrap by
 * dynamically registering as public clients without an authentication
 * header — this flag has to be on for the standard MCP onboarding flow
 * to work. The plugin's README flags it as deprecation-bound: the MCP
 * spec is debating Client ID Metadata Documents and signed `software_
 * statement` registration, both of which would supersede the unauth path.
 *
 * Default on for SaaS deployments (the only path where the hosted MCP
 * endpoint is reachable). Self-hosted operators can opt out via
 * `ATLAS_OAUTH_ALLOW_UNAUTH_DCR=false` if their threat model rejects
 * unattended client registration.
 *
 * Track the upstream MCP spec evolution and phase this off when CIMD or
 * software-statement registration lands on `@better-auth/oauth-provider`.
 */
export function resolveAllowUnauthDcr(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ATLAS_OAUTH_ALLOW_UNAUTH_DCR?.trim().toLowerCase();
  if (raw === undefined) return true;
  return !["false", "0", "no", "off"].includes(raw);
}

/**
 * Default access-token TTL — 1 hour (Better Auth's default, OAuth 2.1
 * "industry standard"). Refresh-token default — 30 days. Documented in
 * `docs/guides/mcp.mdx` (hosted protocol reference) so SDK consumers have one source of truth
 * for the contract; the literals here are the implementation half.
 *
 * Surfacing both as env vars (#2066) lets the e2e test override them to
 * run a full register → expire → refresh cycle in seconds. Production
 * operators rarely need to change these — the override exists so a
 * Playwright spec can mint a 30-second JWT instead of waiting an hour.
 */
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Parse an integer env var of seconds, with a positive lower bound.
 * Empty string or a non-numeric / non-positive value falls back to the
 * default — avoids a typo like `ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS=`
 * silently shipping a 0-second token.
 */
function resolveTtlSeconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveAccessTokenTtlSeconds(env: NodeJS.ProcessEnv): number {
  return resolveTtlSeconds(env.ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
}

export function resolveRefreshTokenTtlSeconds(env: NodeJS.ProcessEnv): number {
  return resolveTtlSeconds(env.ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS, DEFAULT_REFRESH_TOKEN_TTL_SECONDS);
}

/**
 * Build the Better Auth plugins array.
 *
 * Stripe plugin is conditionally included when STRIPE_SECRET_KEY is set.
 * This keeps all Stripe dependencies out of the module graph for
 * self-hosted deployments that don't use billing.
 */
/**
 * Best-effort workspace-branding lookup for the invitation email. Returns
/**
 * Distinguish "Postgres is unreachable" from "we made a coding mistake."
 * The seat-limit gate fails open only on the former — a bad SQL or a
 * malformed `checkResourceLimit` response must escalate to 500 so it
 * surfaces in dashboards instead of silently leaking seats.
 *
 * @internal — exported for unit tests.
 */
// `isTransportError`, `assertInvitationRoleAllowed`, and `loadInviteBranding`
// moved to `lib/auth/invitations.ts` so the platform-admin cross-org invite
// route can reuse the same helpers without copy/paste. Re-exported below
// for the small handful of older callers that still import them from this
// module — drop the re-exports once those move.
export { assertInvitationRoleAllowed, isTransportError } from "@atlas/api/lib/auth/invitations";

/** @internal — exported for wiring assertions in tests. */
/**
 * Stripe subscription id an event concerns, for the event ledger's
 * per-subscription ordering guard (#3423). Returns null for events with
 * no subscription scope (ledger still dedupes them by event id).
 *
 * `invoice.payment_failed` reports its subscription id too, but only
 * TIER_LIFECYCLE_EVENT_TYPES participate in the ordering guard (see
 * classifyStripeEvent) — a payment failure recorded first must never
 * make a delayed `updated`/`deleted` lifecycle sync look stale.
 *
 * @internal — exported for testing.
 */
export function stripeEventSubscriptionId(event: Stripe.Event): string | null {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      return typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return (event.data.object as Stripe.Subscription).id ?? null;
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub = invoice.parent?.subscription_details?.subscription;
      return typeof parentSub === "string" ? parentSub : parentSub?.id ?? null;
    }
    default:
      return null;
  }
}

/**
 * Resolve the Atlas orgId a Stripe subscription belongs to. Checkout-
 * created subscriptions carry `metadata.referenceId` (stamped by the
 * plugin's upgrade flow); dashboard-created ones are resolved through
 * the plugin's subscription table.
 */
async function resolveOrgIdForStripeSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const metaRef = subscription.metadata?.referenceId;
  if (typeof metaRef === "string" && metaRef.length > 0) return metaRef;
  const rows = await internalQuery<{ referenceId: string }>(
    `SELECT "referenceId" FROM subscription WHERE "stripeSubscriptionId" = $1 LIMIT 1`,
    [subscription.id],
  );
  return rows[0]?.referenceId ?? null;
}

/**
 * Tier write + cache invalidation shared by the sync arms below.
 * Returns whether the write matched an organization row — callers use
 * it to skip follow-on side effects (e.g. the CRM conversion stamp)
 * for orgs that no longer exist.
 */
async function applyWorkspaceTier(orgId: string, tier: PlanTier, context: string): Promise<boolean> {
  // false = no organization row matched (helper logs the contract
  // violation). Do NOT throw — Stripe redelivering won't create the org.
  const updated = await updateWorkspacePlanTier(orgId, tier);
  if (!updated) return false;
  invalidatePlanCache(orgId);
  billingLog.info({ orgId, tier }, "%s — plan tier synced", context);
  return true;
}

/**
 * The must-not-be-lost Stripe sync (#3423): plan-tier writes + the Twenty
 * CRM conversion stamp, keyed on the four subscription-lifecycle event
 * types. Runs inside `onEvent` (behind the event ledger), so internal-DB
 * failures THROW and surface as webhook 400s — Stripe redelivers instead
 * of the failure being swallowed like in the onSubscription* hooks.
 *
 * Returns the plan tier this event actually WROTE (null when none) —
 * recorded into the ledger's `applied_plan_tier` so the reconciliation
 * sweep can heal from ordering-correct data instead of the plugin's
 * last-delivered-wins subscription row.
 *
 * Skip vs throw discipline:
 *  - PERMANENT conditions return null and get recorded (replaying the
 *    identical event could never succeed): non-Atlas checkouts/
 *    subscriptions (no referenceId), deleted orgs, setup-mode sessions.
 *  - RETRYABLE conditions THROW (→ 400 → Stripe retries for ~3 weeks):
 *    an unrecognized price id is an env misconfiguration — once the
 *    operator fixes STRIPE_*_PRICE_ID, the redelivery applies the tier
 *    (and stamps the conversion) instead of the event being permanently
 *    no-op'd by the dedup guard.
 *
 * The CRM stamp itself stays best-effort at the dispatch boundary
 * (`dispatchConversionCrmStamp` swallows internally): once enqueued the
 * `crm_outbox` provides its durability, and a Twenty outage must not
 * block the tier sync retry loop.
 *
 * @internal — exported for testing.
 */
export async function syncStripeEventToWorkspace(
  event: Stripe.Event,
  stripeClient: Stripe,
): Promise<PlanTier | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "setup") return null;
      const orgId = session.client_reference_id ?? session.metadata?.referenceId ?? null;
      const subId = typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;
      if (!orgId || !subId) {
        billingLog.warn(
          { eventId: event.id, orgId, subId },
          "checkout.session.completed without referenceId/subscription — skipping sync",
        );
        return null;
      }
      // The plugin's own handler retrieved the subscription too, but its
      // copy is closed over — one extra retrieve per checkout is the
      // price of a durable, independently-retryable sync.
      const stripeSubscription = await stripeClient.subscriptions.retrieve(subId);
      const priceId = stripeSubscription.items?.data?.[0]?.price?.id;
      const tier = priceId ? resolvePlanTierFromPriceId(priceId) : null;
      if (!tier) {
        // Retryable: money moved but the price env mapping is broken.
        // Throwing keeps Stripe redelivering until the operator fixes
        // STRIPE_*_PRICE_ID — the redelivery then applies the tier AND
        // enqueues the conversion stamp below.
        throw new Error(
          `checkout.session.completed for org ${orgId} carries unrecognized price "${priceId ?? "<none>"}" — fix STRIPE_*_PRICE_ID; Stripe will retry`,
        );
      }
      const applied = await applyWorkspaceTier(orgId, tier, "Checkout completed");
      // Org row gone (stale checkout for a deleted workspace): the
      // tier write missed, so don't record a paid conversion for a
      // nonexistent workspace either (Codex review on #3444).
      if (!applied) return null;

      // #2737 — Twenty CRM conversion stamp. Trialing checkouts are
      // skipped (would overcount unpaid trials); the trial → active
      // transition is picked up by customer.subscription.updated below.
      // Gating centralised in `planConversionStamp`.
      const customerId = typeof stripeSubscription.customer === "string"
        ? stripeSubscription.customer
        : stripeSubscription.customer?.id;
      const directive = planConversionStamp({
        trigger: "complete",
        subscription: { status: stripeSubscription.status, stripeCustomerId: customerId },
      });
      if (directive.kind === "log-and-skip") {
        log.warn(
          { orgId, eventId: event.id, event: "conversion_crm.no_stripe_customer_id" },
          "Subscription completed without stripeCustomerId — skipping Twenty conversion stamp",
        );
      } else if (directive.kind === "dispatch") {
        await dispatchConversionCrmStamp({
          stripeClient,
          stripeCustomerId: directive.stripeCustomerId,
          orgId,
        });
      }
      return tier;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const stripeSubscription = event.data.object as Stripe.Subscription;
      const orgId = await resolveOrgIdForStripeSubscription(stripeSubscription);
      if (!orgId) {
        // Permanent: no referenceId metadata and no subscription row —
        // a non-Atlas subscription in a shared Stripe account.
        billingLog.warn(
          { eventId: event.id, stripeSubscriptionId: stripeSubscription.id },
          "Subscription event has no resolvable org referenceId — skipping sync",
        );
        return null;
      }

      const priceId = stripeSubscription.items?.data?.[0]?.price?.id;
      if (!priceId) {
        billingLog.warn(
          { orgId, stripeSubscriptionId: stripeSubscription.id },
          "Subscription event has no price ID on items — skipping plan sync",
        );
        return null;
      }
      const tier = resolvePlanTierFromPriceId(priceId);
      if (!tier) {
        // Retryable env misconfig — see the checkout arm.
        throw new Error(
          `Subscription event for org ${orgId} carries unrecognized price "${priceId}" — fix STRIPE_*_PRICE_ID; Stripe will retry`,
        );
      }
      const applied = await applyWorkspaceTier(orgId, tier, "Subscription updated");

      // #2737 — trial → active is the real "paid" signal (first
      // post-trial invoice paid). Only fires for `updated` events with
      // the right previous_attributes transition. Stamped AFTER the
      // tier write succeeds (CodeRabbit on #3444): if the write throws,
      // onEvent 400s and Stripe redelivers — stamping first would
      // enqueue a duplicate conversion on every failed attempt. Skipped
      // when the org row is gone, matching the checkout arm.
      if (applied && event.type === "customer.subscription.updated") {
        const customerId = typeof stripeSubscription.customer === "string"
          ? stripeSubscription.customer
          : stripeSubscription.customer?.id;
        const updateDirective = planConversionStamp({
          trigger: "update",
          subscription: { stripeCustomerId: customerId },
          event: event as unknown as { type: string; data: { previous_attributes?: { status?: string | null } | null; object: { status?: string | null } } },
        });
        if (updateDirective.kind === "dispatch") {
          await dispatchConversionCrmStamp({
            stripeClient,
            stripeCustomerId: updateDirective.stripeCustomerId,
            orgId,
          });
        }
      }
      return applied ? tier : null;
    }

    case "customer.subscription.deleted": {
      // #3421 — the single churn landing point: the subscription actually
      // ended. Locked (zero entitlements, resubscribe CTA), never free.
      const stripeSubscription = event.data.object as Stripe.Subscription;
      const orgId = await resolveOrgIdForStripeSubscription(stripeSubscription);
      if (!orgId) {
        billingLog.warn(
          { eventId: event.id, stripeSubscriptionId: stripeSubscription.id },
          "Subscription deleted with no resolvable org referenceId — skipping lock",
        );
        return null;
      }
      // Stale-deletion guard (Codex review on #3443): webhook delivery is
      // unordered, so a delayed deleted event for an OLD subscription can
      // arrive after the org already resubscribed (a different
      // subscription row, active/trialing). Locking then would revoke a
      // paying customer's access. The plugin marked THIS subscription
      // canceled before onEvent runs, so any remaining active/trialing
      // row is a different, current subscription — skip the lock. (The
      // ledger's per-subscription stale check can't catch this: the two
      // events concern DIFFERENT subscription ids.)
      const activeRows = await internalQuery<{ id: string }>(
        `SELECT id FROM subscription
          WHERE "referenceId" = $1 AND status IN ('active', 'trialing')
            AND "stripeSubscriptionId" IS DISTINCT FROM $2
          LIMIT 1`,
        [orgId, stripeSubscription.id ?? null],
      );
      if (activeRows.length > 0) {
        billingLog.info(
          { orgId, deletedSubscriptionId: stripeSubscription.id },
          "Subscription deleted but another active subscription exists — skipping lock",
        );
        return null;
      }
      const applied = await applyWorkspaceTier(orgId, "locked", "Subscription deleted — workspace locked");
      return applied ? "locked" : null;
    }

    default:
      return null;
  }
}

/**
 * @better-auth/stripe plugin options — extracted from {@link buildPlugins}
 * so the exact production configuration (org scoping, authorizeReference,
 * webhook hooks) is constructible in tests against a mock Stripe client
 * and an in-memory Better Auth instance. Better Auth closes over its
 * plugin options, so without this seam the webhook hooks were untestable
 * (see the caveat note in dispatch-conversion-crm-stamp.test.ts).
 *
 * @internal — exported for testing and for buildPlugins only.
 */
export function buildStripePluginOptions(deps: {
  stripeClient: Stripe;
  webhookSecret: string;
}): StripeOptions {
  const { stripeClient, webhookSecret } = deps;
  return {
    stripeClient,
    stripeWebhookSecret: webhookSecret,
    createCustomerOnSignUp: true,
    // #3416 — Atlas subscriptions are ORG-scoped, not user-scoped. With
    // org mode on, the plugin maintains `organization.stripeCustomerId`
    // (created lazily at first /subscription/upgrade), blocks org deletion
    // while a subscription exists, and syncs member count → seat quantity.
    // Every client call must pass `customerType: "organization"` so
    // `subscription.referenceId` is the orgId — the contract every webhook
    // hook below (`updateWorkspacePlanTier(orgId, …)`) is written against.
    organization: {
      enabled: true,
    },
    subscription: {
      enabled: true,
      plans: getStripePlans(),
      // Required for org-referenced subscription actions: the plugin 400s
      // org-scoped calls without it (AUTHORIZE_REFERENCE_REQUIRED). Role
      // policy (admin/owner for money-moving actions, member for list)
      // lives in stripe-authorize-reference.ts. customerType is threaded
      // through so user-mode calls carrying a foreign referenceId fail
      // closed — Atlas has no user-scoped subscriptions.
      authorizeReference({ user, referenceId, action }, ctx) {
        const body = ctx?.body as { customerType?: unknown } | undefined;
        const query = ctx?.query as { customerType?: unknown } | undefined;
        return authorizeStripeReference({
          user,
          referenceId,
          action,
          customerType: body?.customerType ?? query?.customerType,
        });
      },
      // Two jobs at the last gate before Stripe Checkout (#3418):
      //
      // 1. Org-scope guard — the one path authorizeReference cannot see: a
      //    user-mode upgrade with NO explicit referenceId skips the
      //    reference middleware entirely (referenceId defaults to user.id)
      //    and would create a Checkout session whose webhook referenceId
      //    never matches an organization — the customer pays, the
      //    workspace gets nothing.
      //
      // 2. Double-trial suppression (#3426 one-trial decision) — every
      //    paid plan carries `freeTrial`, and the plugin's own one-trial
      //    guard only consults its own subscription table. An org that
      //    consumed Atlas's PRE-checkout trial (assignSaasTrial stamps
      //    `trial_ends_at` at workspace creation) has no subscription row,
      //    so the plugin would grant a SECOND 14-day Stripe trial at first
      //    checkout. The plugin spreads our `subscription_data` AFTER its
      //    `freeTrial` computation, so `trial_period_days: undefined`
      //    overrides it and the Stripe SDK drops the undefined key.
      //    Fails toward suppression: if the workspace lookup errors, the
      //    customer starts billing immediately rather than risking a
      //    double trial grant.
      async getCheckoutSessionParams({ user, subscription }) {
        const orgId = subscription.referenceId;
        if (orgId === user.id) {
          billingLog.error(
            { userId: user.id, subscriptionId: subscription.id },
            "Blocked user-scoped checkout — Atlas subscriptions must be org-scoped (customerType \"organization\")",
          );
          throw new APIError("BAD_REQUEST", {
            message:
              "Atlas subscriptions are organization-scoped. Retry with customerType \"organization\".",
          });
        }

        let trialConsumed = true;
        try {
          // null workspace (no organization row) → the org never received
          // an Atlas trial → let the plugin's Stripe trial stand. Distinct
          // from the catch below: a lookup ERROR is unknown state and
          // fails toward suppression.
          const workspace = await getWorkspaceDetails(orgId);
          trialConsumed = workspace?.trial_ends_at != null;
        } catch (err) {
          billingLog.error(
            { err: errorMessage(err), orgId },
            "Workspace lookup failed during checkout trial check — suppressing Stripe trial (fail toward no double trial)",
          );
        }

        if (trialConsumed) {
          billingLog.info(
            { orgId, subscriptionId: subscription.id },
            "Suppressing Stripe checkout trial — org already consumed the Atlas pre-checkout trial",
          );
          return {
            params: { subscription_data: { trial_period_days: undefined } },
          };
        }
        return {};
      },
      // #3423 — observability only. The must-not-be-lost sync (plan-tier
      // write + CRM conversion stamp) lives in `onEvent` below, where
      // throws propagate as webhook 400s and Stripe retries. This hook is
      // wrapped in the plugin's catch-and-log, so anything here is
      // best-effort by construction.
      async onSubscriptionComplete({ subscription, plan }) {
        log.info(
          { orgId: subscription.referenceId, plan: plan.name, subscriptionId: subscription.id },
          "Checkout completed — subscription row synced by plugin",
        );
      },
      // #3421 — fires ONCE at the active→pending-cancel transition
      // (schedule-time, verified in plugin source): the customer is paid
      // through period end, so NO tier change happens here. The plugin
      // already persists cancelAtPeriodEnd/cancelAt on the subscription
      // row for UI display (#3429), and restore needs no special handling
      // because nothing was changed. The actual downgrade happens in
      // onSubscriptionDeleted when Stripe ends the subscription.
      async onSubscriptionCancel({ subscription }) {
        log.info(
          { orgId: subscription.referenceId, subscriptionId: subscription.id },
          "Subscription cancellation scheduled — entitlements retained until period end",
        );
      },
      // #3423 — observability only; see onSubscriptionComplete.
      async onSubscriptionUpdate({ subscription }) {
        billingLog.debug(
          { orgId: subscription.referenceId, subscriptionId: subscription.id, status: subscription.status },
          "Subscription updated — row synced by plugin",
        );
      },
      // #3423 — observability only; the locked-tier downgrade (#3421)
      // moved into `onEvent` with the rest of the must-not-be-lost sync.
      async onSubscriptionDeleted({ subscription }) {
        log.info(
          { orgId: subscription.referenceId, subscriptionId: subscription.id },
          "Subscription deleted — row synced by plugin",
        );
      },
    },
    // #3423 — the durable path. `onEvent` is the ONLY hook whose throws
    // the plugin propagates (→ 400 STRIPE_WEBHOOK_ERROR → Stripe retries
    // for ~3 weeks), so the must-not-be-lost sync lives here, wrapped in
    // the event ledger:
    //   1. classify — replays (same event id) and stale deliveries (an
    //      older event arriving after a newer one for the same
    //      subscription) are skipped without side effects.
    //   2. sync — plan-tier write + CRM stamp. Internal-DB failures
    //      THROW so Stripe redelivers; nothing is lost.
    //   3. best-effort branches (payment-failure suspension) — never
    //      throw; #3424 owns the delinquency ladder.
    //   4. record the event id LAST — a crash before this point causes
    //      one extra retry that re-runs an idempotent write (the safe
    //      direction; recording first would make failures unrecoverable).
    async onEvent(event: Stripe.Event) {
      const ledgerEvent: StripeLedgerEvent = {
        id: event.id,
        type: event.type,
        created: event.created,
        stripeSubscriptionId: stripeEventSubscriptionId(event),
      };
      const disposition = await classifyStripeEvent(ledgerEvent);
      if (disposition !== "fresh") {
        billingLog.info(
          { eventId: event.id, eventType: event.type, disposition },
          "Skipping Stripe webhook event (%s)",
          disposition,
        );
        return;
      }

      const appliedTier = await syncStripeEventToWorkspace(event, stripeClient);

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
              const suspended = await updateWorkspaceStatus(orgId, "suspended");
              if (suspended) {
                invalidatePlanCache(orgId);
                billingLog.warn(
                  { orgId, subscriptionId, attemptCount },
                  "Workspace suspended after %d failed payment attempts",
                  attemptCount,
                );
              } else {
                billingLog.error(
                  { orgId, subscriptionId },
                  "Cannot suspend workspace — subscription row references an organization that does not exist",
                );
              }
            } else {
              billingLog.warn(
                { subscriptionId },
                "Cannot suspend workspace — no subscription found for Stripe subscription ID",
              );
            }
          } catch (err) {
            billingLog.error(
              { err: errorMessage(err), subscriptionId, attemptCount },
              "Failed to suspend workspace after repeated payment failures",
            );
            // Do not re-throw — suspension is the best-effort branch
            // (#3424 owns the ladder); the payment failure is already
            // recorded by Stripe, and a throw here would force a
            // redelivery of an already-synced event.
          }
        }
      }

      await recordStripeEvent(ledgerEvent, appliedTier);
    },
  };
}

export function buildPlugins() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin types are complex union types that vary by plugin combination
  const plugins: any[] = [
    bearer(),
    apiKey(),
    // #3159 — the Better Auth `admin()` plugin was removed. It authorized the
    // caller by the raw `user.role` column (via `hasPermission`), which after
    // #2890 (single-role, platform-only) was a contained-but-live footgun: any
    // new admin-plugin route reachable by a workspace admin would silently
    // break the same way removeUser/revokeSessions/SCIM did. Its consumers are
    // now direct internal-DB ops in `lib/auth/admin-user-ops.ts`; ban
    // enforcement is reproduced via the `session.create.before` hook below
    // (+ a per-request check in managed.ts); `user.role`/`banned`/`banReason`/
    // `banExpires` survive as `user.additionalFields` in the options block.
    organization({
      ac,
      roles: { owner: ownerRole, admin: adminRole, member: memberRole },
      // Close the signup-enumeration oracle on the accept-invitation path
      // and prevent an attacker who guesses an `invitationId` from claiming
      // a row intended for someone else. Pairs with the email-OTP plugin.
      requireEmailVerificationOnInvitation: true,
      organizationHooks: {
        // Lives here rather than in `databaseHooks.member.create.after`
        // because the org plugin inserts the initial owner-member through
        // its own internal context, which bypasses user-defined
        // `databaseHooks` — the previous wiring fired zero times in prod.
        afterCreateOrganization: async (args) => {
          // Org creator is already member.role='owner' via the org plugin's
          // creatorRole default — no user.role promotion needed (#2890).
          await assignSaasTrial(args);
        },
        // Defense-in-depth role gate + seat-limit. Better Auth's schema
        // already restricts `role` to the configured roles map above, but a
        // malicious payload could still ship `platform_admin` (single string
        // or inside an array role) — fail loud rather than silently downcast.
        beforeCreateInvitation: async ({ invitation, organization: org }) => {
          assertInvitationRoleAllowed(invitation.role);
          await enforceInvitationSeatLimit(org.id);
        },
        afterCreateInvitation: async ({ invitation, inviter, organization: org }) => {
          await recordInvitationCreated({
            invitationId: invitation.id,
            invitedEmail: invitation.email,
            role: Array.isArray(invitation.role)
              ? invitation.role.join(",")
              : String(invitation.role ?? ""),
            inviter: { id: inviter.user.id, email: inviter.user.email },
            orgId: org.id,
          });
        },
        afterCancelInvitation: async ({ invitation, cancelledBy, organization: org }) => {
          await recordInvitationCancelled({
            invitationId: invitation.id,
            invitedEmail: invitation.email,
            role: Array.isArray(invitation.role)
              ? invitation.role.join(",")
              : String(invitation.role ?? ""),
            // Better Auth's native cancelInvitation gates on status = pending
            // before this hook fires.
            previousStatus: "pending",
            orgId: org.id,
            cancelledBy: { id: cancelledBy.user.id, email: cancelledBy.user.email },
          });
        },
        // #3164 — BLOCK Better Auth's native member-mutation endpoints
        // (`update-member-role` / `remove-member`) so the ONLY path to mutate a
        // membership is Atlas's advisory-lock-guarded admin routes (#3158).
        // Coordinating via these hooks is unsound (the lock can't span Better
        // Auth's separate-connection write); the full rationale + why
        // leaveOrganization / removeUser are unaffected live in
        // `org-member-guards.ts`.
        beforeUpdateMemberRole: blockNativeMemberRoleUpdate,
        beforeRemoveMember: blockNativeMemberRemoval,
      },
      async sendInvitationEmail(data) {
        // The actual render + dispatch lives in `lib/auth/invitations.ts`
        // so the platform-admin cross-org route can share the same code
        // path. Throw on send failure: persisting an invitation while
        // telling the admin "An email is on its way" is a silent half-
        // success — the recipient never gets the email, the admin assumes
        // we're being slow, and a dead row lingers in the pending list.
        await dispatchInvitationEmail({
          invitationId: data.id,
          role: data.role,
          email: data.email,
          organization: { id: data.organization.id, name: data.organization.name },
          inviter: { user: { name: data.inviter.user.name, email: data.inviter.user.email } },
        });
      },
    }),
  ];

  // Email OTP — the only email-verification path Atlas ships. An
  // 8-character one-time code, 10-minute expiry. With
  // `overrideDefaultEmailVerification: true` the plugin's `init()`
  // installs the OTP sender as `emailVerification.sendVerificationEmail`,
  // which is why our config above intentionally does NOT wire a
  // sendVerificationEmail callback — adding one would win the options
  // merge and reintroduce a magic-link path. `sendVerificationOnSignUp:
  // true` triggers the OTP send automatically as part of the signup
  // pipeline. `storeOTP: "hashed"` keeps the plaintext code out of the
  // verification table — only the hash is persisted, the user-supplied
  // code is hashed and compared at verify time.
  plugins.push(
    emailOTP({
      otpLength: 8,
      expiresIn: 600,
      sendVerificationOnSignUp: true,
      overrideDefaultEmailVerification: true,
      storeOTP: "hashed",
      sendVerificationOTP: async (data) => {
        // Fire-and-forget — see `_sendVerificationOTP`'s contract.
        // `.catch` is belt-and-suspenders: the dispatcher already wraps
        // every failure path internally, but a future refactor that
        // drops that try/catch must still not be able to crash the auth
        // response or surface a 500 vs 200 enumeration oracle.
        _sendVerificationOTP({ to: data.email, otp: data.otp }).catch((err: unknown) => {
          log.warn(
            { to: data.email, err: errorMessage(err) },
            "Verification OTP dispatch threw — auth response stays 200 to preserve enumeration protection",
          );
        });
      },
    }),
  );

  // Two-factor (TOTP + recovery codes) — required for admin / owner /
  // platform_admin sessions via the `mfaRequired` middleware in
  // packages/api/src/api/routes/admin-mfa-required.ts. Loaded
  // unconditionally so the backing schema (twoFactor table +
  // user.twoFactorEnabled) is always in place; enforcement is gated by
  // role at the router layer, not here.
  //
  // Plugin remains in the array as a flat push (rather than a wrapping
  // `if (...)`) so the schema can never be conditionally absent —
  // dropping the plugin while `mfaRequired` is still wired would lock
  // every admin out of the console.
  plugins.push(
    twoFactor({
      issuer: process.env.ATLAS_MFA_ISSUER ?? "Atlas",
      // 30 days. Matches Better Auth's current default but pinned explicitly:
      // a future minor bump that lowers the default would silently revoke
      // every trust cookie in the wild. Surfacing the value here keeps the
      // contract with the sign-in challenge UI ("Trust this device for 30
      // days") truthful no matter which Better Auth version is installed.
      trustDeviceMaxAge: 30 * 24 * 60 * 60,
    }),
  );

  // Passkeys — loaded unconditionally (see `twoFactor()` above for rationale:
  // schema must persist for already-enrolled users). Changing the *effective*
  // `rpID` after enrollment invalidates every existing passkey, so resolution
  // is deliberately conservative — explicit `ATLAS_RPID` always wins, else we
  // derive from the configured web origin's host (prod stays exactly
  // `app.useatlas.dev`; staging becomes `app.staging.useatlas.dev` instead of
  // silently inheriting prod's rpID), else the legacy default. The resolver
  // also fails loud at boot if the effective rpID can't be valid for the web
  // origin — turning an opaque browser-side "RP ID is invalid for this domain"
  // into an actionable boot error. See `resolvePasskeyRpId`.
  plugins.push(
    passkey({
      rpID: resolvePasskeyRpId(process.env, getWebOrigin()),
      rpName: process.env.ATLAS_RPNAME ?? "Atlas",
    }),
  );

  // OAuth 2.1 authorization server — powers the hosted MCP endpoint
  // (#2024) and is the standards-compliant path for any external client
  // that needs to authenticate against Atlas (Claude Desktop, ChatGPT,
  // Cursor, third-party MCP agents).
  //
  // The `jwt()` plugin must come BEFORE `oauthProvider()` — the OAuth
  // provider depends on it for JWT-formatted access tokens. Without
  // `jwt()`, oauthProvider would fall back to opaque-only tokens and
  // every resource-server verify would round-trip to the introspection
  // endpoint, which is fine functionally but ~10× slower under load.
  //
  // Schema (`oauthClient`, `oauthAccessToken`, `oauthRefreshToken`,
  // `oauthConsent`, `jwks`) lands automatically through Better Auth's
  // `ctx.runMigrations()` at boot — see migrate.ts.
  plugins.push(jwt());
  plugins.push(
    oauthProvider({
      // Where the user is sent when they hit /oauth2/authorize without
      // a session. Existing managed-auth login page handles it.
      loginPage: "/login",
      // Consent screen for the user-grants-scopes step. Page lives in
      // packages/web at src/app/oauth2/consent/page.tsx.
      consentPage: "/oauth2/consent",
      // Required for MCP onboarding — Claude Desktop / ChatGPT / Cursor
      // dynamically register as public clients without prior credentials.
      // See `resolveAllowUnauthDcr` for the deprecation-tracking note.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: resolveAllowUnauthDcr(process.env),
      scopes: [...ATLAS_OAUTH_SCOPES],
      validAudiences: resolveOAuthValidAudiences(process.env),
      // Token TTLs (#2066). Defaults match Better Auth's own defaults
      // (1h access / 30d refresh) but surfaced explicitly so the e2e
      // test can drop access TTL to ~30s without rebuilding the auth
      // server. The values are documented in mcp.mdx (hosted protocol
      // reference → token refresh contract) — keep that doc in lockstep
      // with the defaults above.
      accessTokenExpiresIn: resolveAccessTokenTtlSeconds(process.env),
      refreshTokenExpiresIn: resolveRefreshTokenTtlSeconds(process.env),
      // Tag the registered DCR client with the workspace it belongs to.
      // `clientReference` controls *ownership* of the OAuth client row
      // (used by /list, /delete, /update endpoints to filter "rows for
      // this workspace") — it does NOT propagate onto issued tokens.
      // `readActiveOrgId` (oauth-claims.ts) is the shared reader so
      // production and the canonical MCP eval can't drift on what
      // counts as a valid workspace binding (e.g. empty-string
      // handling).
      clientReference: ({ session }) =>
        readActiveOrgId(session as Parameters<typeof readActiveOrgId>[0]),
      // The `referenceId` parameter that `customAccessTokenClaims`
      // receives is whatever `postLogin.consentReferenceId` returned
      // at authorize time — `clientReference` only governs DCR client
      // ownership, not token claims. Without this hook, `referenceId`
      // is always undefined, `customAccessTokenClaims` short-circuits
      // to `{}`, and every issued JWT is rejected at the MCP edge with
      // `missing_workspace_claim`. See #2124 for the gap this closes
      // and `customAccessTokenClaims` below for the consuming half.
      //
      // `shouldRedirect: () => false` is what skips the post-login
      // interstitial — Atlas binds tokens to the session's already-
      // active workspace (organization plugin tracks one active org
      // per session) so the user has no further selection to make.
      // The `page` field is required by Better Auth's options shape
      // but is never navigated to under this `shouldRedirect` value.
      postLogin: {
        page: "/oauth2/post-login",
        consentReferenceId: async ({ session }) =>
          readActiveOrgId(session as Parameters<typeof readActiveOrgId>[0]),
        shouldRedirect: () => false,
      },
      // Stamp the workspace id onto access tokens issued under a
      // session that carries an active workspace. Tokens issued without
      // one (e.g. an authenticated user with no organization yet)
      // emit no claim and are rejected at the MCP edge with
      // `missing_workspace_claim` — the issuer doesn't try to fabricate
      // a binding, and the verifier doesn't accept an unbound bearer.
      // Claim key is sourced from `oauth-claims.ts` so production
      // issuance, MCP verification, and the test fixture share one
      // literal — drift between sites silently breaks every token.
      // The `referenceId` argument here is sourced from `postLogin.
      // consentReferenceId` above — see that hook for why.
      customAccessTokenClaims: async ({ referenceId, user }) => {
        if (!referenceId) return {};
        const claims: Record<string, unknown> = {
          [ATLAS_OAUTH_WORKSPACE_CLAIM]: referenceId,
        };
        // #2073 — emit the plural `workspace_ids` claim for users who
        // belong to more than one workspace. The CLI reads this at
        // write-time to decide whether to prompt for single-vs-multi
        // workspace setup; the runtime authorization layer at the MCP
        // edge ignores this claim entirely (it does a live DB lookup
        // against `member` + grants so membership revocation takes
        // effect immediately rather than waiting for token refresh).
        //
        // The lookup is wrapped in try/catch because token issuance
        // must never fail on a transient internal-DB hiccup — the
        // singular claim is sufficient for backward compat, and the
        // plural claim is a CLI affordance, not a security boundary.
        if (user?.id) {
          try {
            const workspaceIds = await listUserWorkspaceIds(user.id);
            if (workspaceIds.length > 1) {
              claims[ATLAS_OAUTH_WORKSPACES_CLAIM] = workspaceIds;
            }
          } catch (err: unknown) {
            // Elevated to error so dashboards / Sentry route this.
            // The user-visible token still issues correctly (singular
            // claim only), but the CLI install flow downstream will
            // silently skip the multi-workspace prompt — operators
            // need to see sustained failure here, not just once-warn.
            log.error(
              {
                err: err instanceof Error ? err.message : String(err),
                userId: user.id,
                metric: "atlas_oauth_plural_claim_lookup_failed",
              },
              "listUserWorkspaceIds failed during token issuance — emitting only singular claim",
            );
          }
        }
        return claims;
      },
      // Refresh-token audit + telemetry hook (#2066). `customTokenResponseFields`
      // is the only oauthProvider hook that surfaces `grantType`; we gate
      // the side-effect on `refresh_token` so initial code-grant issuance
      // doesn't double-count as a refresh. Returns `{}` — the hook is
      // observability-only and never reshapes the wire response.
      //
      // The `metadata` arg is the parsed `oauthClient.metadata` JSONB
      // (NOT the `oauthClient.clientId` column — Better Auth's hook does
      // not surface that column). Atlas does not write `clientId` into
      // the JSONB blob today, so under the production wiring this lookup
      // is essentially always `null` and the audit row + counter
      // attribute fall back to `"unknown"`. The hook still records the
      // userId and scopes — useful even without per-client splits — and
      // the helper signature accepts a populated clientId so a future
      // upstream Better Auth hook upgrade (or a wrapper that joins
      // `oauthAccessToken` post-issuance) can light up the per-agent
      // dashboard split without changing call sites.
      //
      // The whole callback body is wrapped in try/catch because Better
      // Auth `await`s this hook in the token-response code path with no
      // try/catch on its side — a synchronous throw here would 500 the
      // user's `/oauth/token` refresh request, breaking the very
      // contract this telemetry exists to verify. `recordOAuthTokenRefresh`
      // is documented "never throws" but its guarantee depends on
      // `logAdminAction`'s fire-and-forget contract holding indefinitely,
      // and on the `ADMIN_ACTIONS.oauth_token` constant being importable
      // — both fragile in the face of future refactors. The defensive
      // catch enforces the contract at the call site rather than relying
      // on the helper's discipline.
      customTokenResponseFields: ({ grantType, user, scopes, metadata }) => {
        if (grantType !== "refresh_token") return {};
        try {
          const clientId =
            metadata && typeof metadata.clientId === "string"
              ? metadata.clientId
              : null;
          recordOAuthTokenRefresh({
            clientId,
            userId: user?.id ?? null,
            scopes,
          });
        } catch (err: unknown) {
          // Telemetry must never break user-visible refresh. Log loud
          // enough that operators can correlate dashboards going flat
          // with this branch firing; pino warn (not error) reflects
          // "non-fatal but worth investigating".
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "oauth refresh telemetry hook threw — refresh response unaffected",
          );
        }
        return {};
      },
    }),
  );

  // SCIM directory sync — enterprise only.
  // No try/catch: if the plugin fails to initialize (missing dep, bad config),
  // the auth server must fail to start rather than silently running without
  // SCIM while the admin UI suggests it is available.
  if (isEnterpriseEnabled()) {
    plugins.push(
      scim({
        storeSCIMToken: "encrypted",
        async beforeSCIMTokenGenerated(data) {
          // Cast needed: the admin plugin adds `role` to the user
          // object but the SCIM plugin's hook type only includes base
          // user fields.
          const user = data.user as Record<string, unknown> | undefined;
          // #2890: resolve the EFFECTIVE grant (user.role only holds
          // platform_admin now; org admins/owners live in member.role).
          const userId = typeof user?.id === "string" ? user.id : undefined;
          if (!(await canGenerateSCIMToken(user?.role, userId))) {
            throw new Error("Only admin, owner, or platform-admin users can generate SCIM tokens.");
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
        // Shared accessor (#3425) — same client instance + pinned apiVersion
        // as the workspace billing teardown in lib/billing/workspace-teardown.ts.
        const stripeClient = getStripeClient();
        if (!stripeClient) {
          // Unreachable: the STRIPE_SECRET_KEY check above guarantees a client.
          throw new Error("getStripeClient() returned null despite STRIPE_SECRET_KEY being set");
        }

        plugins.push(
          stripePlugin(buildStripePluginOptions({ stripeClient, webhookSecret })),
        );

        log.info("Stripe billing plugin enabled");
      } catch (err) {
        log.error(
          { err: errorMessage(err) },
          "Failed to initialize Stripe billing plugin — billing features will be unavailable",
        );
      }
    }
  }

  // customSession — surface the org-merged effective role on the session
  // for both client (gear icon, sidebar) and server (validateManaged
  // reads `user.effectiveRole` straight off the session payload, avoiding
  // a second member-table SELECT per request).
  //
  // `user.role` is now an `additionalFields` column (the admin plugin that
  // owned it was removed in #3159); it only ever carries `platform_admin` or
  // the `member` default. `effectiveRole` = max(user.role, active-org
  // member.role) is the value gates read.
  //
  // The callback runs on every `getSession`, so `effectiveRole` is recomputed
  // fresh per request (one member-table SELECT, replacing the one validateManaged
  // used to run). NOTE: this does NOT bypass the cookie cache — the base
  // `user`/`session` Better Auth returns (and thus `...user`'s `banned`/
  // `banExpires`) is the signed-cookie snapshot on a cache hit (up to
  // `cookieCache.maxAge`); only the custom `effectiveRole` field is re-derived.
  //
  // Inside the same `any[]` plugin array as every other plugin above —
  // adding it here means we don't need any new casts at the call site.
  plugins.push(customSession(buildCustomSessionPayload));

  return plugins;
}

/**
 * customSession callback — see the {@link buildPlugins} push site for
 * the architectural rationale (why `effectiveRole` and not `role`, why
 * the cookie-cache bypass is fine).
 *
 * Exported for the tiny unit test that pins the role-merge contract; not
 * a public API.
 *
 * @internal
 */
export async function buildCustomSessionPayload({
  user,
  session,
}: {
  user: User & Record<string, unknown>;
  session: Session & { activeOrganizationId?: string | null } & Record<string, unknown>;
}) {
  const rawRole = user.role;
  const userRole =
    typeof rawRole === "string"
      ? (rawRole.split(",")[0].trim() as Parameters<typeof resolveEffectiveRole>[0])
      : undefined;
  const activeOrganizationId =
    typeof session.activeOrganizationId === "string"
      ? session.activeOrganizationId
      : undefined;
  const effectiveRole = await resolveEffectiveRole(userRole, user.id, activeOrganizationId);
  return {
    user: { ...user, effectiveRole: effectiveRole ?? null },
    session,
  };
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
        // checkResourceLimit fails closed on infra errors with
        // `reason: "check_failed"`. Detect that and fail open — blocking
        // SSO login is worse than transient over-provisioning.
        if (limitCheck.reason === "check_failed") {
          log.warn(
            { userId: user.id, orgId },
            "SSO auto-provisioning: billing check failed (infra error?) — allowing provisioning",
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
        { err: errorMessage(err), errName: err instanceof Error ? err.name : "unknown", userId: user.id, orgId },
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
      { err: errorMessage(err), userId: user.id, email: user.email },
      "SSO auto-provisioning failed — user created but not auto-joined to org",
    );
  }
}

/**
 * Inputs to {@link buildAuthOptions}. Split out so `getAuthInstance()` can
 * resolve all boot-time concerns (env parsing, secret validation, plugin
 * assembly, cookie-domain derivation) and hand a pure struct to the options
 * builder — and so tests can drive the builder without standing up Better
 * Auth's full plugin graph or an internal Postgres.
 *
 * Design notes:
 * - `internalDbAvailable` is derived from `database !== undefined` inside
 *   the builder; passing both would admit a mismatched pair (e.g.
 *   `database: undefined, internalDbAvailable: true` → the rate limiter
 *   picks "database" storage against a memory adapter).
 * - `bootstrapAdmin` replaces the earlier `adminEmail` + `allowFirstSignupAdmin`
 *   pair so the three mutually-exclusive modes are statically enforced.
 * - `testOverrides` is an explicit @internal escape hatch; the field's
 *   existence and naming make it obvious that production callers should
 *   leave it unset.
 *
 * @internal — exported for testing.
 */
export interface BuildAuthOptionsDeps {
  env: NodeJS.ProcessEnv;
  secret: AuthSecret;
  baseURL: string | undefined;
  /**
   * The internal Postgres pool that backs auth storage. Pass `undefined`
   * in tests to have Better Auth fall back to its built-in in-memory
   * adapter — the builder uses the presence of this field to also select
   * "memory" vs "database" rate-limit storage, so the two knobs stay in
   * lockstep.
   */
  database: InternalPool | undefined;
  cookieDomain: string | undefined;
  /** Better Auth session-cookie prefix; see {@link buildAdvancedConfig}. */
  cookiePrefix: string;
  socialProviders: ReturnType<typeof buildSocialProviders>;
  plugins: ReturnType<typeof buildPlugins>;
  trustedOrigins: string[];
  bootstrapAdmin: BootstrapAdminConfig;
  /**
   * Test-only overrides. Keeping these in a nested object rather than at
   * the top level makes the seam visible in call sites and prevents
   * accidental production use (e.g. a refactor that reaches for the
   * shape via `deps.sendVerificationEmail`).
   *
   * @internal
   */
  testOverrides?: {
    /**
     * Replace the password-reset-email dispatcher. Pins the outer
     * `.catch()` so a future refactor can't silently turn rejections
     * into floating promises that crash the process under
     * `--unhandled-rejections=strict`.
     */
    sendPasswordResetEmail?: typeof _sendPasswordResetEmail;
  };
}

/**
 * Assemble the options object handed to `betterAuth()`.
 *
 * Kept thin and pure so the wiring — `advanced` / `rateLimit` /
 * `emailAndPassword` / the outer `.catch()` on `sendVerificationEmail` —
 * is an assertable shape rather than a deeply nested literal in the
 * middle of {@link getAuthInstance}. Regression tests in
 * `rate-limit-integration.test.ts` pin every one of those surfaces so a
 * future refactor can't silently swap any of them for `undefined` and
 * reopen the F-05 / F-06 / F-07 attack paths.
 *
 * @internal — exported for testing.
 */
export function buildAuthOptions(deps: BuildAuthOptionsDeps): Parameters<typeof betterAuth>[0] {
  const internalDbAvailable = deps.database !== undefined;
  const requireEmailVerification = resolveRequireEmailVerification(deps.env);
  const rateLimitConfig = resolveAuthRateLimitConfig(deps.env, internalDbAvailable);
  const sendReset = deps.testOverrides?.sendPasswordResetEmail ?? _sendPasswordResetEmail;
  // Frontend origin for post-verify / post-reset redirects. Without this,
  // Better Auth's redirect lands on the API host and 404s. First trusted
  // origin is the canonical web app URL — set via BETTER_AUTH_TRUSTED_ORIGINS.
  // An empty/missing value silently re-creates the original 404 bug, so warn
  // once at config-resolution time rather than per-email-send. Operators
  // running tests with empty trustedOrigins shouldn't be spammed though, so
  // we suppress the warn when the env signal explicitly disables verification.
  const frontendOrigin = deps.trustedOrigins[0] ?? "";
  if (!frontendOrigin && requireEmailVerification) {
    log.warn(
      "BETTER_AUTH_TRUSTED_ORIGINS is empty — verification + password-reset links will redirect to the API host and 404. Set BETTER_AUTH_TRUSTED_ORIGINS to the web app URL (e.g. https://app.useatlas.dev).",
    );
  }

  // Unfold the tagged bootstrap-admin config into the flat args
  // `computeBootstrapRole` expects. Keeping the flat pair confined to
  // this function means the hook body still reads naturally while the
  // deps struct exposes the tagged union to callers.
  const adminEmail = deps.bootstrapAdmin.mode === "email" ? deps.bootstrapAdmin.email : undefined;
  const allowFirstSignupAdmin = deps.bootstrapAdmin.mode === "first-signup";

  // Cast at the return point: `databaseHooks.session` returns a session
  // shape augmented with the organization plugin's `activeOrganizationId`,
  // which is not part of Better Auth's base options shape.
  // `Parameters<typeof betterAuth>[0]` resolves to that base shape because
  // the function is generic over the plugin tuple, which we intentionally
  // erase from `BuildAuthOptionsDeps`. The cast pays the cost of that
  // erasure at the single boundary rather than forcing every caller
  // through plugin generics.
  const options = {
    // InternalPool is pg.Pool-shaped via a local alias; Better Auth
    // expects its own pool/adapter surface type. The cast is a one-way
    // assertion that the pool we hand it is compatible.
    database: deps.database as Parameters<typeof betterAuth>[0]["database"],
    secret: deps.secret,
    baseURL: deps.baseURL,
    // F-05: closes the signup-enumeration oracle and blocks unverified
    // accounts from claiming SSO auto-provision / invitation workflows.
    // See `buildEmailAndPasswordConfig` for the `autoSignIn` invariant.
    // The `sendResetPassword` callback wires Atlas's email-delivery
    // layer into Better Auth's password-reset flow; without it, the
    // request endpoint would 400 with `RESET_PASSWORD_DISABLED` and the
    // /forgot-password UI would have no recovery path.
    emailAndPassword: buildEmailAndPasswordConfig({
      requireEmailVerification,
      sendResetPassword: async (data) => {
        // Mirror the verification-email contract: never await the dispatch
        // and never let a thrown rejection escape. The `.catch()` here is
        // belt-and-suspenders — `_sendPasswordResetEmail` already wraps
        // every failure path — but a future refactor that drops the inner
        // try/catch must still not be able to crash the request handler
        // (which would reopen an enumeration oracle as a 500 vs 200 side
        // channel) or print to stderr with no correlation.
        sendReset({
          to: data.user.email,
          url: rewriteVerificationCallbackURL(data.url, frontendOrigin),
        }).catch((err: unknown) => {
          log.warn(
            { to: data.user.email, err: errorMessage(err) },
            "Password reset dispatch threw — request response stays 200 to preserve enumeration protection",
          );
        });
      },
    }),
    emailVerification: {
      // No `sendVerificationEmail` callback: the `emailOTP` plugin's
      // `init()` overrides this with the OTP sender when
      // `overrideDefaultEmailVerification: true` (see plugin config
      // below). Wiring a magic-link callback here would win on options
      // merge and reintroduce the bug where signup sent a magic link
      // instead of an OTP code while resend correctly sent a code.
      //
      // `_sendVerificationEmail` is retained in this file only as a
      // tested helper for the rate-limit smoke tests; it has no live
      // call site now that OTP is the sole verification path.
      autoSignInAfterVerification: true,
      // Re-issue a verification code whenever an unverified user attempts
      // sign-in. The plugin's override turns this into an OTP send.
      sendOnSignIn: true,
    },
    socialProviders: deps.socialProviders,
    // F-07 — cookieCache.maxAge bounds the revocation window. Previously
    // 5 * 60 (5 minutes), which meant a ban / session revoke (`banUserDirect` /
    // `revokeUserSessionsDirect`, #3159) didn't take effect for up to 5 minutes
    // because the signed cookie short-circuited the DB lookup. Default is now
    // 30s, overridable within [5, 300] via ATLAS_SESSION_COOKIE_CACHE_MAX_AGE_SEC.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: resolveSessionCookieCacheMaxAge(deps.env) },
    },
    // #3159 — these `user` columns were contributed by the removed admin()
    // plugin's schema. Re-declared here as `additionalFields` with the same
    // column types (role: string/input:false; banned: boolean/default false/
    // input:false; banReason: string/input:false; banExpires: date/input:false)
    // so Better Auth still SELECTs them into every getSession — the
    // `customSession` callback reads `role`, the session-create ban guard +
    // per-request check read `banned`/`banExpires`, and the platform user list
    // surfaces all four. The migration generator sees no change (zero drift): it
    // diffs column existence + type only, and the added `defaultValue: "member"`
    // on `role` (the plugin had none) is applied at the application layer —
    // Better Auth emits no DDL DEFAULT for a scalar string default. `input:
    // false` preserves the invariant that a signup payload cannot self-assign
    // `role: "platform_admin"`.
    user: {
      additionalFields: {
        // `defaultValue: "member"` reproduces the removed admin plugin's
        // `defaultRole: "member"` (a user-level role, distinct from member.role
        // where tenant admin-ness lives). It is applied on the real create AND
        // materialized into Better Auth's synthetic existing-email signup
        // envelope, so both signup branches carry the same `role` value — without
        // it, the real path (role "member") and the synthetic path (role null)
        // would diverge and reopen the enumeration oracle (#1792 class).
        role: { type: "string", required: false, input: false, defaultValue: "member" },
        banned: { type: "boolean", required: false, input: false, defaultValue: false },
        banReason: { type: "string", required: false, input: false },
        banExpires: { type: "date", required: false, input: false },
      },
    },
    plugins: deps.plugins,
    trustedOrigins: deps.trustedOrigins,
    // F-06 — explicit rate limits on /api/auth/*. Built-in defaults are
    // NODE_ENV-gated and in-memory-only; see resolveAuthRateLimitConfig.
    rateLimit: rateLimitConfig,
    // F-06: the `advanced` block wires Better Auth's rate limiter to
    // read only the trusted `x-atlas-client-ip` header that our
    // middleware injects. See `buildAdvancedConfig` for the invariant.
    advanced: buildAdvancedConfig(deps.cookieDomain, deps.cookiePrefix),
    databaseHooks: {
      session: {
        create: {
          // Better Auth's hook input for `session.create.before/after` is
          // the base `Session` plus the organization plugin's
          // `activeOrganizationId` extension, plus an unsafe index
          // signature upstream uses to allow further plugin fields.
          // Naming the org extension explicitly keeps `.activeOrganizationId`
          // typed where other fields go through `unknown`.
          before: async (session: Session & { activeOrganizationId?: string | null } & Record<string, unknown>) => {
            // #3159 — reproduce the admin plugin's ban guard: block new-session
            // creation for a banned user (auto-unbanning when `banExpires` has
            // passed). Runs OUTSIDE the try/catch below so its BANNED_USER
            // APIError propagates and aborts session creation — swallowing it
            // would make ban inert. Throws only for an active ban; a read
            // failure fails open (the per-request check in managed.ts backstops).
            await enforceBanOnSessionCreate(session.userId);

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
                { err: errorMessage(err), userId: session.userId },
                "Failed to auto-set active org — user may need to switch manually",
              );
            }
          },
          after: async (session: Session & { activeOrganizationId?: string | null }) => {
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
                { err: errorMessage(err), userId: session.userId },
                "Login event emission skipped",
              );
            }
          },
        },
      },
      user: {
        create: {
          before: async (user: User & Record<string, unknown>) => {
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

              // Non-promoted signups fall through: the `role` additionalField's
              // `defaultValue: "member"` (#3159) supplies the default, so the
              // hook only needs to act on the promote case. Setting it here too
              // would diverge from the synthetic existing-email envelope (which
              // can't run this hook) and reopen the enumeration oracle.

            } catch (err) {
              // Include the full env state in the log so operators who expected
              // their signup to be promoted (ATLAS_ADMIN_EMAIL match or opt-in
              // fallback) can see WHY it fell through. Without this context, a
              // DB outage or schema drift during legitimate bootstrap would
              // silently lock out the operator with one opaque log line.
              log.error(
                {
                  err: errorMessage(err),
                  email: user.email,
                  hasAdminEmail: !!adminEmail,
                  allowFirstSignupAdmin,
                  internalDbAvailable,
                },
                "Bootstrap admin check failed — defaulting to normal role assignment. Check DB connectivity and env configuration.",
              );
            }
          },
          after: async (user: User) => {
            // Awaited deliberately — the helper swallows every failure
            // mode internally, so the await only blocks on the
            // outbox INSERT. Not awaiting risks an unhandled rejection
            // if a future change widens the error channel.
            await dispatchSignupCrmLead({ user });

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
                    { userId: user.id, err: errorMessage(err) },
                    "Failed to trigger welcome email — non-blocking",
                  );
                }
              }, 2000);
            }

            await _autoProvisionSsoMember(user);
          },
        },
      },
      verification: {
        create: {
          // Capture device metadata for trust-device cookies. The 2FA plugin
          // writes the verification row with `identifier: "trust-device-..."`;
          // we mirror UA / IP / label into `trusted_device` keyed on the same
          // identifier so the security page can render a meaningful list.
          //
          // Defensive outer try/catch: `onVerificationCreated` already swallows
          // its own errors, but Better Auth awaits this hook inside
          // `queueAfterTransactionHook` and rethrows — a future regression that
          // adds an unguarded throw inside the hook (or any module-level
          // initialization that fails) would otherwise 500 the user's auth
          // flow. See trusted-device-hook.ts header for the invariant.
          after: async (record: Record<string, unknown>, ctx: unknown) => {
            try {
              await onVerificationCreated(
                record,
                ctx as { headers?: Headers; request?: Request } | null | undefined,
              );
            } catch (err) {
              log.warn(
                { err: errorMessage(err) },
                "trust-device after-hook escaped its inner catch — auth flow continued",
              );
            }
          },
        },
      },
    },
  };

  return options as unknown as Parameters<typeof betterAuth>[0];
}

export function getAuthInstance(): AuthInstance {
  if (_instance) return _instance;

  const secret = parseAuthSecret(process.env.BETTER_AUTH_SECRET);

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

  // Derive parent domain for cross-subdomain cookies — the longest dotted
  // suffix common to the API host (BETTER_AUTH_URL) and the canonical app
  // origin. Only for cross-origin deploys (ATLAS_CORS_ORIGIN set); without it,
  // cookies are host-scoped and won't be sent from the frontend subdomain.
  // Use getWebOrigin() (the FIRST CORS entry — the app) rather than the whole
  // allowlist, so an unrelated allowlisted origin can't veto the shared
  // domain. See `deriveCookieDomain` for why the env-specific suffix matters.
  const webOrigin = process.env.ATLAS_CORS_ORIGIN ? getWebOrigin() : null;
  const cookieDomain = deriveCookieDomain(process.env.BETTER_AUTH_URL, webOrigin ?? undefined);
  // Fail loud on the silent footgun: a cross-origin deploy that yields no
  // shared domain — usually a malformed BETTER_AUTH_URL or an app origin that
  // shares no 2+ label suffix with it — leaves session cookies host-only, so
  // the app subdomain never receives them and auth breaks with no other
  // signal. Hostnames aren't secrets (CLAUDE.md), so log them.
  if (process.env.BETTER_AUTH_URL && webOrigin && !cookieDomain) {
    log.warn(
      { authUrl: process.env.BETTER_AUTH_URL, webOrigin },
      "Cross-origin deploy (ATLAS_CORS_ORIGIN set) but no shared cookie domain could be "
        + "derived from the API host and the app origin — session cookies will be host-only "
        + "and won't reach the app subdomain. Verify BETTER_AUTH_URL and the first "
        + "ATLAS_CORS_ORIGIN entry are valid URLs sharing a 2+ label suffix.",
    );
  }

  // Session-cookie name prefix — distinct per deployment env so prod and
  // staging (which share the `.useatlas.dev` cookie zone) don't collide on a
  // single cookie slot. MUST match web's NEXT_PUBLIC_ATLAS_COOKIE_PREFIX.
  const cookiePrefix = resolveCookiePrefix(process.env);

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

  const options = buildAuthOptions({
    env: process.env,
    secret,
    baseURL,
    database: internalDbAvailable ? getInternalDB() : undefined,
    cookieDomain,
    cookiePrefix,
    socialProviders,
    plugins: buildPlugins(),
    trustedOrigins:
      process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [],
    bootstrapAdmin: resolveBootstrapAdminConfig(adminEmail, allowFirstSignupAdmin),
  });

  const instance = betterAuth(options) as unknown as AuthInstance;

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
