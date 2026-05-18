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
import { Effect } from "effect";
import { Parser } from "node-sql-parser";
import { connections, detectDBType, getRegionAwareConnection, isConnectionVisibleInMode, ConnectionNotRegisteredError, NoDatasourceConfiguredError, PoolCapacityExceededError } from "@atlas/api/lib/db/connection";
import type { DBConnection, DBType } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables, loadOrgWhitelist } from "@atlas/api/lib/semantic";
import { logQueryAudit } from "@atlas/api/lib/auth/audit";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { withSpan } from "@atlas/api/lib/tracing";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { withSourceSlot } from "@atlas/api/lib/db/source-rate-limit";
import { getConfig } from "@atlas/api/lib/config";
import { resolveRLSFilters, injectRLSConditions, type RLSFilterGroup } from "@atlas/api/lib/rls";
import { getSetting, getSettingAuto } from "@atlas/api/lib/settings";
import { getCache, buildCacheKey, cacheEnabled, getDefaultTtl } from "@atlas/api/lib/cache/index";
import { proposePatternIfNovel } from "@atlas/api/lib/learn/pattern-proposer";
import {
  ConnectionNotFoundError, PoolExhaustedError, NoDatasourceError,
  QueryExecutionError, RateLimitExceededError, ConcurrencyLimitError,
  RLSError, PluginRejectedError,
} from "@atlas/api/lib/effect/errors";
import { EXECUTE_SQL_TOOL_DESCRIPTION } from "./descriptions";
import { resolveRoutingPlan, type RoutingMode, type RoutingReason } from "@atlas/api/lib/env-routing";
import { loadGroupRoutingContext } from "@atlas/api/lib/env-routing/lookup";
import { mergeMemberResults } from "@atlas/api/lib/multi-env-merger";
import {
  ApprovalGate,
  MaskingPolicy,
  type ApprovalGateShape,
  type MaskingContext,
} from "@atlas/api/lib/effect/services";
import { EnterpriseLayer } from "@atlas/api/lib/effect/enterprise-layer";

/**
 * Run `MaskingPolicy.applyMasking` via `EnterpriseLayer`. Promise-shaped
 * wrapper so the two sql.ts call sites (live + cache path) can keep
 * their existing async/await structure without restructuring around
 * `Effect.gen` (#2566 — slice 4/11 of #2017). Fails open: any error in
 * the program is rethrown to the caller's existing try/catch, which
 * already logs `"PII masking failed — returning unmasked results"`.
 */
function applyMaskingViaTag(
  ctx: MaskingContext,
): Promise<Record<string, unknown>[]> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const masking = yield* MaskingPolicy;
      return yield* masking.applyMasking(ctx);
    }).pipe(Effect.provide(EnterpriseLayer)),
  );
}

/**
 * Resolve the `ApprovalGate` Tag against `EnterpriseLayer`. Each sql.ts
 * approval call site (live path + cache path) reads three methods on
 * the gate (`checkApprovalRequired` → `hasApprovedRequest` →
 * `createApprovalRequest`); resolving the shape once + reading methods
 * keeps the existing try/catch fail-closed semantics intact and avoids
 * paying for three separate `Effect.runPromise` round-trips (#2567).
 */
function loadApprovalGate(): Promise<ApprovalGateShape> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ApprovalGate;
    }).pipe(Effect.provide(EnterpriseLayer)),
  );
}

const log = createLogger("sql");

let whitelistWarned = false;
function warnWhitelistDisabled() {
  if (!whitelistWarned) {
    log.warn("SQL table whitelist is disabled — all tables are queryable");
    whitelistWarned = true;
  }
}

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

// Unwrap MySQL version-gated executable comments. F-17: MySQL treats
// `/*!NNNNN body */` (and the MariaDB `/*! body */` form with no version) as
// live SQL whenever the server version is ≥ NNNNN. node-sql-parser treats the
// whole block as an ordinary comment, hiding the payload from the AST parser
// and the table whitelist — so an attacker could smuggle
// `/*!50000 UNION SELECT ... FROM mysql.user */` past every validation layer.
//
// Fix (Option A): in MySQL mode, replace the executable-comment wrapper with
// its body so downstream layers see the SQL MySQL will actually execute.
// String-literal alternation prevents the regex from firing on the token
// inside a quoted string. The loop runs until stable so stacked wrappers
// (nested `/*!NNNNN ... */` pairs) peel in both levels.
//
// Unclosed forms (no closing `*/`) are left intact — the regex guard still
// sees the literal DML keyword after `stripSqlComments` refuses to strip
// an unclosed block, so mutation detection still fires.
//
// Gated on `dbType === "mysql"` at the call site — other dialects (PG and
// any plugin-registered dialect) skip this step and treat `/*!...*/` as an
// ordinary block comment.
function unwrapMysqlExecutableComments(sql: string): string {
  let current = sql;
  let prev: string;
  do {
    prev = current;
    current = current.replace(
      /'(?:[^']|'')*'|\/\*!(?:\d{0,5})([\s\S]*?)\*\//g,
      (match, body) => (match.startsWith("'") ? match : ` ${body ?? ""} `),
    );
  } while (current !== prev);
  return current;
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
  // Both MySQL filesystem-writing variants must be enumerated: OUTFILE
  // (formatted rows) and DUMPFILE (single binary blob). Same FILE privilege
  // required, same attack class — a regex that lists only one is a gap (F-19).
  /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,
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

export async function validateSQL(sql: string, connectionId?: string): Promise<SQLValidationResult> {
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
  let trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) {
    return { valid: false, error: "Empty query" };
  }

  // F-17: In MySQL mode, unwrap /*!NNNNN ... */ executable comments so all
  // downstream layers see the SQL MySQL will actually execute. PG has no
  // equivalent syntax; leave its queries untouched.
  if (dbType === "mysql") {
    const preUnwrap = trimmed;
    trimmed = unwrapMysqlExecutableComments(trimmed);
    if (!trimmed.trim()) {
      if (preUnwrap !== trimmed) {
        // Input collapsed to whitespace only AFTER executable-comment unwrap —
        // the caller sent something whose only non-empty content lived inside
        // a `/*!NNNNN ... */` wrapper. Benign on its own (we reject as "Empty
        // query"), but the shape is a probe signature worth surfacing to
        // security telemetry.
        log.warn(
          { connectionId, sqlPrefix: preUnwrap.slice(0, 200) },
          "F-17 guard: MySQL query collapsed to empty after executable-comment unwrap — possible probe",
        );
      }
      return { valid: false, error: "Empty query" };
    }
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
      // F-18: reject `SELECT ... INTO <table>` (PG creates a new table).
      // node-sql-parser surfaces these as `stmt.into.type === "into"`; plain
      // SELECTs come back with `stmt.into = { position: null }` and no `type`.
      // MySQL `SELECT ... INTO @var` uses `keyword === "var"` (session-local
      // variable assignment) — explicitly allowed.
      //
      // MySQL `INTO OUTFILE|DUMPFILE` is already rejected upstream by the
      // F-19 `FORBIDDEN_PATTERNS` regex; this guard is the AST-level safety
      // net if that regex is ever loosened or a new filesystem-write syntax
      // is added that the regex misses.
      const into = (stmt as { into?: { type?: string; keyword?: string | null } }).into;
      if (into?.type === "into" && into.keyword !== "var") {
        return {
          valid: false,
          error: "SELECT ... INTO is a forbidden operation — only plain read-only SELECT is allowed.",
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

  // 3. Table whitelist check — use getSettingAuto for SaaS hot-reload
  const whitelistSetting = getSettingAuto("ATLAS_TABLE_WHITELIST") ?? process.env.ATLAS_TABLE_WHITELIST;
  if (whitelistSetting === "false") {
    warnWhitelistDisabled();
  } else {
    try {
      const tables = parser.tableList(trimmed, { database: parserDatabase(dbType, connectionId) });
      const sqlReqCtx = getRequestContext();
      const orgId = sqlReqCtx?.user?.activeOrganizationId;
      // Lazy-load the per-org whitelist into the in-process cache.
      // The chat path (`agent.ts:570`) explicitly preloads this before
      // dispatching the agent loop. The MCP edge does NOT — every
      // executeSQL call from Claude Desktop / Cursor was hitting an
      // empty whitelist and rejecting every table with `unknown_entity`
      // regardless of what `listEntities` reported. The fix is to
      // ensure the whitelist is loaded HERE so every code path that
      // reaches SQL validation gets the same answer, instead of
      // relying on each entry-point caller to remember the preload.
      // `loadOrgWhitelist` is cache-guarded — the second call onward
      // is O(1).
      if (orgId) {
        await loadOrgWhitelist(orgId, sqlReqCtx?.atlasMode);
      }
      const allowed = orgId
        ? getOrgWhitelistedTables(orgId, connectionId, sqlReqCtx?.atlasMode)
        : getWhitelistedTables(connectionId);

      // Self-hosted reads its whitelist from on-disk `catalog.yml` / entity
      // YAML files; SaaS workspaces read from the per-org `entities` table
      // managed via the admin UI. Pointing a SaaS user at `catalog.yml` is
      // a dead end — there is no such file in the deployed image.
      const guidance = orgId
        ? "Open admin → Semantic to add this table."
        : "Check catalog.yml for available tables.";

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
              error: `Table "${qualifiedName}" is not in the allowed list. ${guidance}`,
            };
          }
        } else {
          // No schema — allow unqualified match
          if (!allowed.has(tableName)) {
            return {
              valid: false,
              error: `Table "${tableName}" is not in the allowed list. ${guidance}`,
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

// ── Effect Pipeline ──────────────────────────────────────────────────

type CustomValidator = (sql: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;

/** Union of all errors the pipeline can produce in the error channel. */
type PipelineError =
  | ConnectionNotFoundError
  | PoolExhaustedError
  | NoDatasourceError
  | RateLimitExceededError
  | ConcurrencyLimitError
  | RLSError
  | PluginRejectedError
  | QueryExecutionError;

/** Resolve the database connection. Fails with tagged connection errors. */
function resolveConnectionEffect(
  connId: string,
  /** Org ID used for pool routing — gated on `isOrgPoolingEnabled()` in SaaS. */
  orgId: string | undefined,
  atlasMode: import("@useatlas/types/auth").AtlasMode,
  /** Org ID from auth context — undefined in unauthenticated self-hosted mode. Used for mode visibility. */
  authOrgId: string | undefined,
): Effect.Effect<
  { db: DBConnection; dbType: DBType },
  ConnectionNotFoundError | PoolExhaustedError | NoDatasourceError
> {
  // Sentinel thrown by the mode-visibility gate so the catch arm can return an
  // error without leaking the full registered-connection list — in published
  // mode that list includes draft connections the user must not know about.
  class ModeGateRejection extends Error {
    readonly connectionId: string;
    constructor(connectionId: string) {
      super(`Connection "${connectionId}" is not available in ${atlasMode} mode.`);
      this.connectionId = connectionId;
    }
  }

  return Effect.tryPromise({
    try: async () => {
      // Mode isolation: published-mode requests may only resolve published
      // connections; developer-mode may also resolve drafts; archived is
      // hidden in both. `default` bypasses the check (config-managed, no DB
      // row). Uses authOrgId — pool-level org isolation is a separate concern
      // and may be disabled, but mode visibility still applies.
      if (authOrgId) {
        const visible = await isConnectionVisibleInMode(authOrgId, connId, atlasMode);
        if (!visible) {
          throw new ModeGateRejection(connId);
        }
      }

      let db: DBConnection;
      let resolvedConnId = connId;
      if (orgId) {
        const result = await getRegionAwareConnection(orgId, connId);
        db = result.db;
        resolvedConnId = result.resolvedConnId;
      } else if (connId === "default") {
        db = connections.getDefault();
      } else {
        db = connections.get(connId);
      }
      const dbType = connections.getDBType(resolvedConnId);
      return { db, dbType };
    },
    catch: (err) => {
      // Zero-knowledge guarantee: when a caller has an org/mode context, the
      // list of registered connections must never be surfaced — the registry
      // is populated from every org's DB rows on boot, so exposing it would
      // leak draft IDs across orgs and modes. Self-hosted callers without an
      // org context still get the debug list.
      const availableList = authOrgId ? [] : connections.list();
      const availableSuffix = availableList.length > 0 ? availableList.join(", ") : "(none)";

      if (err instanceof ModeGateRejection) {
        return new ConnectionNotFoundError({
          message: err.message,
          connectionId: connId,
          available: availableList,
        });
      }
      if (err instanceof ConnectionNotRegisteredError) {
        return new ConnectionNotFoundError({
          message: authOrgId
            ? `Connection "${connId}" is not registered.`
            : `Connection "${connId}" is not registered. Available: ${availableSuffix}`,
          connectionId: connId,
          available: availableList,
        });
      }
      if (err instanceof NoDatasourceConfiguredError) {
        return new NoDatasourceError({ message: (err as Error).message });
      }
      if (err instanceof PoolCapacityExceededError) {
        log.warn({ connectionId: connId, orgId }, "Org pool capacity exceeded");
        return new PoolExhaustedError({
          message: "Connection pool capacity reached — the system is handling many concurrent tenants. Try again shortly.",
          current: err.currentSlots,
          max: err.maxTotalConnections,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, connectionId: connId }, "Unexpected error during connection lookup");
      return new ConnectionNotFoundError({
        message: `Connection "${connId}" failed to initialize: ${message}`,
        connectionId: connId,
        available: availableList,
      });
    },
  });
}

/**
 * Run query validation (custom validator or standard SQL).
 * Returns a result object — validation rejection is a normal outcome, not an error channel event.
 * `auditError` preserves specific error detail for audit logs.
 */
function runQueryValidationEffect(
  sql: string,
  connId: string,
  dbType: DBType | string,
  customValidator: CustomValidator | undefined,
): Effect.Effect<{ ok: true; classification?: SQLClassification } | { ok: false; error: string; auditError: string }> {
  if (!customValidator) {
    return Effect.promise(async () => {
      const validation = await validateSQL(sql, connId);
      if (!validation.valid) {
        return { ok: false as const, error: validation.error, auditError: `Validation rejected: ${validation.error}` };
      }
      return { ok: true as const, classification: validation.classification };
    });
  }

  // Custom validator (async) — errors are caught and returned as result values, not thrown
  return Effect.promise(async () => {
    let result: { valid: boolean; reason?: string };
    try {
      result = await customValidator(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, connectionId: connId, sql: sql.slice(0, 200) }, "Custom validator threw an exception");
      return { ok: false as const, error: `Query validation failed for connection "${connId}": internal validator error`, auditError: `Custom validator error: ${message}` };
    }
    if (typeof result?.valid !== "boolean") {
      log.error({ connectionId: connId, returnValue: result }, "Custom validator returned invalid shape");
      return { ok: false as const, error: `Query validation misconfigured for connection "${connId}"`, auditError: "Custom validator returned invalid result" };
    }
    if (!result.valid) {
      const reason = result.reason ?? "Query rejected by custom validator";
      return { ok: false as const, error: reason, auditError: `Validation rejected: ${reason}` };
    }
    return { ok: true as const, classification: undefined as SQLClassification | undefined };
  });
}

/** Apply RLS conditions. Returns the (possibly modified) SQL. Fails with RLSError. */
function applyRLSEffect(
  sql: string,
  connId: string,
  dbType: DBType | string,
  targetHost: string | undefined,
): Effect.Effect<string, RLSError> {
  return Effect.gen(function* () {
    const config = getConfig();
    let rlsConfig = config?.rls;

    // In SaaS mode only, overlay settings-based RLS config for hot-reload.
    // Only activates when there is a DB override for ATLAS_RLS_ENABLED — env
    // vars and defaults are handled by the boot-time config and don't trigger
    // the overlay, preserving multi-policy configs from atlas.config.ts.
    if (config?.deployMode === "saas") {
      const rlsEnabledSetting = getSettingAuto("ATLAS_RLS_ENABLED");
      if (rlsEnabledSetting !== undefined) {
        if (rlsEnabledSetting !== "true") {
          // Explicitly disabled via settings — skip RLS
          return sql;
        }
        // Setting says enabled — build/overlay config from settings
        const column = getSettingAuto("ATLAS_RLS_COLUMN");
        const claim = getSettingAuto("ATLAS_RLS_CLAIM");
        if (column && claim) {
          rlsConfig = {
            enabled: true,
            policies: [{ tables: ["*"], column, claim }],
            combineWith: rlsConfig?.combineWith ?? "and",
          };
        } else {
          // RLS enabled but missing required config — fail closed
          log.error(
            { column: !!column, claim: !!claim },
            "RLS enabled via settings but ATLAS_RLS_COLUMN or ATLAS_RLS_CLAIM is missing — blocking query",
          );
          return yield* new RLSError({
            message: "Row-level security is enabled but not fully configured. Contact your administrator.",
            phase: "filter",
          });
        }
      }
    }

    if (!rlsConfig?.enabled) return sql;

    const ctx = getRequestContext();
    const user = ctx?.user;

    // Extract tables
    const queriedTables = yield* Effect.try({
      try: () => {
        const dialect = parserDatabase(dbType, connId);
        const tableRefs = parser.tableList(sql, { database: dialect });
        return new Set(
          tableRefs
            .map((ref) => {
              const parts = ref.split("::");
              return parts.pop()?.toLowerCase() ?? "";
            })
            .filter(Boolean),
        );
      },
      catch: (tableErr) => {
        const tableErrMsg = tableErr instanceof Error ? tableErr.message : String(tableErr);
        log.error({ err: tableErr, sql: sql.slice(0, 200) }, "RLS: failed to extract table list from query");
        logQueryAudit({
          sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
          error: `RLS: could not extract tables from query: ${tableErrMsg}`,
          sourceId: connId, sourceType: dbType, targetHost,
        });
        return new RLSError({
          message: "Query could not be analyzed for row-level security. Rewrite using standard SQL.",
          phase: "extraction",
        });
      },
    });

    // Resolve filters
    const filterResult = resolveRLSFilters(user, queriedTables, rlsConfig);
    if ("error" in filterResult) {
      log.warn({ error: filterResult.error, userId: user?.id }, "RLS filter resolution failed — query blocked");
      logQueryAudit({
        sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
        error: `RLS blocked: ${filterResult.error}`,
        sourceId: connId, sourceType: dbType, targetHost,
      });
      return yield* new RLSError({ message: filterResult.error, phase: "filter" });
    }

    // Inject conditions
    const hasFilters = filterResult.groups.some((g: RLSFilterGroup) => g.filters.length > 0);
    if (hasFilters) {
      const injected = yield* Effect.try({
        try: () => injectRLSConditions(sql, filterResult.groups, filterResult.combineWith, dbType),
        catch: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err, userId: user?.id }, "RLS injection failed — query blocked");
          logQueryAudit({
            sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
            error: `RLS injection failed: ${msg}`,
            sourceId: connId, sourceType: dbType, targetHost,
          });
          return new RLSError({ message: "Query could not be processed for row-level security.", phase: "injection" });
        },
      });
      log.debug(
        { groups: filterResult.groups.length, combineWith: filterResult.combineWith, userId: user?.id },
        "RLS conditions injected",
      );
      return injected;
    }

    return sql;
  });
}

/**
 * Build the OTel attribute set for the `atlas.sql.execute` span.
 *
 * Exported for unit testing: capturing live spans requires wiring an
 * `InMemorySpanExporter` into the global tracer provider, which is
 * heavier than the value of catching a typo in the attribute keys. The
 * pure builder is the load-bearing piece — the tracing glue around it
 * is exercised by the cross-env routing integration test.
 *
 * Always emits:
 *   - `db.system` — the underlying DB driver type.
 *   - `atlas.connection_id` — which member ran the query.
 *   - `atlas.routing_mode` — `auto` | `pin` | `all` (defaults to `auto`).
 *
 * Conditionally emits:
 *   - `atlas.connection_group_id` when the caller passed one (typically
 *     the fanout path, where the group lookup already resolved the id).
 *   - `atlas.routing_reason` when the caller threaded the planner's
 *     `RoutingReason` discriminator (single-env back-compat callers
 *     don't have one). Lets observers attribute fanout vs single-env
 *     decisions without joining audit rows.
 */
export function buildSqlExecuteSpanAttrs(opts: {
  dbType: string;
  connectionId: string;
  routingMode?: RoutingMode;
  connectionGroupId?: string;
  routingReason?: RoutingReason;
}): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "db.system": opts.dbType,
    "atlas.connection_id": opts.connectionId,
    "atlas.routing_mode": opts.routingMode ?? "auto",
  };
  if (opts.connectionGroupId) {
    attrs["atlas.connection_group_id"] = opts.connectionGroupId;
  }
  if (opts.routingReason) {
    attrs["atlas.routing_reason"] = opts.routingReason;
  }
  return attrs;
}

function executeAndAuditEffect(opts: {
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
  /** Parent audit row id when this execution is one leg of a fanout. */
  parentAuditId?: string;
  /** Routing mode for the parent `executeSQL` call. Stamped on the OTel span. */
  routingMode?: RoutingMode;
  /** Connection group id (for the OTel `atlas.connection_group_id` attribute). */
  connectionGroupId?: string;
  /** Planner reason that picked this connection (for the OTel `atlas.routing_reason` attribute). */
  routingReason?: RoutingReason;
}): Effect.Effect<Record<string, unknown>, QueryExecutionError> {
  const {
    db, dbType, connId, orgId, targetHost, querySql, queryTimeout,
    rowLimit, explanation, classification, cacheKey, hookMetadata, dispatchHook,
    parentAuditId, routingMode, connectionGroupId, routingReason,
  } = opts;

  const start = performance.now();

  // Per #2519: every executeSQL span (single + fanout legs) carries
  // `atlas.routing_mode` and (when known) `atlas.connection_group_id`
  // so traces can attribute fanout behavior without joining audit rows.
  const spanAttrs = buildSqlExecuteSpanAttrs({
    dbType,
    connectionId: connId,
    routingMode,
    connectionGroupId,
    routingReason,
  });

  return Effect.tryPromise({
    try: () =>
      withSpan(
        "atlas.sql.execute",
        spanAttrs,
        () => db.query(querySql, queryTimeout),
        (r) => ({ "atlas.row_count": r.rows.length, "atlas.column_count": r.columns.length }),
      ),
    catch: (err) => {
      const durationMs = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : "Unknown database error";

      connections.recordQuery(connId, durationMs, orgId);
      connections.recordError(connId, orgId);

      // SLA metric (fire-and-forget, enterprise feature)
      if (orgId) {
        Promise.all([import("@atlas/ee/sla/index"), import("effect")])
          .then(([{ recordQueryMetric }, { Effect: E }]) => E.runPromise(recordQueryMetric(orgId, durationMs, true)))
          .catch((slaErr) => {
            // Dynamic import failure = ee not installed (expected in non-enterprise).
            // Runtime error from recordQueryMetric = log warning for diagnostics.
            if (slaErr instanceof Error && !slaErr.message.includes("Cannot find module")) {
              log.warn({ err: slaErr.message, connectionId: connId }, "SLA metric recording failed");
            }
          });
      }

      try {
        logQueryAudit({
          sql: querySql, durationMs, rowCount: null, success: false, error: message,
          sourceId: connId, sourceType: dbType, targetHost,
          tablesAccessed: classification?.tablesAccessed,
          columnsAccessed: classification?.columnsAccessed,
          parentAuditId,
        });
      } catch (auditErr) {
        log.warn(
          { err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
          "Failed to write query audit log",
        );
      }

      // Filter sensitive errors before returning to the agent
      if (SENSITIVE_PATTERNS.test(message)) {
        return new QueryExecutionError({ message: "Database query failed — check server logs for details." });
      }
      const dbErr = err as { hint?: string; position?: string };
      let detail = message;
      if (dbErr.hint) detail += ` — Hint: ${dbErr.hint}`;
      if (dbErr.position) detail += ` (at character ${dbErr.position})`;
      return new QueryExecutionError({ message: detail, hint: dbErr.hint, position: dbErr.position });
    },
  }).pipe(
    // Success path: metrics, cache, audit, hooks, masking
    Effect.flatMap((result) =>
      Effect.tryPromise({
        try: async () => {
          const durationMs = Math.round(performance.now() - start);
          const truncated = result.rows.length >= rowLimit;

          connections.recordQuery(connId, durationMs, orgId);
          connections.recordSuccess(connId, orgId);

          // SLA metric (fire-and-forget, enterprise feature)
          if (orgId) {
            try {
              const { recordQueryMetric } = await import("@atlas/ee/sla/index");
              const { Effect: E } = await import("effect");
              void E.runPromise(recordQueryMetric(orgId, durationMs, false));
            } catch (err) {
              // Dynamic import failure = ee not installed (expected in non-enterprise).
              // Runtime error from recordQueryMetric = log warning for diagnostics.
              if (err instanceof Error && !err.message.includes("Cannot find module")) {
                log.warn({ err: err.message, connectionId: connId }, "SLA metric recording failed");
              }
            }
          }

          // Cache write (fail open)
          if (cacheKey) {
            try {
              getCache().set(cacheKey, {
                columns: result.columns, rows: result.rows,
                cachedAt: Date.now(), ttl: getDefaultTtl(),
              });
            } catch (cacheErr) {
              log.error({ err: cacheErr, connectionId: connId }, "Cache write failed — result not cached");
            }
          }

          try {
            logQueryAudit({
              sql: querySql, durationMs, rowCount: result.rows.length, success: true,
              sourceId: connId, sourceType: dbType, targetHost,
              tablesAccessed: classification?.tablesAccessed,
              columnsAccessed: classification?.columnsAccessed,
              parentAuditId,
            });
          } catch (auditErr) {
            log.warn(
              { err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
              "Failed to write query audit log",
            );
          }

          try {
            await dispatchHook("afterQuery", {
              sql: querySql, connectionId: connId,
              result: { columns: result.columns, rows: result.rows },
              durationMs,
            });
          } catch (hookErr) {
            log.warn(
              { err: hookErr instanceof Error ? hookErr.message : String(hookErr), connectionId: connId },
              "afterQuery hook failed — query result unaffected",
            );
          }

          // Pattern learning (fire-and-forget)
          proposePatternIfNovel({
            sql: querySql, dialect: parserDatabase(dbType, connId), connectionId: connId,
          });

          // PII masking (fails open) — via `MaskingPolicy` Tag (#2566)
          let maskedRows = result.rows;
          let maskingApplied = false;
          if (classification?.tablesAccessed.length && orgId) {
            try {
              const maskCtx = getRequestContext();
              maskedRows = await applyMaskingViaTag({
                columns: result.columns, rows: result.rows,
                tablesAccessed: classification.tablesAccessed,
                orgId, userRole: maskCtx?.user?.role,
                connectionId: connId,
              });
              maskingApplied = maskedRows !== result.rows;
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err), connectionId: connId },
                "PII masking failed — returning unmasked results",
              );
            }
          }

          const hasHookMeta = Object.keys(hookMetadata).length > 0;
          return {
            success: true,
            explanation,
            row_count: maskedRows.length,
            columns: result.columns,
            rows: maskedRows,
            truncated,
            cached: false,
            maskingApplied,
            executionMs: durationMs,
            ...(hasHookMeta && { metadata: hookMetadata }),
          } as Record<string, unknown>;
        },
        catch: (err) => {
          // Query succeeded but post-processing failed — return the error
          // rather than losing the completed query result as an unrecoverable defect.
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, connectionId: connId }, "Post-query processing failed after successful execution");
          return new QueryExecutionError({ message: `Query succeeded but post-processing failed: ${message}` });
        },
      }),
    ),
  );
}

/** Map a pipeline error to the tool's {success: false} response format. Exhaustive over PipelineError. */
function pipelineErrorToResponse(error: PipelineError): Record<string, unknown> {
  switch (error._tag) {
    case "RateLimitExceededError":
      return {
        success: false,
        error: error.message,
        executionMs: 0,
        ...(error.retryAfterMs != null && { retryAfterMs: error.retryAfterMs }),
      };
    case "ConcurrencyLimitError":
    case "ConnectionNotFoundError":
    case "PoolExhaustedError":
    case "NoDatasourceError":
    case "RLSError":
    case "PluginRejectedError":
    case "QueryExecutionError":
      return { success: false, error: error.message, executionMs: 0 };
    default: {
      const _exhaustive: never = error;
      return { success: false, error: `Unknown pipeline error: ${(_exhaustive as { message: string }).message}`, executionMs: 0 };
    }
  }
}

// ── Shared user-query pipeline ──────────────────────────────────────
//
// Mirrors the executeSQL pipeline (validation → org-scoped connection →
// approval → source-slot → plugin beforeQuery → RLS → auto-LIMIT →
// execute + audit + mask + plugin afterQuery) but returns a discriminated
// outcome instead of the agent-flavored success/error envelope. Used by
// the dashboard canvas preview, single-card refresh, and bulk refresh —
// every site that runs user-authored SQL but isn't the agent tool itself.
//
// executeSQL keeps its own copy of the pipeline for now to avoid churn
// against its ~3,000-line test surface; collapsing both onto this helper
// is a planned architecture-wins follow-up.

export type UserQueryOutcome =
  | {
      readonly kind: "ok";
      readonly columns: string[];
      readonly rows: Record<string, unknown>[];
      readonly rowCount: number;
      readonly executionMs: number;
      readonly truncated: boolean;
      readonly maskingApplied: boolean;
    }
  | { readonly kind: "validation_failed"; readonly message: string }
  | {
      readonly kind: "approval_required";
      readonly approvalRequestId: string;
      readonly matchedRules: string[];
      readonly message: string;
    }
  | { readonly kind: "approval_unavailable"; readonly message: string }
  | { readonly kind: "approval_identity_missing"; readonly message: string }
  | { readonly kind: "rate_limited"; readonly message: string; readonly retryAfterMs?: number }
  | { readonly kind: "concurrency_limited"; readonly message: string }
  | { readonly kind: "connection_unavailable"; readonly message: string; readonly connectionId: string }
  | { readonly kind: "no_datasource"; readonly message: string }
  | { readonly kind: "pool_exhausted"; readonly message: string }
  | { readonly kind: "rls_failed"; readonly message: string }
  | { readonly kind: "plugin_rejected"; readonly message: string }
  | { readonly kind: "query_failed"; readonly message: string };

export interface RunUserQueryOpts {
  readonly sql: string;
  readonly connectionId?: string;
  /** Audit + approval surface description (e.g. "Dashboard preview: Weekly signups"). */
  readonly explanation: string;
}

/**
 * Run user-authored SQL through the production pipeline and return a
 * discriminated outcome. See the comment block above for which steps run.
 */
export function runUserQueryPipeline(opts: RunUserQueryOpts): Promise<UserQueryOutcome> {
  const { sql, explanation } = opts;
  const connId = opts.connectionId ?? "default";

  const pipeline: Effect.Effect<UserQueryOutcome, PipelineError> = Effect.gen(function* () {
    const reqCtx = getRequestContext();
    const orgId = connections.isOrgPoolingEnabled()
      ? reqCtx?.user?.activeOrganizationId
      : undefined;
    const authOrgId = reqCtx?.user?.activeOrganizationId;
    const atlasMode = reqCtx?.atlasMode ?? "published";

    const { db, dbType } = yield* resolveConnectionEffect(connId, orgId, atlasMode, authOrgId);

    const targetHost = connections.getTargetHost(connId);
    const customValidator = connections.getValidator(connId);
    const normalizedSql = sql.trim().replace(/;\s*$/, "").trimEnd();

    const initial = yield* runQueryValidationEffect(normalizedSql, connId, dbType, customValidator);
    if (!initial.ok) {
      logQueryAudit({
        sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
        error: initial.auditError, sourceId: connId, sourceType: dbType,
      });
      return { kind: "validation_failed" as const, message: initial.error };
    }
    const classification = initial.classification;

    // Approval gate — fail closed.
    if (classification) {
      const approvalOutcome = yield* Effect.tryPromise({
        try: async (): Promise<UserQueryOutcome | null> => {
          let approvalMatch:
            | { required: boolean; matchedRules: { id: string; name: string }[]; identityMissing?: boolean };
          let approvalGate: ApprovalGateShape;
          try {
            approvalGate = await loadApprovalGate();
            const checkReqCtx = getRequestContext();
            const checkOrgId = checkReqCtx?.user?.activeOrganizationId;
            const checkUserId = checkReqCtx?.user?.id;
            const checkSurface = checkReqCtx?.approvalSurface;
            approvalMatch = await Effect.runPromise(approvalGate.checkApprovalRequired(
              checkOrgId, classification.tablesAccessed, classification.columnsAccessed,
              {
                ...(checkUserId ? { requesterId: checkUserId } : {}),
                ...(checkSurface ? { surface: checkSurface } : {}),
              },
            ));
          } catch (err) {
            log.error(
              { err: err instanceof Error ? err.message : String(err), connectionId: connId },
              "Approval check failed — blocking query (fail-closed)",
            );
            return {
              kind: "approval_unavailable" as const,
              message: "Approval system unavailable — query blocked. Contact your administrator.",
            };
          }

          if (approvalMatch?.required) {
            const reqCtxForApproval = getRequestContext();
            const approvalOrgId = reqCtxForApproval?.user?.activeOrganizationId;
            const userId = reqCtxForApproval?.user?.id;
            const userEmail = reqCtxForApproval?.user?.label ?? null;

            if (!userId || !approvalOrgId) {
              log.warn(
                { connectionId: connId, orgId: approvalOrgId, identityMissing: approvalMatch.identityMissing === true },
                "Approval required but user identity unavailable — blocking query",
              );
              return {
                kind: "approval_identity_missing" as const,
                message: "This query requires approval but the requester identity could not be determined. Please sign in and try again.",
              };
            }

            const alreadyApproved = await Effect.runPromise(approvalGate.hasApprovedRequest(approvalOrgId, userId, normalizedSql, connId));
            if (!alreadyApproved) {
              const firstRule = approvalMatch.matchedRules[0];
              const approvalReq = await Effect.runPromise(approvalGate.createApprovalRequest({
                orgId: approvalOrgId,
                ruleId: firstRule.id,
                ruleName: firstRule.name,
                requesterId: userId,
                requesterEmail: userEmail,
                querySql: normalizedSql,
                explanation,
                connectionId: connId,
                tablesAccessed: classification.tablesAccessed,
                columnsAccessed: classification.columnsAccessed,
                surface: reqCtxForApproval?.approvalSurface ?? null,
              }));
              logQueryAudit({
                sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
                error: `Approval required: ${firstRule.name}`,
                sourceId: connId, sourceType: dbType, targetHost,
              });
              return {
                kind: "approval_required" as const,
                approvalRequestId: approvalReq.id,
                matchedRules: approvalMatch.matchedRules.map((r) => r.name),
                message:
                  `This query requires approval before execution. Rule: "${firstRule.name}". ` +
                  `An approval request has been submitted (ID: ${approvalReq.id}).`,
              };
            }
          }
          return null;
        },
        catch: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err, connectionId: connId }, "Approval workflow failed — blocking query");
          return new QueryExecutionError({ message: `Approval workflow failed: ${message}` });
        },
      });
      if (approvalOutcome !== null) return approvalOutcome;
    }

    // Source-slot wrapper: plugin beforeQuery → re-validate → RLS → LIMIT → execute.
    const slotResult = yield* withSourceSlot(
      connId,
      Effect.gen(function* () {
        const { dispatchHook, dispatchMutableHook } = yield* Effect.tryPromise({
          try: () => import("@atlas/api/lib/plugins/hooks"),
          catch: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error({ err, connectionId: connId }, "Failed to load plugin hooks module");
            return new PluginRejectedError({ message: `Plugin system unavailable: ${message}`, connectionId: connId });
          },
        });
        const hookMetadata: Record<string, unknown> = {};
        const hookCtx = { sql, connectionId: connId, metadata: hookMetadata };
        const mutatedSql = yield* Effect.tryPromise({
          try: () => dispatchMutableHook("beforeQuery", hookCtx, "sql"),
          catch: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            return new PluginRejectedError({
              message: `Query rejected by plugin: ${message}`,
              connectionId: connId,
            });
          },
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              logQueryAudit({
                sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
                error: `Plugin rejected: ${error.message}`,
                sourceId: connId, sourceType: dbType, targetHost,
              }),
            ),
          ),
        );

        let normalizedMutated = mutatedSql.trim().replace(/;\s*$/, "").trimEnd();
        if (normalizedMutated !== normalizedSql) {
          const revalidation = yield* runQueryValidationEffect(normalizedMutated, connId, dbType, customValidator);
          if (!revalidation.ok) {
            logQueryAudit({
              sql: normalizedMutated.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
              error: `Plugin-rewritten SQL failed validation: ${revalidation.auditError}`,
              sourceId: connId, sourceType: dbType, targetHost,
            });
            return { kind: "validation_failed" as const, message: `Plugin-rewritten SQL failed validation: ${revalidation.error}` };
          }
        }

        if (!customValidator) {
          normalizedMutated = yield* applyRLSEffect(normalizedMutated, connId, dbType, targetHost);
        }

        const rowLimit = getRowLimit();
        const queryTimeout = getQueryTimeout();
        let querySql = normalizedMutated;
        if (!customValidator && !/\bLIMIT\b/i.test(querySql)) {
          querySql += ` LIMIT ${rowLimit}`;
        }

        const result = yield* executeAndAuditEffect({
          db, dbType, connId, orgId, targetHost, querySql, queryTimeout,
          rowLimit, explanation, classification, cacheKey: null,
          hookMetadata, dispatchHook,
        });
        return {
          kind: "ok" as const,
          columns: result.columns as string[],
          rows: result.rows as Record<string, unknown>[],
          rowCount: result.row_count as number,
          executionMs: result.executionMs as number,
          truncated: result.truncated as boolean,
          maskingApplied: result.maskingApplied as boolean,
        };
      }),
    ).pipe(
      Effect.tapError((error) => {
        if (error._tag === "RateLimitExceededError" || error._tag === "ConcurrencyLimitError") {
          return Effect.sync(() =>
            logQueryAudit({
              sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
              error: `Rate limited: ${error.message}`,
              sourceId: connId, sourceType: dbType, targetHost,
            }),
          );
        }
        return Effect.void;
      }),
    );

    return slotResult;
  });

  return Effect.runPromise(
    pipeline.pipe(
      Effect.catchAll((error: PipelineError): Effect.Effect<UserQueryOutcome, never> => {
        switch (error._tag) {
          case "RateLimitExceededError":
            return Effect.succeed({
              kind: "rate_limited",
              message: error.message,
              ...(error.retryAfterMs != null && { retryAfterMs: error.retryAfterMs }),
            });
          case "ConcurrencyLimitError":
            return Effect.succeed({ kind: "concurrency_limited", message: error.message });
          case "ConnectionNotFoundError":
            return Effect.succeed({
              kind: "connection_unavailable",
              message: error.message,
              connectionId: connId,
            });
          case "NoDatasourceError":
            return Effect.succeed({ kind: "no_datasource", message: error.message });
          case "PoolExhaustedError":
            return Effect.succeed({ kind: "pool_exhausted", message: error.message });
          case "RLSError":
            return Effect.succeed({ kind: "rls_failed", message: error.message });
          case "PluginRejectedError":
            return Effect.succeed({ kind: "plugin_rejected", message: error.message });
          case "QueryExecutionError":
            return Effect.succeed({ kind: "query_failed", message: error.message });
          default: {
            const _exhaustive: never = error;
            return Effect.succeed({
              kind: "query_failed",
              message: `Unknown pipeline error: ${(_exhaustive as { message: string }).message}`,
            });
          }
        }
      }),
    ),
  );
}

/**
 * Single-environment SQL execution leaf used by both the back-compat path
 * (no `scope`) and the agent-decided fanout path (`scope: "all"` or a
 * named member id, PRD #2515 / slice 1 #2516). The body is the original
 * `executeSQL.execute` pipeline; the dispatch lives in the tool wrapper
 * below so existing callers see zero behaviour change.
 *
 * Returns the tool's `{success: true | false, ...}` response shape as an
 * opaque record — the merger then reads `columns` / `rows` / `error` from
 * each per-member outcome to compose the fanned-out result.
 */
async function executeSqlForConnection({
  sql,
  explanation,
  connId,
  parentAuditId,
  routingMode,
  routingReason,
}: {
  readonly sql: string;
  readonly explanation: string;
  readonly connId: string;
  /**
   * Parent audit row id when this execution is one leg of a cross-environment
   * fanout. Threaded through every `logQueryAudit` call below so each audit
   * row carries the linkage. Undefined for single-env executions.
   */
  readonly parentAuditId?: string;
  /**
   * Routing mode for the parent `executeSQL` call. Stamped on the OTel
   * span so traces can attribute fanout behavior without joining audit
   * rows. Defaults to "auto" when not threaded.
   */
  readonly routingMode?: RoutingMode;
  /**
   * Planner reason that picked this connection (e.g. `agent-all`,
   * `picker-pin`, `1x1-group`). Stamped on the OTel span as
   * `atlas.routing_reason` so observers can distinguish fanout-by-agent
   * from fanout-by-picker without joining audit rows.
   */
  readonly routingReason?: RoutingReason;
}): Promise<Record<string, unknown>> {
    // The full pipeline runs as an Effect.gen program. Tagged errors flow through
    // the error channel; expected rejections (validation, approval, cache) return
    // as {success: false} values. At the boundary, catchAll maps errors to responses.
    const pipeline = Effect.gen(function* () {
      // Resolve org context for tenant-scoped pool isolation
      const reqCtx = getRequestContext();
      const orgId = connections.isOrgPoolingEnabled()
        ? reqCtx?.user?.activeOrganizationId
        : undefined;
      // Mode visibility always uses the real auth orgId — draft/published
      // isolation applies in self-hosted single-org deployments as well as
      // SaaS, even when pool-level org isolation is disabled.
      const authOrgId = reqCtx?.user?.activeOrganizationId;
      // Fail-closed default for mode: missing atlasMode implies published.
      const atlasMode = reqCtx?.atlasMode ?? "published";

      // Step 1: Resolve connection (tagged errors)
      const { db, dbType } = yield* resolveConnectionEffect(connId, orgId, atlasMode, authOrgId);

      const targetHost = connections.getTargetHost(connId);
      const customValidator = connections.getValidator(connId);
      const normalizedSql = sql.trim().replace(/;\s*$/, "").trimEnd();

      // Step 2: Validate (custom validator or standard SQL validation)
      const initial = yield* runQueryValidationEffect(normalizedSql, connId, dbType, customValidator);
      if (!initial.ok) {
        logQueryAudit({
          sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
          error: initial.auditError, sourceId: connId, sourceType: dbType,
          parentAuditId,
        });
        return { success: false, error: initial.error, executionMs: 0 };
      }
      // Classification is only populated for standard SQL (validateSQL path).
      // Custom validators (SOQL, GraphQL) bypass node-sql-parser so classification
      // stays undefined — their audit entries store NULL for tables/columns_accessed.
      const classification = initial.classification;

      // Step 3: Enterprise approval check.
      // F-54 / F-55: this gate is fail-CLOSED. The previous behaviour
      // (catch → log.warn → proceed without approvalMatch) silently
      // bypassed governance whenever the EE module failed to import or
      // `checkApprovalRequired` rejected — a "catch { return false } on a
      // security check is a bug" pattern called out in CLAUDE.md. The new
      // shape returns a clear "approval system unavailable" error to the
      // agent so the operator sees the failure instead of silently
      // executing approval-gated queries.
      //
      // When the caller binds no user, `checkApprovalRequired` itself
      // now returns `required: true` with `identityMissing: true` if any
      // rule exists in the database; the Phase 2 user-identity gate
      // below routes that into the "approve via the Atlas web app" error.
      if (classification) {
        const approvalResult = yield* Effect.tryPromise({
          try: async () => {
            let approvalMatch:
              | { required: boolean; matchedRules: { id: string; name: string }[]; identityMissing?: boolean };
            let approvalGate: ApprovalGateShape;
            try {
              approvalGate = await loadApprovalGate();
              const checkReqCtx = getRequestContext();
              const checkOrgId = checkReqCtx?.user?.activeOrganizationId;
              const checkUserId = checkReqCtx?.user?.id;
              // #2072 — propagate the request's origin surface so
              // surface-scoped rules only fire on the matching transport.
              // Routes stamp this on `withRequestContext`; an unstamped
              // route (or a legacy caller) reaches checkApprovalRequired
              // with `surface: undefined` and only triggers `'any'`
              // rules — scope isolation rather than governance bypass,
              // since the `'any'` migration default still fires.
              const checkSurface = checkReqCtx?.approvalSurface;
              // Pass requesterId so the defensive identity-missing check
              // distinguishes "scheduler/Slack/MCP forgot to bind anything"
              // (fail-closed) from "demo / single-user mode bound a user
              // but no org" (pass-through, no rule can match anyway).
              approvalMatch = await Effect.runPromise(approvalGate.checkApprovalRequired(
                checkOrgId, classification.tablesAccessed, classification.columnsAccessed,
                {
                  ...(checkUserId ? { requesterId: checkUserId } : {}),
                  ...(checkSurface ? { surface: checkSurface } : {}),
                },
              ));
            } catch (err) {
              log.error(
                { err: err instanceof Error ? err.message : String(err), connectionId: connId },
                "Approval check failed — blocking query (fail-closed)",
              );
              return {
                success: false,
                error: "Approval system unavailable — query blocked. Contact your administrator.",
                executionMs: 0,
              };
            }

            // Phase 2: create request (hard fail — governance bypass is worse than a failed query)
            if (approvalMatch?.required) {
              const reqCtxForApproval = getRequestContext();
              const approvalOrgId = reqCtxForApproval?.user?.activeOrganizationId;
              const userId = reqCtxForApproval?.user?.id;
              const userEmail = reqCtxForApproval?.user?.label ?? null;

              if (!userId || !approvalOrgId) {
                log.warn(
                  { connectionId: connId, orgId: approvalOrgId, identityMissing: approvalMatch.identityMissing === true },
                  "Approval required but user identity unavailable — blocking query",
                );
                return {
                  success: false,
                  error: "This query requires approval but the requester identity could not be determined. Please sign in and try again.",
                  executionMs: 0,
                };
              }

              const alreadyApproved = await Effect.runPromise(approvalGate.hasApprovedRequest(approvalOrgId, userId, normalizedSql, connId));
              if (!alreadyApproved) {
                const firstRule = approvalMatch.matchedRules[0];
                const approvalReq = await Effect.runPromise(approvalGate.createApprovalRequest({
                  orgId: approvalOrgId,
                  ruleId: firstRule.id,
                  ruleName: firstRule.name,
                  requesterId: userId,
                  requesterEmail: userEmail,
                  querySql: normalizedSql,
                  explanation,
                  connectionId: connId,
                  tablesAccessed: classification.tablesAccessed,
                  columnsAccessed: classification.columnsAccessed,
                  // #2072 — stamp the origin surface on the queue row
                  // for the audit dimension (queryable via direct SQL
                  // until a surface filter ships in /admin/audit).
                  surface: reqCtxForApproval?.approvalSurface ?? null,
                }));
                logQueryAudit({
                  sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
                  error: `Approval required: ${firstRule.name}`,
                  sourceId: connId, sourceType: dbType, targetHost,
                  parentAuditId,
                });
                return {
                  success: false,
                  approval_required: true,
                  approval_request_id: approvalReq.id,
                  matched_rules: approvalMatch.matchedRules.map((r: { name: string }) => r.name),
                  message: `This query requires approval before execution. Rule: "${firstRule.name}". ` +
                    `An approval request has been submitted (ID: ${approvalReq.id}). ` +
                    `An admin must approve it before the query can run.`,
                  executionMs: 0,
                };
              }
            }
            return null; // proceed to execution
          },
          catch: (err) => {
            // Phase 2 failure — governance bypass is worse than a failed query.
            // Surface as a typed error so it reaches the agent as {success: false}.
            const message = err instanceof Error ? err.message : String(err);
            log.error({ err, connectionId: connId }, "Approval request creation failed — blocking query");
            return new QueryExecutionError({ message: `Approval workflow failed: ${message}` });
          },
        });
        if (approvalResult !== null) return approvalResult;
      }

      // Step 4: Cache check (short-circuit on hit)
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
              sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: cached.rows.length,
              success: true, sourceId: connId, sourceType: dbType, targetHost,
              parentAuditId,
            });
            // Apply PII masking to cached results (same as live query path)
            const cacheResponse = yield* Effect.tryPromise({
              try: async () => {
                let cachedRows = cached.rows;
                let cachedMaskingApplied = false;
                if (classification?.tablesAccessed.length && orgId) {
                  try {
                    cachedRows = await applyMaskingViaTag({
                      columns: cached.columns, rows: cached.rows,
                      tablesAccessed: classification.tablesAccessed,
                      orgId, userRole: ctx?.user?.role,
                      connectionId: connId,
                    });
                    cachedMaskingApplied = cachedRows !== cached.rows;
                  } catch (err) {
                    log.warn(
                      { err: err instanceof Error ? err.message : String(err), connectionId: connId },
                      "PII masking failed on cached results — returning unmasked results",
                    );
                  }
                }
                return {
                  success: true, explanation, row_count: cachedRows.length,
                  columns: cached.columns, rows: cachedRows,
                  truncated: cachedRows.length >= getRowLimit(), cached: true,
                  maskingApplied: cachedMaskingApplied,
                  executionMs: 0,
                };
              },
              catch: (err) => {
                const message = err instanceof Error ? err.message : String(err);
                log.error({ err, connectionId: connId }, "Cache response processing failed");
                return new QueryExecutionError({ message: `Cache response processing failed: ${message}` });
              },
            });
            return cacheResponse;
          }
        } catch (cacheErr) {
          log.error({ err: cacheErr, connectionId: connId }, "Cache read failed — executing query against database");
          cacheKey = null;
        }
      }

      // Step 5: Execute inside a rate-limit slot (concurrency release is automatic)
      return yield* withSourceSlot(connId,
        Effect.gen(function* () {
          // Plugin beforeQuery hook (may rewrite SQL)
          const { dispatchHook, dispatchMutableHook } = yield* Effect.tryPromise({
            try: () => import("@atlas/api/lib/plugins/hooks"),
            catch: (err) => {
              const message = err instanceof Error ? err.message : String(err);
              log.error({ err, connectionId: connId }, "Failed to load plugin hooks module");
              return new PluginRejectedError({ message: `Plugin system unavailable: ${message}`, connectionId: connId });
            },
          });
          const hookMetadata: Record<string, unknown> = {};
          const hookCtx = { sql, connectionId: connId, metadata: hookMetadata };
          const mutatedSql = yield* Effect.tryPromise({
            try: () => dispatchMutableHook("beforeQuery", hookCtx, "sql"),
            catch: (err) => {
              const message = err instanceof Error ? err.message : String(err);
              return new PluginRejectedError({
                message: `Query rejected by plugin: ${message}`,
                connectionId: connId,
              });
            },
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                logQueryAudit({
                  sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
                  error: `Plugin rejected: ${error.message}`,
                  sourceId: connId, sourceType: dbType, targetHost,
                  parentAuditId,
                }),
              ),
            ),
          );

          // Re-validate if plugin rewrote the SQL
          let normalizedMutated = mutatedSql.trim().replace(/;\s*$/, "").trimEnd();
          if (normalizedMutated !== normalizedSql) {
            const revalidation = yield* runQueryValidationEffect(normalizedMutated, connId, dbType, customValidator);
            if (!revalidation.ok) {
              logQueryAudit({
                sql: normalizedMutated.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
                error: `Plugin-rewritten SQL failed validation: ${revalidation.auditError}`,
                sourceId: connId, sourceType: dbType, targetHost,
                parentAuditId,
              });
              return { success: false, error: `Plugin-rewritten SQL failed validation: ${revalidation.error}`, executionMs: 0 };
            }
          }

          // RLS: inject WHERE conditions (skipped for custom validators / non-SQL languages)
          if (!customValidator) {
            normalizedMutated = yield* applyRLSEffect(normalizedMutated, connId, dbType, targetHost);
          }

          // Auto-append LIMIT if not present
          const rowLimit = getRowLimit();
          const queryTimeout = getQueryTimeout();
          let querySql = normalizedMutated;
          if (!customValidator && !/\bLIMIT\b/i.test(querySql)) {
            querySql += ` LIMIT ${rowLimit}`;
          }

          // Execute the query
          return yield* executeAndAuditEffect({
            db, dbType, connId, orgId, targetHost, querySql, queryTimeout,
            rowLimit, explanation, classification, cacheKey: cacheKey ?? null,
            hookMetadata, dispatchHook, parentAuditId, routingMode, routingReason,
          });
        }),
      ).pipe(
        // Audit log rate-limit rejections (inner errors have their own audit handling)
        Effect.tapError((error) => {
          if (error._tag === "RateLimitExceededError" || error._tag === "ConcurrencyLimitError") {
            return Effect.sync(() =>
              logQueryAudit({
                sql: sql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
                error: `Rate limited: ${error.message}`,
                sourceId: connId, sourceType: dbType, targetHost,
                parentAuditId,
              }),
            );
          }
          return Effect.void;
        }),
      );
    });

    // Run the pipeline, mapping tagged errors to {success: false} tool responses
    return Effect.runPromise(
      pipeline.pipe(
        Effect.catchAll((error: PipelineError) =>
          Effect.succeed(pipelineErrorToResponse(error)),
        ),
      ),
    );
}

/**
 * Cross-environment fanout — runs `executeSqlForConnection` once per
 * member of the active group in parallel via `Promise.allSettled`, then
 * merges the outcomes into one result table with a prepended `__env__`
 * column and parallel `envContributions` metadata.
 *
 * Settled rejections (which the leaf function should not produce — it
 * already maps tagged errors to `{success: false}`) are coerced into a
 * `MemberExecutionResult.error` entry so the merger can surface them.
 *
 * Audit linkage (#2519): before fanning out, writes a single "parent"
 * audit row with a pre-generated UUID and `parent_audit_id = NULL`. Each
 * leg then receives that UUID via `parentAuditId` so its own audit row
 * carries the back-reference. Cross-env turns become one logical step
 * with N child executions in the audit dimension.
 */
async function executeSqlFanout(args: {
  readonly sql: string;
  readonly explanation: string;
  readonly connectionIds: readonly string[];
  /**
   * Planner reason that picked this fanout (one of `agent-all` /
   * `picker-all`). Threaded into each leg's OTel span as
   * `atlas.routing_reason` so observers can distinguish "agent decided
   * to fan out" from "user forced fanout via picker" without joining
   * audit rows.
   */
  readonly fanoutReason: RoutingReason;
}): Promise<Record<string, unknown>> {
  const { sql, explanation, connectionIds, fanoutReason } = args;

  // Write the parent audit row up front so each leg's audit insert can
  // reference it. The parent carries no per-environment metadata
  // (durationMs / rowCount come from the merge), is success=true on
  // dispatch (the final aggregated outcome is reflected by the children
  // + the merger's success/failure shape returned to the caller), and
  // its id is what we thread into every leg.
  //
  // `crypto.randomUUID()` is available on Node 19+ and Bun — both are
  // baseline for the API server. We use it instead of relying on the
  // column default so the value is in scope locally for the children.
  const parentAuditId = crypto.randomUUID();
  try {
    // `source_id` is intentionally omitted on the parent row: every other
    // audit_log row stamps source_id with a connection id, so overloading
    // it with a connection_group_id would silently drop the parent from
    // forensic queries that JOIN against `connections.id` or filter by
    // `source_id IN (<connection ids>)`. The children carry the real
    // connection ids; the group dimension is recoverable by JOINing
    // children's `source_id` back to `connections.group_id`.
    logQueryAudit({
      id: parentAuditId,
      sql: sql.slice(0, 2000),
      durationMs: 0,
      rowCount: connectionIds.length,
      success: true,
    });
  } catch (auditErr) {
    log.warn(
      { err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
      "Failed to write fanout parent audit row",
    );
  }

  const startTimes = new Map<string, number>();
  const settled = await Promise.allSettled(
    connectionIds.map((connId) => {
      startTimes.set(connId, performance.now());
      return executeSqlForConnection({
        sql,
        explanation,
        connId,
        parentAuditId,
        routingMode: "all",
        routingReason: fanoutReason,
      });
    }),
  );

  const memberResults = settled.map((outcome, idx) => {
    const connectionId = connectionIds[idx]!;
    const startedAt = startTimes.get(connectionId);
    const durationMsFallback = startedAt == null ? 0 : Math.round(performance.now() - startedAt);
    if (outcome.status === "rejected") {
      const reason = outcome.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      return {
        connectionId,
        error: message,
        durationMs: durationMsFallback,
      };
    }
    const value = outcome.value;
    const success = value["success"] === true;
    const durationMs = typeof value["executionMs"] === "number" ? (value["executionMs"] as number) : durationMsFallback;
    if (success) {
      return {
        connectionId,
        columns: (value["columns"] as readonly string[] | undefined) ?? [],
        rows: (value["rows"] as readonly Record<string, unknown>[] | undefined) ?? [],
        durationMs,
      };
    }
    const errorMessage = typeof value["error"] === "string" ? (value["error"] as string) : "Query failed";
    return { connectionId, error: errorMessage, durationMs };
  });

  const merged = mergeMemberResults(memberResults);
  const successCount = merged.envContributions.filter(
    (c: { error: string | null }) => c.error === null,
  ).length;
  const totalExecutionMs = merged.envContributions.reduce(
    (acc: number, c: { durationMs: number }) => Math.max(acc, c.durationMs),
    0,
  );

  // All members errored → surface as success=false with a summary message
  // so the agent's recovery loop kicks in. Partial failures stay
  // success=true with envContributions describing which env failed.
  if (successCount === 0) {
    const messages = merged.envContributions.map(
      (c: { connectionId: string; error: string | null }) => `${c.connectionId}: ${c.error ?? "no rows"}`,
    );
    return {
      success: false,
      explanation,
      error: `All ${merged.envContributions.length} environments failed — ${messages.join("; ")}`,
      envContributions: merged.envContributions,
      executionMs: totalExecutionMs,
    };
  }

  return {
    success: true,
    explanation,
    row_count: merged.rows.length,
    columns: merged.columns,
    rows: merged.rows,
    truncated: false,
    cached: false,
    maskingApplied: false,
    envContributions: merged.envContributions,
    executionMs: totalExecutionMs,
  };
}

export const executeSQL = tool({
  description: EXECUTE_SQL_TOOL_DESCRIPTION,

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
    scope: z
      .string()
      .optional()
      .describe(
        "Cross-environment routing override (PRD #2515). \"this\" or omitted runs against the conversation's current member; \"all\" fans out across every member of the active environment group; a member connection id routes to that specific environment. Only applies when the active group has more than one member.",
      ),
  }),

  execute: async ({ sql, explanation, connectionId, scope }) => {
    // Chat routes stamp the user-selected per-turn connection into
    // RequestContext. The model normally omits `connectionId`, so fall back to
    // that routed context before the legacy default to avoid executing against
    // the wrong environment while conversation metadata says otherwise.
    const reqCtx = getRequestContext();
    const requestContextConnectionId = reqCtx?.connectionId;
    const currentMember = connectionId ?? requestContextConnectionId ?? "default";

    // #2518 — three-state picker. `routingMode` reaches us via
    // `RequestContext` (stamped by the chat route from the conversation
    // row). The chat route applies the NULL→"pin" back-compat default
    // before stamping; reaching this code with `routingMode === undefined`
    // means the caller never went through the chat route (tools / MCP /
    // scheduler / unit tests), and the legacy "agent decides" semantics
    // are the right answer there.
    const routingMode = reqCtx?.routingMode ?? "auto";

    // Fast path — only valid when EVERY override path collapses to
    // "single execution against currentMember". That is true when:
    //   - the agent emitted no scope (or scope === "this"), AND
    //   - the picker is NOT pinning the fanout case ('all').
    // The 'pin' picker case ALSO collapses to single — pin always
    // routes to `currentMember` regardless of the agent's hint — so we
    // keep the fast path for it (no DB lookup needed). 'auto' with no
    // agent scope is the same shape as legacy single-env execution.
    //
    // Wraps the leaf result with a 1-element `envContributions` array so
    // SDK consumers see the same wire shape for single-env and fanout
    // responses (#2519). The leaf result already carries `success`,
    // `columns`, `rows`, etc. — we only attach the contribution.
    if ((scope === undefined || scope === "this") && routingMode !== "all") {
      const result = await executeSqlForConnection({
        sql,
        explanation,
        connId: currentMember,
        routingMode,
      });
      return attachSingleEnvContribution(result, currentMember);
    }

    // Routing path: either the agent asked for fanout / a specific
    // member, or the picker is pinning 'all' (which overrides the
    // agent's scope regardless of value). Resolve the active group's
    // members + primary, then run the pure routing module. Failures
    // collapse to a 1×1 fallback so the tool call still returns a
    // useful result.
    const orgId = reqCtx?.user?.activeOrganizationId;
    const ctx = await loadGroupRoutingContext(orgId, currentMember);
    const { plan, warnings } = resolveRoutingPlan({
      agentScope: scope,
      currentMember: ctx.currentMember,
      members: ctx.members,
      primaryMember: ctx.primaryMember,
      pickerMode: routingMode,
    });
    for (const w of warnings) {
      log.warn({ connectionId: currentMember, scope, plan: plan.kind }, w);
    }

    if (plan.kind === "single") {
      const result = await executeSqlForConnection({
        sql,
        explanation,
        connId: plan.connectionId,
        routingMode,
        routingReason: plan.reason,
      });
      return attachSingleEnvContribution(result, plan.connectionId);
    }
    return executeSqlFanout({
      sql,
      explanation,
      connectionIds: plan.connectionIds,
      fanoutReason: plan.reason,
    });
  },
});

/**
 * Wrap a single-env executeSQL result with a 1-element `envContributions`
 * array so SDK consumers see the same wire shape for single and fanout
 * responses — they branch on length, not presence.
 *
 * Pure — returns a new object via spread; the input is not mutated.
 * Never overwrites a contribution the leaf may have already provided.
 *
 * Failure-shape coercion: when the leaf returned `success: false` and
 * its `error` field is not a string (e.g. a future code path that uses
 * `message` instead of `error`), we surface a sentinel rather than
 * letting the contribution claim `error: null`, which would falsely
 * present the failed execution as a success row to SDK consumers.
 */
function attachSingleEnvContribution(
  result: Record<string, unknown>,
  connectionId: string,
): Record<string, unknown> {
  if (Array.isArray(result["envContributions"])) {
    return result;
  }
  const rowCount = typeof result["row_count"] === "number"
    ? (result["row_count"] as number)
    : Array.isArray(result["rows"])
      ? (result["rows"] as unknown[]).length
      : 0;
  const durationMs = typeof result["executionMs"] === "number"
    ? (result["executionMs"] as number)
    : 0;
  let error: string | null = null;
  if (result["success"] === false) {
    error = typeof result["error"] === "string"
      ? (result["error"] as string)
      : "Execution failed (no error message available)";
  }
  return {
    ...result,
    envContributions: [{ connectionId, rowCount, error, durationMs }],
  };
}
