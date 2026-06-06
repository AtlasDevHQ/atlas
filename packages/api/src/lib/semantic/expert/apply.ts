/**
 * Apply a semantic expert amendment to the org's semantic layer.
 *
 * Reads the current entity YAML, applies the amendment, writes the
 * updated YAML, records a version snapshot, and invalidates caches.
 */

import * as yaml from "js-yaml";
import type { AnalysisResult } from "./types";
import { createLogger } from "@atlas/api/lib/logger";

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
 * Apply an amendment from an AnalysisResult to the org's semantic entity.
 *
 * 1. Read current YAML from DB — scoped to the finding's Connection group
 *    (`result.group`) so a group entity resolves without a 409 (#3284)
 * 2. Parse, apply amendment, serialize back
 * 3. Upsert entity + create version snapshot — written back to the row's OWN
 *    `connection_group_id`, so the amendment can never land in the wrong scope
 * 4. Invalidate caches and sync to disk (same group)
 */
export async function applyAmendmentToEntity(
  orgId: string | null,
  result: AnalysisResult,
  requestId: string,
): Promise<void> {
  // Self-hosted (null orgId) uses empty string as sentinel for global scope
  const effectiveOrgId = orgId ?? "";

  const {
    getEntity,
    upsertEntityForGroup,
    createVersion,
    generateChangeSummary,
    AmbiguousEntityError,
  } = await import("@atlas/api/lib/semantic/entities");

  // Look the entity up in its Connection group (ADR-0012, #3284). An explicit
  // group avoids the unscoped ambiguity 409 for a name shared across groups;
  // an undefined group keeps the legacy unscoped behavior for the interactive
  // path. `getEntity` may still throw AmbiguousEntityError (undefined group,
  // 2+ groups) — that propagates to the route as a 409 with `groups`.
  const lookupScope = groupToLookupScope(result.group);
  let entity = await getEntity(effectiveOrgId, "entity", result.entityName, lookupScope);
  if (!entity && lookupScope !== undefined) {
    // The persisted group didn't resolve to a row — e.g. an interactive
    // `proposeAmendment` row (NULL group) whose flat-root entity was imported
    // under a datasource group, or a stale group label. Fall back to the
    // back-compat UNSCOPED lookup, which resolves a unique match (and only
    // throws AmbiguousEntityError → 409 on genuine cross-group ambiguity). The
    // write-back below still targets the resolved row's OWN group, so a wrong
    // scope is never written.
    entity = await getEntity(effectiveOrgId, "entity", result.entityName);
  }
  if (!entity) {
    throw new Error(`Entity "${result.entityName}" not found for org ${orgId}`);
  }

  // The row's OWN group is authoritative for every write-back below — whether
  // we resolved it by explicit scope or via the unscoped fallback, this is the
  // exact row we read, so the amendment can never be written into a different
  // (e.g. default) scope than the one it was analyzed against (#3284).
  const targetGroupId = entity.connection_group_id ?? null;

  // Parse current YAML
  const parsed = yaml.load(entity.yaml_content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Failed to parse YAML for entity "${result.entityName}": expected a mapping`);
  }

  // Apply amendment (same logic as CLI's apply-amendment)
  const updated = applyAmendment(parsed, result);

  // Serialize back to YAML
  const newYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });

  // Upsert entity into its own group scope.
  await upsertEntityForGroup(effectiveOrgId, "entity", result.entityName, newYaml, targetGroupId);

  // Create version snapshot. Tagged errors (AmbiguousEntityError) must
  // re-throw so the route layer maps them to 409 with `groups`; a generic
  // warn-log would bury the structural ambiguity that the expert agent
  // needs the operator to resolve.
  try {
    const refreshed = await getEntity(effectiveOrgId, "entity", result.entityName, targetGroupId);
    if (refreshed) {
      const changeSummary = await generateChangeSummary(entity.yaml_content, newYaml);
      const versionSummary = `Expert agent: ${result.rationale}${changeSummary ? ` (${changeSummary})` : ""}`;
      await createVersion(
        refreshed.id, effectiveOrgId, "entity", result.entityName, newYaml, versionSummary,
        "expert-agent", "Semantic Expert Agent",
      );
    }
  } catch (versionErr) {
    if (versionErr instanceof AmbiguousEntityError) throw versionErr;
    log.warn(
      { err: versionErr instanceof Error ? versionErr.message : String(versionErr), requestId, orgId, entity: result.entityName },
      "Amendment applied but version snapshot failed",
    );
  }

  // Invalidate caches
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  invalidateOrgWhitelist(effectiveOrgId);

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

/** Maps simple "add_*" amendment types to their target array key. */
const ADD_AMENDMENT_KEYS: Record<string, string> = {
  add_dimension: "dimensions",
  add_measure: "measures",
  add_join: "joins",
  add_query_pattern: "query_patterns",
};

/** Apply an amendment to a parsed entity object. Returns a new object. */
export function applyAmendment(
  entity: Record<string, unknown>,
  result: AnalysisResult,
): Record<string, unknown> {
  const updated = structuredClone(entity);
  const amendment = result.amendment;

  // Handle the four simple "push to array" amendment types
  const arrayKey = ADD_AMENDMENT_KEYS[result.amendmentType];
  if (arrayKey) {
    const arr = (updated[arrayKey] ?? []) as Record<string, unknown>[];
    arr.push(amendment);
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
            `Cannot update description: dimension "${String(amendment.dimension)}" not found in entity "${result.entityName}"`,
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
      Object.assign(target, amendment);
      break;
    }
    case "add_virtual_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      dims.push({ ...amendment, virtual: true });
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
