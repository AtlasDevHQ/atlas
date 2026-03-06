/**
 * SQL execution tool with production-grade validation.
 *
 * Validation layers (in validateSQL):
 * 0. Empty check — reject empty/whitespace-only input
 * 1. Regex mutation guard — quick reject of DML/DDL keywords
 * 2. AST parse — node-sql-parser (PostgreSQL or MySQL mode, auto-detected), SELECT-only, single statement
 * 3. Table whitelist — only tables defined in the semantic layer (CTE names excluded)
 *
 * Applied during execution:
 * 4. RLS injection — WHERE clause injection based on user claims (when enabled)
 * 5. Auto LIMIT — appended to every query (default 1000)
 * 6. Statement timeout — configurable per-query deadline
 */

import { tool } from "ai";
import { z } from "zod";
import { Parser } from "node-sql-parser";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import type { DBConnection, DBType } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables } from "@atlas/api/lib/semantic";
import { logQueryAudit } from "@atlas/api/lib/auth/audit";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { withSpan } from "@atlas/api/lib/tracing";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { acquireSourceSlot, decrementSourceConcurrency } from "@atlas/api/lib/db/source-rate-limit";
import { getConfig } from "@atlas/api/lib/config";
import { resolveRLSFilters, injectRLSConditions } from "@atlas/api/lib/rls";

const log = createLogger("sql");

const parser = new Parser();

/**
 * Strip SQL comments for regex guard testing.
 *
 * Block comments and line comments are removed so that anchored patterns
 * like `^\s*(KILL)\b` cannot be bypassed with a leading comment.
 *
 * Only used for regex testing — the original SQL is passed to the AST parser
 * unchanged so that comment-aware parsing still works correctly.
 */
function stripSqlComments(sql: string): string {
  // Single regex handles string literals, block comments, line comments,
  // and MySQL-style # comments in one pass. String literals (single-quoted
  // with '' escape) are preserved unchanged; comments are replaced with a space.
  return sql
    .replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*/g, (match) =>
      match.startsWith("'") ? match : " ",
    )
    .trim();
}

const FORBIDDEN_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
  /\b(GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i,
  /\b(COPY|LOAD|VACUUM|REINDEX|OPTIMIZE)\b/i,
  /\bINTO\s+OUTFILE\b/i,
];

// MySQL-specific patterns — only applied when dbType === "mysql"
// Note: LOAD DATA/XML is already caught by the base LOAD pattern above
const MYSQL_FORBIDDEN_PATTERNS = [
  /\b(HANDLER)\b/i,
  /\b(SHOW|DESCRIBE|EXPLAIN|USE)\b/i,
];

/**
 * Map DBType to node-sql-parser dialect string.
 *
 * When a connectionId is provided, plugin-registered metadata is checked first.
 * Falls back to the hardcoded switch for known types, and defaults to
 * "PostgresQL" for unknown/custom dbType strings (plugin escape hatch).
 */
export function parserDatabase(dbType: DBType | string, connectionId?: string): string {
  // 1. Plugin metadata takes precedence
  if (connectionId) {
    const pluginDialect = connections.getParserDialect(connectionId);
    if (pluginDialect) return pluginDialect;
  }

  // 2. Core types + fallback for plugin-registered types
  switch (dbType) {
    case "postgres": return "PostgresQL";
    case "mysql": return "MySQL";
    default:
      // Unknown types (plugin-registered via `string & {}`) default to
      // PostgreSQL mode as a safe fallback. Log a warning so plugin authors
      // know to register a parserDialect via ConnectionPluginMeta.
      log.warn(
        { dbType, connectionId },
        "No parser dialect registered for dbType '%s' — falling back to PostgreSQL parser. " +
        "Register a parserDialect via ConnectionPluginMeta to use the correct SQL grammar.",
        dbType,
      );
      return "PostgresQL";
  }
}

/**
 * Get extra forbidden patterns for a connection.
 *
 * When a connectionId is provided, plugin-registered patterns are checked first.
 * Falls back to the hardcoded arrays for known types, and returns an empty
 * array for unknown/custom dbType strings.
 */
function getExtraPatterns(dbType: DBType | string, connectionId?: string): RegExp[] {
  // 1. Plugin metadata takes precedence
  if (connectionId) {
    const pluginPatterns = connections.getForbiddenPatterns(connectionId);
    if (pluginPatterns.length > 0) return pluginPatterns;
  }

  // 2. Core types + fallback for plugin-registered types
  switch (dbType) {
    case "postgres": return [];
    case "mysql": return MYSQL_FORBIDDEN_PATTERNS;
    default:
      // Unknown types (plugin-registered) — no extra patterns from core.
      // Warn so plugin authors know to register forbiddenPatterns.
      if (dbType) {
        log.warn(
          { dbType, connectionId },
          "No forbidden patterns registered for dbType '%s' — only base DML/DDL patterns apply. " +
          "Register forbiddenPatterns via ConnectionPluginMeta for database-specific protection.",
          dbType,
        );
      }
      return [];
  }
}

export function validateSQL(sql: string, connectionId?: string): { valid: boolean; error?: string } {
  // Resolve DB type for this connection.
  // When an explicit connectionId is given but not found, return a validation
  // error instead of silently falling back — wrong parser mode is a security risk.
  let dbType: DBType | string;
  if (connectionId) {
    try {
      dbType = connections.getDBType(connectionId);
    } catch (err) {
      log.debug({ err, connectionId }, "getDBType failed for connectionId");
      return { valid: false, error: `Connection "${connectionId}" is not registered.` };
    }
  } else {
    try {
      dbType = detectDBType();
    } catch (err) {
      log.debug({ err }, "detectDBType failed — no valid datasource configured");
      return { valid: false, error: "No valid datasource configured. Set ATLAS_DATASOURCE_URL to a PostgreSQL or MySQL connection string, or register a datasource plugin." };
    }
  }

  // 0. Reject empty / whitespace-only input
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) {
    return { valid: false, error: "Empty query" };
  }

  // 1. Regex guard against mutation keywords
  //
  // Strip comments before testing so that leading block/line comments
  // cannot bypass start-of-string anchored patterns (e.g. `/* x */ KILL ...`).
  const forRegex = stripSqlComments(trimmed);
  const extraPatterns = getExtraPatterns(dbType, connectionId);
  const patterns = [...FORBIDDEN_PATTERNS, ...extraPatterns];
  for (const pattern of patterns) {
    if (pattern.test(forRegex)) {
      return {
        valid: false,
        error: `Forbidden SQL operation detected: ${pattern.source}`,
      };
    }
  }

  // 2. AST validation — must be a single SELECT
  //
  // Security rationale: if the regex guard (layer 1) passed but the AST parser
  // cannot parse the query, we REJECT it rather than allowing it through.
  // A query that passes regex but confuses the parser could be a crafted bypass
  // attempt. The agent can always reformulate into standard SQL that parses.
  const cteNames = new Set<string>();
  try {
    const ast = parser.astify(trimmed, { database: parserDatabase(dbType, connectionId) });
    const statements = Array.isArray(ast) ? ast : [ast];

    // Single-statement check — reject batched queries
    if (statements.length > 1) {
      return { valid: false, error: "Multiple statements are not allowed" };
    }

    for (const stmt of statements) {
      if (stmt.type !== "select") {
        return {
          valid: false,
          error: `Only SELECT statements are allowed, got: ${stmt.type}`,
        };
      }
      // Collect CTE names so the table whitelist can ignore them
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (Array.isArray((stmt as any).with)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const cte of (stmt as any).with) {
          const name = cte?.name?.value ?? cte?.name;
          if (typeof name === "string") cteNames.add(name.toLowerCase());
        }
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    return {
      valid: false,
      error: `Query could not be parsed.${detail ? ` ${detail}.` : ""} Rewrite using standard SQL syntax.`,
    };
  }

  // 3. Table whitelist check
  if (process.env.ATLAS_TABLE_WHITELIST !== "false") {
    try {
      const tables = parser.tableList(trimmed, { database: parserDatabase(dbType, connectionId) });
      const allowed = getWhitelistedTables(connectionId);

      for (const ref of tables) {
        // tableList returns "select::schema::table" format
        const parts = ref.split("::");
        const tableName = parts.pop()?.toLowerCase();
        // node-sql-parser returns "null" (the string) for unqualified tables — filter it out
        const rawSchema = parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
        const schemaName = rawSchema && rawSchema !== "null" ? rawSchema : undefined;
        if (!tableName || cteNames.has(tableName)) continue;

        const qualifiedName = schemaName ? `${schemaName}.${tableName}` : undefined;
        if (schemaName) {
          // Schema explicitly specified — require qualified match
          if (!(qualifiedName && allowed.has(qualifiedName))) {
            return {
              valid: false,
              error: `Table "${qualifiedName}" is not in the allowed list. Check catalog.yml for available tables.`,
            };
          }
        } else {
          // No schema — allow unqualified match
          if (!allowed.has(tableName)) {
            return {
              valid: false,
              error: `Table "${tableName}" is not in the allowed list. Check catalog.yml for available tables.`,
            };
          }
        }
      }
    } catch {
      // Table extraction uses the same parser that just succeeded in step 2.
      // If it fails here, reject to avoid bypassing the whitelist.
      return {
        valid: false,
        error: "Could not verify table permissions. Rewrite using standard SQL syntax.",
      };
    }
  }

  return { valid: true };
}

const ROW_LIMIT = parseInt(process.env.ATLAS_ROW_LIMIT ?? "1000", 10);
const QUERY_TIMEOUT = parseInt(
  process.env.ATLAS_QUERY_TIMEOUT ?? "30000",
  10
);

export const executeSQL = tool({
  description: `Execute a read-only SQL query against the database. Only SELECT statements are allowed.

Rules:
- Always read the relevant entity schema from the semantic layer BEFORE writing SQL
- Use exact column names from the schema — never guess
- Use canonical metric SQL from metrics/*.yml when available
- Include a LIMIT clause for large result sets
- If a query fails, fix the issue — do not retry the same SQL`,

  inputSchema: z.object({
    sql: z.string().describe("The SELECT query to execute"),
    explanation: z
      .string()
      .describe("Brief explanation of what this query does and why"),
    connectionId: z
      .string()
      .optional()
      .describe(
        "Target connection ID. Check the entity YAML's `connection` field to determine which source a table belongs to. Omit for the default connection.",
      ),
  }),

  execute: async ({ sql, explanation, connectionId }) => {
    const connId = connectionId ?? "default";

    // Validate connection exists before proceeding.
    // Use getDefault() for "default" to trigger lazy initialization from
    // ATLAS_DATASOURCE_URL — plain get("default") throws on fresh startup.
    let db: DBConnection;
    let dbType: DBType;
    try {
      if (connId === "default") {
        db = connections.getDefault();
        dbType = connections.getDBType(connId);
      } else {
        db = connections.get(connId);
        dbType = connections.getDBType(connId);
      }
    } catch {
      return {
        success: false,
        error: `Connection "${connId}" is not registered. Available: ${connections.list().join(", ") || "(none)"}`,
      };
    }

    const targetHost = connections.getTargetHost(connId);

    // Check for a custom validator (non-SQL datasource plugins like SOQL, GraphQL).
    // When present, it completely replaces the standard SQL validation pipeline.
    // If absent, validateSQL is used instead — validators are mutually exclusive.
    const customValidator = connections.getValidator(connId);
    const normalizedSql = sql.trim().replace(/;\s*$/, "").trimEnd();
    if (customValidator) {
      let result: { valid: boolean; reason?: string };
      try {
        result = customValidator(normalizedSql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, connectionId: connId, sql: normalizedSql.slice(0, 200) }, "Custom validator threw an exception");
        logQueryAudit({
          sql: normalizedSql.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: `Custom validator error: ${message}`,
          sourceId: connId,
          sourceType: dbType,
        });
        return { success: false, error: `Query validation failed for connection "${connId}": internal validator error` };
      }
      if (typeof result?.valid !== "boolean") {
        log.error({ connectionId: connId, returnValue: result }, "Custom validator returned invalid shape");
        logQueryAudit({
          sql: normalizedSql.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: "Custom validator returned invalid result",
          sourceId: connId,
          sourceType: dbType,
        });
        return { success: false, error: `Query validation misconfigured for connection "${connId}"` };
      }
      if (!result.valid) {
        logQueryAudit({
          sql: normalizedSql.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: `Validation rejected: ${result.reason ?? "Query rejected by custom validator"}`,
          sourceId: connId,
          sourceType: dbType,
        });
        return { success: false, error: result.reason ?? "Query rejected by custom validator" };
      }
    } else {
      const validation = validateSQL(sql, connId);
      if (!validation.valid) {
        logQueryAudit({
          sql: sql.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: `Validation rejected: ${validation.error}`,
          sourceId: connId,
          sourceType: dbType,
        });
        return { success: false, error: validation.error };
      }
    }

    // Per-source rate limiting — atomic check-and-acquire
    const slot = acquireSourceSlot(connId);
    if (!slot.acquired) {
      logQueryAudit({
        sql: sql.slice(0, 2000),
        durationMs: 0,
        rowCount: null,
        success: false,
        error: `Rate limited: ${slot.reason}`,
        sourceId: connId,
        sourceType: dbType,
        targetHost,
      });
      return {
        success: false,
        error: slot.reason ?? "Rate limited",
        ...(slot.retryAfterMs != null && { retryAfterMs: slot.retryAfterMs }),
      };
    }

    const { dispatchHook, dispatchMutableHook } = await import("@atlas/api/lib/plugins/hooks");
    let mutatedSql: string;
    try {
      const hookCtx = { sql, connectionId: connId } as const;
      mutatedSql = await dispatchMutableHook(
        "beforeQuery",
        hookCtx,
        "sql",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      decrementSourceConcurrency(connId);
      logQueryAudit({
        sql: sql.slice(0, 2000),
        durationMs: 0,
        rowCount: null,
        success: false,
        error: `Plugin rejected: ${message}`,
        sourceId: connId,
        sourceType: dbType,
        targetHost,
      });
      return { success: false, error: `Query rejected by plugin: ${message}` };
    }

    // Re-validate if a plugin rewrote the SQL — a plugin could introduce DML,
    // disallowed tables, or invalid syntax that would bypass the initial validation
    let normalizedMutated = mutatedSql.trim().replace(/;\s*$/, "").trimEnd();
    if (normalizedMutated !== normalizedSql) {
      if (customValidator) {
        let reresult: { valid: boolean; reason?: string };
        try {
          reresult = customValidator(normalizedMutated);
        } catch (err) {
          decrementSourceConcurrency(connId);
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, connectionId: connId, sql: normalizedMutated.slice(0, 200) }, "Custom validator threw during re-validation of plugin-mutated query");
          logQueryAudit({
            sql: normalizedMutated.slice(0, 2000),
            durationMs: 0,
            rowCount: null,
            success: false,
            error: `Custom validator error on rewritten query: ${message}`,
            sourceId: connId,
            sourceType: dbType,
            targetHost,
          });
          return { success: false, error: `Re-validation failed for connection "${connId}": internal validator error` };
        }
        if (typeof reresult?.valid !== "boolean") {
          decrementSourceConcurrency(connId);
          log.error({ connectionId: connId, returnValue: reresult }, "Custom validator returned invalid shape during re-validation");
          logQueryAudit({
            sql: normalizedMutated.slice(0, 2000),
            durationMs: 0,
            rowCount: null,
            success: false,
            error: "Custom validator returned invalid result during re-validation",
            sourceId: connId,
            sourceType: dbType,
            targetHost,
          });
          return { success: false, error: `Query validation misconfigured for connection "${connId}"` };
        }
        if (!reresult.valid) {
          decrementSourceConcurrency(connId);
          logQueryAudit({
            sql: normalizedMutated.slice(0, 2000),
            durationMs: 0,
            rowCount: null,
            success: false,
            error: `Plugin-rewritten SQL failed validation: ${reresult.reason ?? "Query rejected by custom validator"}`,
            sourceId: connId,
            sourceType: dbType,
            targetHost,
          });
          return { success: false, error: `Plugin-rewritten SQL failed validation: ${reresult.reason ?? "Query rejected by custom validator"}` };
        }
      } else {
        const revalidation = validateSQL(mutatedSql, connId);
        if (!revalidation.valid) {
          decrementSourceConcurrency(connId);
          logQueryAudit({
            sql: mutatedSql.slice(0, 2000),
            durationMs: 0,
            rowCount: null,
            success: false,
            error: `Plugin-rewritten SQL failed validation: ${revalidation.error}`,
            sourceId: connId,
            sourceType: dbType,
            targetHost,
          });
          return { success: false, error: `Plugin-rewritten SQL failed validation: ${revalidation.error}` };
        }
      }
    }

    // --- RLS: inject WHERE conditions based on user claims ---
    // Applied after validation + plugin hooks so plugins cannot strip RLS.
    // Skipped for custom validators (non-SQL languages like SOQL).
    const config = getConfig();
    const rlsConfig = config?.rls;
    if (rlsConfig?.enabled && !customValidator) {
      if (!config) {
        // Config not loaded — fail-closed rather than risk missing RLS.
        decrementSourceConcurrency(connId);
        log.error("getConfig() returned null during RLS-enabled SQL execution — config not loaded");
        return { success: false, error: "Server configuration not initialized. Please retry." };
      }
      const ctx = getRequestContext();
      const user = ctx?.user;

      // Extract tables from the (possibly plugin-mutated) SQL
      let queriedTables: Set<string>;
      try {
        const dialect = parserDatabase(dbType, connId);
        const tableRefs = parser.tableList(normalizedMutated, { database: dialect });
        queriedTables = new Set(
          tableRefs
            .map((ref) => {
              const parts = ref.split("::");
              return parts.pop()?.toLowerCase() ?? "";
            })
            .filter(Boolean),
        );
      } catch (tableErr) {
        decrementSourceConcurrency(connId);
        const tableErrMsg = tableErr instanceof Error ? tableErr.message : String(tableErr);
        log.error({ err: tableErr, sql: normalizedMutated.slice(0, 200) }, "RLS: failed to extract table list from query");
        logQueryAudit({
          sql: normalizedMutated.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: `RLS: could not extract tables from query: ${tableErrMsg}`,
          sourceId: connId,
          sourceType: dbType,
          targetHost,
        });
        return { success: false, error: "Query could not be analyzed for row-level security. Rewrite using standard SQL." };
      }

      const filterResult = resolveRLSFilters(user, queriedTables, rlsConfig);
      if ("error" in filterResult) {
        decrementSourceConcurrency(connId);
        log.warn({ error: filterResult.error, userId: user?.id }, "RLS filter resolution failed — query blocked");
        logQueryAudit({
          sql: normalizedMutated.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: `RLS blocked: ${filterResult.error}`,
          sourceId: connId,
          sourceType: dbType,
          targetHost,
        });
        return { success: false, error: filterResult.error };
      }

      if (filterResult.filters.length > 0) {
        try {
          normalizedMutated = injectRLSConditions(normalizedMutated, filterResult.filters, dbType);
          log.debug(
            { filters: filterResult.filters.length, userId: user?.id },
            "RLS conditions injected",
          );
        } catch (err) {
          decrementSourceConcurrency(connId);
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err, userId: user?.id }, "RLS injection failed — query blocked");
          logQueryAudit({
            sql: normalizedMutated.slice(0, 2000),
            durationMs: 0,
            rowCount: null,
            success: false,
            error: `RLS injection failed: ${msg}`,
            sourceId: connId,
            sourceType: dbType,
            targetHost,
          });
          return { success: false, error: "Query could not be processed for row-level security." };
        }
      }
    }

    // Auto-append LIMIT if not present.
    // Custom validators are responsible for their own pagination — non-SQL
    // languages (SOQL, GraphQL) may not support the LIMIT keyword.
    let querySql = normalizedMutated;
    if (!customValidator && !/\bLIMIT\b/i.test(querySql)) {
      querySql += ` LIMIT ${ROW_LIMIT}`;
    }

    // Includes connection acquisition time; the OTel span inside withSpan
    // covers only the actual query execution against the database.
    const start = performance.now();
    try {
      const result = await withSpan(
        "atlas.sql.execute",
        {
          "db.system": dbType,
          "db.statement": querySql.slice(0, 200),
        },
        () => db.query(querySql, QUERY_TIMEOUT),
      );
      const durationMs = Math.round(performance.now() - start);
      const truncated = result.rows.length >= ROW_LIMIT;

      try {
        logQueryAudit({
          sql: querySql,
          durationMs,
          rowCount: result.rows.length,
          success: true,
          sourceId: connId,
          sourceType: dbType,
          targetHost,
        });
      } catch (auditErr) {
        log.warn({ err: auditErr }, "Failed to write query audit log");
      }

      await dispatchHook("afterQuery", {
        sql: querySql,
        connectionId: connId,
        result: { columns: result.columns, rows: result.rows },
        durationMs,
      });

      return {
        success: true,
        explanation,
        row_count: result.rows.length,
        columns: result.columns,
        rows: result.rows,
        truncated,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const message =
        err instanceof Error ? err.message : "Unknown database error";

      try {
        logQueryAudit({
          sql: querySql,
          durationMs,
          rowCount: null,
          success: false,
          error: message,
          sourceId: connId,
          sourceType: dbType,
          targetHost,
        });
      } catch (auditErr) {
        log.warn({ err: auditErr }, "Failed to write query audit log");
      }

      // Block errors that might expose connection details or internal state
      if (SENSITIVE_PATTERNS.test(message)) {
        return { success: false, error: "Database query failed — check server logs for details." };
      }

      // Surface the full DB error to the agent for self-correction
      // (includes column-not-found, syntax, timeout, type mismatch, etc.)
      const dbErr = err as { hint?: string; position?: string };
      let detail = message;
      if (dbErr.hint) {
        detail += ` — Hint: ${dbErr.hint}`;
      }
      if (dbErr.position) {
        detail += ` (at character ${dbErr.position})`;
      }
      return { success: false, error: detail };
    } finally {
      decrementSourceConcurrency(connId);
    }
  },
});
