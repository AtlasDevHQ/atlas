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
import { connections, detectDBType, ConnectionNotRegisteredError, NoDatasourceConfiguredError, PoolCapacityExceededError } from "@atlas/api/lib/db/connection";
import type { DBConnection, DBType } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables } from "@atlas/api/lib/semantic";
import { logQueryAudit } from "@atlas/api/lib/auth/audit";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { withSpan } from "@atlas/api/lib/tracing";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { acquireSourceSlot, decrementSourceConcurrency } from "@atlas/api/lib/db/source-rate-limit";
import { getConfig } from "@atlas/api/lib/config";
import { resolveRLSFilters, injectRLSConditions, type RLSFilterGroup } from "@atlas/api/lib/rls";
import { getSetting } from "@atlas/api/lib/settings";
import { getCache, buildCacheKey, cacheEnabled, getDefaultTtl } from "@atlas/api/lib/cache/index";

const log = createLogger("sql");

const parser = new Parser();

// ── Classification ──────────────────────────────────────────────────

interface SQLClassification {
  readonly tablesAccessed: string[];
  readonly columnsAccessed: string[];
}

type SQLValidationResult =
  | { valid: true; error?: undefined; classification: SQLClassification }
  | { valid: false; error: string; classification?: undefined };

/**
 * Extract table and column references from validated SQL.
 *
 * Uses node-sql-parser's tableList/columnList helpers.
 * CTE names are excluded from tablesAccessed.
 * SELECT * is stored as ["*"] in columnsAccessed.
 * Best-effort: returns empty arrays on extraction failure.
 */
export function extractClassification(
  sql: string,
  dialect: string,
  cteNames: Set<string>,
): SQLClassification {
  try {
    const tableRefs = parser.tableList(sql, { database: dialect });
    const tablesAccessed = [...new Set(
      tableRefs
        .map((ref) => {
          const parts = ref.split("::");
          return parts.pop()?.toLowerCase() ?? "";
        })
        .filter((t) => t && !cteNames.has(t)),
    )];

    const columnRefs = parser.columnList(sql, { database: dialect });
    const columnsAccessed = [...new Set(
      columnRefs
        .map((ref) => {
          const parts = ref.split("::");
          const col = parts.pop() ?? "";
          // node-sql-parser uses "(.*)" for SELECT *
          if (col === "(.*)") return "*";
          return col.toLowerCase();
        })
        .filter(Boolean),
    )];

    return { tablesAccessed, columnsAccessed };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), sql: sql.slice(0, 200), dialect },
      "Classification extraction failed — storing empty arrays",
    );
    return { tablesAccessed: [], columnsAccessed: [] };
  }
}

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
  /\b(GRANT|REVOKE|EXEC|EXECUTE|CALL|KILL)\b/i,
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

export function validateSQL(sql: string, connectionId?: string): SQLValidationResult {
  // Resolve DB type for this connection.
  // When an explicit connectionId is given but not found, return a validation
  // error instead of silently falling back — wrong parser mode is a security risk.
  let dbType: DBType | string;
  if (connectionId) {
    try {
      dbType = connections.getDBType(connectionId);
    } catch (err) {
      log.warn({ err, connectionId }, "getDBType failed for connectionId");
      return { valid: false, error: `Connection "${connectionId}" is not registered.` };
    }
  } else {
    try {
      dbType = detectDBType();
    } catch (err) {
      log.warn({ err }, "detectDBType failed — no valid datasource configured");
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
      // Extract CTE names so they can be excluded from the table whitelist check
      if (Array.isArray(stmt.with)) {
        for (const cte of stmt.with) {
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
      const orgId = getRequestContext()?.user?.activeOrganizationId;
      const allowed = orgId
        ? getOrgWhitelistedTables(orgId, connectionId)
        : getWhitelistedTables(connectionId);

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
    } catch (err) {
      // Table extraction uses the same parser that just succeeded in step 2.
      // If it fails here, reject to avoid bypassing the whitelist.
      log.warn({ err, sql: trimmed.slice(0, 200) }, "Table extraction failed after successful AST parse");
      return {
        valid: false,
        error: "Could not verify table permissions. Rewrite using standard SQL syntax.",
      };
    }
  }

  // 4. Extract classification data (best-effort, never blocks validation)
  const classification = extractClassification(
    trimmed,
    parserDatabase(dbType, connectionId),
    cteNames,
  );

  return { valid: true, classification };
}

let lastWarnedRowLimit: string | undefined;

/** Read row limit from settings cache (DB override > env var > default). Called per-query so admin changes take effect without restart. */
function getRowLimit(): number {
  const raw = getSetting("ATLAS_ROW_LIMIT") ?? "1000";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== lastWarnedRowLimit) {
      log.warn({ value: raw }, "Invalid ATLAS_ROW_LIMIT value; using default 1000");
      lastWarnedRowLimit = raw;
    }
    return 1000;
  }
  return n;
}

let lastWarnedQueryTimeout: string | undefined;

/** Read query timeout from settings cache (DB override > env var > default). Called per-query so admin changes take effect without restart. */
function getQueryTimeout(): number {
  const raw = getSetting("ATLAS_QUERY_TIMEOUT") ?? "30000";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== lastWarnedQueryTimeout) {
      log.warn({ value: raw }, "Invalid ATLAS_QUERY_TIMEOUT value; using default 30000ms");
      lastWarnedQueryTimeout = raw;
    }
    return 30000;
  }
  return n;
}

// ── executeSQL helpers ──────────────────────────────────────────────────

type CustomValidator = (sql: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;

/** Resolve the database connection for a query. Returns the connection and dbType, or an error response. */
function resolveConnection(
  connId: string,
  orgId: string | undefined,
): { ok: true; db: DBConnection; dbType: DBType } | { ok: false; error: { success: false; error: string } } {
  try {
    let db: DBConnection;
    if (orgId) {
      db = connections.getForOrg(orgId, connId);
    } else if (connId === "default") {
      db = connections.getDefault();
    } else {
      db = connections.get(connId);
    }
    const dbType = connections.getDBType(connId);
    return { ok: true, db, dbType };
  } catch (err) {
    if (err instanceof ConnectionNotRegisteredError) {
      return { ok: false, error: { success: false, error: `Connection "${connId}" is not registered. Available: ${connections.list().join(", ") || "(none)"}` } };
    }
    if (err instanceof NoDatasourceConfiguredError) {
      return { ok: false, error: { success: false, error: err.message } };
    }
    if (err instanceof PoolCapacityExceededError) {
      log.warn({ connectionId: connId, orgId }, "Org pool capacity exceeded");
      return { ok: false, error: { success: false, error: "Connection pool capacity reached — the system is handling many concurrent tenants. Try again shortly." } };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, connectionId: connId }, "Unexpected error during connection lookup");
    return { ok: false, error: { success: false, error: `Connection "${connId}" failed to initialize: ${message}` } };
  }
}

/**
 * Run query validation using either a custom validator or standard SQL validation.
 * Does not write audit log entries — the caller is responsible for audit logging on failure.
 * `auditError` preserves the specific error detail for audit logs (e.g., original exception message).
 */
async function runQueryValidation(
  sql: string,
  connId: string,
  dbType: DBType | string,
  customValidator: CustomValidator | undefined,
): Promise<{ ok: true; classification?: SQLClassification } | { ok: false; error: string; auditError: string }> {
  if (customValidator) {
    let result: { valid: boolean; reason?: string };
    try {
      result = await customValidator(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, connectionId: connId, sql: sql.slice(0, 200) }, "Custom validator threw an exception");
      return {
        ok: false,
        error: `Query validation failed for connection "${connId}": internal validator error`,
        auditError: `Custom validator error: ${message}`,
      };
    }
    if (typeof result?.valid !== "boolean") {
      log.error({ connectionId: connId, returnValue: result }, "Custom validator returned invalid shape");
      return {
        ok: false,
        error: `Query validation misconfigured for connection "${connId}"`,
        auditError: "Custom validator returned invalid result",
      };
    }
    if (!result.valid) {
      const reason = result.reason ?? "Query rejected by custom validator";
      return { ok: false, error: reason, auditError: `Validation rejected: ${reason}` };
    }
    return { ok: true };
  }

  const validation = validateSQL(sql, connId);
  if (!validation.valid) {
    return { ok: false, error: validation.error, auditError: `Validation rejected: ${validation.error}` };
  }
  return { ok: true, classification: validation.classification };
}

/**
 * Apply RLS conditions to a query. Returns the modified SQL or an error.
 * Handles table extraction, filter resolution, and condition injection.
 * Unlike runQueryValidation, this function logs audit entries on failure paths.
 */
function applyRLSToQuery(
  sql: string,
  connId: string,
  dbType: DBType | string,
  targetHost: string | undefined,
): { ok: true; sql: string } | { ok: false; error: string } {
  const config = getConfig();
  const rlsConfig = config?.rls;
  if (!rlsConfig?.enabled) return { ok: true, sql };

  const ctx = getRequestContext();
  const user = ctx?.user;

  // Extract tables from the (possibly plugin-mutated) SQL
  let queriedTables: Set<string>;
  try {
    const dialect = parserDatabase(dbType, connId);
    const tableRefs = parser.tableList(sql, { database: dialect });
    queriedTables = new Set(
      tableRefs
        .map((ref) => {
          const parts = ref.split("::");
          return parts.pop()?.toLowerCase() ?? "";
        })
        .filter(Boolean),
    );
  } catch (tableErr) {
    const tableErrMsg = tableErr instanceof Error ? tableErr.message : String(tableErr);
    log.error({ err: tableErr, sql: sql.slice(0, 200) }, "RLS: failed to extract table list from query");
    logQueryAudit({
      sql: sql.slice(0, 2000),
      durationMs: 0,
      rowCount: null,
      success: false,
      error: `RLS: could not extract tables from query: ${tableErrMsg}`,
      sourceId: connId,
      sourceType: dbType,
      targetHost,
    });
    return { ok: false, error: "Query could not be analyzed for row-level security. Rewrite using standard SQL." };
  }

  const filterResult = resolveRLSFilters(user, queriedTables, rlsConfig);
  if ("error" in filterResult) {
    log.warn({ error: filterResult.error, userId: user?.id }, "RLS filter resolution failed — query blocked");
    logQueryAudit({
      sql: sql.slice(0, 2000),
      durationMs: 0,
      rowCount: null,
      success: false,
      error: `RLS blocked: ${filterResult.error}`,
      sourceId: connId,
      sourceType: dbType,
      targetHost,
    });
    return { ok: false, error: filterResult.error };
  }

  const hasFilters = filterResult.groups.some((g: RLSFilterGroup) => g.filters.length > 0);
  if (hasFilters) {
    try {
      const injected = injectRLSConditions(sql, filterResult.groups, filterResult.combineWith, dbType);
      log.debug(
        { groups: filterResult.groups.length, combineWith: filterResult.combineWith, userId: user?.id },
        "RLS conditions injected",
      );
      return { ok: true, sql: injected };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, userId: user?.id }, "RLS injection failed — query blocked");
      logQueryAudit({
        sql: sql.slice(0, 2000),
        durationMs: 0,
        rowCount: null,
        success: false,
        error: `RLS injection failed: ${msg}`,
        sourceId: connId,
        sourceType: dbType,
        targetHost,
      });
      return { ok: false, error: "Query could not be processed for row-level security." };
    }
  }

  return { ok: true, sql };
}

/**
 * Execute a validated query with tracing, cache write, audit logging, plugin hooks,
 * and error filtering. Releases the concurrency slot (decrementSourceConcurrency)
 * in its finally block — callers must not release it separately.
 * SQL content is NOT included in span attributes for security.
 */
async function executeAndAudit(opts: {
  db: DBConnection;
  dbType: DBType;
  connId: string;
  orgId: string | undefined;
  targetHost: string | undefined;
  querySql: string;
  queryTimeout: number;
  rowLimit: number;
  explanation: string;
  classification: SQLClassification | undefined;
  cacheKey: string | null;
  hookMetadata: Record<string, unknown>;
  dispatchHook: (event: "afterQuery", ctx: Record<string, unknown>) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { db, dbType, connId, orgId, targetHost, querySql, queryTimeout, rowLimit, explanation, classification, cacheKey, hookMetadata, dispatchHook } = opts;

  const start = performance.now();
  try {
    const result = await withSpan(
      "atlas.sql.execute",
      {
        "db.system": dbType,
        "atlas.connection_id": connId,
      },
      () => db.query(querySql, queryTimeout),
      (r) => ({
        "atlas.row_count": r.rows.length,
        "atlas.column_count": r.columns.length,
      }),
    );
    const durationMs = Math.round(performance.now() - start);
    const truncated = result.rows.length >= rowLimit;

    connections.recordQuery(connId, durationMs, orgId);
    connections.recordSuccess(connId, orgId);

    // Store in cache on success — fail open if cache backend is broken
    if (cacheKey) {
      try {
        getCache().set(cacheKey, {
          columns: result.columns,
          rows: result.rows,
          cachedAt: Date.now(),
          ttl: getDefaultTtl(),
        });
      } catch (cacheErr) {
        log.error({ err: cacheErr, connectionId: connId }, "Cache write failed — result not cached");
      }
    }

    try {
      logQueryAudit({
        sql: querySql,
        durationMs,
        rowCount: result.rows.length,
        success: true,
        sourceId: connId,
        sourceType: dbType,
        targetHost,
        tablesAccessed: classification?.tablesAccessed,
        columnsAccessed: classification?.columnsAccessed,
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

    const hasHookMeta = Object.keys(hookMetadata).length > 0;
    return {
      success: true,
      explanation,
      row_count: result.rows.length,
      columns: result.columns,
      rows: result.rows,
      truncated,
      cached: false,
      ...(hasHookMeta && { metadata: hookMetadata }),
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const message =
      err instanceof Error ? err.message : "Unknown database error";

    connections.recordQuery(connId, durationMs, orgId);
    connections.recordError(connId, orgId);

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
        tablesAccessed: classification?.tablesAccessed,
        columnsAccessed: classification?.columnsAccessed,
      });
    } catch (auditErr) {
      log.warn({ err: auditErr }, "Failed to write query audit log");
    }

    // Block errors that might expose connection details or internal state
    if (SENSITIVE_PATTERNS.test(message)) {
      return { success: false, error: "Database query failed — check server logs for details." };
    }

    // Surface the full DB error to the agent for self-correction
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
}

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

    // Resolve org context for tenant-scoped pool isolation.
    // Only active when pool.perOrg is explicitly configured in atlas.config.ts.
    const reqCtx = getRequestContext();
    const orgId = connections.isOrgPoolingEnabled()
      ? reqCtx?.user?.activeOrganizationId
      : undefined;

    // Validate connection exists before proceeding.
    const resolved = resolveConnection(connId, orgId);
    if (!resolved.ok) return resolved.error;
    const { db, dbType } = resolved;

    const targetHost = connections.getTargetHost(connId);

    // Check for a custom validator (non-SQL datasource plugins like SOQL, GraphQL).
    // When present, it completely replaces the standard SQL validation pipeline.
    // If absent, validateSQL is used instead — validators are mutually exclusive.
    const customValidator = connections.getValidator(connId);
    const normalizedSql = sql.trim().replace(/;\s*$/, "").trimEnd();

    // Run initial validation (custom validator or standard SQL validation)
    const initial = await runQueryValidation(normalizedSql, connId, dbType, customValidator);
    if (!initial.ok) {
      logQueryAudit({
        sql: normalizedSql.slice(0, 2000),
        durationMs: 0,
        rowCount: null,
        success: false,
        error: initial.auditError,
        sourceId: connId,
        sourceType: dbType,
      });
      return { success: false, error: initial.error };
    }
    // Classification is only populated for standard SQL (validateSQL path).
    // Custom validators (SOQL, GraphQL) bypass node-sql-parser so classification
    // stays undefined — their audit entries store NULL for tables/columns_accessed.
    const classification = initial.classification;

    // Check cache before acquiring a concurrency slot — cache hits need no DB connection.
    // Wrapped in try-catch so a broken cache backend (plugin Redis down) fails open.
    let cacheKey: string | null = null;
    if (cacheEnabled()) {
      try {
        const ctx = getRequestContext();
        const cacheOrgId = ctx?.user?.activeOrganizationId;
        const claims = ctx?.user?.claims;
        cacheKey = buildCacheKey(normalizedSql, connId, cacheOrgId, claims);
        const cached = getCache().get(cacheKey);
        if (cached) {
          logQueryAudit({
            sql: normalizedSql.slice(0, 2000),
            durationMs: 0,
            rowCount: cached.rows.length,
            success: true,
            sourceId: connId,
            sourceType: dbType,
            targetHost,
          });
          return {
            success: true,
            explanation,
            row_count: cached.rows.length,
            columns: cached.columns,
            rows: cached.rows,
            truncated: cached.rows.length >= getRowLimit(),
            cached: true,
          };
        }
      } catch (cacheErr) {
        log.error({ err: cacheErr, connectionId: connId }, "Cache read failed — executing query against database");
        cacheKey = null;
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
    const hookMetadata: Record<string, unknown> = {};
    let mutatedSql: string;
    try {
      const hookCtx = { sql, connectionId: connId, metadata: hookMetadata };
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
      const revalidation = await runQueryValidation(normalizedMutated, connId, dbType, customValidator);
      if (!revalidation.ok) {
        decrementSourceConcurrency(connId);
        logQueryAudit({
          sql: normalizedMutated.slice(0, 2000),
          durationMs: 0,
          rowCount: null,
          success: false,
          error: `Plugin-rewritten SQL failed validation: ${revalidation.auditError}`,
          sourceId: connId,
          sourceType: dbType,
          targetHost,
        });
        return { success: false, error: `Plugin-rewritten SQL failed validation: ${revalidation.error}` };
      }
    }

    // --- RLS: inject WHERE conditions based on user claims ---
    // Applied after validation + plugin hooks so plugins cannot strip RLS.
    // Skipped for custom validators (non-SQL languages like SOQL).
    if (!customValidator) {
      const rlsResult = applyRLSToQuery(normalizedMutated, connId, dbType, targetHost);
      if (!rlsResult.ok) {
        decrementSourceConcurrency(connId);
        return { success: false, error: rlsResult.error };
      }
      normalizedMutated = rlsResult.sql;
    }

    // Read limits per-query so admin changes take effect immediately.
    const rowLimit = getRowLimit();
    const queryTimeout = getQueryTimeout();

    // Auto-append LIMIT if not present.
    // Custom validators are responsible for their own pagination — non-SQL
    // languages (SOQL, GraphQL) may not support the LIMIT keyword.
    let querySql = normalizedMutated;
    if (!customValidator && !/\bLIMIT\b/i.test(querySql)) {
      querySql += ` LIMIT ${rowLimit}`;
    }

    // Execute the query and handle results/errors
    return executeAndAudit({
      db, dbType, connId, orgId, targetHost, querySql, queryTimeout,
      rowLimit, explanation, classification, cacheKey: cacheKey ?? null,
      hookMetadata, dispatchHook,
    });
  },
});
