/**
 * Per-tier Knowledge Base caps — the composition seam between the **platform**
 * guardrails (`ATLAS_KNOWLEDGE_INGEST_*`, one value for the whole region) and
 * the **plan tier** limits in `PlanLimits` (#4235).
 *
 * The two tiers of cap answer different questions and neither replaces the
 * other:
 *
 *   - The platform setting is the operator's fleet-wide abuse guardrail. It
 *     is the only cap on self-hosted, where every workspace sits on the
 *     unlimited `free` tier.
 *   - The plan limit is the SaaS pricing lever — KB size is storage plus
 *     prompt-token cost, so it ladders with the plan.
 *
 * The effective cap is therefore `min(platform ceiling, tier limit)`
 * ({@link minKnowledgeCap}, composed per-ingest by {@link resolveIngestCaps}).
 * A tier that ranks *above* the platform ceiling is clamped by it, which is
 * exactly why the SaaS ceiling is pinned to the Business values — see
 * `lib/knowledge/ingest-limits.ts`.
 *
 * The composition lives HERE rather than next to the platform readers because
 * `knowledge/ingest-limits.ts` is imported by the knowledge mirror and by the
 * connector clients that bound their own fetch: pulling the billing stack
 * (enforcement → metering → seat-count) into that module would widen their
 * dependency graph for a concern none of them have.
 *
 * ## Fail-closed posture
 *
 * {@link resolveKnowledgeTierLimits} follows `checkResourceLimit`'s arms, plus
 * the `"self-hosted"` sentinel `orgId` that `checkResourceLimit` never sees:
 *
 *   - No `orgId` / the `"self-hosted"` sentinel / no internal DB → `null` (no
 *     billing context, no tier cap).
 *   - Workspace lookup **error** → throws {@link BillingCheckFailedError}
 *     (→ 503 "try again"). A transient DB fault must never silently widen a
 *     cap.
 *   - No `organization` row (pre-migration / Better-Auth-only) → `null`. The
 *     one deliberate fail-open, identical to the sibling gates: a genuine
 *     *absence* of a plan means there is no plan to enforce.
 *   - `free` tier **off SaaS** → `null`. Every KB limit is unlimited there, so
 *     collapsing to `null` keeps the platform knob authoritative and the
 *     self-hosted path allocation-free.
 *   - `free` tier **on SaaS** → the `starter` limits, with a warn. There is no
 *     SaaS free tier: `organization.plan_tier` merely DEFAULTS to `'free'`, so
 *     a `free` row on SaaS means trial provisioning never landed. Reading that
 *     as "no plan to enforce" would hand a provisioning failure the raised
 *     SaaS ceiling (100 MB / 5,000 docs) — a strictly wider entitlement than
 *     any paying tier. Fail closed to the cheapest tier instead.
 *
 * There is no operator-workspace bypass here, matching the resource-cap family
 * (`checkResourceLimit` has none either) rather than the feature-entitlement
 * guard. An operator workspace is capped by its own tier like any other.
 *
 * @module
 */

import type { PlanTier } from "@useatlas/types";
import { PLAN_RANK } from "@atlas/api/lib/integrations/install/plan-rank";
import { BillingCheckFailedError, FeatureEntitlementError } from "@atlas/api/lib/effect/errors";
import { hasInternalDB, type WorkspaceRow } from "@atlas/api/lib/db/internal";
import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";
import { createLogger } from "@atlas/api/lib/logger";
import {
  getIngestMaxBundleBytes,
  getIngestMaxDocBytes,
  getIngestMaxDocs,
} from "@atlas/api/lib/knowledge/ingest-limits";
import { getCachedWorkspace } from "./enforcement";
import { KNOWLEDGE_CAP_CHECK_FAILED_MSG } from "./knowledge-limits-message";
import { getPlanLimits, isUnlimited, type PlanLimits } from "./plans";

const log = createLogger("billing:knowledge-limits");



/**
 * The three numeric {@link PlanLimits} fields that ladder the Knowledge Base.
 * The first two are composed with a platform ceiling at ingest; the third is a
 * countable resource enforced by the `checkResourceLimit` family at install.
 * All three share {@link lowestTierAdmitting} so every KB upgrade prompt names
 * the tier from the same table.
 */
export type KnowledgeLimitField =
  | "maxKnowledgeBundleBytes"
  | "maxKnowledgeDocsPerBundle"
  | "maxKnowledgeCollections";

/** The subset composed with a platform ceiling at ingest time. */
export type KnowledgeIngestLimitField = Exclude<KnowledgeLimitField, "maxKnowledgeCollections">;

/** A workspace's resolved KB tier context, or `null` when no tier applies. */
export interface KnowledgeTierContext {
  readonly tier: PlanTier;
  readonly limits: Readonly<PlanLimits>;
}

/**
 * Resolve the workspace's plan tier and its KB limits, or `null` when no tier
 * cap applies (see the module docblock for every arm).
 *
 * @throws {BillingCheckFailedError} when the workspace lookup faults — the
 *   caller surfaces a 503 "try again", never a silently-widened cap.
 */
export async function resolveKnowledgeTierLimits(
  orgId: string | undefined,
): Promise<KnowledgeTierContext | null> {
  if (!orgId || orgId === "self-hosted" || !hasInternalDB()) return null;

  let workspace: WorkspaceRow | null;
  try {
    workspace = await getCachedWorkspace(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to resolve workspace for Knowledge Base tier caps — blocking as precaution",
    );
    throw new BillingCheckFailedError({ message: KNOWLEDGE_CAP_CHECK_FAILED_MSG, workspaceId: orgId });
  }

  // Genuine absence of a plan → no tier cap (the sibling gates' one fail-open).
  if (!workspace) return null;
  const tier = workspace.plan_tier;
  if (tier === "free") {
    // Off SaaS `free` is the real, unlimited self-hosted tier — the platform
    // knob stays the only cap. On SaaS it is an anomaly (see the module
    // docblock): fail closed to `starter` rather than to "unlimited".
    if (resolveDeployMode() !== "saas") return null;
    log.warn(
      { orgId },
      "SaaS workspace resolved to the `free` tier — applying starter Knowledge Base caps; its trial provisioning may have failed",
    );
    return { tier: "starter", limits: getPlanLimits("starter") };
  }
  return { tier, limits: getPlanLimits(tier) };
}

/** Which side of `min(platform ceiling, tier limit)` produced an effective cap. */
export type CapBoundBy = "platform" | "tier";

/**
 * Is the cap that refused something the READER can actually change?
 *
 * Only off SaaS. A hosted workspace admin cannot reach the platform settings
 * registry at all, and on SaaS the platform ceiling is deliberately pinned to
 * the Business tier's values — so even a `boundBy: "platform"` refusal there is
 * effectively a plan ceiling to them. Naming `ATLAS_KNOWLEDGE_INGEST_*` in a
 * hosted error message sends the reader after a knob they can never turn.
 *
 * Used by the sync paths, which surface a status row rather than an HTTP
 * response and so have no upgrade envelope to fall back on — only wording.
 */
export function capIsOperatorTunable(boundBy: CapBoundBy): boolean {
  return boundBy === "platform" && resolveDeployMode() !== "saas";
}

/**
 * Turn a **tier-bound** over-limit into the standard 403 upgrade envelope, or
 * return so the caller emits its ordinary over-limit 4xx.
 *
 * Three cases, and only the first is an upgrade prompt:
 *   - `boundBy === "tier"` and a higher tier admits `required` → throw
 *     {@link FeatureEntitlementError} (→ 403 `plan_upgrade_required`), the same
 *     envelope the integration install endpoints emit.
 *   - `boundBy === "tier"` but no higher tier admits it → return. The value
 *     exceeds even the top plan, so "upgrade" would be a lie.
 *   - `boundBy === "platform"` → return. The operator's fleet-wide guardrail
 *     bound, not the customer's plan; upgrading would change nothing.
 *
 * `tier` is the plan that was resolved when the cap was COMPUTED
 * ({@link EffectiveIngestCaps.tier}), never a fresh lookup: `getCachedWorkspace`
 * has a 60s per-replica TTL, so re-resolving could name a different plan than
 * the one whose limit is being quoted — and could fault, turning a correct
 * refusal into a 503. This function is pure; it neither reads nor can fail.
 *
 * `required` is the value that breached the cap. When the true value is only
 * known to be *at least* something (a streamed body aborted at the cap), pass
 * `exact: false` — an upgrade target cannot be named honestly from a lower
 * bound, so the caller falls through to its plain over-limit response.
 */
export function assertNotTierBound(input: {
  readonly field: KnowledgeLimitField;
  readonly boundBy: CapBoundBy;
  /** The plan that set `limit`, as resolved when the cap was composed. */
  readonly tier: PlanTier | null;
  /** The value that breached the cap (document count, byte count, …). */
  readonly required: number;
  /** False when `required` is a lower bound rather than the true value. */
  readonly exact?: boolean;
  /** The effective cap that was enforced. */
  readonly limit: number;
  /** Human noun for the message, e.g. `"documents in one bundle"`. */
  readonly noun: string;
  /** Log/forensic context only — never part of the customer-facing message. */
  readonly orgId?: string;
}): void {
  const { field, boundBy, tier, required, limit, noun, orgId } = input;
  if (boundBy !== "tier") return;
  // A lower bound can only prove the CURRENT tier was breached, not that any
  // higher one admits the real value — naming one would be a guess.
  if (input.exact === false) return;
  // `boundBy === "tier"` is only produced by `compose`, which runs only when a
  // tier context exists, so `tier` is non-null here by construction; the guard
  // is belt-and-braces rather than a fabricated "free".
  if (tier === null) return;

  const requiredPlan = lowestTierAdmitting(field, required, tier);
  if (requiredPlan === null) return;

  log.info(
    { orgId, field, required, limit, currentPlan: tier, requiredPlan },
    "Knowledge Base ingest denied: the workspace's plan tier is the binding cap",
  );
  throw new FeatureEntitlementError({
    message: `Your "${tier}" plan allows up to ${limit} ${noun}. Upgrade to "${requiredPlan}" to raise the limit.`,
    feature: field,
    requiredPlan,
    currentPlan: tier,
  });
}

/**
 * Compose the effective cap: the smaller of the platform ceiling and the tier
 * limit, with `-1` (unlimited) on the tier side meaning "the platform ceiling
 * governs". `tierCap` of `0` (the `locked` churn tier) is a real cap of zero,
 * NOT unlimited — a locked workspace ingests nothing.
 */
export function minKnowledgeCap(platformCap: number, tierCap: number): number {
  if (isUnlimited(tierCap)) return platformCap;
  return Math.min(platformCap, tierCap);
}

/**
 * The lowest plan tier whose `field` limit admits `required`, ranking strictly
 * above `currentTier` — i.e. the tier the upgrade prompt should name. Returns
 * `null` when no higher tier admits the value, so the caller reports a plain
 * over-limit error instead of telling a Business customer to "upgrade".
 *
 * Only the self-serve paid ladder is considered: `free` is self-hosted-only,
 * `locked` is the churn tier, and `trial` is not something you upgrade *to* —
 * none is ever a legitimate upgrade target. (A workspace ON `trial` still gets
 * a target: it ranks below `starter`, so `starter` is offered when it helps.)
 */
export function lowestTierAdmitting(
  field: KnowledgeLimitField,
  required: number,
  currentTier: PlanTier,
): PlanTier | null {
  const currentRank = PLAN_RANK[currentTier];
  // Ascending rank order — the first match is the cheapest tier that works.
  for (const tier of ["starter", "pro", "business"] as const) {
    if (PLAN_RANK[tier] <= currentRank) continue;
    const cap = getPlanLimits(tier)[field];
    if (isUnlimited(cap) || cap >= required) return tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Effective ingest caps — the composition itself
// ---------------------------------------------------------------------------

/** One effective cap plus the provenance a caller needs to phrase a refusal. */
export interface EffectiveCap {
  readonly value: number;
  readonly boundBy: CapBoundBy;
}

/**
 * The caps one ingest enforces, already composed with the workspace's tier.
 *
 * `workspaceId` is load-bearing, not informational: this object is passed
 * between the route (which caps the raw request body) and the ingest seam, and
 * both `assertIngestCapsFor` it against the workspace they are actually writing
 * to. Without that, a refactor that hoists a caps resolution out of a loop
 * would silently apply one tenant's cap to another's ingest.
 */
export interface EffectiveIngestCaps {
  /** The workspace these caps were resolved FOR. Checked at every seam. */
  readonly workspaceId: string;
  /** The plan that set the tier half, or `null` when no tier context applied. */
  readonly tier: PlanTier | null;
  readonly maxDocs: EffectiveCap;
  readonly maxBundleBytes: EffectiveCap;
  /** Platform-only, so it carries no provenance. */
  readonly maxDocBytes: number;
}

/**
 * Guard a caller-supplied {@link EffectiveIngestCaps} against the workspace it
 * is about to govern. `caps` is an optional parameter on the ingest seams (so
 * the route and the seam share ONE tier lookup), which makes it the one place a
 * plan cap could be crossed between tenants — fail loud rather than enforce the
 * wrong tenant's limit.
 */
export function assertIngestCapsFor(
  caps: EffectiveIngestCaps,
  workspaceId: string,
): void {
  if (caps.workspaceId === workspaceId) return;
  throw new Error(
    `Knowledge ingest caps were resolved for workspace "${caps.workspaceId}" but are being applied to "${workspaceId}" — refusing to enforce another tenant's plan limits.`,
  );
}

function compose(platform: number, tier: number): EffectiveCap {
  const value = minKnowledgeCap(platform, tier);
  // Ties attribute to the platform: with equal caps nothing is gained by
  // telling a customer to upgrade, so the honest refusal is "too large".
  return { value, boundBy: value < platform ? "tier" : "platform" };
}

/**
 * Resolve the caps a single ingest must satisfy for `orgId`:
 * `min(platform ceiling, plan-tier limit)` per field, with `boundBy` naming the
 * binding side.
 *
 * A workspace with no tier context (self-hosted, no internal DB, no
 * `organization` row, or the unlimited `free` tier) gets the platform ceilings
 * verbatim — the self-hosted path is unchanged by #4235.
 *
 * @throws {BillingCheckFailedError} when the workspace lookup faults (→ 503
 *   "try again"). An ingest is refused rather than run against a cap we could
 *   not verify.
 */
export async function resolveIngestCaps(orgId: string | undefined): Promise<EffectiveIngestCaps> {
  const platformDocs = getIngestMaxDocs();
  const platformBundle = getIngestMaxBundleBytes();
  const maxDocBytes = getIngestMaxDocBytes();
  // `orgId` is optional upstream (self-hosted no-auth has no workspace); the
  // sentinel keeps `workspaceId` a plain string so the correlation check has a
  // total comparison rather than a null-vs-null hole.
  const workspaceId = orgId ?? "";

  const ctx = await resolveKnowledgeTierLimits(orgId);
  if (!ctx) {
    return {
      workspaceId,
      tier: null,
      maxDocs: { value: platformDocs, boundBy: "platform" },
      maxBundleBytes: { value: platformBundle, boundBy: "platform" },
      maxDocBytes,
    };
  }
  return {
    workspaceId,
    tier: ctx.tier,
    maxDocs: compose(platformDocs, ctx.limits.maxKnowledgeDocsPerBundle),
    maxBundleBytes: compose(platformBundle, ctx.limits.maxKnowledgeBundleBytes),
    maxDocBytes,
  };
}
