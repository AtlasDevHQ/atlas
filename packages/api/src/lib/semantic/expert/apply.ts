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
 * Apply an amendment from an AnalysisResult to the org's semantic entity.
 *
 * 1. Read current YAML from DB
 * 2. Parse, apply amendment, serialize back
 * 3. Upsert entity + create version snapshot
 * 4. Invalidate caches and sync to disk
 */
export async function applyAmendmentToEntity(
  orgId: string,
  result: AnalysisResult,
  requestId: string,
): Promise<void> {
  const {
    getEntity,
    upsertEntity,
    createVersion,
    generateChangeSummary,
  } = await import("@atlas/api/lib/semantic/entities");

  const entity = await getEntity(orgId, "entity", result.entityName);
  if (!entity) {
    throw new Error(`Entity "${result.entityName}" not found for org ${orgId}`);
  }

  // Parse current YAML
  const parsed = yaml.load(entity.yaml_content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Failed to parse YAML for entity "${result.entityName}": expected a mapping`);
  }

  // Apply amendment (same logic as CLI's apply-amendment)
  const updated = applyAmendment(parsed, result);

  // Serialize back to YAML
  const newYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });

  // Upsert entity
  await upsertEntity(orgId, "entity", result.entityName, newYaml, entity.connection_id ?? undefined);

  // Create version snapshot
  try {
    const refreshed = await getEntity(orgId, "entity", result.entityName);
    if (refreshed) {
      const changeSummary = await generateChangeSummary(entity.yaml_content, newYaml);
      const versionSummary = `Expert agent: ${result.rationale}${changeSummary ? ` (${changeSummary})` : ""}`;
      await createVersion(
        refreshed.id, orgId, "entity", result.entityName, newYaml, versionSummary,
        "expert-agent", "Semantic Expert Agent",
      );
    }
  } catch (versionErr) {
    log.warn(
      { err: versionErr instanceof Error ? versionErr.message : String(versionErr), requestId, orgId, entity: result.entityName },
      "Amendment applied but version snapshot failed",
    );
  }

  // Invalidate caches
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  invalidateOrgWhitelist(orgId);

  // Sync to disk (non-fatal)
  try {
    const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
    await syncEntityToDisk(orgId, result.entityName, "entity", newYaml);
  } catch (syncErr) {
    log.warn(
      { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, entity: result.entityName },
      "Amendment applied but disk sync failed",
    );
  }

  log.info(
    { requestId, orgId, entity: result.entityName, amendmentType: result.amendmentType },
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
