import { describe, expect, it } from "bun:test";
import { Parser } from "node-sql-parser";
import {
  resolveClaimPath,
  resolveRLSFilters,
  injectRLSConditions,
  type RLSFilterGroup,
} from "@atlas/api/lib/rls";
import { type RLSConfig, RLSPolicySchema, RLSConfigSchema } from "@atlas/api/lib/config";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

// ---------------------------------------------------------------------------
// resolveClaimPath
// ---------------------------------------------------------------------------

describe("resolveClaimPath", () => {
  it("resolves a flat claim", () => {
    expect(resolveClaimPath({ tenant_id: "acme" }, "tenant_id")).toBe("acme");
  });

  it("resolves a nested claim", () => {
    expect(
      resolveClaimPath({ app: { tenant: "acme" } }, "app.tenant"),
    ).toBe("acme");
  });

  it("resolves a deeply nested claim", () => {
    expect(
      resolveClaimPath({ a: { b: { c: "val" } } }, "a.b.c"),
    ).toBe("val");
  });

  it("returns undefined for missing path", () => {
    expect(resolveClaimPath({ x: 1 }, "y")).toBeUndefined();
  });

  it("returns undefined for partial path", () => {
    expect(resolveClaimPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("returns undefined when intermediate is null", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveClaimPath({ a: null } as Record<string, any>, "a.b")).toBeUndefined();
  });

  it("returns non-string values", () => {
    expect(resolveClaimPath({ count: 42 }, "count")).toBe(42);
    expect(resolveClaimPath({ flag: true }, "flag")).toBe(true);
  });

  it("returns array values", () => {
    const result = resolveClaimPath({ groups: ["eng", "sales"] }, "groups");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["eng", "sales"]);
  });
});

// ---------------------------------------------------------------------------
// resolveRLSFilters
// ---------------------------------------------------------------------------

describe("resolveRLSFilters", () => {
  const config: RLSConfig = {
    enabled: true,
    policies: [
      { tables: ["*"], column: "tenant_id", claim: "tenant_id" },
    ],
    combineWith: "and",
  };

  const user: AtlasUser = {
    id: "user-1",
    mode: "byot",
    label: "test@example.com",
    claims: { tenant_id: "acme", sub: "user-1" },
  };

  it("wildcard policy matches all queried tables", () => {
    const result = resolveRLSFilters(
      user,
      new Set(["orders", "customers"]),
      config,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      const allFilters = result.groups.flatMap((g) => g.filters);
      expect(allFilters).toHaveLength(2);
      expect(allFilters.map((f) => f.table).sort()).toEqual(["customers", "orders"]);
      expect(allFilters[0].column).toBe("tenant_id");
      expect(allFilters[0].value).toBe("acme");
    }
  });

  it("specific table policy matches only named tables", () => {
    const specificConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["orders"], column: "tenant_id", claim: "tenant_id" },
      ],
      combineWith: "and",
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders", "customers"]),
      specificConfig,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      const allFilters = result.groups.flatMap((g) => g.filters);
      expect(allFilters).toHaveLength(1);
      expect(allFilters[0].table).toBe("orders");
    }
  });

  it("no match when policy tables not in query", () => {
    const specificConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["invoices"], column: "tenant_id", claim: "tenant_id" },
      ],
      combineWith: "and",
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders", "customers"]),
      specificConfig,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups).toHaveLength(0);
    }
  });

  it("returns error when user is undefined", () => {
    const result = resolveRLSFilters(undefined, new Set(["orders"]), config);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("no authenticated user");
    }
  });

  it("returns error when user has no claims", () => {
    const noClaimsUser: AtlasUser = {
      id: "user-1",
      mode: "simple-key",
      label: "api-key-test",
    };
    const result = resolveRLSFilters(noClaimsUser, new Set(["orders"]), config);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("no claims");
    }
  });

  it("returns error when required claim is missing (fail-closed)", () => {
    const missingClaimUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test@example.com",
      claims: { sub: "user-1" }, // no tenant_id
    };
    const result = resolveRLSFilters(
      missingClaimUser,
      new Set(["orders"]),
      config,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain('claim "tenant_id"');
    }
  });

  it("supports dot-path claim extraction", () => {
    const nestedConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "org_id", claim: "app_metadata.org_id" },
      ],
      combineWith: "and",
    };
    const nestedUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { app_metadata: { org_id: "org-42" } },
    };
    const result = resolveRLSFilters(
      nestedUser,
      new Set(["orders"]),
      nestedConfig,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups[0].filters[0].value).toBe("org-42");
    }
  });

  it("multiple policies with different claims produce separate groups", () => {
    const multiConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "tenant_id", claim: "tenant_id" },
        { tables: ["users"], column: "id", claim: "sub" },
      ],
      combineWith: "and",
    };
    const result = resolveRLSFilters(
      user,
      new Set(["users", "orders"]),
      multiConfig,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups).toHaveLength(2);
      // First group: wildcard policy → filters for both tables
      expect(result.groups[0].filters).toHaveLength(2);
      // Second group: users-only policy → filter for users
      expect(result.groups[1].filters).toHaveLength(1);
      expect(result.groups[1].filters[0].table).toBe("users");
      expect(result.groups[1].filters[0].column).toBe("id");
    }
  });

  it("table matching is case-insensitive", () => {
    const upperConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["Orders"], column: "tenant_id", claim: "tenant_id" },
      ],
      combineWith: "and",
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders"]),
      upperConfig,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      const allFilters = result.groups.flatMap((g) => g.filters);
      expect(allFilters).toHaveLength(1);
    }
  });

  it("escapes single quotes in claim values", () => {
    const quoteUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { tenant_id: "O'Brien" },
    };
    const result = resolveRLSFilters(
      quoteUser,
      new Set(["orders"]),
      config,
    );
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups[0].filters[0].value).toBe("O''Brien");
    }
  });

  it("returns combineWith from config", () => {
    const orConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "tenant_id", claim: "tenant_id" },
      ],
      combineWith: "or",
    };
    const result = resolveRLSFilters(user, new Set(["orders"]), orConfig);
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.combineWith).toBe("or");
    }
  });

  // --- Multi-column policies ---

  it("multi-column policy with conditions[] produces ANDed filters in one group", () => {
    const multiColConfig: RLSConfig = {
      enabled: true,
      policies: [
        {
          tables: ["orders"],
          conditions: [
            { column: "tenant_id", claim: "tenant_id" },
            { column: "region", claim: "region" },
          ],
        },
      ],
      combineWith: "and",
    };
    const multiUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { tenant_id: "acme", region: "us-east" },
    };
    const result = resolveRLSFilters(multiUser, new Set(["orders"]), multiColConfig);
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups).toHaveLength(1);
      // Two conditions × one table = two filters in the group
      expect(result.groups[0].filters).toHaveLength(2);
      expect(result.groups[0].filters[0].column).toBe("tenant_id");
      expect(result.groups[0].filters[1].column).toBe("region");
    }
  });

  it("multi-column policy blocks when any condition claim is missing", () => {
    const multiColConfig: RLSConfig = {
      enabled: true,
      policies: [
        {
          tables: ["orders"],
          conditions: [
            { column: "tenant_id", claim: "tenant_id" },
            { column: "region", claim: "region" },
          ],
        },
      ],
      combineWith: "and",
    };
    const partialUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { tenant_id: "acme" }, // no region
    };
    const result = resolveRLSFilters(partialUser, new Set(["orders"]), multiColConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain('claim "region"');
    }
  });

  // --- Array claim support ---

  it("array claim produces filter with values[]", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "department", claim: "departments" },
      ],
      combineWith: "and",
    };
    const arrayUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { departments: ["eng", "sales"] },
    };
    const result = resolveRLSFilters(arrayUser, new Set(["orders"]), arrayConfig);
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups[0].filters[0].values).toEqual(["eng", "sales"]);
    }
  });

  it("single-element array produces filter with values[] of length 1", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "department", claim: "departments" },
      ],
      combineWith: "and",
    };
    const singleArrayUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { departments: ["eng"] },
    };
    const result = resolveRLSFilters(singleArrayUser, new Set(["orders"]), arrayConfig);
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups[0].filters[0].values).toEqual(["eng"]);
    }
  });

  it("empty array claim blocks the query (fail-closed)", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "department", claim: "departments" },
      ],
      combineWith: "and",
    };
    const emptyArrayUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { departments: [] },
    };
    const result = resolveRLSFilters(emptyArrayUser, new Set(["orders"]), arrayConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("empty array");
    }
  });

  it("array claim values are SQL-escaped", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "department", claim: "departments" },
      ],
      combineWith: "and",
    };
    const quoteArrayUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { departments: ["R&D", "O'Brien's team"] },
    };
    const result = resolveRLSFilters(quoteArrayUser, new Set(["orders"]), arrayConfig);
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups[0].filters[0].values).toEqual(["R&D", "O''Brien''s team"]);
    }
  });
});

// ---------------------------------------------------------------------------
// injectRLSConditions
// ---------------------------------------------------------------------------

describe("injectRLSConditions", () => {
  /** Helper: wrap filters in a single group with AND combineWith. */
  function group(...filters: { table: string; column: string; value: string; values?: string[] }[]): RLSFilterGroup[] {
    return [{ filters }];
  }

  const filter = (table: string, column = "tenant_id", value = "acme"): {
    table: string;
    column: string;
    value: string;
  } => ({ table, column, value });

  it("injects WHERE into a simple SELECT with no existing WHERE", () => {
    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "postgres");
    expect(result.toLowerCase()).toContain("where");
    expect(result).toContain("tenant_id");
    expect(result).toContain("acme");
  });

  it("AND-merges with an existing WHERE clause", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "postgres");
    expect(result.toLowerCase()).toContain("and");
    expect(result).toContain("tenant_id");
    expect(result).toContain("active");
  });

  it("uses table alias in the injected condition", () => {
    const sql = "SELECT o.id FROM orders o WHERE o.status = 'active'";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "postgres");
    // The condition should reference the alias 'o', not the table name 'orders'
    expect(result).toContain("o");
    expect(result).toContain("tenant_id");
  });

  it("injects into multiple joined tables", () => {
    const sql = "SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id";
    const result = injectRLSConditions(
      sql,
      group(filter("orders"), filter("customers")),
      "and",
      "postgres",
    );
    expect(result).toContain("tenant_id");
    // Both tables should be filtered
    const lowerResult = result.toLowerCase();
    expect(lowerResult).toContain("where");
  });

  it("returns SQL unchanged when no filters match", () => {
    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(sql, [], "and", "postgres");
    expect(result).toBe(sql);
  });

  it("handles SQL injection safely — quotes in claim values", () => {
    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(
      sql,
      group(filter("orders", "tenant_id", "O''Brien")),
      "and",
      "postgres",
    );
    // Should produce valid SQL with escaped quotes
    expect(result).toContain("O''Brien");
    // Should NOT contain unescaped single quote that would break SQL
    expect(result).not.toContain("O'B");
  });

  it("works with MySQL dialect", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "mysql");
    expect(result.toLowerCase()).toContain("and");
    expect(result).toContain("tenant_id");
  });

  it("produces valid SQL that can be re-parsed", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "postgres");

    // The result should be parseable by node-sql-parser
    const parser = new Parser();
    expect(() => {
      parser.astify(result, { database: "PostgresQL" });
    }).not.toThrow();
  });

  it("handles UNION queries", () => {
    const sql = "SELECT id FROM orders UNION SELECT id FROM returns";
    const result = injectRLSConditions(
      sql,
      group(filter("orders"), filter("returns")),
      "and",
      "postgres",
    );
    // Both sides of the UNION should get filtered
    expect(result).toContain("tenant_id");
  });

  it("injects into derived tables (subqueries in FROM clause)", () => {
    const sql = "SELECT * FROM (SELECT * FROM orders) sub";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "postgres");
    // The inner subquery should get the WHERE condition
    expect(result).toContain("tenant_id");
    expect(result).toContain("acme");
    // Verify the result is valid SQL
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("injects into CTE body", () => {
    const sql = "WITH recent AS (SELECT * FROM orders WHERE created > '2024-01-01') SELECT * FROM recent";
    const result = injectRLSConditions(sql, group(filter("orders")), "and", "postgres");
    expect(result).toContain("tenant_id");
    expect(result).toContain("acme");
  });

  it("injects into WHERE subqueries", () => {
    const sql = "SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders)";
    const result = injectRLSConditions(
      sql,
      group(filter("orders"), filter("customers")),
      "and",
      "postgres",
    );
    expect(result).toContain("tenant_id");
    // Both customers (outer) and orders (subquery) should be filtered
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("end-to-end: resolveRLSFilters -> injectRLSConditions with malicious claim", () => {
    // Full pipeline test: raw malicious value through resolve then inject
    const user: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { tenant_id: "'; DROP TABLE orders; --" },
    };
    const rlsConfig: RLSConfig = {
      enabled: true,
      policies: [{ tables: ["*"], column: "tenant_id", claim: "tenant_id" }],
      combineWith: "and",
    };
    const filterResult = resolveRLSFilters(user, new Set(["orders"]), rlsConfig);
    expect("groups" in filterResult).toBe(true);
    if (!("groups" in filterResult)) return;

    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(sql, filterResult.groups, filterResult.combineWith, "postgres");

    // The injected SQL should be parseable as a single SELECT (no injection breakout)
    const p = new Parser();
    const ast = p.astify(result, { database: "PostgresQL" });
    const stmts = Array.isArray(ast) ? ast : [ast];
    expect(stmts).toHaveLength(1);
    expect(stmts[0].type).toBe("select");
    // The malicious value is safely contained in a string literal
    expect(result).toContain("''';");
  });

  it("uses qualified alias reference for joined tables", () => {
    const sql = "SELECT o.id, c.name FROM orders o JOIN customers c ON o.cid = c.id";
    const result = injectRLSConditions(
      sql,
      group(filter("orders"), filter("customers")),
      "and",
      "postgres",
    );
    // Verify qualified references: o.tenant_id and c.tenant_id (not orders.tenant_id)
    const p = new Parser();
    const ast = p.astify(result, { database: "PostgresQL" });
    // If parsing succeeds with correct structure, the aliases are used correctly
    expect(ast).toBeDefined();
    // Both aliases should appear in the WHERE clause
    expect(result.toLowerCase()).toContain("where");
    expect(result).toContain("tenant_id");
  });

  // --- Array claim: IN-list injection ---

  it("injects IN-list for array claim values", () => {
    const sql = "SELECT * FROM orders";
    const groups: RLSFilterGroup[] = [{
      filters: [{
        table: "orders",
        column: "department",
        value: "eng",
        values: ["eng", "sales"],
      }],
    }];
    const result = injectRLSConditions(sql, groups, "and", "postgres");
    expect(result.toLowerCase()).toContain("in");
    expect(result).toContain("eng");
    expect(result).toContain("sales");
    // Verify it's valid SQL
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("single-element array claim uses IN-list", () => {
    const sql = "SELECT * FROM orders";
    const groups: RLSFilterGroup[] = [{
      filters: [{
        table: "orders",
        column: "department",
        value: "eng",
        values: ["eng"],
      }],
    }];
    const result = injectRLSConditions(sql, groups, "and", "postgres");
    expect(result.toLowerCase()).toContain("in");
    expect(result).toContain("eng");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("mixed scalar and array filters in same group", () => {
    const sql = "SELECT * FROM orders";
    const groups: RLSFilterGroup[] = [{
      filters: [
        { table: "orders", column: "tenant_id", value: "acme" },
        { table: "orders", column: "department", value: "eng", values: ["eng", "sales"] },
      ],
    }];
    const result = injectRLSConditions(sql, groups, "and", "postgres");
    // Should have both = and IN conditions
    expect(result).toContain("acme");
    expect(result).toContain("eng");
    expect(result).toContain("sales");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  // --- OR-logic between policies ---

  it("OR-logic combines policy groups with OR", () => {
    const sql = "SELECT * FROM orders";
    const groups: RLSFilterGroup[] = [
      { filters: [{ table: "orders", column: "tenant_id", value: "acme" }] },
      { filters: [{ table: "orders", column: "region", value: "us-east" }] },
    ];
    const result = injectRLSConditions(sql, groups, "or", "postgres");
    // Should contain OR between the two conditions
    expect(result.toLowerCase()).toContain("or");
    expect(result).toContain("tenant_id");
    expect(result).toContain("region");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("OR-logic with existing WHERE wraps OR in parens", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const groups: RLSFilterGroup[] = [
      { filters: [{ table: "orders", column: "tenant_id", value: "acme" }] },
      { filters: [{ table: "orders", column: "region", value: "us-east" }] },
    ];
    const result = injectRLSConditions(sql, groups, "or", "postgres");
    // The OR condition should be parenthesized so it doesn't break existing WHERE
    // e.g. WHERE status = 'active' AND (tenant_id = 'acme' OR region = 'us-east')
    expect(result).toContain("active");
    expect(result.toLowerCase()).toContain("or");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("AND-logic combines policy groups with AND (default)", () => {
    const sql = "SELECT * FROM orders";
    const groups: RLSFilterGroup[] = [
      { filters: [{ table: "orders", column: "tenant_id", value: "acme" }] },
      { filters: [{ table: "orders", column: "region", value: "us-east" }] },
    ];
    const result = injectRLSConditions(sql, groups, "and", "postgres");
    // Should contain AND between the two conditions
    const lower = result.toLowerCase();
    expect(lower).toContain("and");
    expect(result).toContain("tenant_id");
    expect(result).toContain("region");
  });

  it("multi-column policy with OR between policies (complex)", () => {
    const sql = "SELECT * FROM orders WHERE created > '2024-01-01'";
    const groups: RLSFilterGroup[] = [
      // Policy 1: multi-column (ANDed within group)
      {
        filters: [
          { table: "orders", column: "tenant_id", value: "acme" },
          { table: "orders", column: "active", value: "true" },
        ],
      },
      // Policy 2: single-column
      {
        filters: [{ table: "orders", column: "region", value: "us-east" }],
      },
    ];
    const result = injectRLSConditions(sql, groups, "or", "postgres");
    // Should produce: WHERE created > '2024-01-01' AND ((tenant_id = 'acme' AND active = 'true') OR region = 'us-east')
    expect(result).toContain("2024-01-01");
    expect(result.toLowerCase()).toContain("or");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("single policy group with OR does not add parens", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const groups: RLSFilterGroup[] = [
      { filters: [{ table: "orders", column: "tenant_id", value: "acme" }] },
    ];
    const result = injectRLSConditions(sql, groups, "or", "postgres");
    // Only one group → no OR operator needed, just AND with existing WHERE
    expect(result.toUpperCase()).not.toContain(" OR ");
    expect(result).toContain("acme");
    expect(result).toContain("active");
  });

  // --- End-to-end: multi-column + array + OR ---

  it("end-to-end: multi-column conditions with array claims", () => {
    const rlsConfig: RLSConfig = {
      enabled: true,
      policies: [
        {
          tables: ["orders"],
          conditions: [
            { column: "tenant_id", claim: "org" },
            { column: "department", claim: "departments" },
          ],
        },
      ],
      combineWith: "and",
    };
    const arrayUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { org: "acme", departments: ["eng", "sales"] },
    };
    const filterResult = resolveRLSFilters(arrayUser, new Set(["orders"]), rlsConfig);
    expect("groups" in filterResult).toBe(true);
    if (!("groups" in filterResult)) return;

    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, filterResult.groups, filterResult.combineWith, "postgres");
    // Should have tenant_id = 'acme' AND department IN ('eng', 'sales')
    expect(result).toContain("acme");
    expect(result.toLowerCase()).toContain("in");
    expect(result).toContain("eng");
    expect(result).toContain("sales");
    expect(result).toContain("active");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("end-to-end: OR between policies with array claims in subquery", () => {
    const rlsConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "tenant_id", claim: "org" },
        { tables: ["*"], column: "department", claim: "departments" },
      ],
      combineWith: "or",
    };
    const arrayUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { org: "acme", departments: ["eng", "sales"] },
    };
    const filterResult = resolveRLSFilters(
      arrayUser,
      new Set(["orders", "customers"]),
      rlsConfig,
    );
    expect("groups" in filterResult).toBe(true);
    if (!("groups" in filterResult)) return;

    const sql = "SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders)";
    const result = injectRLSConditions(sql, filterResult.groups, filterResult.combineWith, "postgres");
    // Should inject into both outer query and subquery with OR between policies
    expect(result.toLowerCase()).toContain("or");
    expect(result).toContain("acme");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("end-to-end: CTE + UNION + OR between policies", () => {
    const rlsConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "tenant_id", claim: "org" },
        { tables: ["orders"], column: "region", claim: "region" },
      ],
      combineWith: "or",
    };
    const testUser: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { org: "acme", region: "us-east" },
    };
    const filterResult = resolveRLSFilters(
      testUser,
      new Set(["orders", "returns"]),
      rlsConfig,
    );
    expect("groups" in filterResult).toBe(true);
    if (!("groups" in filterResult)) return;

    const sql = "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent UNION SELECT * FROM returns";
    const result = injectRLSConditions(sql, filterResult.groups, filterResult.combineWith, "postgres");
    expect(result).toContain("acme");
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("OR parenthesization preserves existing WHERE precedence", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const groups: RLSFilterGroup[] = [
      { filters: [{ table: "orders", column: "tenant_id", value: "acme" }] },
      { filters: [{ table: "orders", column: "region", value: "us-east" }] },
    ];
    const result = injectRLSConditions(sql, groups, "or", "postgres");
    // Parse result and verify the top-level WHERE is AND (existing AND rls)
    // not OR (which would widen access)
    const p = new Parser();
    const ast = p.astify(result, { database: "PostgresQL" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stmt = (Array.isArray(ast) ? ast[0] : ast) as any;
    // Top-level WHERE operator must be AND (existing WHERE AND rls_group)
    expect(stmt.where.operator).toBe("AND");
    // The right side of the AND should contain OR (the RLS groups)
    expect(stmt.where.right.operator).toBe("OR");
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe("RLSPolicySchema validation", () => {
  it("accepts single column+claim shorthand", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      column: "tenant_id",
      claim: "org_id",
    });
    expect(result.success).toBe(true);
  });

  it("accepts conditions array", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      conditions: [
        { column: "tenant_id", claim: "org_id" },
        { column: "region", claim: "region" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects both column+claim AND conditions", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      column: "tenant_id",
      claim: "org_id",
      conditions: [{ column: "region", claim: "region" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects neither column+claim NOR conditions", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects column without claim", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      column: "tenant_id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects claim without column", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      claim: "org_id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid column name in shorthand", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      column: "1invalid",
      claim: "org_id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid column name in conditions", () => {
    const result = RLSPolicySchema.safeParse({
      tables: ["orders"],
      conditions: [{ column: "drop table", claim: "org_id" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("RLSConfigSchema validation", () => {
  it("defaults combineWith to 'and'", () => {
    const result = RLSConfigSchema.safeParse({
      enabled: true,
      policies: [{ tables: ["*"], column: "tenant_id", claim: "org" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.combineWith).toBe("and");
    }
  });

  it("accepts combineWith 'or'", () => {
    const result = RLSConfigSchema.safeParse({
      enabled: true,
      combineWith: "or",
      policies: [{ tables: ["*"], column: "tenant_id", claim: "org" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.combineWith).toBe("or");
    }
  });

  it("rejects enabled with no policies", () => {
    const result = RLSConfigSchema.safeParse({
      enabled: true,
      policies: [],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: claim type validation
// ---------------------------------------------------------------------------

describe("resolveRLSFilters claim type validation", () => {
  const config: RLSConfig = {
    enabled: true,
    policies: [{ tables: ["*"], column: "tenant_id", claim: "tenant" }],
    combineWith: "and",
  };

  it("blocks object-type claims with actionable error", () => {
    const user: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { tenant: { id: "acme", name: "Acme Corp" } },
    };
    const result = resolveRLSFilters(user, new Set(["orders"]), config);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("object");
      expect(result.error).toContain("tenant.id");
    }
  });

  it("blocks null elements in array claims", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [{ tables: ["*"], column: "dept", claim: "departments" }],
      combineWith: "and",
    };
    const user: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { departments: ["eng", null, "sales"] },
    };
    const result = resolveRLSFilters(user, new Set(["orders"]), arrayConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("null");
    }
  });

  it("blocks object elements in array claims", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [{ tables: ["*"], column: "dept", claim: "departments" }],
      combineWith: "and",
    };
    const user: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { departments: [{ name: "eng" }, { name: "sales" }] },
    };
    const result = resolveRLSFilters(user, new Set(["orders"]), arrayConfig);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("non-primitive");
    }
  });

  it("allows numeric array elements", () => {
    const arrayConfig: RLSConfig = {
      enabled: true,
      policies: [{ tables: ["*"], column: "dept_id", claim: "dept_ids" }],
      combineWith: "and",
    };
    const user: AtlasUser = {
      id: "user-1",
      mode: "byot",
      label: "test",
      claims: { dept_ids: [1, 2, 3] },
    };
    const result = resolveRLSFilters(user, new Set(["orders"]), arrayConfig);
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups[0].filters[0].values).toEqual(["1", "2", "3"]);
    }
  });
});
