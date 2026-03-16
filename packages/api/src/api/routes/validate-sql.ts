/**
 * SQL validation endpoint — validate SQL without executing it.
 *
 * POST /api/v1/validate-sql accepts a SQL string, runs the full validation
 * pipeline (empty check → regex guard → AST parse → table whitelist), and
 * returns structured results with the failing layer, error messages, and
 * referenced tables.
 *
 * Does NOT execute the query against any database.
 */

import { Hono } from "hono";
import { z } from "zod";
import { Parser } from "node-sql-parser";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { authPreamble } from "./auth-preamble";
import { validateSQL, parserDatabase } from "@atlas/api/lib/tools/sql";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";

const log = createLogger("validate-sql");
const parser = new Parser();

const ValidateSQLRequestSchema = z.object({
  sql: z.string().trim().min(1, "sql must not be empty"),
  connectionId: z.string().optional(),
});

/**
 * Map the error message from validateSQL() to the validation layer that
 * produced it. Error messages are stable strings we control.
 */
function inferLayer(error: string): string {
  if (error === "Empty query") return "empty_check";
  if (error.startsWith("Connection") || error.startsWith("No valid datasource")) return "connection";
  if (error.startsWith("Forbidden SQL operation")) return "regex_guard";
  if (
    error.includes("not in the allowed list") ||
    error.includes("Could not verify table")
  ) return "table_whitelist";
  // Covers: parse failures, non-SELECT, multiple statements
  return "ast_parse";
}

export const validateSqlRoute = new Hono();

validateSqlRoute.post("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  // Parse body before entering request context
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: "invalid_request", message: "Invalid JSON body." },
      400,
    );
  }

  const parsed = ValidateSQLRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", message: "Invalid request body.", details: parsed.error.issues },
      422,
    );
  }

  const { sql, connectionId } = parsed.data;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const result = validateSQL(sql, connectionId);

    if (!result.valid) {
      return c.json({
        valid: false,
        errors: [{ layer: inferLayer(result.error!), message: result.error! }],
        tables: [],
      });
    }

    // Extract referenced tables from the valid query
    let tables: string[] = [];
    try {
      let dbType: string;
      if (connectionId) {
        dbType = connections.getDBType(connectionId);
      } else {
        dbType = detectDBType();
      }
      const trimmed = sql.trim().replace(/;\s*$/, "");
      const tableRefs = parser.tableList(trimmed, {
        database: parserDatabase(dbType, connectionId),
      });
      tables = [
        ...new Set(
          tableRefs
            .map((ref) => {
              const parts = ref.split("::");
              return parts.pop()?.toLowerCase() ?? "";
            })
            .filter((t) => t && t !== "null"),
        ),
      ];
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Table extraction failed for valid query",
      );
    }

    return c.json({ valid: true, errors: [], tables });
  });
});
