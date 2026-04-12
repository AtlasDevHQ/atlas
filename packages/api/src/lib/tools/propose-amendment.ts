/**
 * proposeAmendment tool — propose a semantic layer YAML change with rationale.
 *
 * Generates a unified YAML diff, optionally runs a test query, and writes the
 * proposal to the learned_patterns table for admin review.
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createTwoFilesPatch } from "diff";
import { hasInternalDB, insertSemanticAmendment } from "@atlas/api/lib/db/internal";
import { connections, getDB } from "@atlas/api/lib/db/connection";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import type { AmendmentPayload, AmendmentType } from "@useatlas/types";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";

const log = createLogger("tool:propose-amendment");

/** Apply an amendment to a parsed entity object and return the updated object. */
function applyAmendment(
  entity: Record<string, unknown>,
  amendmentType: AmendmentType,
  amendment: Record<string, unknown>,
): Record<string, unknown> {
  const updated = structuredClone(entity);

  switch (amendmentType) {
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
        if (target) target.description = amendment.description;
      }
      break;
    }
    case "update_dimension": {
      const dims = (updated.dimensions ?? []) as Record<string, unknown>[];
      const target = dims.find((d) => d.name === amendment.name);
      if (target) Object.assign(target, amendment);
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

  return updated;
}

export const proposeAmendment = tool({
  description: `Propose a semantic layer YAML change. Generates a unified diff and writes to the review queue.

Amendment types: add_dimension, add_measure, add_join, add_query_pattern, update_description, update_dimension, add_glossary_term, add_virtual_dimension.

The amendment object should match the YAML structure for that type (e.g., { name, sql, type, description } for a dimension).`,

  inputSchema: z.object({
    entityName: z.string().describe("Entity (table) name to amend"),
    amendmentType: z.enum([
      "add_dimension",
      "add_measure",
      "add_join",
      "add_query_pattern",
      "update_description",
      "update_dimension",
      "add_glossary_term",
      "add_virtual_dimension",
    ]),
    amendment: z
      .record(z.string(), z.unknown())
      .describe("Type-specific amendment payload matching the YAML structure"),
    rationale: z
      .string()
      .describe("Why this change improves the semantic layer"),
    testQuery: z
      .string()
      .optional()
      .describe("Optional SQL to validate the amendment"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Confidence this amendment is correct (0.0–1.0)"),
  }),

  execute: async ({
    entityName,
    amendmentType,
    amendment,
    rationale,
    testQuery,
    confidence,
  }) => {
    try {
      // Load current entity YAML
      const entityPath = path.join(
        getSemanticRoot(),
        "entities",
        `${entityName}.yml`,
      );

      let beforeYaml: string;
      let entity: Record<string, unknown>;

      if (fs.existsSync(entityPath)) {
        beforeYaml = fs.readFileSync(entityPath, "utf-8");
        const raw = yaml.load(beforeYaml);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return {
            error: `Entity file ${entityName}.yml could not be parsed as a YAML mapping. The file may be empty or malformed.`,
          };
        }
        entity = raw as Record<string, unknown>;
      } else {
        return {
          error: `Entity file not found: ${entityPath}. Check that the entity name matches a YAML file in the semantic layer.`,
        };
      }

      // Apply amendment
      const updated = applyAmendment(entity, amendmentType, amendment);

      // Normalize both sides through yaml.dump() with identical options so
      // the diff only shows actual content changes, not formatting drift
      // (e.g. inline arrays → multiline, whitespace differences).
      const dumpOpts: yaml.DumpOptions = {
        lineWidth: 120,
        noRefs: true,
        quotingType: '"',
      };
      const beforeNormalized = yaml.dump(entity, dumpOpts);
      const afterYaml = yaml.dump(updated, dumpOpts);

      // Generate diff — LCS-based algorithm produces proper multi-hunk unified diffs
      const filePath = `semantic/entities/${entityName}.yml`;
      const diff = createTwoFilesPatch(filePath, filePath, beforeNormalized, afterYaml, "", "", { context: 3 });

      // Run test query if provided — validate through SQL pipeline first
      let testResult: AmendmentPayload["testResult"];
      if (testQuery) {
        try {
          // Validate test query through the same SQL pipeline as executeSQL
          const validation = validateSQL(testQuery);
          if (!validation.valid) {
            testResult = {
              success: false,
              rowCount: 0,
              sampleRows: [],
              error: validation.error ?? "SQL validation failed",
            };
            log.warn(
              { testQuery, error: validation.error },
              "Amendment test query failed SQL validation",
            );
          } else {
            const reqCtx = getRequestContext();
            const orgId = connections.isOrgPoolingEnabled()
              ? reqCtx?.user?.activeOrganizationId
              : undefined;

            const db = orgId
              ? connections.getForOrg(orgId)
              : getDB();

            const result = await db.query(testQuery, 30000);
            testResult = {
              success: true,
              rowCount: result.rows.length,
              sampleRows: result.rows.slice(0, 5) as Record<string, unknown>[],
            };
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          testResult = {
            success: false,
            rowCount: 0,
            sampleRows: [],
            error: errMsg,
          };
          log.warn(
            { err: errMsg, testQuery },
            "Amendment test query failed",
          );
        }
      }

      // Build payload
      const payload: AmendmentPayload = {
        entityName,
        amendmentType,
        amendment,
        rationale,
        diff,
        confidence,
        ...(testQuery && { testQuery }),
        ...(testResult && { testResult }),
      };

      // Write to review queue if internal DB available
      let proposalId: string;
      let status: "queued" | "auto_approved";

      if (hasInternalDB()) {
        const result = await insertSemanticAmendment({
          orgId: getRequestContext()?.user?.activeOrganizationId ?? null,
          description: `[${amendmentType}] ${entityName}: ${rationale}`,
          sourceEntity: entityName,
          confidence,
          amendmentPayload: payload as unknown as Record<string, unknown>,
        });

        proposalId = result.id;
        status = result.status === "approved" ? "auto_approved" : "queued";
      } else {
        proposalId = `local-${Date.now()}`;
        status = "queued";
      }

      return {
        proposalId,
        status,
        diff,
        ...(testResult && { testResult }),
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), entityName, amendmentType },
        "proposeAmendment failed",
      );
      return {
        error: `Failed to propose amendment: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
