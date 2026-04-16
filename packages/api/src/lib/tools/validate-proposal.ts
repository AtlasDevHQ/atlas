/**
 * validateProposal tool — dry-run validation of a semantic amendment proposal.
 *
 * Three-stage validation:
 * 1. YAML parse (js-yaml)
 * 2. Whitelist check (all referenced tables exist)
 * 3. Test query execution (if proposal has testQuery)
 */

import { tool } from "ai";
import { z } from "zod";
import * as yaml from "js-yaml";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { connections, getDB } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables } from "@atlas/api/lib/semantic";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import type { AmendmentPayload } from "@useatlas/types";

const log = createLogger("tool:validate-proposal");

export const validateProposal = tool({
  description:
    "Validate a semantic amendment proposal. Checks YAML syntax, table whitelist compliance, and optionally runs the test query.",

  inputSchema: z.object({
    proposalId: z.string().describe("The proposal ID from proposeAmendment"),
  }),

  execute: async ({ proposalId }) => {
    const issues: string[] = [];

    try {
      // Fetch proposal from DB
      if (!hasInternalDB()) {
        return {
          yamlValid: false,
          whitelistValid: false,
          issues: ["Internal database not configured. Cannot fetch proposal."],
        };
      }

      const rows = await internalQuery<{
        id: string;
        amendment_payload: string | Record<string, unknown> | null;
        type: string;
      }>(
        `SELECT id, amendment_payload, type FROM learned_patterns WHERE id = $1`,
        [proposalId],
      );

      if (rows.length === 0) {
        return {
          yamlValid: false,
          whitelistValid: false,
          issues: [`Proposal not found: ${proposalId}`],
        };
      }

      const row = rows[0];
      if (row.type !== "semantic_amendment") {
        return {
          yamlValid: false,
          whitelistValid: false,
          issues: [`Pattern ${proposalId} is not a semantic amendment (type: ${row.type})`],
        };
      }

      let payload: AmendmentPayload;
      try {
        payload = (
          typeof row.amendment_payload === "string"
            ? JSON.parse(row.amendment_payload)
            : row.amendment_payload
        ) as AmendmentPayload;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.warn({ proposalId, err: detail }, "Failed to parse amendment_payload JSON");
        return {
          yamlValid: false,
          whitelistValid: false,
          issues: [`Failed to parse amendment_payload JSON: ${detail}`],
        };
      }

      if (!payload) {
        return {
          yamlValid: false,
          whitelistValid: false,
          issues: ["Amendment payload is null"],
        };
      }

      // Stage 1: YAML parse
      let yamlValid = true;
      if (payload.diff) {
        // Extract the "after" content from the diff (lines starting with +, excluding +++)
        const addedLines = payload.diff
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1));

        if (addedLines.length > 0) {
          try {
            yaml.load(addedLines.join("\n"));
          } catch (err) {
            yamlValid = false;
            issues.push(
              `YAML parse error in added lines: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      // Stage 2: Whitelist check
      let whitelistValid = true;
      const reqCtx = getRequestContext();
      const orgId = connections.isOrgPoolingEnabled()
        ? reqCtx?.user?.activeOrganizationId
        : undefined;

      const whitelist = orgId
        ? getOrgWhitelistedTables(orgId, "default", reqCtx?.atlasMode)
        : getWhitelistedTables();

      if (!whitelist.has(payload.entityName.toLowerCase())) {
        whitelistValid = false;
        issues.push(
          `Entity "${payload.entityName}" is not in the table whitelist`,
        );
      }

      // Check join targets if it's a join amendment
      if (
        payload.amendmentType === "add_join" &&
        payload.amendment
      ) {
        const joinSql = String(payload.amendment.sql ?? "");
        // Extract table references from join SQL (e.g., "table_a.col = table_b.col")
        const tableRefs = joinSql.match(/(\w+)\.\w+/g);
        if (tableRefs) {
          for (const ref of tableRefs) {
            const tableName = ref.split(".")[0].toLowerCase();
            if (!whitelist.has(tableName)) {
              whitelistValid = false;
              issues.push(
                `Join references table "${tableName}" which is not in the whitelist`,
              );
            }
          }
        }
      }

      // Stage 3: Test query execution
      let testQueryResult:
        | { success: boolean; error?: string; rowCount?: number; sampleRows?: Record<string, unknown>[] }
        | undefined;

      if (payload.testQuery) {
        // Validate test query through SQL pipeline before execution
        const sqlValidation = validateSQL(payload.testQuery);
        if (!sqlValidation.valid) {
          testQueryResult = {
            success: false,
            error: sqlValidation.error,
          };
          issues.push(`Test query failed SQL validation: ${sqlValidation.error}`);
        } else {
          try {
            const db = orgId
              ? connections.getForOrg(orgId)
              : getDB();

            const result = await db.query(payload.testQuery, 30000);
            testQueryResult = {
              success: true,
              rowCount: result.rows.length,
              sampleRows: result.rows.slice(0, 3) as Record<string, unknown>[],
            };

            if (result.rows.length === 0) {
              issues.push(
                "Test query returned 0 rows — the amendment may reference incorrect columns",
              );
            }
          } catch (err) {
            testQueryResult = {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
            issues.push(
              `Test query failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      return {
        yamlValid,
        whitelistValid,
        ...(testQueryResult && { testQueryResult }),
        issues,
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), proposalId },
        "validateProposal failed",
      );
      return {
        yamlValid: false,
        whitelistValid: false,
        issues: [
          `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  },
});
