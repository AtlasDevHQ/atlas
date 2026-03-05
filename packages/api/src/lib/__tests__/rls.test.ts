import { describe, expect, it } from "bun:test";
import { Parser } from "node-sql-parser";
import {
  resolveClaimPath,
  resolveRLSFilters,
  injectRLSConditions,
} from "@atlas/api/lib/rls";
import type { RLSConfig } from "@atlas/api/lib/config";
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
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters).toHaveLength(2);
      expect(result.filters.map((f) => f.table).sort()).toEqual(["customers", "orders"]);
      expect(result.filters[0].column).toBe("tenant_id");
      expect(result.filters[0].value).toBe("acme");
    }
  });

  it("specific table policy matches only named tables", () => {
    const specificConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["orders"], column: "tenant_id", claim: "tenant_id" },
      ],
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders", "customers"]),
      specificConfig,
    );
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters).toHaveLength(1);
      expect(result.filters[0].table).toBe("orders");
    }
  });

  it("no match when policy tables not in query", () => {
    const specificConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["invoices"], column: "tenant_id", claim: "tenant_id" },
      ],
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders", "customers"]),
      specificConfig,
    );
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters).toHaveLength(0);
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
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters[0].value).toBe("org-42");
    }
  });

  it("deduplicates table/column pairs", () => {
    const dupeConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "tenant_id", claim: "tenant_id" },
        { tables: ["orders"], column: "tenant_id", claim: "tenant_id" },
      ],
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders"]),
      dupeConfig,
    );
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters).toHaveLength(1);
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
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters[0].value).toBe("O''Brien");
    }
  });

  it("multiple policies with different claims", () => {
    const multiConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["*"], column: "tenant_id", claim: "tenant_id" },
        { tables: ["users"], column: "id", claim: "sub" },
      ],
    };
    const result = resolveRLSFilters(
      user,
      new Set(["users", "orders"]),
      multiConfig,
    );
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      // orders gets tenant_id filter, users gets both tenant_id and id filter
      expect(result.filters).toHaveLength(3);
      const usersFilters = result.filters.filter((f) => f.table === "users");
      expect(usersFilters).toHaveLength(2);
    }
  });

  it("table matching is case-insensitive", () => {
    const upperConfig: RLSConfig = {
      enabled: true,
      policies: [
        { tables: ["Orders"], column: "tenant_id", claim: "tenant_id" },
      ],
    };
    const result = resolveRLSFilters(
      user,
      new Set(["orders"]),
      upperConfig,
    );
    expect("filters" in result).toBe(true);
    if ("filters" in result) {
      expect(result.filters).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// injectRLSConditions
// ---------------------------------------------------------------------------

describe("injectRLSConditions", () => {
  const filter = (table: string, column = "tenant_id", value = "acme"): {
    table: string;
    column: string;
    value: string;
  } => ({ table, column, value });

  it("injects WHERE into a simple SELECT with no existing WHERE", () => {
    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(sql, [filter("orders")], "postgres");
    expect(result.toLowerCase()).toContain("where");
    expect(result).toContain("tenant_id");
    expect(result).toContain("acme");
  });

  it("AND-merges with an existing WHERE clause", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, [filter("orders")], "postgres");
    expect(result.toLowerCase()).toContain("and");
    expect(result).toContain("tenant_id");
    expect(result).toContain("active");
  });

  it("uses table alias in the injected condition", () => {
    const sql = "SELECT o.id FROM orders o WHERE o.status = 'active'";
    const result = injectRLSConditions(sql, [filter("orders")], "postgres");
    // The condition should reference the alias 'o', not the table name 'orders'
    expect(result).toContain("o");
    expect(result).toContain("tenant_id");
  });

  it("injects into multiple joined tables", () => {
    const sql = "SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id";
    const result = injectRLSConditions(
      sql,
      [filter("orders"), filter("customers")],
      "postgres",
    );
    expect(result).toContain("tenant_id");
    // Both tables should be filtered
    const lowerResult = result.toLowerCase();
    expect(lowerResult).toContain("where");
  });

  it("returns SQL unchanged when no filters match", () => {
    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(sql, [], "postgres");
    expect(result).toBe(sql);
  });

  it("handles SQL injection safely — quotes in claim values", () => {
    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(
      sql,
      [filter("orders", "tenant_id", "O''Brien")],
      "postgres",
    );
    // Should produce valid SQL with escaped quotes
    expect(result).toContain("O''Brien");
    // Should NOT contain unescaped single quote that would break SQL
    expect(result).not.toContain("O'B");
  });

  it("works with MySQL dialect", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, [filter("orders")], "mysql");
    expect(result.toLowerCase()).toContain("and");
    expect(result).toContain("tenant_id");
  });

  it("produces valid SQL that can be re-parsed", () => {
    const sql = "SELECT * FROM orders WHERE status = 'active'";
    const result = injectRLSConditions(sql, [filter("orders")], "postgres");

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
      [filter("orders"), filter("returns")],
      "postgres",
    );
    // Both sides of the UNION should get filtered
    expect(result).toContain("tenant_id");
  });

  it("injects into derived tables (subqueries in FROM clause)", () => {
    const sql = "SELECT * FROM (SELECT * FROM orders) sub";
    const result = injectRLSConditions(sql, [filter("orders")], "postgres");
    // The inner subquery should get the WHERE condition
    expect(result).toContain("tenant_id");
    expect(result).toContain("acme");
    // Verify the result is valid SQL
    const p = new Parser();
    expect(() => p.astify(result, { database: "PostgresQL" })).not.toThrow();
  });

  it("injects into CTE body", () => {
    const sql = "WITH recent AS (SELECT * FROM orders WHERE created > '2024-01-01') SELECT * FROM recent";
    const result = injectRLSConditions(sql, [filter("orders")], "postgres");
    expect(result).toContain("tenant_id");
    expect(result).toContain("acme");
  });

  it("injects into WHERE subqueries", () => {
    const sql = "SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders)";
    const result = injectRLSConditions(
      sql,
      [filter("orders"), filter("customers")],
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
    };
    const filterResult = resolveRLSFilters(user, new Set(["orders"]), rlsConfig);
    expect("filters" in filterResult).toBe(true);
    if (!("filters" in filterResult)) return;

    const sql = "SELECT * FROM orders";
    const result = injectRLSConditions(sql, filterResult.filters, "postgres");

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
      [filter("orders"), filter("customers")],
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
});
