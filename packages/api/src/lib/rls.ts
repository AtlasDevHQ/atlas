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

import { Parser, type Select } from "node-sql-parser";
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
  /** Array of resolved claim values for IN-list conditions. When set,
   *  takes precedence over `value`. Each element is already SQL-escaped. */
  values?: string[];
}

/** A group of filters from a single RLS policy — ANDed together. */
export interface RLSFilterGroup {
  filters: RLSFilter[];
}

/**
 * Match RLS policies against the tables in a query and resolve claim values.
 *
 * Returns either `{ groups, combineWith }` on success or `{ error }` when
 * the query should be blocked (missing user, missing claims, etc.).
 */
export function resolveRLSFilters(
  user: AtlasUser | undefined,
  queriedTables: Set<string>,
  config: RLSConfig,
): { groups: RLSFilterGroup[]; combineWith: "and" | "or" } | { error: string } {
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

  const groups: RLSFilterGroup[] = [];
  const combineWith = config.combineWith;

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

    // Normalize conditions: single column/claim → conditions array
    const conditions = policy.conditions ?? (() => {
      if (!policy.column || !policy.claim) {
        // Should be unreachable after Zod validation, but fail-closed if it isn't.
        return [{ column: "__INVALID__", claim: "__INVALID__" }];
      }
      return [{ column: policy.column, claim: policy.claim }];
    })();

    const filters: RLSFilter[] = [];

    for (const condition of conditions) {
      // Resolve claim value — fail-closed on missing claims
      const rawValue = resolveClaimPath(user.claims, condition.claim);
      if (rawValue === undefined || rawValue === null) {
        return {
          error: `RLS policy requires claim "${condition.claim}" but it is missing from the user's claims. Query blocked.`,
        };
      }

      // Reject object-typed claims (not arrays) — would produce "[object Object]"
      if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
        return {
          error: `RLS policy claim "${condition.claim}" resolved to an object instead of a scalar or array. Use a more specific claim path (e.g. "${condition.claim}.id"). Query blocked.`,
        };
      }

      if (Array.isArray(rawValue)) {
        // Empty array → fail-closed (no values to match against)
        if (rawValue.length === 0) {
          return {
            error: `RLS policy claim "${condition.claim}" resolved to an empty array. Query blocked (fail-closed).`,
          };
        }
        // Validate array elements are primitives — objects would produce "[object Object]"
        for (const v of rawValue) {
          if (v === null || v === undefined) {
            return {
              error: `RLS policy claim "${condition.claim}" contains a null/undefined array element. Query blocked (fail-closed).`,
            };
          }
          if (typeof v === "object") {
            return {
              error: `RLS policy claim "${condition.claim}" contains a non-primitive array element. Array values must be strings, numbers, or booleans. Query blocked.`,
            };
          }
        }
        const escapedValues = rawValue.map((v) => String(v).replace(/'/g, "''"));
        for (const table of matchingTables) {
          filters.push({
            table,
            column: condition.column,
            value: escapedValues[0],
            values: escapedValues,
          });
        }
      } else {
        // Scalar claim: SQL-escape single quotes and convert to string
        const strValue = String(rawValue).replace(/'/g, "''");
        for (const table of matchingTables) {
          filters.push({ table, column: condition.column, value: strValue });
        }
      }
    }

    if (filters.length > 0) {
      groups.push({ filters });
    }
  }

  return { groups, combineWith };
}

// ---------------------------------------------------------------------------
// AST-based WHERE injection
// ---------------------------------------------------------------------------

/**
 * Walk the AST's FROM array to build a map of table_name → alias.
 * If a table has no alias, it maps to the table name itself.
 */
function extractTableAliasMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- avoids narrowing boilerplate across the BaseFrom | Join | TableExpr | Dual union members
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
function collectCTENames(ast: Select): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(ast.with)) {
    for (const cte of ast.with) {
      const name = cte?.name?.value ?? cte?.name;
      if (typeof name === "string") names.add(name.toLowerCase());
    }
  }
  return names;
}

/** Build an AST condition node for a single RLS filter (= or IN). */
function buildCondition(tableRef: string, filter: RLSFilter) {
  if (filter.values && filter.values.length > 0) {
    // IN-list for array claims
    return {
      type: "binary_expr",
      operator: "IN",
      left: {
        type: "column_ref",
        table: tableRef,
        column: filter.column,
      },
      right: {
        type: "expr_list",
        value: filter.values.map((v) => ({
          type: "single_quote_string",
          value: v,
        })),
      },
    };
  }
  // Equality for scalar claims
  return {
    type: "binary_expr",
    operator: "=",
    left: {
      type: "column_ref",
      table: tableRef,
      column: filter.column,
    },
    right: {
      type: "single_quote_string",
      value: filter.value,
    },
  };
}

/**
 * Recursively inject RLS conditions into a SELECT AST node.
 * Handles: FROM tables, CTEs, UNIONs, and WHERE-clause subqueries.
 *
 * Conditions within a single policy group are ANDed. Groups are combined
 * using the `combineWith` operator (AND or OR).
 */
function injectIntoSelectAST(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AST is mutated in place with hand-constructed condition nodes that don't conform to Binary type, and direct property assignment bypasses type narrowing
  ast: any,
  groups: RLSFilterGroup[],
  combineWith: "and" | "or",
  dialect: string,
): void {
  const cteNames = collectCTENames(ast);

  // Inject into CTE definitions
  if (Array.isArray(ast.with)) {
    for (const cte of ast.with) {
      const cteAst = cte?.stmt?.ast ?? cte?.stmt;
      if (cteAst && cteAst.type === "select") {
        injectIntoSelectAST(cteAst, groups, combineWith, dialect);
      }
    }
  }

  // Build table→alias map from FROM clause
  const from = ast.from;
  if (Array.isArray(from) && from.length > 0) {
    const aliasMap = extractTableAliasMap(from, cteNames);

    // Build per-policy-group conditions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructed AST condition nodes don't match Binary type exactly
    const groupConditions: any[] = [];
    for (const group of groups) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accumulated binary_expr nodes built from plain objects
      let groupCondition: any = null;
      for (const filter of group.filters) {
        const alias = aliasMap.get(filter.table.toLowerCase());
        if (!alias) continue;

        const condition = buildCondition(alias, filter);
        groupCondition = groupCondition
          ? {
              type: "binary_expr",
              operator: "AND",
              left: groupCondition,
              right: condition,
            }
          : condition;
      }
      if (groupCondition) groupConditions.push(groupCondition);
    }

    // Combine groups with AND or OR
    if (groupConditions.length > 0) {
      const combineOp = combineWith === "or" ? "OR" : "AND";
      let rlsCondition = groupConditions[0];
      for (let i = 1; i < groupConditions.length; i++) {
        rlsCondition = {
          type: "binary_expr",
          operator: combineOp,
          left: rlsCondition,
          right: groupConditions[i],
        };
      }

      // When using OR with multiple groups, wrap in parens to prevent
      // precedence issues with the existing WHERE clause
      if (combineWith === "or" && groupConditions.length > 1) {
        rlsCondition.parentheses = true;
      }

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
        injectIntoSelectAST(subAst, groups, combineWith, dialect);
      }
    }
  }

  // Recurse into subqueries within the WHERE clause
  if (ast.where) {
    walkWhereForSubqueries(ast.where, groups, combineWith, dialect);
  }

  // Handle UNION (recursively inject into _next)
  if (ast._next) {
    injectIntoSelectAST(ast._next, groups, combineWith, dialect);
  }
}

/**
 * Recursively walk a WHERE clause AST looking for subqueries.
 * Injects RLS conditions into any nested SELECT statements.
 */
function walkWhereForSubqueries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursive duck-typed traversal of AST nodes; a union type would require discriminant checks at each step that would obscure the traversal logic
  node: any,
  groups: RLSFilterGroup[],
  combineWith: "and" | "or",
  dialect: string,
): void {
  if (!node || typeof node !== "object") return;

  // Subquery in WHERE (e.g., WHERE id IN (SELECT ...))
  if (node.ast && typeof node.ast === "object" && node.ast.type === "select") {
    injectIntoSelectAST(node.ast, groups, combineWith, dialect);
  }

  // Recurse into binary expression children
  if (node.left) walkWhereForSubqueries(node.left, groups, combineWith, dialect);
  if (node.right) walkWhereForSubqueries(node.right, groups, combineWith, dialect);

  // Recurse into expr_list values (e.g., IN (...subquery...))
  if (node.type === "expr_list" && Array.isArray(node.value)) {
    for (const v of node.value) {
      walkWhereForSubqueries(v, groups, combineWith, dialect);
    }
  }
}

/**
 * Inject RLS WHERE conditions into a validated SQL query via AST manipulation.
 *
 * The input SQL must be a single SELECT statement that has already passed
 * validateSQL(). The output is a syntactically valid SQL string with RLS
 * conditions injected into the WHERE clause.
 *
 * @param sql - Validated SQL string (single SELECT).
 * @param groups - RLS filter groups to inject. Conditions within a group are
 *   ANDed; groups are combined using `combineWith`.
 * @param combineWith - How to combine conditions from different policies.
 * @param dbType - Database type for parser dialect selection.
 * @returns Modified SQL string with RLS conditions.
 * @throws Error if AST parsing or regeneration fails.
 */
export function injectRLSConditions(
  sql: string,
  groups: RLSFilterGroup[],
  combineWith: "and" | "or",
  dbType: DBType,
): string {
  const allFilters = groups.flatMap((g) => g.filters);
  if (allFilters.length === 0) return sql;

  const dialect = parserDatabase(dbType);
  const ast = parser.astify(sql.trim().replace(/;\s*$/, ""), {
    database: dialect,
  });
  const stmt = Array.isArray(ast) ? ast[0] : ast;

  injectIntoSelectAST(stmt, groups, combineWith, dialect);

  const result = parser.sqlify(stmt, { database: dialect });
  log.debug({ originalLength: sql.length, resultLength: result.length }, "RLS conditions injected into SQL");
  return result;
}
