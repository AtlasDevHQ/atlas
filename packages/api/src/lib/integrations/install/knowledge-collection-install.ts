/**
 * The two gates every knowledge form handler runs around its collection UPSERT
 * — one pre-write, one atomic — plus the shared `RETURNING id` invariant.
 *
 * A *collection* is a `pillar='knowledge'` `workspace_plugins` row keyed by
 * `install_id` (the collection slug). Twelve handlers create them (upload,
 * bundle-sync, and ten connectors), and before #4235 each carried its own copy
 * of the slug-collision check and the upsert-plus-id-validation block. Both now
 * live here, alongside the per-tier collections cap the same slice added:
 *
 *   1. {@link assertCollectionInstallable} — the PRE-WRITE gate. Runs before a
 *      handler validates upstream credentials or writes a
 *      `knowledge_sync_credentials` row, so an at-cap workspace is refused
 *      before a secret is ever persisted.
 *   2. {@link upsertKnowledgeCollectionRow} — the ATOMIC gate. Runs the caller's
 *      UPSERT inside `checkKnowledgeCollectionLimitAndInstall`'s advisory-locked
 *      recount, so two concurrent creations can't both take a shared last slot,
 *      and validates the `RETURNING id` invariant.
 *
 * Denials surface as {@link FeatureEntitlementError} — HTTP 403
 * `plan_upgrade_required` carrying the same `PlanUpgradeRequiredBody` envelope
 * the integration install endpoints emit — never a generic error. A failure to
 * *determine* the count is a {@link BillingCheckFailedError} (503 "try again"),
 * never a misleading "upgrade your plan".
 *
 * @module
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import type { PlanTier, WorkspaceId } from "@useatlas/types";
import {
  checkKnowledgeCollectionLimit,
  checkKnowledgeCollectionLimitAndInstall,
} from "@atlas/api/lib/billing/enforcement";
import {
  lowestTierAdmitting,
  resolveKnowledgeTierLimits,
} from "@atlas/api/lib/billing/knowledge-limits";
import { BillingCheckFailedError, FeatureEntitlementError } from "@atlas/api/lib/effect/errors";
import type { createLogger } from "@atlas/api/lib/logger";
import { FormInstallValidationError } from "./email-form-handler";
import { KNOWLEDGE_INSTALL_ID_FIELD } from "./knowledge-collection-slug";

/** The handlers only ever log errors from these seams — narrow to that. */
type CollectionInstallLogger = Pick<ReturnType<typeof createLogger>, "error" | "info">;

/**
 * Compose the 403 upgrade error for a collections-cap denial.
 *
 * `requiredPlan` is the cheapest tier that admits one more collection. Business
 * is unlimited, so a real denial always has a named upgrade target; the
 * `"business"` fallback is reachable only if the tier changed between the cap
 * decision and this resolution, and naming the top plan is the honest answer
 * there. `currentPlan` collapses an unresolved tier to `"free"`, matching the
 * feature-entitlement guard's handling of the same case.
 */
function collectionCapError(
  workspaceId: WorkspaceId,
  limit: number,
  tier: PlanTier | null,
): FeatureEntitlementError {
  const currentPlan: PlanTier = tier ?? "free";
  const requiredPlan =
    lowestTierAdmitting("maxKnowledgeCollections", limit + 1, currentPlan) ?? "business";
  const noun = limit === 1 ? "knowledge collection" : "knowledge collections";
  return new FeatureEntitlementError({
    message: `Your "${currentPlan}" plan allows up to ${limit} ${noun}. Upgrade to "${requiredPlan}" to add more. (workspace ${workspaceId})`,
    feature: "knowledge_collections",
    requiredPlan,
    currentPlan,
  });
}

/**
 * Resolve the workspace's tier for an upgrade prompt without letting a lookup
 * fault mask the cap denial we already have. The cap decision is authoritative;
 * this is prompt cosmetics, so a fault degrades to `null` (→ `"free"`) rather
 * than replacing a correct 403 with a 503.
 */
async function tierForPrompt(
  workspaceId: WorkspaceId,
  log: CollectionInstallLogger,
): Promise<PlanTier | null> {
  try {
    return (await resolveKnowledgeTierLimits(workspaceId))?.tier ?? null;
  } catch (err) {
    log.error(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Could not resolve the plan tier for a knowledge-collection cap denial — naming the free tier in the upgrade prompt",
    );
    return null;
  }
}

/**
 * The pre-write gate: reject before any credential or row is written when
 * either the slug is taken by a different knowledge catalog, or the workspace's
 * plan tier has no room for another collection.
 *
 * The slug half exists because `knowledge_documents` keys on
 * `(workspace_id, collection_id, path)` with NO catalog dimension, so two
 * catalogs sharing an `install_id` would silently merge their document trees —
 * and a bundle-sync's archive-absent pass would archive the other collection's
 * docs (#4211). Archived installs count too: their documents still live under
 * the slug and an explicit re-ingest may resurrect them (ADR-0028 §5).
 *
 * @throws {FormInstallValidationError} 400 field error — the slug is taken.
 * @throws {FeatureEntitlementError} 403 upgrade — the tier cap is reached.
 * @throws {BillingCheckFailedError} 503 — the count couldn't be determined.
 */
export async function assertCollectionInstallable(
  workspaceId: WorkspaceId,
  collectionSlug: string,
  ownCatalogId: string,
  log: CollectionInstallLogger,
): Promise<void> {
  const rows = await internalQuery<{ catalog_id: string }>(
    `SELECT catalog_id
       FROM workspace_plugins
      WHERE workspace_id = $1 AND install_id = $2 AND pillar = 'knowledge'
        AND catalog_id <> $3
      LIMIT 1`,
    [workspaceId, collectionSlug, ownCatalogId],
  );
  if (rows.length > 0) {
    throw new FormInstallValidationError({
      fieldErrors: {
        [KNOWLEDGE_INSTALL_ID_FIELD]: [
          `Collection id "${collectionSlug}" is already used by another Knowledge Base integration in this workspace.`,
        ],
      },
      formErrors: [],
    });
  }

  const decision = await checkKnowledgeCollectionLimit(workspaceId, collectionSlug);
  if (decision.allowed) return;
  if (decision.reason === "cap_reached") {
    log.info(
      { workspaceId, collectionSlug, limit: decision.limit },
      "Knowledge collection install blocked — workspace at plan collections cap (precheck)",
    );
    throw collectionCapError(workspaceId, decision.limit, await tierForPrompt(workspaceId, log));
  }
  // `check_failed` — and, defensively, any future non-cap denial reason: the
  // count couldn't be determined, so fail closed as a transient 503 "try
  // again", never a misleading 403 "upgrade your plan".
  log.error(
    { workspaceId, collectionSlug },
    "Knowledge collection install blocked — collection count check failed (failing closed)",
  );
  throw new BillingCheckFailedError({ message: decision.errorMessage, workspaceId });
}

/**
 * Run a handler's collection UPSERT inside the atomic collections-cap gate and
 * return the persisted row id.
 *
 * `INSERT ... ON CONFLICT ... DO UPDATE RETURNING` emits exactly one row on both
 * paths; an empty result is a driver/RLS/query-rewrite anomaly. Returning the
 * caller's candidate id instead would be WRONG on the conflict path (the row
 * keeps its existing id), so this fails loud rather than guessing.
 *
 * @throws {FeatureEntitlementError} 403 upgrade — the tier cap is reached.
 * @throws {BillingCheckFailedError} 503 — the count couldn't be determined.
 * @throws {Error} write-path failures (lock / UPSERT / COMMIT), for the
 *   caller's own rollback-and-rethrow block to handle.
 */
export async function upsertKnowledgeCollectionRow(input: {
  readonly workspaceId: WorkspaceId;
  readonly collectionSlug: string;
  /** The handler's own UPSERT, which MUST end in `RETURNING id`. */
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Candidate row id — logged on the invariant violation for correlation. */
  readonly candidateId: string;
  readonly log: CollectionInstallLogger;
}): Promise<string> {
  const { workspaceId, collectionSlug, sql, params, candidateId, log } = input;

  const result = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
    workspaceId,
    collectionSlug,
    { sql, params },
  );

  if (!result.allowed) {
    if (result.reason === "cap_reached") {
      log.info(
        { workspaceId, collectionSlug, limit: result.limit },
        "Knowledge collection install blocked — workspace at plan collections cap",
      );
      throw collectionCapError(workspaceId, result.limit, await tierForPrompt(workspaceId, log));
    }
    log.error(
      { workspaceId, collectionSlug },
      "Knowledge collection install blocked — collection count check failed under lock (failing closed)",
    );
    throw new BillingCheckFailedError({ message: result.errorMessage, workspaceId });
  }

  const returned = result.rows[0]?.id;
  if (typeof returned !== "string" || returned.length === 0) {
    log.error(
      { workspaceId, candidateId, collectionSlug },
      "workspace_plugins upsert returned no id — Postgres invariant violation",
    );
    throw new Error(
      "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
    );
  }
  return returned;
}
