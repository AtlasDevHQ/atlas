/**
 * Shared amendment application logic for `atlas improve`.
 *
 * Used by both batch mode (improve.ts) and interactive mode (interactive.ts)
 * to apply semantic layer amendments to parsed YAML entity objects.
 */

import type { AnalysisResult } from "@atlas/api/lib/semantic/expert";

/**
 * Apply an amendment to a parsed entity and return the updated object.
 *
 * Returns a deep clone — the original entity is not mutated.
 * Returns null if the amendment could not be applied (e.g. target dimension not found).
 */
export function applyAmendmentToEntity(
  entity: Record<string, unknown>,
  result: AnalysisResult,
): { updated: Record<string, unknown>; warning?: string } {
  const updated = structuredClone(entity);
  const amendment = result.amendment;

  switch (result.amendmentType) {
    case "add_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      dims.push(amendment);
      updated.dimensions = dims;
      break;
    }
    case "add_measure": {
      const measures = (updated.measures ?? []) as Record<string, unknown>[];
      measures.push(amendment);
      updated.measures = measures;
      break;
    }
    case "add_join": {
      const joins = (updated.joins ?? []) as Record<string, unknown>[];
      joins.push(amendment);
      updated.joins = joins;
      break;
    }
    case "add_query_pattern": {
      const patterns = (updated.query_patterns ?? []) as Record<string, unknown>[];
      patterns.push(amendment);
      updated.query_patterns = patterns;
      break;
    }
    case "update_description": {
      if (amendment.field === "table") {
        updated.description = amendment.description;
      } else if (amendment.dimension) {
        const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
        const target = dims.find((d) => d.name === amendment.dimension);
        if (target) {
          target.description = amendment.description;
        } else {
          return {
            updated,
            warning: `dimension "${String(amendment.dimension)}" not found in ${result.entityName} — description not updated`,
          };
        }
      } else {
        return {
          updated,
          warning: `update_description amendment has unrecognized target (field=${String(amendment.field)}) — skipping`,
        };
      }
      break;
    }
    case "update_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      const target = dims.find((d) => d.name === amendment.name);
      if (target) {
        Object.assign(target, amendment);
      } else {
        return {
          updated,
          warning: `dimension "${String(amendment.name)}" not found in ${result.entityName} — update not applied`,
        };
      }
      break;
    }
    case "add_virtual_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      dims.push({ ...amendment, virtual: true });
      updated.dimensions = dims;
      break;
    }
    case "add_glossary_term":
      // Glossary amendments don't modify entity files — handled separately
      break;
  }

  return { updated };
}
