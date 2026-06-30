/**
 * Claim-gated metering for self-serve MCP trials (ADR-0018, #3651).
 *
 * A Workspace provisioned over MCP by the anonymous onboarding caller
 * (`start_trial`, #3649) is **unclaimed** until a human completes the web OTP
 * interstitial (emailOTP verify — never magic link — set a credential/passkey,
 * accept ToS), which flips the owner's `emailVerified` bit. Unclaimed =
 * **metered**: *setup* (connect a datasource, build the semantic layer) and
 * *MCP querying* (the client's own model pays — no Atlas tokens) stay open, but
 * *Atlas-token Q&A* — the only thing that actually costs Atlas — is withheld.
 *
 * The non-obvious part (recorded in ADR-0018) is **where** the meter lives.
 * Every MCP datasource tool declares `checksBilling: true` and routes through
 * Gate 0 (`checkAgentBillingGate`), so implementing "metered" as a
 * `tokenBudgetPerSeat: 0` clamp would trip Gate 0 and block setup + MCP
 * querying — the opposite of the intent. So the meter is a SEPARATE claim-gate
 * placed ONLY on the Atlas-token-spending path (`executeAgentQuery`: web
 * `/api/v1/query`, chat platforms, scheduler), keyed on the owner's
 * `emailVerified` bit. MCP `executeSQL` never enters `executeAgentQuery`, and
 * setup tools only hit Gate-0 solvency, so both keep working pre-claim. No new
 * plan tier, no `meter_state` column — a gate over the existing `trial` tier
 * plus an existing bit.
 *
 * SaaS-only by construction: `checkClaimGate` short-circuits to `allowed` off
 * SaaS, with no internal DB, or with no org — the same passthrough posture the
 * rest of the billing/enforcement subsystem takes (it lives in core, gated on
 * `deployMode === 'saas'` + `hasInternalDB()`, never importing `isEnterpriseEnabled`).
 */

import type { PlanTier, WorkspaceRow } from "@atlas/api/lib/db/internal";
import { hasInternalDB as defaultHasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { getCachedWorkspace } from "./enforcement";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { createLogger } from "@atlas/api/lib/logger";
import { claimGateDecisions } from "@atlas/api/lib/metrics";

const log = createLogger("billing:claim-gate");

/**
 * Build the web claim URL — the dedicated OTP→passkey claim interstitial the
 * prospect completes to claim an unclaimed Workspace (#4135). Points at the
 * `/claim` page (NOT `/signup`: a `start_trial` account already exists, so the
 * new-account funnel collides at the Account step — `USER_ALREADY_EXISTS` on
 * the throw path, an enumeration-safe synthetic 200 in prod — and can never
 * claim it; #4125 fault A). `/claim` verifies the email by OTP, enrolls a
 * passkey (password-free, clearing the admin-MFA gate via `passkeyCount>0`),
 * and accepts ToS — the credential step ADR-0018 specified. `email` is
 * prefilled when known so the interstitial can resume the right account.
 *
 * Falls back to a relative `/claim` path when the web origin can't be
 * resolved (only reachable off-SaaS, where the gate never fires anyway).
 */
export function buildClaimUrl(email?: string): string {
  const origin = getWebOrigin();
  const path = "/claim";
  if (!origin) {
    return email ? `${path}?email=${encodeURIComponent(email)}` : path;
  }
  const url = new URL(path, origin);
  if (email) url.searchParams.set("email", email);
  return url.toString();
}

/**
 * Thrown by `executeAgentQuery` when an unclaimed (metered) Workspace attempts
 * Atlas-token Q&A. `message` is user-safe (surfaces verbatim on chat platforms
 * and run rows); `claimUrl` points the human at the web claim interstitial.
 *
 * A plain `Error` subclass (not a `Data.TaggedError`) because the
 * `executeAgentQuery` path is plain async and uses `instanceof` sentinels —
 * mirrors {@link BillingBlockedError}.
 */
export class ClaimRequiredError extends Error {
  override readonly name = "ClaimRequiredError";
  readonly claimUrl: string;
  /** Stable machine-readable code for transport envelopes. */
  readonly errorCode = "claim_required" as const;
  readonly httpStatus = 403 as const;

  constructor(claimUrl: string) {
    super(
      "Asking Atlas questions of your data is paused until you claim this workspace. " +
        `Verify your email and finish setup on the web to continue: ${claimUrl}`,
    );
    this.claimUrl = claimUrl;
  }
}

/**
 * Thrown when the claim-gate cannot DETERMINE claim status because a lookup
 * failed (e.g. the owner-`emailVerified` query errored transiently). The gate
 * FAILS CLOSED: rather than allow an unclaimed workspace to spend Atlas tokens
 * on a blip (a false-negative on a metering gate — CLAUDE.md: "Return 500, not
 * a false negative"), it surfaces a retryable 503 "try again". Distinct from
 * {@link ClaimRequiredError} so a genuinely-claimed user is told to retry, not
 * misdirected to re-claim.
 */
export class ClaimCheckFailedError extends Error {
  override readonly name = "ClaimCheckFailedError";
  readonly errorCode = "claim_check_failed" as const;
  readonly httpStatus = 503 as const;
  readonly retryable = true as const;

  constructor() {
    super("Unable to verify your workspace's claim status. Please try again.");
  }
}

export type ClaimGateResult =
  | { allowed: true }
  | { allowed: false; reason: "claim_required"; claimUrl: string }
  | { allowed: false; reason: "check_failed" };

/** Owner-verification shape resolved per org. */
interface OwnerVerification {
  emailVerified: boolean;
  email: string | null;
}

/**
 * Injectable boundaries for {@link checkClaimGate}, so the block-vs-allow
 * matrix can be exercised without `mock.module`. Mirrors the dependency-
 * injection seam in `ee/src/onboarding/provision-trial.ts`.
 */
export interface ClaimGateDeps {
  getDeployMode: () => "saas" | "self-hosted" | undefined;
  hasInternalDB: () => boolean;
  getWorkspace: (orgId: string) => Promise<WorkspaceRow | null>;
  getOwnerVerification: (orgId: string) => Promise<OwnerVerification | null>;
  buildClaimUrl: (email?: string) => string;
}

/**
 * Resolve the workspace owner's `emailVerified` bit (and email, for the
 * claim-URL prefill). The owner is the `member.role = 'owner'` row; on the
 * rare multi-owner workspace the earliest-created membership wins (the
 * original creator). Returns `null` when no owner row exists.
 */
async function defaultGetOwnerVerification(orgId: string): Promise<OwnerVerification | null> {
  const rows = await internalQuery<{ emailVerified: boolean; email: string | null }>(
    `SELECT u."emailVerified" AS "emailVerified", u.email AS email
       FROM member m
       JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = $1 AND m.role = 'owner'
      ORDER BY m."createdAt" ASC
      LIMIT 1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return { emailVerified: !!row.emailVerified, email: row.email ?? null };
}

function defaultDeps(): ClaimGateDeps {
  return {
    getDeployMode: () => getConfig()?.deployMode,
    hasInternalDB: defaultHasInternalDB,
    getWorkspace: getCachedWorkspace,
    getOwnerVerification: defaultGetOwnerVerification,
    buildClaimUrl,
  };
}

/** Tiers the claim-gate applies to. Only an unclaimed *trial* is metered. */
function isMeterableTier(tier: PlanTier): boolean {
  return tier === "trial";
}

/**
 * Decide whether the metered claim-gate blocks an Atlas-token agent run for
 * `orgId`. Returns `{ allowed: true }` for every non-metered case,
 * `{ allowed: false, reason: "claim_required", claimUrl }` for an unclaimed
 * (owner `emailVerified` false) `trial` Workspace on SaaS, and
 * `{ allowed: false, reason: "check_failed" }` when a lookup errored and claim
 * status can't be determined.
 *
 * Short-circuits to `allowed` when: no org (self-hosted / CLI), no internal DB,
 * not SaaS, the workspace row is absent, the tier isn't metered, or no owner
 * row exists. The expiry/solvency concerns (`trial_expired`, `locked`,
 * suspension, hard-cap) are NOT this gate's job — Gate 0
 * (`checkAgentBillingGate`) runs first and owns them on every surface.
 *
 * FAILS CLOSED on a lookup error: a metering gate that returned `allowed` on a
 * DB blip would be a false-negative (let an unclaimed workspace spend Atlas
 * tokens), which CLAUDE.md forbids ("Return 500, not a false negative"). The
 * caller surfaces `check_failed` as a retryable 503 — no token spend, and no
 * misdirecting an already-claimed user to "re-claim".
 */
export async function checkClaimGate(
  orgId: string | undefined,
  overrides: Partial<ClaimGateDeps> = {},
): Promise<ClaimGateResult> {
  const deps = { ...defaultDeps(), ...overrides };

  if (!orgId || !deps.hasInternalDB() || deps.getDeployMode() !== "saas") {
    return { allowed: true };
  }

  const result = await computeSaasClaimGate(orgId, deps);
  // Observability (#3796): one counter per real SaaS claim decision so the
  // withheld-vs-served ratio is a graphable series and a `claim_required`
  // spike (or a `check_failed` blip from a DB wobble) is alertable. The
  // non-SaaS short-circuit above is deliberately not counted — it isn't a
  // metering decision. No-op when OTel is uninitialized (see metrics.ts).
  claimGateDecisions.add(1, { outcome: result.allowed ? "allowed" : result.reason });
  return result;
}

/**
 * Core claim decision for a SaaS request that carries an org and has an
 * internal DB — the metering-relevant path. Split out from
 * {@link checkClaimGate} so the decision counter wraps exactly the real
 * decisions (the non-SaaS short-circuit stays uncounted). See
 * {@link checkClaimGate} for the full fail-closed contract.
 */
async function computeSaasClaimGate(
  orgId: string,
  deps: ClaimGateDeps,
): Promise<ClaimGateResult> {
  let workspace: WorkspaceRow | null;
  try {
    // Gate 0 (`checkAgentBillingGate`) already warmed this cache on the
    // `executeAgentQuery` path, so this is a cache hit. A genuine lookup error
    // would have failed Gate 0 closed (503) before we ever got here; fail
    // closed here too rather than let an unclaimed workspace through.
    workspace = await deps.getWorkspace(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Claim-gate workspace lookup failed — blocking as precaution (claim status unknown)",
    );
    return { allowed: false, reason: "check_failed" };
  }

  // No org row (pre-migration / Better-Auth-only) or a non-metered tier:
  // nothing to meter. Paid/locked/free workspaces are never claim-gated.
  if (!workspace || !isMeterableTier(workspace.plan_tier)) {
    return { allowed: true };
  }

  let owner: OwnerVerification | null;
  try {
    owner = await deps.getOwnerVerification(orgId);
  } catch (err) {
    // Fail CLOSED: we can't tell whether this metered trial is claimed, so we
    // must not let it spend Atlas tokens. Surfaced as a retryable 503, not a
    // `claim_required` (which would wrongly tell a claimed user to re-claim).
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Claim-gate owner lookup failed — blocking as precaution (claim status unknown)",
    );
    return { allowed: false, reason: "check_failed" };
  }

  // No owner row, or owner already verified → claimed (or not a metered trial).
  if (!owner || owner.emailVerified) {
    return { allowed: true };
  }

  // Unclaimed metered trial — withhold Atlas-token Q&A.
  return {
    allowed: false,
    reason: "claim_required",
    claimUrl: deps.buildClaimUrl(owner.email ?? undefined),
  };
}
