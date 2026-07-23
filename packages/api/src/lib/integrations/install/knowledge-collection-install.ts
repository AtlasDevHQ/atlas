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
 * Both are `Data.TaggedError`s, so every handler must let them propagate with
 * their `_tag` intact; the fan-out handlers' `retryableInstallError` wrapper
 * passes them through unchanged for exactly this reason (see
 * `./retryable-install-error.ts`).
 *
 * @module
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import type { PlanTier, WorkspaceId } from "@useatlas/types";
import {
  checkKnowledgeCollectionFanOutLimit,
  checkKnowledgeCollectionLimit,
  checkKnowledgeCollectionLimitAndInstall,
  type ResourceLimitResult,
} from "@atlas/api/lib/billing/enforcement";
import { lowestTierAdmitting } from "@atlas/api/lib/billing/knowledge-limits";
import { BillingCheckFailedError, FeatureEntitlementError } from "@atlas/api/lib/effect/errors";
import type { createLogger } from "@atlas/api/lib/logger";
import { FormInstallValidationError } from "./email-form-handler";
import { KNOWLEDGE_INSTALL_ID_FIELD } from "./knowledge-collection-slug";

/** The handlers only ever log errors from these seams — narrow to that. */
type CollectionInstallLogger = Pick<ReturnType<typeof createLogger>, "error" | "info">;

/**
 * Compose the 403 upgrade error for a collections-cap denial.
 *
 * `tier` rides on the denial itself (`ResourceLimitResult.cap_reached.tier`),
 * so the plan named here is provably the one whose `limit` is being quoted —
 * a second `getCachedWorkspace` read could return a different tier (60s
 * per-replica TTL) and tell a Pro customer they are on `free`.
 *
 * `requiredPlan` is the cheapest tier admitting one more collection. Business
 * is unlimited on this field, so a real denial always has a named target; the
 * `"business"` fallback is unreachable in practice and is the honest answer if
 * the ladder is ever edited to have a finite top.
 */
function collectionCapError(limit: number, tier: PlanTier): FeatureEntitlementError {
  const requiredPlan =
    lowestTierAdmitting("maxKnowledgeCollections", limit + 1, tier) ?? "business";
  const noun = limit === 1 ? "knowledge collection" : "knowledge collections";
  return new FeatureEntitlementError({
    message: `Your "${tier}" plan allows up to ${limit} ${noun}. Upgrade to "${requiredPlan}" to add more.`,
    feature: "knowledge_collections",
    requiredPlan,
    currentPlan: tier,
  });
}

/**
 * Translate a collections-cap DENIAL into the right throw. Shared by the
 * single-key precheck, the fan-out precheck, and the atomic gate so all three
 * map `cap_reached` → 403 upgrade and `check_failed` → 503 fail-closed
 * identically.
 *
 * Returns `never`, so a call site's `if (!decision.allowed)` narrows the
 * admitted arm afterwards without a second runtime branch. The parameter is
 * the denial union alone, which `ResourceLimitResult` and
 * `CapGatedInstallResult` share structurally.
 */
function throwCollectionDenial(
  decision: Extract<ResourceLimitResult, { allowed: false }>,
  workspaceId: WorkspaceId,
  context: Record<string, unknown>,
  log: CollectionInstallLogger,
): never {
  if (decision.reason === "cap_reached") {
    log.info(
      { workspaceId, ...context, limit: decision.limit, tier: decision.tier },
      "Knowledge collection install blocked — workspace at plan collections cap",
    );
    throw collectionCapError(decision.limit, decision.tier);
  }
  // `check_failed` — and, defensively, any future non-cap denial reason: the
  // count couldn't be determined, so fail closed as a transient 503 "try
  // again", never a misleading 403 "upgrade your plan".
  log.error(
    { workspaceId, ...context },
    "Knowledge collection install blocked — collection count check failed (failing closed)",
  );
  throw new BillingCheckFailedError({ message: decision.errorMessage, workspaceId });
}

/**
 * The cross-catalog slug probe: reject a slug already owned by a DIFFERENT
 * knowledge catalog in this workspace.
 *
 * `knowledge_documents` keys on `(workspace_id, collection_id, path)` with NO
 * catalog dimension, so two catalogs sharing an `install_id` would silently
 * merge their document trees — and a bundle-sync's archive-absent pass would
 * archive the other collection's docs (#4211).
 *
 * Unlike the cap aggregate (`KNOWLEDGE_COLLECTION_COUNT_SQL`, which filters
 * `status <> 'archived'`), this probe deliberately INCLUDES archived installs:
 * their documents still live under the slug and an explicit re-ingest may
 * resurrect them (ADR-0028 §5).
 */
async function assertCollectionSlugFree(
  workspaceId: WorkspaceId,
  collectionSlug: string,
  ownCatalogId: string,
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
  await assertCollectionSlugFree(workspaceId, collectionSlug, ownCatalogId);
  const decision = await checkKnowledgeCollectionLimit(workspaceId, collectionSlug);
  if (!decision.allowed) throwCollectionDenial(decision, workspaceId, { collectionSlug }, log);
}

/**
 * The pre-write gate for a **fan-out** install — one collection per vendor
 * object (Zendesk per brand, Front per knowledge base, Freshdesk per category,
 * Help Scout per site).
 *
 * Looping {@link assertCollectionInstallable} would be wrong: every iteration
 * sees the same pre-write count, so all N pass, and the atomic gate then
 * refuses the (cap+1)-th *after* earlier items have written their rows AND
 * their credentials — a partial install the admin has to unpick. This checks
 * the whole batch against the cap once, before anything is written.
 *
 * @throws {FormInstallValidationError} 400 — a slug is taken by another catalog.
 * @throws {FeatureEntitlementError} 403 upgrade — the batch exceeds the cap.
 * @throws {BillingCheckFailedError} 503 — the count couldn't be determined.
 */
export async function assertCollectionBatchInstallable(
  workspaceId: WorkspaceId,
  collectionSlugs: readonly string[],
  ownCatalogId: string,
  log: CollectionInstallLogger,
): Promise<void> {
  for (const slug of collectionSlugs) {
    await assertCollectionSlugFree(workspaceId, slug, ownCatalogId);
  }
  const decision = await checkKnowledgeCollectionFanOutLimit(workspaceId, collectionSlugs);
  if (!decision.allowed) {
    throwCollectionDenial(decision, workspaceId, { planned: collectionSlugs.length }, log);
  }
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
  // The `RETURNING id` invariant below is only detectable AFTER the write has
  // run inside the transaction. Catch the omission before we take the lock, so
  // a handler wired with the wrong SQL fails loudly instead of rolling back a
  // committed-looking install.
  if (!/\breturning\s+id\b/i.test(sql)) {
    throw new Error(
      `upsertKnowledgeCollectionRow requires SQL ending in "RETURNING id" (collection "${collectionSlug}")`,
    );
  }

  const result = await checkKnowledgeCollectionLimitAndInstall<{ id: string }>(
    workspaceId,
    collectionSlug,
    { sql, params },
  );

  if (!result.allowed) {
    throwCollectionDenial(result, workspaceId, { collectionSlug, underLock: true }, log);
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
