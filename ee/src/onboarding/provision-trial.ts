/**
 * Reusable trial-Workspace provisioner — the highest, most testable seam for
 * self-serve signup (ADR-0018, PRD #3646, #3649).
 *
 * `provisionTrialWorkspace({ email, orgName })` orchestrates the same Better
 * Auth path the web signup uses — `signUpEmail` then `organization.create` —
 * and lands the new Workspace on the existing `trial` tier in an **unclaimed
 * grace** state (a short initial `trial_ends_at`). It reuses the existing
 * `assignSaasTrial` / `claimTrialGrant` path verbatim: creating the
 * organization fires Better Auth's `afterCreateOrganization` hook, which runs
 * `assignSaasTrial` (atomic one-trial-per-user claim + tier assignment). This
 * provisioner then narrows `trial_ends_at` from the full {@link TRIAL_DAYS}
 * window down to {@link TRIAL_GRACE_HOURS} — the 14-day clock only starts when
 * a human *claims* the account on the web.
 *
 * SaaS-only: it refuses when `deployMode !== 'saas'`. This is the single lib
 * seam the `start_trial` MCP tool and any future HTTP onboarding face both
 * call — neither re-implements the signup orchestration.
 *
 * It deliberately lives in `ee/` (self-serve trial signup is a hosted-SaaS
 * concern) and never binds an MCP actor: the caller is the *anonymous
 * onboarding caller*, and a normal *hosted* actor takes over via the DCR/PKCE
 * connect using the returned `connectUrl`.
 */

import { randomBytes } from "node:crypto";
import { getConfig } from "@atlas/api/lib/config";
import { TRIAL_GRACE_HOURS } from "@atlas/api/lib/billing/plans";
import type { PlanTier } from "@atlas/api/lib/db/internal";
import { buildMcpConnectUrl } from "@atlas/api/lib/mcp/connect-url";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("provision-trial");

export type TrialWorkspaceState = "grace" | "locked";

export interface ProvisionTrialInput {
  readonly email: string;
  readonly orgName: string;
}

export interface ProvisionTrialResult {
  /** Better Auth `organization.id` of the freshly created Workspace. */
  readonly workspaceId: string;
  /** Hosted-MCP connect URL the agent uses to attach a hosted actor (DCR/PKCE). */
  readonly connectUrl: string;
  /**
   * `grace` — provisioned onto `trial` in unclaimed grace (happy path).
   * `locked` — the user already consumed a trial, so the Workspace lands on
   * the zero-entitlement `locked` tier (one-trial-per-user, #3426). No grace.
   */
  readonly state: TrialWorkspaceState;
}

/** Discriminating reason codes for a refused / failed provisioning attempt. */
export type TrialProvisioningCode =
  | "not_saas"
  | "invalid_input"
  | "business_email"
  | "signup_failed"
  | "org_failed"
  | "trial_not_assigned";

/**
 * Typed error so the MCP tool / HTTP face can map to a structured envelope.
 *
 * A plain `Error` subclass (not a `Data.TaggedError`) on purpose: the consumer
 * is the plain-async MCP `start_trial` tool seam, which recognizes it with
 * `instanceof TrialProvisioningError` (see `packages/mcp/src/onboarding.ts`).
 * Converting it to a tagged error would break that `instanceof` check — mirrors
 * the same deliberate choice in `ClaimRequiredError` (`billing/claim-gate.ts`).
 */
export class TrialProvisioningError extends Error {
  override readonly name = "TrialProvisioningError";
  readonly code: TrialProvisioningCode;
  constructor(code: TrialProvisioningCode, message: string) {
    super(message);
    this.code = code;
  }
}

// A type alias (not an interface) so it satisfies the
// `Record<string, unknown>` constraint on `internalQuery<T>`. `plan_tier` is
// typed as the closed `PlanTier` union (not a widened `string`) so the
// `planTier === 'trial' | 'locked'` checks below narrow instead of comparing
// against an open string. `OrgTierRow` is module-private and not part of the
// ee-stub lockstep surface, so importing `PlanTier` here costs nothing there.
type OrgTierRow = {
  plan_tier: PlanTier;
  trial_ends_at: string | null;
};

/**
 * External boundaries the provisioner touches, injectable for testing. Each
 * default lazily imports the heavy `@atlas/api` module it needs so a test that
 * supplies stubs never pulls Better Auth / the internal DB into its graph.
 */
export interface ProvisionTrialDeps {
  /** Resolve the configured deploy mode. */
  getDeployMode: () => "saas" | "self-hosted" | undefined;
  /** Better Auth server-side `signUpEmail`. */
  signUpEmail: (body: {
    email: string;
    password: string;
    name: string;
  }) => Promise<{ user?: { id?: string } } | undefined>;
  /** Better Auth server-side `createOrganization` (fires `assignSaasTrial`). */
  createOrganization: (body: {
    name: string;
    slug: string;
    userId: string;
  }) => Promise<{ id?: string } | undefined>;
  /** Read the post-hook tier so we know whether the Workspace got the trial. */
  readOrgTier: (orgId: string) => Promise<OrgTierRow | undefined>;
  /**
   * Narrow `trial_ends_at` to the grace window (guarded on `plan_tier='trial'`).
   * Returns the number of rows actually updated so the caller can detect a
   * guarded no-op (tier changed under us between read and write) rather than
   * silently returning a full-window `grace` state.
   */
  setGraceWindow: (orgId: string, endsAtIso: string) => Promise<number>;
  /** Build the hosted-MCP connect URL for the new Workspace. */
  buildConnectUrl: (workspaceId: string) => string;
  /**
   * Enqueue the distinct `MCP_SIGNUP` CRM lead (ADR-0018, #3653) through the
   * existing `SaasCrm.upsertLead` → `crm_outbox` → Twenty pipeline. Mirrors
   * the web path's `signup` enqueue, but as a measurable acquisition channel.
   * Swallows its own failures (a CRM/outbox outage must not fail provisioning).
   */
  enqueueMcpSignupLead: (email: string, name?: string) => Promise<void>;
  /** Grace window length in ms. */
  graceMs: number;
}

function defaultDeps(): ProvisionTrialDeps {
  return {
    getDeployMode: () => getConfig()?.deployMode,
    signUpEmail: async (body) => {
      const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
      const { runWithSignupOrigin } = await import(
        "@atlas/api/lib/auth/signup-origin"
      );
      const auth = getAuthInstance();
      const signUp = (auth.api as Record<string, unknown>).signUpEmail as (o: {
        body: { email: string; password: string; name: string };
      }) => Promise<{ user?: { id?: string } } | undefined>;
      // Tag the in-flight signup as MCP-originated so Better Auth's
      // `user.create.after` hook (`dispatchSignupCrmLead`) suppresses the
      // generic SIGNUP CRM lead — this path emits MCP_SIGNUP itself, and a
      // second same-email row with an earlier `created_at` would steal the
      // sticky first-source. The ALS context propagates through the await
      // chain into the hook.
      return runWithSignupOrigin("mcp", () => signUp({ body }));
    },
    createOrganization: async (body) => {
      const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
      const auth = getAuthInstance();
      const createOrg = (auth.api as Record<string, unknown>)
        .createOrganization as (o: {
        body: { name: string; slug: string; userId: string };
      }) => Promise<{ id?: string } | undefined>;
      return createOrg({ body });
    },
    readOrgTier: async (orgId) => {
      const { internalQuery } = await import("@atlas/api/lib/db/internal");
      const rows = await internalQuery<OrgTierRow>(
        `SELECT plan_tier, trial_ends_at FROM organization WHERE id = $1 LIMIT 1`,
        [orgId],
      );
      return rows[0];
    },
    setGraceWindow: async (orgId, endsAtIso) => {
      const { internalQuery } = await import("@atlas/api/lib/db/internal");
      // `RETURNING id` so we get the affected rows back — `internalQuery`
      // surfaces rows, not a `rowCount`, so this is how we know the guarded
      // `plan_tier = 'trial'` UPDATE actually landed.
      const updated = await internalQuery<{ id: string }>(
        `UPDATE organization SET trial_ends_at = $1
         WHERE id = $2 AND plan_tier = 'trial'
         RETURNING id`,
        [endsAtIso, orgId],
      );
      return updated.length;
    },
    buildConnectUrl: (workspaceId) => buildMcpConnectUrl(workspaceId),
    enqueueMcpSignupLead: async (email, name) => {
      const { dispatchMcpSignupCrmLead } = await import(
        "@atlas/api/lib/auth/server"
      );
      await dispatchMcpSignupCrmLead({ email, name });
    },
    graceMs: TRIAL_GRACE_HOURS * 60 * 60 * 1000,
  };
}

/** A throwaway password — the human sets a real credential when they claim. */
function generateThrowawayPassword(): string {
  return `${randomBytes(24).toString("base64url")}Aa1!`;
}

/** Derive a unique-ish org slug from the workspace name. */
function deriveSlug(orgName: string): string {
  const base = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = randomBytes(4).toString("hex");
  return base.length > 0 ? `${base}-${suffix}` : `workspace-${suffix}`;
}

function isValidEmail(email: string): boolean {
  // Deliberately permissive — disposable/freemium policy is enforced on the
  // shared Better Auth signup path (#3650), not here. This only rejects
  // obviously malformed input before we spend a signup round-trip.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Provision a brand-new trial Workspace and return the hosted-MCP connect URL.
 *
 * @throws {TrialProvisioningError} `not_saas` when deploy mode isn't SaaS;
 *   `invalid_input` for empty/malformed email or name; `business_email` when the
 *   address is freemium/disposable (the shared #3650 signup-hook deny);
 *   `signup_failed` / `org_failed` when the Better Auth path returns no id;
 *   `trial_not_assigned` when the org landed on neither `trial` nor `locked`.
 */
export async function provisionTrialWorkspace(
  input: ProvisionTrialInput,
  overrides: Partial<ProvisionTrialDeps> = {},
): Promise<ProvisionTrialResult> {
  const deps: ProvisionTrialDeps = { ...defaultDeps(), ...overrides };

  if (deps.getDeployMode() !== "saas") {
    throw new TrialProvisioningError(
      "not_saas",
      "Self-serve trial provisioning is only available on Atlas SaaS.",
    );
  }

  const email = input.email?.trim();
  const orgName = input.orgName?.trim();
  if (!email || !isValidEmail(email)) {
    throw new TrialProvisioningError(
      "invalid_input",
      "A valid email address is required to start a trial.",
    );
  }
  if (!orgName) {
    throw new TrialProvisioningError(
      "invalid_input",
      "A workspace name is required to start a trial.",
    );
  }

  const name = email.split("@")[0] || orgName;
  let signup: Awaited<ReturnType<ProvisionTrialDeps["signUpEmail"]>>;
  try {
    signup = await deps.signUpEmail({
      email,
      password: generateThrowawayPassword(),
      name,
    });
  } catch (err) {
    // The business-email-only policy (#3650) is enforced in the SHARED Better
    // Auth `user.create.before` hook, so a freemium/disposable address throws
    // a typed `business_email_required` APIError out of `signUpEmail`. Map it to
    // the distinct `business_email` code so the MCP `start_trial` envelope
    // surfaces the actionable "use your work email" message + a tailored hint
    // (a `validation_failed` envelope on the wire, but distinguishable from a
    // malformed-email `invalid_input`) — NOT the generic `internal_error`/"please
    // retry" a bare rethrow would produce (a deny is permanent, not transient).
    // Lazily imported so the heavy `better-auth-harmony` graph this recognizer
    // pulls stays out of stub-injected unit tests (mirrors the dep philosophy).
    //
    // The import is wrapped so a (realistically impossible — already loaded on
    // the real signup path) module-evaluation failure can't *substitute* the
    // original signup error: on import failure we log and rethrow `err`, the
    // genuine failure, rather than letting the import rejection mask it.
    let recognizer:
      | typeof import("@atlas/api/lib/auth/business-email")
      | undefined;
    try {
      recognizer = await import("@atlas/api/lib/auth/business-email");
    } catch (importErr) {
      log.warn(
        { err: importErr instanceof Error ? importErr.message : String(importErr) },
        "business-email recognizer import failed; rethrowing original signup error",
      );
    }
    if (recognizer?.isBusinessEmailRejection(err)) {
      throw new TrialProvisioningError(
        "business_email",
        recognizer.BUSINESS_EMAIL_REQUIRED_MESSAGE,
      );
    }
    throw err;
  }
  const userId = signup?.user?.id;
  if (!userId) {
    // Better Auth returns an enumeration-safe synthetic response (no real user
    // id) when the email is already registered, so a missing id here means the
    // account couldn't be freshly provisioned.
    throw new TrialProvisioningError(
      "signup_failed",
      "Could not create an account for this email. It may already be registered — sign in on the web instead.",
    );
  }

  // Attribute the acquisition channel as MCP_SIGNUP. Enqueued here — right
  // after the user account is created, BEFORE org creation — to mirror where
  // the web path enqueues its SIGNUP lead (Better Auth's `user.create.after`
  // hook), and so there's no "user created with zero CRM lead" gap if org
  // creation fails downstream. The competing auto-SIGNUP is suppressed on this
  // path (`signUpEmail` ran under `runWithSignupOrigin("mcp")`), leaving
  // MCP_SIGNUP the sole `crm_outbox` row — see `lib/auth/signup-origin.ts` for
  // the sticky-first-touch race that makes suppression load-bearing.
  //
  // Wrapped in try/catch as a seam guard, belt-and-suspenders over the
  // swallow-and-log inside the default `enqueueMcpSignupLead`: a CRM/outbox
  // outage — or a future dep whose contract regresses — must NEVER fail trial
  // provisioning. Attribution is best-effort; provisioning is not.
  try {
    await deps.enqueueMcpSignupLead(email, name);
  } catch (err) {
    log.warn(
      {
        event: "mcp_signup_crm.enqueue_threw",
        err: err instanceof Error ? err.message : String(err),
      },
      "enqueueMcpSignupLead threw — swallowed to keep provisioning unblocked",
    );
  }

  const org = await deps.createOrganization({
    name: orgName,
    slug: deriveSlug(orgName),
    userId,
  });
  const workspaceId = org?.id;
  if (!workspaceId) {
    // The user account was already created by `signUpEmail` above, so this
    // leaves an orphaned user with no Workspace. Retrying `start_trial` with
    // the same email would now hit `signup_failed` ("already registered"), so
    // the prospect can't self-recover — log it so an operator can find/reap the
    // orphan, and tell the caller to sign in rather than retry.
    log.error(
      { userId },
      "start_trial: organization creation returned no id — orphaned user with no workspace",
    );
    throw new TrialProvisioningError(
      "org_failed",
      "Your account was created but the workspace could not be provisioned. Sign in on the web to finish setup, or contact support.",
    );
  }

  // `assignSaasTrial` already ran in the org-create hook: the Workspace is on
  // `trial` (full window) or `locked` (consumed trial). Read it back, then
  // narrow a trial to the short unclaimed-grace window.
  const tier = await deps.readOrgTier(workspaceId);
  const planTier = tier?.plan_tier;

  let state: TrialWorkspaceState;
  if (planTier === "trial") {
    const graceEndsAt = new Date(Date.now() + deps.graceMs).toISOString();
    const updated = await deps.setGraceWindow(workspaceId, graceEndsAt);
    if (updated !== 1) {
      // The guarded UPDATE matched no row — the tier changed between the
      // read-back and the write (TOCTOU). Returning `grace` here would hand
      // back a Workspace still on the full TRIAL_DAYS window, silently
      // defeating the unclaimed-grace property. Fail loud instead.
      log.warn(
        { workspaceId, updated },
        "start_trial: grace-window narrowing matched no row (tier changed under us); refusing to report grace",
      );
      throw new TrialProvisioningError(
        "trial_not_assigned",
        "Workspace was created but the trial grace window could not be set. Please contact support.",
      );
    }
    state = "grace";
  } else if (planTier === "locked") {
    state = "locked";
  } else {
    log.error(
      { workspaceId, planTier: planTier ?? "unknown" },
      "start_trial: workspace landed on neither trial nor locked after assignSaasTrial",
    );
    throw new TrialProvisioningError(
      "trial_not_assigned",
      "Workspace was created but did not land on the trial tier. Please contact support.",
    );
  }

  return {
    workspaceId,
    connectUrl: deps.buildConnectUrl(workspaceId),
    state,
  };
}
