/**
 * Row-Level Security (RLS) — WHERE clause injection.
 *
 * When RLS is enabled, every SQL query gets automatic WHERE conditions
 * based on the authenticated user's claims. Policies define which
 * tables/columns map to which user claims.
 *
 * Security model:
 * - Fail-closed: missing claims block the query
 * - Auth mode "none" + RLS enabled blocks the query
 * - Claim values are SQL-escaped (single quotes doubled) and coerced to string
 * - AST manipulation ensures syntactic correctness
 * - Custom validators (SOQL, GraphQL) bypass RLS — they must enforce their own
 * - Injection runs after plugin beforeQuery hooks — plugins cannot strip RLS
 */

import { Parser } from "node-sql-parser";
import type { RLSConfig } from "@atlas/api/lib/config";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { DBType } from "@atlas/api/lib/db/connection";
import { parserDatabase } from "@atlas/api/lib/tools/sql";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("rls");
const parser = new Parser();

// ---------------------------------------------------------------------------
// Claim path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-delimited path in a nested object.
 * e.g. resolveClaimPath({ app_metadata: { tenant: "acme" } }, "app_metadata.tenant") => "acme"
 */
export function resolveClaimPath(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Filter resolution
// ---------------------------------------------------------------------------

export interface RLSFilter {
  /** Table name (lowercase, as referenced in the query). */
  table: string;
  /** Column to filter on. */
  column: string;
  /** Resolved claim value (already SQL-escaped — single quotes doubled).
   *  Pre-escaping is required because node-sql-parser's sqlify emits
   *  single_quote_string values literally without escaping. */
  value: string;
}

/**
 * Match RLS policies against the tables in a query and resolve claim values.
 *
 * Returns either `{ filters }` on success or `{ error }` when the query
 * should be blocked (missing user, missing claims, etc.).
 */
export function resolveRLSFilters(
  user: AtlasUser | undefined,
  queriedTables: Set<string>,
  config: RLSConfig,
): { filters: RLSFilter[] } | { error: string } {
  if (!user) {
    return {
      error:
        "RLS is enabled but no authenticated user is available. Authentication is required when RLS policies are active.",
    };
  }

  if (!user.claims) {
    return {
      error:
        "RLS is enabled but the authenticated user has no claims. Ensure the auth mode provides claims for RLS policy evaluation.",
    };
  }

  const filters: RLSFilter[] = [];
  const seen = new Set<string>();

  for (const policy of config.policies) {
    // Match queried tables against policy tables
    const isWildcard = policy.tables.includes("*");
    const matchingTables = isWildcard
      ? queriedTables
      : new Set(
          [...policy.tables]
            .map((t) => t.toLowerCase())
            .filter((t) => queriedTables.has(t)),
        );

    if (matchingTables.size === 0) continue;

    // Resolve claim value — fail-closed on missing claims
    const rawValue = resolveClaimPath(user.claims, policy.claim);
    if (rawValue === undefined || rawValue === null) {
      return {
        error: `RLS policy requires claim "${policy.claim}" but it is missing from the user's claims. Query blocked.`,
      };
    }

    // SQL-escape single quotes and convert to string
    const strValue = String(rawValue).replace(/'/g, "''");

    for (const table of matchingTables) {
      const key = `${table}:${policy.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filters.push({ table, column: policy.column, value: strValue });
    }
  }

  return { filters };
}

// ---------------------------------------------------------------------------
// AST-based WHERE injection
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Walk the AST's FROM array to build a map of table_name → alias.
 * If a table has no alias, it maps to the table name itself.
 */
function extractTableAliasMap(
  from: any[],
  cteNames: Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of from) {
    if (!entry?.table) continue;
    const tableName =
      typeof entry.table === "string" ? entry.table.toLowerCase() : undefined;
    if (!tableName || cteNames.has(tableName)) continue;
    const alias = entry.as || entry.table;
    map.set(tableName, alias);
  }
  return map;
}

/** Collect CTE names from the WITH clause. */
function collectCTENames(ast: any): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(ast.with)) {
    for (const cte of ast.with) {
      const name = cte?.name?.value ?? cte?.name;
      if (typeof name === "string") names.add(name.toLowerCase());
    }
  }
  return names;
}

/** Build a column_ref → value equality condition AST node. */
function buildEqCondition(tableRef: string, column: string, value: string) {
  return {
    type: "binary_expr",
    operator: "=",
    left: {
      type: "column_ref",
      table: tableRef,
      column: column,
    },
    right: {
      type: "single_quote_string",
      value,
    },
  };
}

/**
 * Recursively inject RLS conditions into a SELECT AST node.
 * Handles: FROM tables, CTEs, UNIONs, and WHERE-clause subqueries.
 */
function injectIntoSelectAST(
  ast: any,
  filters: RLSFilter[],
  dialect: string,
): void {
  const cteNames = collectCTENames(ast);

  // Inject into CTE definitions
  if (Array.isArray(ast.with)) {
    for (const cte of ast.with) {
      const cteAst = cte?.stmt?.ast ?? cte?.stmt;
      if (cteAst && cteAst.type === "select") {
        injectIntoSelectAST(cteAst, filters, dialect);
      }
    }
  }

  // Build table→alias map from FROM clause
  const from = ast.from;
  if (Array.isArray(from) && from.length > 0) {
    const aliasMap = extractTableAliasMap(from, cteNames);

    let rlsCondition: any = null;
    for (const filter of filters) {
      const alias = aliasMap.get(filter.table.toLowerCase());
      if (!alias) continue;

      const condition = buildEqCondition(alias, filter.column, filter.value);
      rlsCondition = rlsCondition
        ? {
            type: "binary_expr",
            operator: "AND",
            left: rlsCondition,
            right: condition,
          }
        : condition;
    }

    if (rlsCondition) {
      ast.where = ast.where
        ? {
            type: "binary_expr",
            operator: "AND",
            left: ast.where,
            right: rlsCondition,
          }
        : rlsCondition;
    }

    // Recurse into derived tables (subqueries in FROM clause)
    for (const entry of from) {
      const subAst = entry?.expr?.ast;
      if (subAst && subAst.type === "select") {
        injectIntoSelectAST(subAst, filters, dialect);
      }
    }
  }

  // Recurse into subqueries within the WHERE clause
  if (ast.where) {
    walkWhereForSubqueries(ast.where, filters, dialect);
  }

  // Handle UNION (recursively inject into _next)
  if (ast._next) {
    injectIntoSelectAST(ast._next, filters, dialect);
  }
}

/**
 * Recursively walk a WHERE clause AST looking for subqueries.
 * Injects RLS conditions into any nested SELECT statements.
 */
function walkWhereForSubqueries(
  node: any,
  filters: RLSFilter[],
  dialect: string,
): void {
  if (!node || typeof node !== "object") return;

  // Subquery in WHERE (e.g., WHERE id IN (SELECT ...))
  if (node.ast && typeof node.ast === "object" && node.ast.type === "select") {
    injectIntoSelectAST(node.ast, filters, dialect);
  }

  // Recurse into binary expression children
  if (node.left) walkWhereForSubqueries(node.left, filters, dialect);
  if (node.right) walkWhereForSubqueries(node.right, filters, dialect);

  // Recurse into expr_list values (e.g., IN (...subquery...))
  if (node.type === "expr_list" && Array.isArray(node.value)) {
    for (const v of node.value) {
      walkWhereForSubqueries(v, filters, dialect);
    }
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Inject RLS WHERE conditions into a validated SQL query via AST manipulation.
 *
 * The input SQL must be a single SELECT statement that has already passed
 * validateSQL(). The output is a syntactically valid SQL string with RLS
 * conditions AND-ed into the WHERE clause.
 *
 * @param sql - Validated SQL string (single SELECT).
 * @param filters - RLS filters to inject.
 * @param dbType - Database type for parser dialect selection.
 * @returns Modified SQL string with RLS conditions.
 * @throws Error if AST parsing or regeneration fails.
 */
export function injectRLSConditions(
  sql: string,
  filters: RLSFilter[],
  dbType: DBType,
): string {
  if (filters.length === 0) return sql;

  const dialect = parserDatabase(dbType);
  const ast = parser.astify(sql.trim().replace(/;\s*$/, ""), {
    database: dialect,
  });
  const stmt = Array.isArray(ast) ? ast[0] : ast;

  injectIntoSelectAST(stmt, filters, dialect);

  const result = parser.sqlify(stmt, { database: dialect });
  log.debug({ originalLength: sql.length, resultLength: result.length }, "RLS conditions injected into SQL");
  return result;
}
