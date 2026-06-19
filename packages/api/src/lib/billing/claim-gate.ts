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

const log = createLogger("billing:claim-gate");

/**
 * Build the web claim URL — the post-signup OTP interstitial the prospect
 * completes to claim an unclaimed Workspace. Points at the `/signup` page
 * (which renders the emailOTP verify form when a pending signup is detected);
 * `email` is prefilled when known so the form can resume the right account.
 *
 * Falls back to a relative `/signup` path when the web origin can't be
 * resolved (only reachable off-SaaS, where the gate never fires anyway).
 */
export function buildClaimUrl(email?: string): string {
  const origin = getWebOrigin();
  const path = "/signup";
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

export type ClaimGateResult =
  | { allowed: true }
  | { allowed: false; claimUrl: string };

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
 * `orgId`. Returns `{ allowed: true }` for every non-metered case and
 * `{ allowed: false, claimUrl }` only for an unclaimed (owner `emailVerified`
 * false) `trial` Workspace on SaaS.
 *
 * Short-circuits to `allowed` when: no org (self-hosted / CLI), no internal DB,
 * not SaaS, the workspace row is absent, the tier isn't metered, or no owner
 * row exists. The expiry/solvency concerns (`trial_expired`, `locked`,
 * suspension, hard-cap) are NOT this gate's job — Gate 0
 * (`checkAgentBillingGate`) runs first and owns them on every surface.
 */
export async function checkClaimGate(
  orgId: string | undefined,
  overrides: Partial<ClaimGateDeps> = {},
): Promise<ClaimGateResult> {
  const deps = { ...defaultDeps(), ...overrides };

  if (!orgId || !deps.hasInternalDB() || deps.getDeployMode() !== "saas") {
    return { allowed: true };
  }

  let workspace: WorkspaceRow | null;
  try {
    // Gate 0 (`checkAgentBillingGate`) already warmed this cache on the
    // `executeAgentQuery` path, so this is a cache hit. A genuine lookup error
    // would have failed Gate 0 closed (503) before we ever got here.
    workspace = await deps.getWorkspace(orgId);
  } catch (err) {
    // Mirror enforcement.ts's metering fail-open posture (#3428): the
    // claim-gate is a metering refinement layered on top of the fail-closed
    // Gate 0 solvency check. If the meter itself can't be evaluated, allow the
    // run rather than block a legitimately-provisioned workspace, and make the
    // bypass operator-visible.
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Claim-gate workspace lookup failed — allowing run (metering refinement unavailable)",
    );
    return { allowed: true };
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
    // Same fail-open rationale as above (#3428): a transient owner-lookup blip
    // must not misdirect an already-claimed user to "re-claim", nor 500 the run.
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Claim-gate owner lookup failed — allowing run (metering refinement unavailable)",
    );
    return { allowed: true };
  }

  // No owner row, or owner already verified → claimed (or not a metered trial).
  if (!owner || owner.emailVerified) {
    return { allowed: true };
  }

  // Unclaimed metered trial — withhold Atlas-token Q&A.
  return { allowed: false, claimUrl: deps.buildClaimUrl(owner.email ?? undefined) };
}
