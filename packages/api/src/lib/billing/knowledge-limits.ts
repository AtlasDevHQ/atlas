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
 * `knowledge/ingest-limits.ts` is imported by the knowledge mirror and by every
 * connector client: pulling the billing stack (enforcement → metering →
 * seat-count) into that module would widen their dependency graph for a concern
 * none of them have.
 *
 * ## Fail-closed posture
 *
 * {@link resolveKnowledgeTierLimits} mirrors `checkResourceLimit`'s arms so the
 * KB caps and the chat/connection caps can never disagree about what a
 * workspace is:
 *
 *   - No `orgId` / no internal DB → `null` (no billing context, no tier cap).
 *   - Workspace lookup **error** → throws {@link BillingCheckFailedError}
 *     (→ 503 "try again"). A transient DB fault must never silently widen a
 *     cap.
 *   - No `organization` row (pre-migration / Better-Auth-only) → `null`. The
 *     one deliberate fail-open, identical to the sibling gates: a genuine
 *     *absence* of a plan means there is no plan to enforce.
 *   - `free` tier (self-hosted) → `null`. Every KB limit is unlimited there, so
 *     collapsing to `null` keeps the platform knob authoritative and the
 *     self-hosted path allocation-free.
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
import { createLogger } from "@atlas/api/lib/logger";
import {
  getIngestMaxBundleBytes,
  getIngestMaxDocBytes,
  getIngestMaxDocs,
} from "@atlas/api/lib/knowledge/ingest-limits";
import { getCachedWorkspace } from "./enforcement";
import { getPlanLimits, isUnlimited, type PlanLimits } from "./plans";

const log = createLogger("billing:knowledge-limits");

/** Message surfaced when the tier can't be resolved (fail-closed → 503). */
const TIER_CHECK_FAILED_MSG = "Unable to verify your plan's Knowledge Base limits. Please try again.";

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
    throw new BillingCheckFailedError({ message: TIER_CHECK_FAILED_MSG, workspaceId: orgId });
  }

  // Genuine absence of a plan → no tier cap (the sibling gates' one fail-open).
  if (!workspace) return null;
  const tier = workspace.plan_tier;
  // `free` is unlimited on every KB field — the platform knob stays the only cap.
  if (tier === "free") return null;
  return { tier, limits: getPlanLimits(tier) };
}

/** Which side of `min(platform ceiling, tier limit)` produced an effective cap. */
export type CapBoundBy = "platform" | "tier";

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
 * A tier-resolution fault here degrades to `null` (→ `"free"` in the prompt)
 * rather than replacing a correct refusal with a 503: the cap decision was
 * already made upstream, and this call only phrases it.
 */
export async function assertNotTierBound(input: {
  readonly orgId: string | undefined;
  readonly field: KnowledgeLimitField;
  readonly boundBy: CapBoundBy;
  /** The value that breached the cap (document count, byte count, …). */
  readonly required: number;
  /** The effective cap that was enforced. */
  readonly limit: number;
  /** Human noun for the message, e.g. `"documents in one bundle"`. */
  readonly noun: string;
}): Promise<void> {
  const { orgId, field, boundBy, required, limit, noun } = input;
  if (boundBy !== "tier") return;

  let currentPlan: PlanTier = "free";
  try {
    currentPlan = (await resolveKnowledgeTierLimits(orgId))?.tier ?? "free";
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, field },
      "Could not resolve the plan tier for a Knowledge Base over-limit — falling back to the plain over-limit response",
    );
    return;
  }

  const requiredPlan = lowestTierAdmitting(field, required, currentPlan);
  if (requiredPlan === null) return;

  log.info(
    { orgId, field, required, limit, currentPlan, requiredPlan },
    "Knowledge Base ingest denied: the workspace's plan tier is the binding cap",
  );
  throw new FeatureEntitlementError({
    message: `Your "${currentPlan}" plan allows up to ${limit} ${noun}. Upgrade to "${requiredPlan}" to raise the limit.`,
    feature: field,
    requiredPlan,
    currentPlan,
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
 * Only the self-serve paid ladder is considered: `free` is self-hosted-only and
 * `locked` is the churn tier, so neither is ever a legitimate upgrade target.
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

/** The caps one ingest enforces, already composed with the workspace's tier. */
export interface EffectiveIngestCaps {
  readonly maxDocs: EffectiveCap;
  readonly maxBundleBytes: EffectiveCap;
  /** Platform-only, so it carries no provenance. */
  readonly maxDocBytes: number;
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

  const tier = await resolveKnowledgeTierLimits(orgId);
  if (!tier) {
    return {
      maxDocs: { value: platformDocs, boundBy: "platform" },
      maxBundleBytes: { value: platformBundle, boundBy: "platform" },
      maxDocBytes,
    };
  }
  return {
    maxDocs: compose(platformDocs, tier.limits.maxKnowledgeDocsPerBundle),
    maxBundleBytes: compose(platformBundle, tier.limits.maxKnowledgeBundleBytes),
    maxDocBytes,
  };
}
