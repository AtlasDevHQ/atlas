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

/** Validation layer identifiers returned in the `errors` array. */
export type ValidationLayer =
  | "empty_check"
  | "connection"
  | "regex_guard"
  | "ast_parse"
  | "table_whitelist";

/**
 * Map the error message from validateSQL() in lib/tools/sql.ts to the
 * validation layer that produced it. If those messages change, update the
 * matchers below accordingly.
 */
function inferLayer(error: string): ValidationLayer {
  if (error === "Empty query") return "empty_check";
  if (error.startsWith("Connection") || error.startsWith("No valid datasource")) return "connection";
  if (error.startsWith("Forbidden SQL operation")) return "regex_guard";
  if (
    error.includes("not in the allowed list") ||
    error.includes("Could not verify table")
  ) return "table_whitelist";
  // Fallthrough: parse failures, non-SELECT, multiple statements.
  // Log so we notice when new error formats are added to validateSQL().
  log.warn({ error }, "inferLayer: unrecognized error message, defaulting to ast_parse");
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

    // Extract referenced tables from the valid query.
    // getDBType/detectDBType are outside the catch — operational errors
    // (missing connection, bad config) should propagate, not be swallowed.
    let tables: string[] = [];
    let dbType: string;
    if (connectionId) {
      dbType = connections.getDBType(connectionId);
    } else {
      dbType = detectDBType();
    }
    const trimmed = sql.trim().replace(/;\s*$/, "");
    try {
      const tableRefs = parser.tableList(trimmed, {
        database: parserDatabase(dbType, connectionId),
      });
      tables = [
        ...new Set(
          tableRefs
            .map((ref) => {
              // tableList returns "action::schema::table" format
              const parts = ref.split("::");
              const table = parts[2]?.toLowerCase() ?? "";
              const schema = parts[1]?.toLowerCase();
              if (!table) return "";
              return schema && schema !== "null" ? `${schema}.${table}` : table;
            })
            .filter(Boolean),
        ),
      ];
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)), sql: trimmed },
        "Table extraction failed for valid query",
      );
    }

    return c.json({ valid: true, errors: [], tables });
  });
});
