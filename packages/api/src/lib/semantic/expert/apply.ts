/**
 * Apply a semantic expert amendment to the org's semantic layer.
 *
 * Reads the current entity YAML, applies the amendment, writes the updated
 * YAML, invalidates caches, then records a version snapshot. Rollback-ability
 * is part of the apply (#4506): a snapshot failure fails the whole apply and
 * best-effort restores the pre-image, so the decide seam's compensation
 * (row → pending) stays truthful. The disk-mirror sync stays warn-only.
 */

import * as yaml from "js-yaml";
import { loadYaml } from "../yaml";
import { ANALYSIS_CATEGORIES, type AnalysisResult, type AnalysisCategory } from "./types";
import { AMENDMENT_TYPES, type AmendmentType } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import type { SemanticEntityRow } from "@atlas/api/lib/semantic/entities";
import {
  AMENDMENT_MUTABLE_FIELDS,
  parseEntityShapeOrError,
} from "./amendment-validation";
import {
  StaleBaselineError,
  computeEntityDiff,
  hashBaselineYaml,
  normalizeEntityYaml,
} from "./diff";

const log = createLogger("semantic-expert-apply");

/**
 * Resolve an {@link AnalysisResult.group} label to the `connection_group_id`
 * scope used for the entity LOOKUP (#3284):
 *
 * - `undefined` (interactive `proposeAmendment` path, group unknown) → `undefined`,
 *   preserving the back-compat unscoped lookup (`getEntity` runs its ambiguity
 *   check and 409s when the name exists in 2+ groups).
 * - `"default"` (the flat `entities/` group) → `null`, an EXPLICIT default-scope
 *   lookup that won't 409 even when the same name also lives in a group.
 * - `"<group>"` → the group name, scoping the lookup to that group's row.
 */
function groupToLookupScope(group: string | undefined): string | null | undefined {
  if (group === undefined) return undefined;
  return group === "default" ? null : group;
}

/**
 * Resolve the current entity ROW + parsed YAML baseline for an amendment,
 * scoped to its Connection group (ADR-0012, #3284). This is the SINGLE resolver
 * both the diff preview (`proposeAmendment`) and the write
 * (`applyAmendmentToEntity`) go through — identical org/group scoping on both,
 * so the document an admin reviews is the one approval mutates (each path does
 * its own DB read, so a concurrent write between them is not excluded — but the
 * scope can no longer diverge, which is the flat-root-vs-DB bug this closes:
 * the tool diffed a stale/absent file while apply mutated the org's DB row,
 * #4488).
 *
 * Lookup:
 * - scoped lookup via `groupToLookupScope(group)` — an explicit group avoids
 *   the unscoped ambiguity 409 for a name shared across groups; an undefined
 *   group keeps the legacy unscoped behavior for the interactive path;
 * - on a scoped miss (`group !== undefined`), fall back to the back-compat
 *   UNSCOPED lookup, which resolves a unique match (and only throws
 *   `AmbiguousEntityError` on genuine cross-group ambiguity).
 *
 * The returned `targetGroupId` is the resolved row's OWN `connection_group_id`
 * — authoritative for every write-back, and the group callers must thread to
 * the apply so it lands in the exact scope the baseline was read from.
 *
 * @throws when the entity is absent for this org, or its stored YAML is not a
 *   mapping. An `AmbiguousEntityError` from an unscoped multi-group lookup
 *   propagates too — the apply/approve route path maps it to 409; the
 *   `proposeAmendment` tool catches it and returns a generic error result.
 */
export async function resolveAmendmentBaseline(
  orgId: string | null,
  entityName: string,
  group: string | undefined,
  // #4511 — the disambiguation group an admin picked from a prior cross-group
  // 409. Consulted ONLY in the unscoped-fallback ambiguity branch below, so a
  // well-scoped amendment can never be redirected to a different group by a
  // caller-supplied value ("honored only when the server demanded disambiguation").
  // `undefined` = none provided; `null` = the legacy/default (flat) scope; a
  // string = that group. A candidate can legitimately be `null`, which is why
  // the "provided" test is `!== undefined`, not truthiness.
  disambiguationGroup?: string | null,
): Promise<{
  row: SemanticEntityRow;
  targetGroupId: string | null;
  parsed: Record<string, unknown>;
}> {
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  const { getEntity, AmbiguousEntityError } = await import("@atlas/api/lib/semantic/entities");

  const lookupScope = groupToLookupScope(group);
  let row = await getEntity(effectiveOrgId, "entity", entityName, lookupScope);
  if (!row && lookupScope !== undefined) {
    // The persisted group didn't resolve to a row — e.g. an interactive
    // `proposeAmendment` row (NULL group) whose flat-root entity was imported
    // under a datasource group, or a stale group label. Fall back to the
    // back-compat UNSCOPED lookup. Log the fallback so a wrong-scope diagnosis
    // isn't silent — the write-back below still targets the resolved row's OWN
    // group, so this only widens the read, never the write.
    log.debug(
      { entityName, requestedScope: lookupScope },
      "scoped amendment baseline lookup missed — falling back to unscoped resolve",
    );
    try {
      row = await getEntity(effectiveOrgId, "entity", entityName);
    } catch (fallbackErr) {
      // #4511 — cross-group ambiguity on a legacy row (the name lives in 2+
      // groups and no scope resolved it). If the admin picked a disambiguation
      // group, resolve at THAT explicit scope instead of re-raising the 409;
      // otherwise re-raise so the route surfaces the group picker.
      if (fallbackErr instanceof AmbiguousEntityError && disambiguationGroup !== undefined) {
        row = await getEntity(effectiveOrgId, "entity", entityName, disambiguationGroup);
      } else {
        throw fallbackErr;
      }
    }
  }
  if (!row) {
    throw new Error(
      `Entity "${entityName}" not found for org ${orgId ?? "self-hosted (global)"}`,
    );
  }

  // The row's OWN group is authoritative for every write-back — whether we
  // resolved it by explicit scope or via the unscoped fallback, this is the
  // exact row we read, so the amendment can never be written into a different
  // (e.g. default) scope than the one it was analyzed against (#3284).
  const targetGroupId = row.connection_group_id ?? null;

  // Parse current YAML.
  // `loadYaml` returns undefined for a document-less row (v5 would throw),
  // routing it into the "expected a mapping" guard below.
  const parsed = loadYaml(row.yaml_content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Failed to parse YAML for entity "${entityName}": expected a mapping`);
  }

  return { row, targetGroupId, parsed };
}

/**
 * Apply an amendment from an AnalysisResult to the org's semantic entity.
 *
 * 1. Read current YAML from DB — scoped to the finding's Connection group
 *    (`result.group`) so a group entity resolves without a 409 (#3284), via the
 *    shared {@link resolveAmendmentBaseline} the diff preview also uses (#4488)
 * 2. Apply amendment, serialize back
 * 3. Upsert entity + create version snapshot — written back to the row's OWN
 *    `connection_group_id`, so the amendment can never land in the wrong scope
 * 4. Invalidate caches and sync to disk (same group)
 */
export async function applyAmendmentToEntity(
  orgId: string | null,
  result: AnalysisResult,
  requestId: string,
  // #4511 — review-integrity options: `disambiguationGroup` resolves a legacy
  // cross-group-ambiguous row at an admin-picked scope; `expectedBaselineHash`
  // is the hash-carried claim — a mismatch against the current baseline raises
  // a StaleBaselineError (fresh diff, inline update-and-confirm) instead of
  // silently applying against a baseline the admin never saw.
  opts?: { disambiguationGroup?: string | null; expectedBaselineHash?: string },
): Promise<void> {
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  // Read the baseline through the shared resolver so the diff preview and this
  // write agree on the exact row + scope (#4488). Returns the row's OWN group.
  const { row: entity, targetGroupId, parsed } = await resolveAmendmentBaseline(
    orgId,
    result.entityName,
    result.group,
    opts?.disambiguationGroup,
  );

  const {
    getEntity,
    upsertEntityForGroup,
    createVersion,
    generateChangeSummary,
    AmbiguousEntityError,
  } = await import("@atlas/api/lib/semantic/entities");

  // Apply amendment (same logic as CLI's apply-amendment)
  const updated = applyAmendment(parsed, result);

  // #4511 — hash-carried claim: the admin reviewed a live diff computed against
  // a baseline whose hash they carried into this approve. Recompute the hash
  // against the baseline we just resolved; a mismatch means the entity changed
  // since render. That is not a failure — raise a StaleBaselineError carrying
  // the FRESHLY-computed live diff so the decide seam returns the claim to
  // pending cleanly and the card presents inline update-and-confirm. Run this
  // BEFORE the post-apply shape gate: a changed baseline should surface the
  // fresh-diff confirm, never a shape error against a baseline the admin never
  // saw. The hash is taken over the normalized baseline, exactly as the
  // review-render path computed it, so the two can only disagree on real change.
  if (opts?.expectedBaselineHash !== undefined) {
    const beforeNormalized = normalizeEntityYaml(parsed);
    const baselineHash = hashBaselineYaml(beforeNormalized);
    if (baselineHash !== opts.expectedBaselineHash) {
      throw new StaleBaselineError({
        entityName: result.entityName,
        diff: computeEntityDiff(result.entityName, beforeNormalized, normalizeEntityYaml(updated)),
        baselineHash,
      });
    }
  }

  // Post-apply gate (#4513): the mutated document must still parse as an entity
  // BEFORE it is written. A failure fails the whole apply (nothing is upserted),
  // so the decide seam compensates the claimed row back to `pending` with this
  // reason in `last_apply_error` — an amendment can never corrupt the
  // authoritative entity into a shape the whitelist/loader would silently drop.
  const shapeError = parseEntityShapeOrError(updated);
  if (shapeError) {
    throw new Error(
      `Post-apply validation failed for entity "${result.entityName}": ${shapeError}. The amendment was not applied.`,
    );
  }

  // Serialize back to YAML
  const newYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });

  // Upsert entity into its own group scope.
  await upsertEntityForGroup(effectiveOrgId, "entity", result.entityName, newYaml, targetGroupId);

  // Invalidate caches immediately — the mutation has landed, so a stale
  // whitelist must not outlive it even if the version snapshot below fails.
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  invalidateOrgWhitelist(effectiveOrgId);

  // Create version snapshot. Rollback-ability is part of the apply (#4506):
  // a snapshot failure FAILS the whole apply, so the decide seam compensates
  // the row back to pending instead of stamping `approved` on a change that
  // can't be rolled back. Tagged errors (AmbiguousEntityError) re-throw
  // untouched so the route layer maps them to 409 with `groups`.
  try {
    const refreshed = await getEntity(effectiveOrgId, "entity", result.entityName, targetGroupId);
    if (!refreshed) {
      throw new Error("entity row not found after upsert");
    }
    const changeSummary = await generateChangeSummary(entity.yaml_content, newYaml);
    const versionSummary = `Expert agent: ${result.rationale}${changeSummary ? ` (${changeSummary})` : ""}`;
    await createVersion(
      refreshed.id, effectiveOrgId, "entity", result.entityName, newYaml, versionSummary,
      "expert-agent", "Semantic Expert Agent",
    );
  } catch (versionErr) {
    if (versionErr instanceof AmbiguousEntityError) throw versionErr;
    const msg = versionErr instanceof Error ? versionErr.message : String(versionErr);
    log.warn(
      { err: msg, requestId, orgId, entity: result.entityName },
      "Version snapshot failed — failing the amendment apply (rollback-ability is part of the apply)",
    );
    // The upsert has already landed, so a compensated "pending" row would lie
    // about the layer's state. Best-effort restore of the pre-image keeps the
    // compensation truthful; if the restore itself fails, say so loudly in the
    // error (which becomes the row's visible `last_apply_error`) so an admin
    // never reads "pending" + a neutral reason and rejects a LIVE change.
    let restored = false;
    try {
      await upsertEntityForGroup(
        effectiveOrgId, "entity", result.entityName, entity.yaml_content, targetGroupId,
      );
      invalidateOrgWhitelist(effectiveOrgId);
      restored = true;
    } catch (restoreErr) {
      log.error(
        {
          err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          requestId,
          orgId,
          entity: result.entityName,
        },
        "Failed to roll back entity YAML after snapshot failure — the change is LIVE while the amendment returns to pending",
      );
    }
    throw new Error(
      restored
        ? `Version snapshot failed for entity "${result.entityName}": ${msg}. The YAML change was rolled back — retry the approval.`
        : `Version snapshot failed for entity "${result.entityName}": ${msg}. WARNING: the YAML change is still applied (rollback also failed) — retry the approval to converge; do not reject.`,
      { cause: versionErr },
    );
  }

  // Sync to disk (non-fatal) — same group so the on-disk mirror lands in
  // `groups/<group>/entities/` rather than the flat default dir.
  try {
    const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
    await syncEntityToDisk(effectiveOrgId, result.entityName, "entity", newYaml, targetGroupId);
  } catch (syncErr) {
    log.warn(
      { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, entity: result.entityName },
      "Amendment applied but disk sync failed",
    );
  }

  log.info(
    { requestId, orgId, entity: result.entityName, amendmentType: result.amendmentType, group: targetGroupId },
    "Semantic amendment applied via expert agent",
  );
}

/**
 * Reconstruct an {@link AnalysisResult} from a stored `amendment_payload`
 * envelope and apply it to the org's semantic entity. Shared by every admin
 * approve path — the learned-patterns single-PATCH + bulk handlers and the
 * dedicated amendment-review endpoint — so the envelope→`AnalysisResult`
 * mapping lives once, beside {@link applyAmendmentToEntity} that consumes it.
 *
 * The stored payload is the full envelope
 * (`{ entityName, amendmentType, amendment, rationale, category, … }`); the YAML
 * mutation in {@link applyAmendment} reads the INNER `amendment` object, so the
 * reconstructed result carries `payload.amendment`, never the envelope itself.
 *
 * @throws when the payload is missing/malformed, or the YAML apply fails. An
 *   `AmbiguousEntityError` (a name shared across Connection groups) propagates
 *   to the caller (the route layer maps it to 409).
 */
export async function applyAmendmentFromPayload(params: {
  orgId: string | null;
  /** Entity the amendment targets — the row's authoritative `source_entity`. */
  sourceEntity: string;
  /** The amendment's Connection group; NULL = the default (flat) scope. */
  connectionGroupId: string | null;
  /** Raw `amendment_payload` column value — a JSON string or a parsed object. */
  rawPayload: unknown;
  requestId: string;
  /** Identifier surfaced in error messages (pattern / amendment id). */
  label?: string;
  /**
   * #4511 — an admin-picked group for a legacy cross-group-ambiguous row. Passed
   * through to {@link resolveAmendmentBaseline}, where it is honored ONLY when
   * default resolution is ambiguous (see that function). `undefined` = none.
   */
  disambiguationGroup?: string | null;
  /**
   * #4511 — the baseline hash the admin rendered. A mismatch against the current
   * baseline raises a StaleBaselineError (inline update-and-confirm) instead of
   * applying against an unseen baseline. `undefined` = no hash-carried claim.
   */
  expectedBaselineHash?: string;
}): Promise<void> {
  const { orgId, sourceEntity, connectionGroupId, rawPayload, requestId } = params;

  const result = analysisResultFromStoredPayload({
    sourceEntity,
    connectionGroupId,
    rawPayload,
    label: params.label,
  });

  await applyAmendmentToEntity(orgId, result, requestId, {
    disambiguationGroup: params.disambiguationGroup,
    expectedBaselineHash: params.expectedBaselineHash,
  });
}

/**
 * Reconstruct an {@link AnalysisResult} from a stored `amendment_payload`
 * envelope. Shared by the apply seam ({@link applyAmendmentFromPayload}) and the
 * live-diff render ({@link computeAmendmentLiveDiff}) so the document those two
 * paths mutate/diff is derived from the payload identically — there is one
 * envelope→result mapping, not two that could drift.
 *
 * The stored payload is the full envelope
 * (`{ entityName, amendmentType, amendment, rationale, category, … }`); the YAML
 * mutation in {@link applyAmendment} reads the INNER `amendment` object, so the
 * reconstructed result carries `payload.amendment`, never the envelope itself.
 *
 * @throws when the payload is missing/malformed (a null/corrupt payload or a
 *   missing inner `amendment` object) — never a silent skip (#4506).
 */
export function analysisResultFromStoredPayload(params: {
  sourceEntity: string;
  connectionGroupId: string | null;
  rawPayload: unknown;
  label?: string;
}): AnalysisResult {
  const { sourceEntity, connectionGroupId, rawPayload } = params;
  const label = params.label ?? sourceEntity;

  let payload: Record<string, unknown> | null = null;
  if (typeof rawPayload === "string") {
    try {
      const parsed: unknown = JSON.parse(rawPayload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch (err) {
      throw new Error(
        `Corrupt amendment_payload JSON for amendment ${label}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  } else if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    payload = rawPayload as Record<string, unknown>;
  }

  if (!payload) {
    throw new Error(
      `Amendment ${label} has no amendment_payload — cannot apply its YAML change.`,
    );
  }

  const innerAmendment = payload.amendment;
  if (!innerAmendment || typeof innerAmendment !== "object" || Array.isArray(innerAmendment)) {
    throw new Error(
      `Amendment ${label} payload is missing a valid \`amendment\` object — cannot apply its YAML change.`,
    );
  }

  const rawCategory = String((payload.category ?? "coverage_gaps") as string);
  const rawAmendmentType = String((payload.amendmentType ?? "update_description") as string);

  return {
    entityName: sourceEntity,
    // Recover the Connection group the amendment was analyzed against so the
    // apply targets that group's row, not the default scope or a 409 (#3284).
    // A NULL group means the default (flat) group — map it to the explicit
    // `"default"` label so the lookup is scoped to NULL rather than running
    // the unscoped ambiguity check.
    group: connectionGroupId ?? "default",
    category: (ANALYSIS_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as AnalysisCategory)
      : "coverage_gaps",
    amendmentType: (AMENDMENT_TYPES as readonly string[]).includes(rawAmendmentType)
      ? (rawAmendmentType as AmendmentType)
      : "update_description",
    amendment: innerAmendment as Record<string, unknown>,
    rationale: typeof payload.rationale === "string" ? payload.rationale : "",
    confidence: 0,
    impact: 0,
    score: 0,
    staleness: 0,
  };
}

/** Maps simple "add_*" amendment types to their target array key. */
const ADD_AMENDMENT_KEYS: Record<string, string> = {
  add_dimension: "dimensions",
  add_measure: "measures",
  add_join: "joins",
  add_query_pattern: "query_patterns",
};

/**
 * Identity field per entity-array key, used to make re-applying an amendment
 * idempotent. Dimensions/measures/query-patterns are keyed by `name`; joins by
 * their `target_entity`.
 */
const ADD_AMENDMENT_IDENTITY: Record<string, string> = {
  dimensions: "name",
  measures: "name",
  joins: "target_entity",
  query_patterns: "name",
};

/**
 * Append `entry` to the `arrayKey` array, or REPLACE an existing element with
 * the same identity (last-write-wins) so re-approving the same amendment — or
 * approving an updated version of it — converges instead of pushing a duplicate
 * dimension/measure/join. The `add_*` handlers previously used a blind push, so
 * a second approval of the same name silently produced two identical entries.
 * When the entry carries no identity value we can't dedup it, so we append.
 */
function upsertByIdentity(
  arr: Record<string, unknown>[],
  arrayKey: string,
  entry: Record<string, unknown>,
): void {
  const idField = ADD_AMENDMENT_IDENTITY[arrayKey];
  const idVal = idField ? entry[idField] : undefined;
  if (idVal !== undefined && idVal !== null) {
    const idx = arr.findIndex((e) => e[idField] === idVal);
    if (idx >= 0) {
      arr[idx] = entry;
      return;
    }
  }
  arr.push(entry);
}

/** Apply an amendment to a parsed entity object. Returns a new object. */
export function applyAmendment(
  entity: Record<string, unknown>,
  result: AnalysisResult,
): Record<string, unknown> {
  const updated = structuredClone(entity);
  const amendment = result.amendment;

  // Handle the four simple "push to array" amendment types. Idempotent: a
  // re-approval of the same name replaces rather than duplicates.
  const arrayKey = ADD_AMENDMENT_KEYS[result.amendmentType];
  if (arrayKey) {
    const arr = (updated[arrayKey] ?? []) as Record<string, unknown>[];
    upsertByIdentity(arr, arrayKey, amendment);
    updated[arrayKey] = arr;
    return updated;
  }

  switch (result.amendmentType) {
    case "update_description": {
      if (amendment.field === "table") {
        updated.description = amendment.description;
      } else if (amendment.dimension) {
        const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
        const target = dims.find((d) => d.name === amendment.dimension);
        if (!target) {
          throw new Error(
            `Cannot update description: dimension "${String(amendment.dimension as string)}" not found in entity "${result.entityName}"`,
          );
        }
        target.description = amendment.description;
      } else {
        throw new Error(
          `Invalid update_description amendment: field="${String(amendment.field)}", dimension="${String(amendment.dimension)}"`,
        );
      }
      break;
    }
    case "update_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      const target = dims.find((d) => d.name === amendment.name);
      if (!target) {
        throw new Error(
          `Cannot update dimension: "${String(amendment.name)}" not found in entity "${result.entityName}"`,
        );
      }
      // Typed mutation, not a blind `Object.assign` (#4513): copy ONLY the
      // fields update_dimension declares it may touch. `name` is the selector
      // (never renamed) and `sql` is protected — an update can never repoint a
      // dimension's expression or smuggle a change bigger than its type
      // (ADR-0032 containment). Defense in depth with the propose-time strict
      // schema: even a legacy stored payload carrying `sql` cannot repoint here.
      const mutable = AMENDMENT_MUTABLE_FIELDS.update_dimension ?? [];
      for (const field of mutable) {
        if (Object.hasOwn(amendment, field)) {
          target[field] = amendment[field];
        }
      }
      break;
    }
    case "add_virtual_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      upsertByIdentity(dims, "dimensions", { ...amendment, virtual: true });
      updated.dimensions = dims;
      break;
    }
    case "add_glossary_term":
      // Glossary amendments don't modify entity files
      break;
    default:
      throw new Error(`Unsupported amendment type: ${result.amendmentType}`);
  }

  return updated;
}
