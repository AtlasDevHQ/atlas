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
import { Cause, Effect } from "effect";
import { Parser } from "node-sql-parser";
import type { AST } from "node-sql-parser";
import { connections, detectDBType, isConnectionVisibleInMode, ConnectionNotRegisteredError, NoDatasourceConfiguredError, PoolCapacityExceededError } from "@atlas/api/lib/db/connection";
import type { DBConnection, DBType } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables, loadOrgWhitelist } from "@atlas/api/lib/semantic";
import { logQueryAudit } from "@atlas/api/lib/auth/audit";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { withSpan } from "@atlas/api/lib/tracing";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { withSourceSlot } from "@atlas/api/lib/db/source-rate-limit";
import { getConfig } from "@atlas/api/lib/config";
import { resolveRLSFilters, injectRLSConditions, type RLSFilterGroup } from "@atlas/api/lib/rls";
import {
  extractPlaceholderNames,
  bindDashboardParameters,
  isBindableDbType,
  DashboardParameterError,
} from "@atlas/api/lib/dashboard-parameters";
import { getSetting, getSettingAuto } from "@atlas/api/lib/settings";
import { getCache, buildCacheKey, cacheEnabled, getDefaultTtl } from "@atlas/api/lib/cache/index";
import { proposePatternIfNovel } from "@atlas/api/lib/learn/pattern-proposer";
import {
  ConnectionNotFoundError, PoolExhaustedError, NoDatasourceError,
  QueryExecutionError, RateLimitExceededError, ConcurrencyLimitError,
  RLSError, PluginRejectedError, EnterpriseUnavailableError,
} from "@atlas/api/lib/effect/errors";
import { EXECUTE_SQL_TOOL_DESCRIPTION } from "./descriptions";
import { appendRowLimit, hasLimitClause } from "./auto-limit";
import { type RoutingMode, type RoutingReason } from "@atlas/api/lib/env-routing";
import { resolveExecutionTarget, type ExecutionTarget } from "@atlas/api/lib/group-reach/execution-target";
import { resolveSqlExecutionPlan } from "./sql-execution-plan";
import { mergeMemberResults } from "@atlas/api/lib/multi-env-merger";
import {
  ApprovalGate,
  MaskingPolicy,
  SlaMetrics,
  type ApprovalGateShape,
  type MaskingContext,
} from "@atlas/api/lib/effect/services";
import { runEnterprise, yieldFailClosed } from "@atlas/api/lib/effect/enterprise-layer";

/**
 * Run `MaskingPolicy.applyMasking` via `EnterpriseLayer`. Promise-shaped
 * wrapper so the two sql.ts call sites (live + cache path) can keep
 * their existing async/await structure without restructuring around
 * `Effect.gen` (#2566 — slice 4/11 of #2017).
 *
 * #2593 — consumer-side fail-closed: on SaaS (`ATLAS_ENTERPRISE_ENABLED=true`)
 * if the MaskingPolicy Tag is still the no-op default (`available: false`),
 * the EE layer didn't bind — returning unmasked rows on classified tables
 * is a compliance break. Throw `EnterpriseUnavailableError` so the caller's
 * existing try/catch short-circuits "PII masking failed" into a hard fail
 * instead of the legacy fail-open behavior.
 *
 * Self-hosted (`ATLAS_ENTERPRISE_ENABLED !== true`) keeps the original
 * fail-open behavior: the no-op pass-through is the expected self-hosted
 * code path.
 */
function applyMaskingViaTag(
  ctx: MaskingContext,
): Promise<Record<string, unknown>[]> {
  return runEnterprise(
    Effect.gen(function* () {
      const masking = yield* yieldFailClosed(
        MaskingPolicy,
        "PII masking unavailable — query blocked to prevent unmasked-data exposure. Contact your administrator.",
      );
      return yield* masking.applyMasking(ctx);
    }),
  );
}

/**
 * Resolve the `ApprovalGate` Tag against `EnterpriseLayer` once per
 * pipeline run. The single approval region in `runSqlPipelineEffect`
 * reads three methods on the gate (`checkApprovalRequired` →
 * `hasApprovedRequest` → `createApprovalRequest`); resolving the shape
 * once avoids re-entering the enterprise runtime per method (#2567,
 * #3764).
 *
 * #2593 — consumer-side fail-closed: on SaaS where EE didn't bind, the
 * no-op's `checkApprovalRequired` reports `required: false` — bypassing
 * approval-gated queries entirely. Throw `EnterpriseUnavailableError`
 * so the caller surfaces the existing "approval system unavailable"
 * 503 envelope. Self-hosted falls through (no-op = no rules to match).
 */
function loadApprovalGate(): Promise<ApprovalGateShape> {
  return runEnterprise(
    Effect.gen(function* () {
      const gate = yield* yieldFailClosed(
        ApprovalGate,
        "Approval gate unavailable — query blocked to prevent governance bypass. Contact your administrator.",
      );
      return gate;
    }),
  );
}

/**
 * Fire-and-forget SLA metric write (#2568). Resolves the `SlaMetrics`
 * Tag and runs `recordQueryMetric` once. Errors are swallowed by the
 * Tag's own catchAll (the no-op already returns `Effect.void`), so any
 * unexpected throw lands on the caller's `.catch()` for diagnostic logs.
 */
function recordSlaMetric(
  workspaceId: string,
  durationMs: number,
  isError: boolean,
): Promise<void> {
  return runEnterprise(
    Effect.gen(function* () {
      const sla = yield* SlaMetrics;
      return yield* sla.recordQueryMetric(workspaceId, durationMs, isError);
    }),
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

// ── Parse-once seam (#4349) ─────────────────────────────────────────
//
// The validate-then-execute path used to parse the same query string ~5–6
// times: `astify` for the statement shape; a `tableList` each for the
// ONLY-guard, the whitelist, and the classifier (which also ran `columnList`);
// and a final `tableList` inside `applyRLSEffect`. Each recomputed the dialect
// and discarded the prior parse, so the whitelist bucket and the classifier's
// table set matched only because re-parses of the same string can't disagree —
// an undocumented "these parses can't diverge" invariant rather than a
// structural guarantee. That mattered because `extractClassification` fails
// open to an empty table set, and that set drives the approval gate and PII
// masking: a classifier that could diverge from the whitelist could silently
// un-gate a query.
//
// `parseOnce` collapses all of it: `parser.parse` returns `{ ast, tableList,
// columnList }` from a SINGLE parse. Every consumer (statement-shape guard,
// ONLY-guard, whitelist, classifier) reads from this one result, so they share
// one table set by construction. In node-sql-parser 5.x `astify` is defined AS
// `parse(...).ast`, so `parser.parse` throws exactly when `astify` would and
// the reject-on-unparseable behavior is unchanged.

interface ParsedQuery {
  /** Statement AST (array for multi-statement input — rejected downstream). */
  readonly ast: AST | AST[];
  /** Raw table refs in node-sql-parser's `select::schema::table` format. */
  readonly tables: readonly string[];
  /** Raw column refs in node-sql-parser's `select::table::column` format. */
  readonly columns: readonly string[];
}

/** Parse `sql` exactly once, returning the shared `{ ast, tables, columns }`. */
function parseOnce(sql: string, dialect: string): ParsedQuery {
  const { ast, tableList, columnList } = parser.parse(sql, { database: dialect });
  return { ast, tables: tableList, columns: columnList };
}

/**
 * Reduce a `select::schema::table` ref to its lowercased table name — the
 * shared derivation the ONLY-guard, the classifier, and RLS all apply to the
 * one parse so their table sets can't drift.
 */
function tableNameFromRef(ref: string): string {
  return ref.split("::").pop()?.toLowerCase() ?? "";
}

// ── Classification ──────────────────────────────────────────────────

interface SQLClassification {
  readonly tablesAccessed: string[];
  readonly columnsAccessed: string[];
}

/**
 * The shared parse threaded out of {@link validateSQL} so RLS injection can
 * reuse it instead of re-parsing (#4349). `sql` is the exact normalized string
 * that was parsed; a downstream consumer reuses `tables` only when it is about
 * to operate on that same string (a plugin `beforeQuery` rewrite or a MySQL
 * executable-comment unwrap makes them diverge, and the consumer re-parses).
 *
 * `tables` is valid only for the connection/dialect that produced it — every
 * reuse site here shares the same `connId`, so the dialect is stable and is
 * deliberately NOT part of the reuse key (string identity suffices).
 */
interface ValidatedParse {
  readonly sql: string;
  readonly tables: readonly string[];
}

type SQLValidationResult =
  // `parsed` is always present on the valid standard-SQL path (validateSQL sets
  // it at its single return). It stays absent only for the invalid arm.
  | { valid: true; error?: undefined; classification: SQLClassification; parsed: ValidatedParse }
  | { valid: false; error: string; classification?: undefined; parsed?: undefined };

/**
 * Derive the classification (tables + columns accessed) from an ALREADY-parsed
 * query. Pure — no parse, no I/O — so it cannot fail independently of the
 * shared parse that produced `parsed`. CTE names are excluded from
 * `tablesAccessed`; `SELECT *` is stored as `["*"]` in `columnsAccessed`.
 *
 * This is the seam that closes #4349: `validateSQL` feeds the SAME
 * {@link ParsedQuery} to the whitelist check and to this function, so the
 * classifier's `tablesAccessed` is exactly the whitelist's table set (minus
 * CTEs). An empty `tablesAccessed` can now only mean a genuinely table-less
 * query — never a classifier parse that diverged from the whitelist and
 * fail-opened to empty.
 */
function classifyParsed(
  parsed: Pick<ParsedQuery, "tables" | "columns">,
  cteNames: Set<string>,
): SQLClassification {
  const tablesAccessed = [...new Set(
    parsed.tables
      .map(tableNameFromRef)
      .filter((t) => t && !cteNames.has(t)),
  )];

  const columnsAccessed = [...new Set(
    parsed.columns
      .map((ref) => {
        const col = ref.split("::").pop() ?? "";
        // node-sql-parser uses "(.*)" for SELECT *
        if (col === "(.*)") return "*";
        return col.toLowerCase();
      })
      .filter(Boolean),
  )];

  return { tablesAccessed, columnsAccessed };
}

/**
 * Extract table and column references from SQL.
 *
 * Best-effort: parses the query and returns empty arrays on parse failure.
 * Retained as the standalone (re-parsing) entry point for callers outside the
 * `validateSQL` pipeline; inside the pipeline the parse is shared via
 * {@link parseOnce} + {@link classifyParsed} so no re-parse happens (#4349).
 */
export function extractClassification(
  sql: string,
  dialect: string,
  cteNames: Set<string>,
): SQLClassification {
  try {
    return classifyParsed(parseOnce(sql, dialect), cteNames);
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

// #3342 L-3 — side-effecting / file / network / DoS functions that pass the
// statement-shape layers (a table-less `SELECT pg_read_file(...)` is a valid
// single SELECT against no whitelisted table). Checked via an AST walk over
// function-call nodes, NOT regex, so a string literal containing one of these
// names cannot false-positive. Defense-in-depth: the read-only role + the
// statement timeout already bound most of these; `dblink` writes over a
// separate connection, so only role privileges stop it without this list.
const FORBIDDEN_FUNCTIONS = new Set([
  // PostgreSQL — filesystem / large-object access
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_logdir_ls",
  "lo_import",
  "lo_export",
  // PostgreSQL — server administration
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_create_restore_point",
  "pg_switch_wal",
  "pg_promote",
  // dblink — side-channel connections (writes bypass the read-only session)
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "dblink_connect_u",
  "dblink_open",
  "dblink_send_query",
  // DoS / timing
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "sleep",
  "benchmark",
  // MySQL — filesystem / UDF escapes
  "load_file",
  "sys_eval",
  "sys_exec",
]);

/**
 * Extract the call name from a `function` / `aggr_func` AST node.
 * node-sql-parser 5.x shapes: `aggr_func.name` is a string;
 * `function.name` is `{ name: [{ value: "pg_read_file" }, ...] }` where a
 * schema-qualified call (`pg_catalog.pg_read_file`) yields multiple parts —
 * the last part is the function proper.
 */
function functionCallName(node: { name?: unknown }): string | undefined {
  const name = node.name;
  if (typeof name === "string") return name.toLowerCase();
  if (name && typeof name === "object") {
    const parts = (name as { name?: unknown }).name;
    if (Array.isArray(parts) && parts.length > 0) {
      const last = parts[parts.length - 1] as { value?: unknown };
      if (typeof last?.value === "string") return last.value.toLowerCase();
    }
  }
  return undefined;
}

/** Walk a statement AST and return the first forbidden function name, if any. */
function findForbiddenFunction(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findForbiddenFunction(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;

  const typed = node as { type?: unknown; name?: unknown };
  if (typed.type === "function" || typed.type === "aggr_func") {
    const callName = functionCallName(typed);
    if (callName && FORBIDDEN_FUNCTIONS.has(callName)) return callName;
  }
  for (const value of Object.values(node)) {
    const found = findForbiddenFunction(value);
    if (found) return found;
  }
  return undefined;
}

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
export function parserDatabase(dbType: DBType, connectionId?: string, workspaceId?: string): string {
  // 1. Plugin metadata takes precedence. Scoped to (workspace, install_id) so a
  //    shared install_id can't apply a sibling's plugin dialect — native
  //    per-workspace configs return undefined here and fall through to the
  //    dbType switch (which getDBType already resolved per-workspace) (#3109).
  if (connectionId) {
    const pluginDialect = connections.getParserDialect(connectionId, workspaceId);
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
function getExtraPatterns(dbType: DBType, connectionId?: string, workspaceId?: string): RegExp[] {
  // 1. Plugin metadata takes precedence. Workspace-scoped for the same reason as
  //    parserDatabase — a native per-workspace config returns [] here so the
  //    dbType switch below supplies the right base patterns (#3109).
  if (connectionId) {
    const pluginPatterns = connections.getForbiddenPatterns(connectionId, workspaceId);
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

/**
 * Parse `sql` exactly once (via {@link parseOnce}) and run the statement-shape
 * guards: single statement, SELECT-only, no `SELECT ... INTO <table>`, no
 * forbidden side-effecting function, and — PG-family only — no bare `ONLY`
 * table modifier. Returns the shared parse and the collected CTE names so the
 * whitelist check and the classifier downstream consume ONE table set (#4349).
 *
 * A parse failure or a shape violation is returned as `{ ok: false, error }`;
 * the caller maps it to the `{ valid: false }` validation result verbatim.
 */
function parseAndGuardShape(
  sql: string,
  dialect: string,
):
  | { ok: true; parsed: ParsedQuery; cteNames: Set<string> }
  | { ok: false; error: string } {
  let parsed: ParsedQuery;
  try {
    parsed = parseOnce(sql, dialect);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    return {
      ok: false,
      error: `Query could not be parsed.${detail ? ` ${detail}.` : ""} Rewrite using standard SQL syntax.`,
    };
  }

  const statements = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];

  // Single-statement check — reject batched queries
  if (statements.length > 1) {
    return { ok: false, error: "Multiple statements are not allowed" };
  }

  const cteNames = new Set<string>();
  for (const stmt of statements) {
    if (stmt.type !== "select") {
      return { ok: false, error: `Only SELECT statements are allowed, got: ${stmt.type}` };
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
        ok: false,
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

    // #3342 L-3 — block side-effecting / file / network / DoS functions.
    const forbiddenFn = findForbiddenFunction(stmt);
    if (forbiddenFn) {
      return {
        ok: false,
        error: `Function "${forbiddenFn}" is not allowed — file, network, administrative, and timing functions are blocked.`,
      };
    }
  }

  // F-20 (#3346): reject PG-family queries whose extracted table set
  // contains the bare keyword ONLY. node-sql-parser mis-models
  // `SELECT * FROM ONLY accounts` as table "ONLY" with alias "accounts",
  // dropping the real relation from `tableList` — which silently defeats
  // the whitelist (when disabled), named RLS policies, and audit
  // classification. The agent can always drop the inheritance modifier.
  // Derives from the SHARED parse — no re-parse (#4349).
  if (!/mysql|mariadb/i.test(dialect)) {
    for (const ref of parsed.tables) {
      // No CTE exemption: a CTE named `only` would otherwise mask a real
      // `FROM ONLY accounts` mis-parse (the CTE name and the keyword are
      // the same lowered token). ONLY is a reserved word in PG anyway —
      // an unquoted CTE cannot legitimately carry that name.
      if (tableNameFromRef(ref) === "only") {
        return {
          ok: false,
          error:
            "The PostgreSQL ONLY table modifier is not supported. Rewrite the query without ONLY (e.g. SELECT ... FROM accounts).",
        };
      }
    }
  }

  return { ok: true, parsed, cteNames };
}

export async function validateSQL(
  sql: string,
  connectionId?: string,
  workspaceId?: string,
  executionTarget?: ExecutionTarget,
): Promise<SQLValidationResult> {
  // `workspaceId` scopes the dbType, the dialect/pattern lookups, AND the table
  // whitelist below to the per-(workspace, install_id) config, so a shared
  // install_id validates against the querying workspace's actual dialect +
  // entities — not the bare first-registered row's (#3109). Default it to the
  // active org when a caller omits it: request-scoped flows (validate-sql route,
  // create-dashboard) run authenticated, so the active workspace is the correct
  // scope (Codex review). Explicit callers (agent pipeline, scheduler dashboard
  // refresh — which has no request context) pass their own.
  workspaceId ??= getRequestContext()?.user?.activeOrganizationId;

  // Resolve DB type for this connection. When an explicit connectionId is given
  // but not found, return a validation error instead of silently falling back —
  // wrong parser mode is a security risk.
  let dbType: DBType;
  if (connectionId) {
    try {
      dbType = connections.getDBType(connectionId, workspaceId);
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
  const extraPatterns = getExtraPatterns(dbType, connectionId, workspaceId);
  const patterns = [...FORBIDDEN_PATTERNS, ...extraPatterns];
  for (const pattern of patterns) {
    if (pattern.test(forRegex)) {
      return {
        valid: false,
        error: `Forbidden SQL operation detected: ${pattern.source}`,
      };
    }
  }

  // Resolve the node-sql-parser dialect ONCE for this validation — every
  // downstream parse consumer (statement-shape guard, ONLY-guard, whitelist,
  // classifier) reads this single value instead of recomputing the plugin
  // registry lookup per parse (#4349).
  const dialect = parserDatabase(dbType, connectionId, workspaceId);

  // 2. AST validation — parse ONCE, then run the statement-shape guards.
  //
  // Security rationale: if the regex guard (layer 1) passed but the parser
  // cannot parse the query, we REJECT it rather than allowing it through — a
  // query that passes regex but confuses the parser could be a crafted bypass.
  // The single parse produced here feeds the ONLY-guard, the table whitelist
  // below, and the classifier, so their table sets cannot diverge (#4349).
  const shape = parseAndGuardShape(trimmed, dialect);
  if (!shape.ok) {
    return { valid: false, error: shape.error };
  }
  const { parsed, cteNames } = shape;

  // 3. Table whitelist check — use getSettingAuto for SaaS hot-reload
  const whitelistSetting = getSettingAuto("ATLAS_TABLE_WHITELIST") ?? process.env.ATLAS_TABLE_WHITELIST;
  if (whitelistSetting === "false") {
    warnWhitelistDisabled();
  } else {
    try {
      // Reuse the SHARED parse (#4349) — the same table set the classifier
      // reads below, so the whitelist bucket and the classification can't drift.
      const tables = parsed.tables;
      const sqlReqCtx = getRequestContext();
      // Use the resolved workspace scope (above) for the whitelist — not just the
      // request context. Scheduler-driven callers (dashboard auto-refresh) have
      // no request context but pass an explicit workspaceId, so the whitelist
      // must follow it or org-scoped cards validate against the wrong entities
      // while executing against the workspace's own pool (#3109, Codex review).
      const orgId = workspaceId;
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
      // #3961 — an UNPINNED chat conversation ("All sources" reach, no
      // agent-named group) carries the conversation's own connection id as
      // `currentMember` (`requestContextConnectionId`), NOT the literal
      // `"default"` sentinel the #3947 union fallback keyed on. That real id
      // matches no entity bucket (entities key under `connection_group_id`), so
      // the direct lookup missed AND the literal-`"default"` union was bypassed →
      // every demo table rejected on the first answer, while `/api/v1/tables`
      // (fetched with no connectionId → resolves "default" → unions) still listed
      // the full demo set. The unpinned case — All-sources reach AND the lookup
      // id IS the conversation's own connection — tells the whitelist to union
      // every bucket, matching `/api/v1/tables`.
      //
      // The `unpinned` flag + resolved bucket id come from the single
      // `resolveExecutionTarget` SSOT (`group-reach/execution-target.ts`): the
      // `executeSQL` pipeline threads an `executionTarget` built from the
      // POST-reach/post-routing member id, and non-execute callers fall back to
      // re-deriving it here from the request context + this leg's connectionId.
      // Both compute the SAME `unpinned` — that is the whole point of this SSOT,
      // and why the whitelist bucket a query validates against can no longer
      // drift from the member it executes against. See the interface doc for the
      // load-bearing `connectionId === reqCtx.connectionId` (no sibling widening)
      // and falsy-but-non-null `groupReach` ("all") invariants.
      const target = executionTarget ?? resolveExecutionTarget(sqlReqCtx, connectionId);
      const allowed = orgId
        ? getOrgWhitelistedTables(orgId, target.connectionId, sqlReqCtx?.atlasMode, {
            unpinned: target.unpinned,
          })
        : getWhitelistedTables(target.connectionId);

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
        const rawTableName = parts.pop();
        const tableName = rawTableName?.toLowerCase();
        // node-sql-parser returns "null" (the string) for unqualified tables — filter it out
        const rawSchema = parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
        const schemaName = rawSchema && rawSchema !== "null" ? rawSchema : undefined;
        if (!tableName || cteNames.has(tableName)) continue;

        // #3342 L-4 — quoted mixed-case identifiers resolve to a DIFFERENT
        // relation than the case-folded whitelist entry (`FROM "Orders"` is
        // not table `orders` on PG, and table names are case-sensitive on
        // Linux MySQL). The parser drops quoting info, so detect the quoted
        // form in the raw SQL: an unquoted mixed-case name (which the DB
        // case-folds to the whitelist entry on PG) stays accepted.
        if (
          rawTableName &&
          rawTableName !== tableName &&
          (trimmed.includes(`"${rawTableName}"`) || trimmed.includes(`\`${rawTableName}\``))
        ) {
          return {
            valid: false,
            error:
              `Quoted mixed-case table "${rawTableName}" does not match the semantic-layer table ` +
              `"${tableName}" — quoted identifiers are case-sensitive. Use the unquoted lowercase name.`,
          };
        }

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
      // The table refs come from the shared parse (step 2 already succeeded);
      // this catch now guards the whitelist LOAD/LOOKUP (loadOrgWhitelist,
      // getOrgWhitelistedTables, resolveExecutionTarget). A failure here must
      // reject to avoid bypassing the whitelist.
      log.warn({ err, sql: trimmed.slice(0, 200) }, "Whitelist resolution failed after successful AST parse");
      return {
        valid: false,
        error: "Could not verify table permissions. Rewrite using standard SQL syntax.",
      };
    }
  }

  // 4. Derive classification data from the SHARED parse (best-effort, never
  // blocks validation). Same table set the whitelist consumed above, so a
  // classify divergence can no longer fail-open to an empty set that bypasses
  // the approval gate / PII masking (#4349).
  const classification = classifyParsed(parsed, cteNames);

  // Thread the shared parse out so RLS injection can reuse it instead of
  // re-parsing the (unchanged) query at execution time (#4349).
  return { valid: true, classification, parsed: { sql: trimmed, tables: parsed.tables } };
}

let lastWarnedRowLimit: string | undefined;

/**
 * Read row limit from settings cache (workspace DB override > platform DB
 * override > env var > default). Called per-query so admin changes take
 * effect without restart; `orgId` threads the workspace tier (#3406) —
 * without it the org-scoped override row written by a workspace admin is
 * never consulted.
 */
function getRowLimit(orgId?: string): number {
  const raw = getSetting("ATLAS_ROW_LIMIT", orgId) ?? "1000";
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

/**
 * Read query timeout from settings cache (workspace DB override > platform
 * DB override > env var > default). Called per-query so admin changes take
 * effect without restart; `orgId` threads the workspace tier (#3406).
 */
function getQueryTimeout(orgId?: string): number {
  const raw = getSetting("ATLAS_QUERY_TIMEOUT", orgId) ?? "30000";
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
  | QueryExecutionError
  | EnterpriseUnavailableError;

/** Resolve the database connection. Fails with tagged connection errors. */
function resolveConnectionEffect(
  connId: string,
  /** Org ID used for pool routing — gated on `isOrgPoolingEnabled()` in SaaS. */
  orgId: string | undefined,
  atlasMode: import("@useatlas/types/auth").AtlasMode,
  /** Org ID from auth context — undefined in unauthenticated self-hosted mode. Used for mode visibility. */
  authOrgId: string | undefined,
): Effect.Effect<
  // `poolOrgId` is the org under which the SERVED pool is keyed in `orgEntries`,
  // or undefined for the bare pool. Pool metrics (recordQuery/Error/Success)
  // must use it — NOT the pooling-gated `orgId` — so a workspace clone created
  // on the org-pooling-OFF path is the one that gets accounted/auto-drained,
  // not the unrelated bare entry (#3109, Codex review).
  { db: DBConnection; dbType: DBType; poolOrgId: string | undefined },
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
      const resolvedConnId = connId;
      // Org under which the served pool is keyed (for pool metrics). When org
      // pooling is ON this IS `orgId`; the bare paths leave it undefined.
      let poolOrgId = orgId;
      if (orgId) {
        // Region is a deploy-time constant — the process IS the region
        // (ADR-0024). Resolve the normal org-scoped pool; there is no
        // per-request region routing to overlay.
        db = connections.getForOrg(orgId, connId);
      } else if (connId === "default") {
        db = connections.getDefault();
      } else if (authOrgId) {
        // Org pooling disabled but a workspace context is present: route per
        // (workspace, install_id) so a shared install_id resolves the correct
        // tenant's DB. Bare `get(connId)` would return whichever workspace
        // registered the install_id first (#3109).
        db = connections.getForWorkspace(authOrgId, connId);
        // If a per-workspace clone actually backs this read, pool metrics must
        // target that clone (keyed by authOrgId) rather than the bare entry —
        // otherwise a failing clone never auto-drains (#3109, Codex review).
        if (connections.hasForWorkspace(authOrgId, connId)) {
          poolOrgId = authOrgId;
        }
      } else {
        db = connections.get(connId);
      }
      // Scope dbType to the querying workspace too — even when org pooling is ON,
      // the bare `getDBType` would return a sibling's dialect for a shared
      // install_id (#3109).
      const dbType = connections.getDBType(resolvedConnId, authOrgId);
      return { db, dbType, poolOrgId };
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
  dbType: DBType,
  customValidator: CustomValidator | undefined,
  workspaceId?: string,
  executionTarget?: ExecutionTarget,
): Effect.Effect<{ ok: true; classification?: SQLClassification; parsed?: ValidatedParse } | { ok: false; error: string; auditError: string }> {
  if (!customValidator) {
    return Effect.promise(async () => {
      const validation = await validateSQL(sql, connId, workspaceId, executionTarget);
      if (!validation.valid) {
        return { ok: false as const, error: validation.error, auditError: `Validation rejected: ${validation.error}` };
      }
      return { ok: true as const, classification: validation.classification, parsed: validation.parsed };
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

/**
 * Apply RLS conditions. Returns the (possibly modified) SQL. Fails with RLSError.
 *
 * `validatedParse` (#4349) is the shared parse threaded out of `validateSQL`.
 * When it describes the EXACT string this function is about to inject into,
 * RLS reuses its table refs instead of re-parsing — the fifth parse in the old
 * pipeline. It's deliberately reused only on an exact-string match: a plugin
 * `beforeQuery` rewrite or a MySQL executable-comment unwrap makes the executed
 * string diverge from what was validated, and RLS then re-parses the string it
 * will actually inject into (the correct target for filter resolution).
 */
function applyRLSEffect(
  sql: string,
  connId: string,
  dbType: DBType,
  targetHost: string | undefined,
  validatedParse?: ValidatedParse,
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

    // Extract tables — reuse the shared parse when the executed string is
    // byte-identical to what was validated (the common case: no plugin rewrite
    // and no MySQL executable-comment unwrap actually changed it), else
    // re-parse (#4349). The reuse branch's refs came from the workspace-scoped
    // dialect and the fallback uses the connection dialect; table-NAME
    // extraction is dialect-invariant, so the asymmetry is intentional.
    const queriedTables = yield* Effect.try({
      try: () => {
        const tableRefs =
          validatedParse && validatedParse.sql === sql
            ? validatedParse.tables
            : parser.tableList(sql, { database: parserDatabase(dbType, connId) });
        return new Set(
          tableRefs
            .map(tableNameFromRef)
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

/**
 * The response record produced by a successful SQL execution — the payload
 * carried by {@link SqlPipelineOutcome}'s `executed` outcome. Built at TWO
 * sites: {@link executeAndAuditEffect}'s live-query success path and the
 * cache-hit constructor inside the `check-cache` pre-step. Both `satisfies`
 * this interface so a field rename in one constructor is caught at compile
 * time (previously the record was an untyped `Record<string, unknown>` and a
 * rename could silently desync the `runUserQueryPipeline` adapter's field
 * reads).
 *
 * `success` is always `true` here — the failure record shape lives in
 * {@link pipelineErrorToResponse} and the wrappers' `{ success: false }`
 * branches. `metadata` is present only when a plugin `beforeQuery` hook wrote
 * into the mutable `hookMetadata` bag (the only hook whose dispatch context
 * carries it). The agent wrapper widens this back to `Record<string, unknown>`
 * at its single return seam, since the downstream consumers — the fanout
 * merger and the single-env contribution wrapper — read the tool response by
 * key as an opaque record.
 */
interface ExecutedSqlResult {
  readonly success: true;
  readonly explanation: string;
  readonly row_count: number;
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly truncated: boolean;
  readonly cached: boolean;
  readonly maskingApplied: boolean;
  readonly executionMs: number;
  readonly metadata?: Record<string, unknown>;
}

function executeAndAuditEffect(opts: {
  db: DBConnection;
  dbType: DBType;
  connId: string;
  orgId: string | undefined;
  /** Org under which the SERVED pool is keyed — drives pool metrics so a
   *  workspace clone (org-pooling-OFF path) is accounted/auto-drained, not the
   *  bare entry. Defaults to `orgId` when unset. See {@link resolveConnectionEffect}. */
  poolOrgId?: string | undefined;
  targetHost: string | undefined;
  querySql: string;
  queryTimeout: number;
  rowLimit: number;
  explanation: string;
  classification: SQLClassification | undefined;
  cacheKey: string | null;
  hookMetadata: Record<string, unknown>;
  dispatchHook: (event: "afterQuery", ctx: Record<string, unknown>) => Promise<void>;
  /** Positional bind values for parameterized queries (#2267) — forwarded to
   *  the driver's bind protocol, never interpolated into `querySql`. */
  bindParams?: readonly unknown[];
  /** Parent audit row id when this execution is one leg of a fanout. */
  parentAuditId?: string;
  /** Routing mode for the parent `executeSQL` call. Stamped on the OTel span. */
  routingMode?: RoutingMode;
  /** Connection group id (for the OTel `atlas.connection_group_id` attribute). */
  connectionGroupId?: string;
  /** Planner reason that picked this connection (for the OTel `atlas.routing_reason` attribute). */
  routingReason?: RoutingReason;
}): Effect.Effect<ExecutedSqlResult, QueryExecutionError | EnterpriseUnavailableError> {
  const {
    db, dbType, connId, orgId, poolOrgId, targetHost, querySql, queryTimeout,
    rowLimit, explanation, classification, cacheKey, hookMetadata, dispatchHook,
    bindParams, parentAuditId, routingMode, connectionGroupId, routingReason,
  } = opts;
  // Pool metrics key off the served pool; SLA + masking stay on `orgId`.
  const metricsOrgId = poolOrgId ?? orgId;

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
        () => db.query(querySql, queryTimeout, bindParams),
        (r) => ({ "atlas.row_count": r.rows.length, "atlas.column_count": r.columns.length }),
      ),
    catch: (err) => {
      const durationMs = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : "Unknown database error";

      connections.recordQuery(connId, durationMs, metricsOrgId);
      connections.recordError(connId, metricsOrgId);

      // SLA metric (fire-and-forget) — via `SlaMetrics` Tag (#2568)
      if (orgId) {
        recordSlaMetric(orgId, durationMs, true).catch((slaErr) => {
          if (slaErr instanceof Error) {
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

          connections.recordQuery(connId, durationMs, metricsOrgId);
          connections.recordSuccess(connId, metricsOrgId);

          // SLA metric (fire-and-forget) — via `SlaMetrics` Tag (#2568)
          if (orgId) {
            void recordSlaMetric(orgId, durationMs, false).catch((slaErr) => {
              if (slaErr instanceof Error) {
                log.warn({ err: slaErr.message, connectionId: connId }, "SLA metric recording failed");
              }
            });
          }

          // Cache write (fail open)
          if (cacheKey) {
            try {
              getCache().set(cacheKey, {
                columns: result.columns, rows: result.rows,
                cachedAt: Date.now(), ttl: getDefaultTtl(),
                // #3616 — stamp the real execution cost so the cache-hit
                // audit row replays it instead of logging duration_ms=0.
                executionMs: durationMs,
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

          // Pattern learning (fire-and-forget). Capture org + connection group
          // SYNCHRONOUSLY here (#3610/#3611): `proposePatternIfNovel` spawns a
          // detached promise that runs AFTER this request's ALS context has
          // unwound. Reading the context inside that promise would resolve the
          // org to `undefined` → `org_id = NULL` (the global-scope sentinel),
          // leaking one org's patterns into every org, and would drop the
          // connection group so identical SQL from a different group collides.
          // We use the auth org (`activeOrganizationId`), NOT the pooling-gated
          // `orgId`, which is `undefined` when org-pooling is off. The masking
          // block below reads the same live context the same way.
          const learnReqCtx = getRequestContext();
          proposePatternIfNovel({
            sql: querySql, dialect: parserDatabase(dbType, connId), connectionId: connId,
            orgId: learnReqCtx?.user?.activeOrganizationId,
            connectionGroupId: learnReqCtx?.connectionGroupId,
            // Same wall-clock the audit/SLA path records — seeds/feeds the
            // pattern's rolling avg_duration_ms (#3635, PRD #3617 B-1).
            durationMs,
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
              // #2593 — fail-closed: when EE was supposed to bind but didn't
              // (`ATLAS_ENTERPRISE_ENABLED=true` + `available: false`), rethrow
              // so the outer catch surfaces it instead of returning unmasked
              // rows on classified tables.
              if (err instanceof EnterpriseUnavailableError) throw err;
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
          } satisfies ExecutedSqlResult;
        },
        catch: (err) => {
          // #2593 — preserve the `enterprise_load_failed` signal end-to-end
          // instead of wrapping as a generic post-processing failure.
          if (err instanceof EnterpriseUnavailableError) return err;
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
    case "EnterpriseUnavailableError":
      return { success: false, error: error.message, executionMs: 0 };
    default: {
      const _exhaustive: never = error;
      return { success: false, error: `Unknown pipeline error: ${(_exhaustive as { message: string }).message}`, executionMs: 0 };
    }
  }
}

// ── Unified SQL execution pipeline (#4185, ADR-0027) ────────────────
//
// ONE core effect owns the full choreography for every path that runs
// user- or agent-authored SQL:
//
//   resolve connection → validate (+ fail audit) → fail-closed approval
//   gate → source slot → plugin beforeQuery / re-validate → RLS →
//   row limit → execute + audit (+ mask + afterQuery)
//
// `runUserQueryPipeline` (the raw-query path: dashboards, metrics,
// validate-proposal, executeSQL-over-REST) and `executeSqlForConnection`
// (the agent `executeSQL` leaf, called directly and via
// `executeSqlFanout`) are THIN wrappers over this core: each contributes
// only its pre-step (dashboard parameter binding vs result-cache check),
// input adornments (fanout audit linkage, routing span attributes), and
// a result adapter (the
// `UserQueryOutcome` union vs the tool's `{success}` record). ADR-0027's
// invariant — "raw-SQL reach ≡ agent-loop reach for the same member" — is
// therefore structural: a governance fix to the pipeline cannot apply to
// one path and silently skip the other, because there is only one
// pipeline.

/** Fail-closed approval-gate messages — surfaced verbatim by both wrappers. */
const APPROVAL_UNAVAILABLE_MESSAGE =
  "Approval system unavailable — query blocked. Contact your administrator.";
const APPROVAL_IDENTITY_MISSING_MESSAGE =
  "This query requires approval but the requester identity could not be determined. Please sign in and try again.";

/**
 * Optional pipeline pre-step, discriminated so a caller can't accidentally
 * enable both: the raw path binds dashboard `:key` placeholders (#2267)
 * BEFORE validation; the agent path consults the result cache AFTER the
 * approval gate (a cache hit must never bypass governance or masking).
 */
type SqlPipelinePreStep =
  | {
      readonly kind: "bind-dashboard-parameters";
      /**
       * Resolved parameter values keyed by parameter key. A placeholder
       * without a value is rejected (fail closed), never interpolated.
       */
      readonly values: Record<string, string | number | null>;
    }
  | { readonly kind: "check-cache" };

export interface SqlPipelineOptions {
  readonly sql: string;
  /** Approval-request + response-surface description (e.g. "Dashboard preview: Weekly signups"). */
  readonly explanation: string;
  readonly connId: string;
  /**
   * Optional pre-step (see {@link SqlPipelinePreStep}). Direct callers
   * must pick the pre-step matching their surface: SQL carrying `:key`
   * placeholders REQUIRES `bind-dashboard-parameters` — without it the
   * explicit fail-closed placeholder rejection is skipped and the query
   * only fails later at AST validation with a less actionable parse
   * error.
   */
  readonly preStep?: SqlPipelinePreStep;
  /**
   * Parent audit row id when this execution is one leg of a cross-environment
   * fanout. Threaded through every `logQueryAudit` call so each audit row
   * carries the linkage. Undefined for single-env executions.
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
   * `atlas.routing_reason`.
   */
  readonly routingReason?: RoutingReason;
  /**
   * Pre-resolved execution target (post-reach/post-routing member id +
   * whitelist-widening `unpinned` flag) for THIS leg. Threaded into
   * `validateSQL` so the table whitelist a query validates against is the
   * SAME bucket the query executes against — the SSOT that closes the
   * #3961/#3947/#3109 drift. Fan-out resolves this PER-LEG; each leg carries
   * its own target, never a shared broadcast one. Undefined for callers that
   * don't route through `executeSQL` (validateSQL re-derives via fallback).
   */
  readonly executionTarget?: ExecutionTarget;
}

/**
 * Discriminated pipeline outcome. `executed` carries the response record
 * built by {@link executeAndAuditEffect} (or its cache-hit equivalent) —
 * wrappers adapt it to their own result shape. The approval outcomes carry
 * structured fields so each wrapper composes its own user-facing message
 * without the core duplicating either format.
 */
export type SqlPipelineOutcome =
  | { readonly kind: "executed"; readonly result: ExecutedSqlResult }
  | { readonly kind: "validation_failed"; readonly message: string }
  | { readonly kind: "approval_unavailable"; readonly message: string }
  | { readonly kind: "approval_identity_missing"; readonly message: string }
  | {
      readonly kind: "approval_required";
      readonly approvalRequestId: string;
      readonly ruleName: string;
      readonly matchedRules: readonly string[];
    };

/**
 * The unified SQL execution pipeline core. Exported so tests can exercise
 * the shared seam directly (approval fail-closed, RLS injection, row
 * limit) — the wrappers add only input adornments and result adapters.
 *
 * Tagged errors flow through the error channel; expected rejections
 * (validation, approval) return as outcome values.
 */
export function runSqlPipelineEffect(
  opts: SqlPipelineOptions,
): Effect.Effect<SqlPipelineOutcome, PipelineError> {
  const { sql, explanation, connId, preStep, parentAuditId, routingMode, routingReason, executionTarget } = opts;

  return Effect.gen(function* () {
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

    // Resolve connection (tagged errors)
    const { db, dbType, poolOrgId } = yield* resolveConnectionEffect(connId, orgId, atlasMode, authOrgId);

    const targetHost = connections.getTargetHost(connId, authOrgId);
    const customValidator = connections.getValidator(connId, authOrgId);
    let normalizedSql = sql.trim().replace(/;\s*$/, "").trimEnd();

    // Pre-step (raw path): dashboard parameters (#2267) — rewrite `:<key>`
    // placeholders to the dialect's positional binds and resolve the aligned
    // value array. The bound SQL (positional placeholders) is what gets
    // validated, RLS-injected, and executed; the values reach the DB ONLY
    // through the driver bind protocol. Any SQL carrying placeholders MUST
    // arrive with resolved values — a missing value or a non-bindable
    // dialect is rejected (fail closed), never sent to the DB with a raw
    // `:name` or interpolated.
    let bindParams: readonly unknown[] | undefined;
    if (preStep?.kind === "bind-dashboard-parameters" && extractPlaceholderNames(normalizedSql).length > 0) {
      if (!isBindableDbType(dbType)) {
        return {
          kind: "validation_failed" as const,
          message: "Parameterized queries are supported on PostgreSQL and MySQL datasources only.",
        };
      }
      try {
        const bound = bindDashboardParameters(normalizedSql, preStep.values, dbType);
        normalizedSql = bound.sql;
        bindParams = bound.values;
      } catch (err) {
        // `DashboardParameterError` is the expected fail-closed rejection
        // (missing value / bad placeholder) and carries an actionable
        // message. Anything else is an unexpected binder fault (e.g. a
        // `TypeError`) whose message we deliberately don't surface — log it
        // so it stays diagnosable instead of vanishing behind the generic
        // "Failed to bind query parameters." response.
        if (!(err instanceof DashboardParameterError)) {
          log.warn(
            { err: err instanceof Error ? err : new Error(String(err)), connectionId: connId },
            "Unexpected error binding dashboard parameters — returning generic bind-failure message",
          );
        }
        return {
          kind: "validation_failed" as const,
          message:
            err instanceof DashboardParameterError
              ? err.message
              : "Failed to bind query parameters.",
        };
      }
    }

    // Validate (custom validator or standard SQL validation)
    const initial = yield* runQueryValidationEffect(normalizedSql, connId, dbType, customValidator, authOrgId, executionTarget);
    if (!initial.ok) {
      logQueryAudit({
        sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
        error: initial.auditError, sourceId: connId, sourceType: dbType, targetHost,
        parentAuditId,
      });
      return { kind: "validation_failed" as const, message: initial.error };
    }
    // Classification is only populated for standard SQL (validateSQL path).
    // Custom validators (SOQL, GraphQL) bypass node-sql-parser so classification
    // stays undefined — their audit entries store NULL for tables/columns_accessed.
    const classification = initial.classification;
    // Shared parse for RLS reuse (#4349) — tracks whichever validation produced
    // the string RLS will inject into (updated on a plugin rewrite below).
    let parsedForRls = initial.parsed;

    // Enterprise approval check — the fail-closed gate, exactly once.
    // F-54 / F-55: this gate is fail-CLOSED. The previous behaviour
    // (catch → log.warn → proceed without approvalMatch) silently
    // bypassed governance whenever the EE module failed to import or
    // `checkApprovalRequired` rejected — a "catch { return false } on a
    // security check is a bug" pattern called out in CLAUDE.md. The gate
    // surfaces a clear "approval system unavailable" outcome so the
    // operator sees the failure instead of silently executing
    // approval-gated queries.
    //
    // When the caller binds no user, `checkApprovalRequired` itself
    // returns `required: true` with `identityMissing: true` if any
    // rule exists in the database; the Phase 2 user-identity gate below
    // routes that into the `approval_identity_missing` outcome
    // (`APPROVAL_IDENTITY_MISSING_MESSAGE`).
    if (classification) {
      // #3764 — compose the gate's per-method Effects with `yield*` instead of
      // dropping out to `async`/`Effect.runPromise` per call. `loadApprovalGate()`
      // resolves the EE-bound gate via the shared enterprise runtime (a legit
      // Promise→Effect boundary, NOT the re-entry smell), then the gate's
      // already-resolved Effects thread onto the surrounding pipeline fiber.
      //
      // Two distinct fail-closed regions are preserved exactly:
      //   1. CHECK (gate load + checkApprovalRequired) → on failure, surface
      //      `approval_unavailable` (block the query, don't bypass governance).
      //   2. CREATE (hasApprovedRequest + createApprovalRequest) → on failure,
      //      surface `QueryExecutionError` ("Approval workflow failed: …") so a
      //      governance-write failure blocks rather than silently executes.
      const check = yield* Effect.gen(function* () {
        const approvalGate = yield* Effect.tryPromise({
          try: () => loadApprovalGate(),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        });
        const checkReqCtx = getRequestContext();
        const checkOrgId = checkReqCtx?.user?.activeOrganizationId;
        const checkUserId = checkReqCtx?.user?.id;
        // #2072 — propagate the request's agent origin so
        // origin-scoped rules only fire on the matching transport.
        // Routes stamp this on `withRequestContext`; an unstamped
        // route (or a legacy caller) reaches checkApprovalRequired
        // with `origin: undefined` and only triggers `'any'`
        // rules — scope isolation rather than governance bypass,
        // since the `'any'` migration default still fires.
        const checkOrigin = checkReqCtx?.agentOrigin;
        // Pass requesterId so the defensive identity-missing check
        // distinguishes "scheduler/Slack/MCP forgot to bind anything"
        // (fail-closed) from "demo / single-user mode bound a user
        // but no org" (pass-through, no rule can match anyway).
        const approvalMatch = yield* approvalGate.checkApprovalRequired(
          checkOrgId, classification.tablesAccessed, classification.columnsAccessed,
          {
            ...(checkUserId ? { requesterId: checkUserId } : {}),
            ...(checkOrigin ? { origin: checkOrigin } : {}),
          },
        );
        return { approvalGate, approvalMatch } as const;
      }).pipe(
        // `catchAllCause` (not `catchAll`): `checkApprovalRequired`'s typed
        // error channel is `never`, so its only failure mode is a SYNCHRONOUS
        // throw (a packaging glitch / unexpected DB schema inside the EE
        // helper), which surfaces as a DEFECT — invisible to `catchAll`. The
        // pre-#3764 `async`/`try-catch` body caught both; we must too, or a
        // sync throw would escape the fail-closed gate as a 500.
        Effect.catchAllCause((cause) => {
          // Log the squashed Error object (a `FiberFailure` for a defect — an
          // Error subclass) so pino's `err` serializer keeps the stack, matching
          // the CREATE handler below + the P4 normalization (don't strip via
          // `.message`).
          log.error(
            { err: Cause.squash(cause), connectionId: connId },
            "Approval check failed — blocking query (fail-closed)",
          );
          return Effect.succeed({
            kind: "approval_unavailable" as const,
            message: APPROVAL_UNAVAILABLE_MESSAGE,
          });
        }),
      );
      // The catch branch returns the failure outcome with no `approvalGate`;
      // discriminate on its presence to know the check succeeded.
      if (!("approvalGate" in check)) return check;
      const { approvalGate, approvalMatch } = check;

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
            kind: "approval_identity_missing" as const,
            message: APPROVAL_IDENTITY_MISSING_MESSAGE,
          };
        }

        const createOutcome = yield* Effect.gen(function* () {
          const alreadyApproved = yield* approvalGate.hasApprovedRequest(approvalOrgId, userId, normalizedSql, connId);
          if (alreadyApproved) return null;
          const firstRule = approvalMatch.matchedRules[0];
          const approvalReq = yield* approvalGate.createApprovalRequest({
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
            // #2072 — stamp the agent origin on the queue row
            // for the audit dimension (queryable via direct SQL
            // until an origin filter ships in /admin/audit).
            origin: reqCtxForApproval?.agentOrigin ?? null,
          });
          logQueryAudit({
            sql: normalizedSql.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
            error: `Approval required: ${firstRule.name}`,
            sourceId: connId, sourceType: dbType, targetHost,
            parentAuditId,
          });
          return {
            kind: "approval_required" as const,
            approvalRequestId: approvalReq.id,
            ruleName: firstRule.name,
            matchedRules: approvalMatch.matchedRules.map((r) => r.name),
          };
        }).pipe(
          // `catchAllCause`, like the check region: map BOTH typed failures
          // (createApprovalRequest's ApprovalError | EnterpriseError | Error)
          // AND defects (a sync throw inside the gate) to a typed
          // `QueryExecutionError` so a governance-write failure blocks the
          // query rather than escaping — the pre-#3764 outer `catch` did both.
          Effect.catchAllCause((cause) => {
            const err = Cause.squash(cause);
            const message = err instanceof Error ? err.message : String(err);
            log.error({ err, connectionId: connId }, "Approval workflow failed — blocking query");
            return Effect.fail(new QueryExecutionError({ message: `Approval workflow failed: ${message}` }));
          }),
        );
        if (createOutcome !== null) return createOutcome;
      }
    }

    // Pre-step (agent path): result-cache check (short-circuit on hit).
    // Deliberately AFTER the approval gate so a cache hit can never bypass
    // governance, and masking + the CURRENT row limit apply before serving.
    let cacheKey: string | null = null;
    if (preStep?.kind === "check-cache" && cacheEnabled()) {
      try {
        const ctx = getRequestContext();
        const cacheOrgId = ctx?.user?.activeOrganizationId;
        const claims = ctx?.user?.claims;
        cacheKey = buildCacheKey(normalizedSql, connId, cacheOrgId, claims);
        const cached = getCache().get(cacheKey);
        if (cached) {
          // Wrapped locally (mirrors the live-path audit in
          // `executeAndAuditEffect`) so an audit-write failure on a hit
          // doesn't fall through to the outer catch — that catch mislabels
          // any throw here as "Cache read failed" and needlessly re-executes
          // the query, silently defeating the cache. A failed audit log
          // should not cost us the cache hit.
          try {
            logQueryAudit({
              // #3616 — replay the original execution duration persisted on
              // the cache entry so this hit carries the query's real cost,
              // not duration_ms=0. Falls back to 0 only for legacy/external
              // entries written before executionMs was stamped.
              sql: normalizedSql.slice(0, 2000), durationMs: cached.executionMs ?? 0,
              rowCount: cached.rows.length,
              success: true, sourceId: connId, sourceType: dbType, targetHost,
              parentAuditId,
            });
          } catch (auditErr) {
            log.warn(
              { err: auditErr instanceof Error ? auditErr.message : String(auditErr), connectionId: connId },
              "Failed to write cache-hit query audit log",
            );
          }
          // Apply PII masking to cached results (same as live query path)
          const cacheResponse = yield* Effect.tryPromise({
            try: async () => {
              // #3406 — enforce the CURRENT row limit (workspace tier
              // included) on cache hits, not just the limit that applied
              // when the entry was written: an admin lowering the cap (or
              // adding a workspace override) must bound cached responses
              // too, matching the fresh-query path where the limit rides
              // the SQL itself. Slice before masking so dropped rows are
              // never masked.
              const cacheRowLimit = getRowLimit(authOrgId);
              let cachedRows = cached.rows.length > cacheRowLimit
                ? cached.rows.slice(0, cacheRowLimit)
                : cached.rows;
              const cachedTruncated = cached.rows.length >= cacheRowLimit;
              let cachedMaskingApplied = false;
              if (classification?.tablesAccessed.length && orgId) {
                const preMaskRows = cachedRows;
                try {
                  cachedRows = await applyMaskingViaTag({
                    columns: cached.columns, rows: preMaskRows,
                    tablesAccessed: classification.tablesAccessed,
                    orgId, userRole: ctx?.user?.role,
                    connectionId: connId,
                  });
                  cachedMaskingApplied = cachedRows !== preMaskRows;
                } catch (err) {
                  // #2593 — `EnterpriseUnavailableError` (EE failed to bind
                  // on SaaS) is fail-CLOSED; any other masking failure
                  // deliberately fails OPEN (warn + serve unmasked), the
                  // same scope as the live path in `executeAndAuditEffect`.
                  if (err instanceof EnterpriseUnavailableError) throw err;
                  log.warn(
                    { err: err instanceof Error ? err.message : String(err), connectionId: connId },
                    "PII masking failed on cached results — returning unmasked results",
                  );
                }
              }
              return {
                success: true, explanation, row_count: cachedRows.length,
                columns: cached.columns, rows: cachedRows,
                truncated: cachedTruncated, cached: true,
                maskingApplied: cachedMaskingApplied,
                // Cost of *serving this hit* (~0, no DB round-trip) — NOT the
                // original execution cost. The query's real duration is
                // replayed onto the audit row above via `cached.executionMs`;
                // this response field intentionally reports the cache-serve
                // cost (#3616 naming: two distinct "executionMs" meanings).
                executionMs: 0,
              } satisfies ExecutedSqlResult;
            },
            catch: (err) => {
              // #2593 — preserve fail-closed signal through the cache path.
              if (err instanceof EnterpriseUnavailableError) return err;
              const message = err instanceof Error ? err.message : String(err);
              log.error({ err, connectionId: connId }, "Cache response processing failed");
              return new QueryExecutionError({ message: `Cache response processing failed: ${message}` });
            },
          });
          return { kind: "executed" as const, result: cacheResponse };
        }
      } catch (cacheErr) {
        log.error({ err: cacheErr, connectionId: connId }, "Cache read failed — executing query against database");
        cacheKey = null;
      }
    }

    // Execute inside a rate-limit slot (concurrency release is automatic):
    // plugin beforeQuery → re-validate → RLS → auto-LIMIT → execute + audit.
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
        // Which SQL string the hook receives is derived from the pre-step
        // (keeping it a free option would let a caller desync the hook
        // input from the bind array): the agent path (`check-cache`)
        // historically hands plugins the ORIGINAL (untrimmed, possibly
        // `;`-suffixed) SQL; the raw path hands the normalized/bound SQL
        // so the hook, re-validation, RLS, and execution all operate on
        // the same string the bind array aligns to (#2267). Plugins that
        // rewrite SQL must preserve placeholder order for parameterized
        // cards.
        const hookInputSql = preStep?.kind === "check-cache" ? sql : normalizedSql;
        const hookCtx = { sql: hookInputSql, connectionId: connId, metadata: hookMetadata };
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
          const revalidation = yield* runQueryValidationEffect(normalizedMutated, connId, dbType, customValidator, authOrgId);
          if (!revalidation.ok) {
            logQueryAudit({
              sql: normalizedMutated.slice(0, 2000), durationMs: 0, rowCount: null, success: false,
              error: `Plugin-rewritten SQL failed validation: ${revalidation.auditError}`,
              sourceId: connId, sourceType: dbType, targetHost,
              parentAuditId,
            });
            return { kind: "validation_failed" as const, message: `Plugin-rewritten SQL failed validation: ${revalidation.error}` };
          }
          // The re-validation reparsed the rewritten SQL — carry its parse so RLS
          // reuses it rather than parsing the mutated string a third time (#4349).
          parsedForRls = revalidation.parsed;
        }

        // RLS: inject WHERE conditions (skipped for custom validators / non-SQL languages)
        if (!customValidator) {
          normalizedMutated = yield* applyRLSEffect(normalizedMutated, connId, dbType, targetHost, parsedForRls);
        }

        // Auto-append LIMIT if not present
        const rowLimit = getRowLimit(authOrgId);
        const queryTimeout = getQueryTimeout(authOrgId);
        let querySql = normalizedMutated;
        if (!customValidator && !hasLimitClause(querySql, { backslashEscapes: dbType === "mysql" })) {
          querySql = appendRowLimit(querySql, rowLimit);
        }

        // Execute the query
        const result = yield* executeAndAuditEffect({
          db, dbType, connId, orgId, poolOrgId, targetHost, querySql, queryTimeout,
          rowLimit, explanation, classification, cacheKey,
          hookMetadata, dispatchHook, bindParams, parentAuditId, routingMode, routingReason,
        });
        return { kind: "executed" as const, result };
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
}

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
  | { readonly kind: "query_failed"; readonly message: string }
  | { readonly kind: "enterprise_unavailable"; readonly message: string };

export interface RunUserQueryOpts {
  readonly sql: string;
  readonly connectionId?: string;
  /** Approval-request + response-surface description (e.g. "Dashboard preview: Weekly signups"). */
  readonly explanation: string;
  /**
   * Resolved dashboard parameter values keyed by parameter key (#2267). When
   * `sql` carries `:<key>` placeholders, each name is rewritten to a positional
   * bind and its value is pulled from here — values reach the DB ONLY through
   * the driver's bind protocol, never string interpolation. Produced by
   * `resolveDashboardParameterValues`. Required (per-placeholder) whenever the
   * SQL has placeholders: a missing value is rejected, not interpolated.
   */
  readonly parameters?: Record<string, string | number | null>;
}

/**
 * Run user-authored SQL through the production pipeline and return a
 * discriminated outcome. Thin wrapper over {@link runSqlPipelineEffect}:
 * contributes the dashboard-parameter pre-step (#2267) and adapts the
 * shared outcome onto the {@link UserQueryOutcome} union. Used by the
 * dashboard canvas preview, single-card refresh, bulk refresh, metrics,
 * validate-proposal, and executeSQL-over-REST — every site that runs
 * user-authored SQL but isn't the agent tool itself.
 */
export function runUserQueryPipeline(opts: RunUserQueryOpts): Promise<UserQueryOutcome> {
  const connId = opts.connectionId ?? "default";

  const pipeline: Effect.Effect<UserQueryOutcome, PipelineError> = runSqlPipelineEffect({
    sql: opts.sql,
    explanation: opts.explanation,
    connId,
    preStep: { kind: "bind-dashboard-parameters", values: opts.parameters ?? {} },
  }).pipe(
    Effect.map((outcome): UserQueryOutcome => {
      switch (outcome.kind) {
        case "executed": {
          const result = outcome.result;
          return {
            kind: "ok",
            columns: result.columns,
            rows: result.rows,
            rowCount: result.row_count,
            executionMs: result.executionMs,
            truncated: result.truncated,
            maskingApplied: result.maskingApplied,
          };
        }
        case "validation_failed":
        case "approval_unavailable":
        case "approval_identity_missing":
          return outcome;
        case "approval_required":
          return {
            kind: "approval_required",
            approvalRequestId: outcome.approvalRequestId,
            matchedRules: [...outcome.matchedRules],
            message:
              `This query requires approval before execution. Rule: "${outcome.ruleName}". ` +
              `An approval request has been submitted (ID: ${outcome.approvalRequestId}).`,
          };
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    }),
  );

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
          case "EnterpriseUnavailableError":
            // #2593 — surface the fail-closed signal end-to-end so the
            // route handler can return 503 `enterprise_load_failed`.
            return Effect.succeed({ kind: "enterprise_unavailable", message: error.message });
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
 * named member id, PRD #2515 / slice 1 #2516). Thin wrapper over
 * {@link runSqlPipelineEffect}: contributes the result-cache pre-step +
 * fanout/routing adornments, and adapts the shared outcome onto the
 * tool's `{success: true | false, ...}` response shape as an opaque
 * record — the merger then reads `columns` / `rows` / `error` from each
 * per-member outcome to compose the fanned-out result.
 */
async function executeSqlForConnection({
  sql,
  explanation,
  connId,
  parentAuditId,
  routingMode,
  routingReason,
  executionTarget,
}: {
  readonly sql: string;
  readonly explanation: string;
  readonly connId: string;
  /** See {@link SqlPipelineOptions.parentAuditId}. */
  readonly parentAuditId?: string;
  /** See {@link SqlPipelineOptions.routingMode}. */
  readonly routingMode?: RoutingMode;
  /** See {@link SqlPipelineOptions.routingReason}. */
  readonly routingReason?: RoutingReason;
  /** See {@link SqlPipelineOptions.executionTarget}. Per-leg; never shared. */
  readonly executionTarget?: ExecutionTarget;
}): Promise<Record<string, unknown>> {
  const pipeline = runSqlPipelineEffect({
    sql,
    explanation,
    connId,
    preStep: { kind: "check-cache" },
    parentAuditId,
    routingMode,
    routingReason,
    executionTarget,
  }).pipe(
    Effect.map((outcome): Record<string, unknown> => {
      switch (outcome.kind) {
        case "executed":
          // Widen the typed result to the opaque tool-response record the
          // downstream consumers read by key — the fanout merger and the
          // single-env contribution wrapper (`success`/`columns`/`rows`/
          // `executionMs`/`error`). The spread is load-bearing: an interface
          // is not assignable to `Record<string, unknown>`, but its spread is.
          return { ...outcome.result };
        case "validation_failed":
        case "approval_unavailable":
        case "approval_identity_missing":
          return { success: false, error: outcome.message, executionMs: 0 };
        case "approval_required":
          return {
            success: false,
            approval_required: true,
            approval_request_id: outcome.approvalRequestId,
            matched_rules: [...outcome.matchedRules],
            message: `This query requires approval before execution. Rule: "${outcome.ruleName}". ` +
              `An approval request has been submitted (ID: ${outcome.approvalRequestId}). ` +
              `An admin must approve it before the query can run.`,
            executionMs: 0,
          };
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    }),
  );

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
  /**
   * Per-leg execution targets, pre-resolved by {@link resolveSqlExecutionPlan}
   * from EACH member's own connection id (never a single broadcast target —
   * that would leak one leg's whitelist bucket onto the others, #3961). Order
   * is the fanout output order. A leg's `connectionId` is the member to run
   * against; its `unpinned` flag feeds the leg's table whitelist.
   */
  readonly legs: readonly ExecutionTarget[];
  /**
   * Planner reason that picked this fanout (one of `agent-all` /
   * `picker-all`). Threaded into each leg's OTel span as
   * `atlas.routing_reason` so observers can distinguish "agent decided
   * to fan out" from "user forced fanout via picker" without joining
   * audit rows.
   */
  readonly fanoutReason: RoutingReason;
}): Promise<Record<string, unknown>> {
  const { sql, explanation, legs, fanoutReason } = args;
  const connectionIds = legs.map((leg) => leg.connectionId);

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
    //
    // #3616 — the parent stays at duration_ms=0 deliberately: it is pure
    // linkage housekeeping written BEFORE any shard runs (its id must exist
    // for the children's FK), so it has no execution cost of its own. The
    // real per-shard durations live on the child rows (and the merged
    // total wall-clock rides `executionMs` in the returned result). 0 is the
    // sentinel that `/analytics/slow` filters out of its AVG so these
    // housekeeping rows never distort slow-query rankings. Do NOT stamp the
    // total here — children already contribute their durations to the
    // aggregate, so a non-zero parent would double-count the same SQL prefix.
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

  // Per-leg execution target: each leg carries its OWN target (pre-resolved by
  // the planner from ITS connection id) — NEVER a single broadcast target
  // across legs (that would leak one leg's whitelist bucket onto the others, a
  // regression). A leg whose id IS the conversation's own connection under
  // All-sources reach derives `unpinned: true`; sibling legs derive `false`.
  // The request context was read ONCE in `execute` and folded into these legs
  // there — this function re-reads nothing (#4350).
  const startTimes = new Map<string, number>();
  const settled = await Promise.allSettled(
    legs.map((leg) => {
      startTimes.set(leg.connectionId, performance.now());
      return executeSqlForConnection({
        sql,
        explanation,
        connId: leg.connectionId,
        parentAuditId,
        routingMode: "all",
        routingReason: fanoutReason,
        executionTarget: leg,
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
    group: z
      .string()
      .optional()
      .describe(
        "Target Connection group (cross-group reach, ADR-0022). Names which datasource group this query runs against — its connection AND its table whitelist resolve to THIS group. Use the group/source name from the semantic tree (`explore`). Omit to use the conversation's current group. A group outside your reach is rejected — the query is NOT silently re-routed to another source; pick a reachable group or omit this. To answer a cross-source question, run one query per relevant group and correlate the results yourself; always report which source(s) you used.",
      ),
    connectionId: z
      .string()
      .optional()
      .describe(
        "Target connection ID — a specific member WITHIN the targeted group. Check the entity YAML's `connection` field to determine which source a table belongs to. Omit for the group's default connection. For cross-group targeting use `group`, not this.",
      ),
    scope: z
      .string()
      .optional()
      .describe(
        "Cross-environment routing override (PRD #2515). \"this\" or omitted runs against the conversation's current member; \"all\" fans out across every member of the active environment group; a member connection id routes to that specific environment. Only applies when the active group has more than one member.",
      ),
  }),

  execute: async ({ sql, explanation, group, connectionId, scope }) => {
    // Read the request context ONCE and hand it to the planner (#4350). The
    // planner folds the whole cascade — reach gate (ADR-0022) → group-target
    // member → current member → routing-mode fast-path → routing plan →
    // per-leg execution target — into a discriminated plan; this closure only
    // runs the leg(s) and merges. The composition-order bugs this surface has
    // shipped (#3961 fanout bucket-leak, #3867(b) no-substitution) now live,
    // tested, inside `resolveSqlExecutionPlan`.
    const reqCtx = getRequestContext();
    const { plan, logs } = await resolveSqlExecutionPlan(reqCtx, { group, connectionId, scope });
    // The planner is pure — it returns operational signals (reach warnings, the
    // out-of-reach rejection, routing fallbacks) rather than logging itself, so
    // the one log seam stays here (per CLAUDE.md "never silently swallow").
    for (const l of logs) {
      log.warn(l.fields, l.message);
    }

    switch (plan.kind) {
      case "reject":
        // Out-of-reach target — a hard error, never a silent re-route to a
        // different source (the #3867(b) no-substitution invariant).
        return { success: false, explanation, error: plan.error, executionMs: 0 };
      case "single": {
        // Wraps the leaf result with a 1-element `envContributions` array so
        // SDK consumers see the same wire shape for single-env and fanout
        // responses (#2519). The leaf result already carries `success`,
        // `columns`, `rows`, etc. — we only attach the contribution.
        // The execution target's `connectionId` IS the resolved member id —
        // the single source for the leg's id (no separate `connId` to drift).
        const connId = plan.executionTarget.connectionId;
        const result = await executeSqlForConnection({
          sql,
          explanation,
          connId,
          routingMode: plan.routingMode,
          routingReason: plan.routingReason,
          executionTarget: plan.executionTarget,
        });
        return attachSingleEnvContribution(result, connId);
      }
      case "fanout":
        return executeSqlFanout({
          sql,
          explanation,
          legs: plan.legs,
          fanoutReason: plan.fanoutReason,
        });
      default: {
        const _exhaustive: never = plan;
        return _exhaustive;
      }
    }
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
