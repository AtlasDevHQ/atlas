/**
 * Tests for the adapter-side public-dataset tool gate (#2614).
 *
 * Pins the pure decision helpers `checkExploreCommand` +
 * `checkExecuteSQL`:
 *   - Allowed entity passes both gates.
 *   - Out-of-allowlist entity is refused (returns the entity name).
 *   - CTE names don't trip the SQL gate.
 *   - Pure-navigation explore commands (no `entities/<name>.yml`
 *     reference) pass through.
 *   - Unparseable SQL falls through to the downstream validator.
 *
 * The wrapping helpers (`wrapExplore`, `wrapExecuteSQL`) are exercised
 * indirectly via the adapter's unlinked-path test — this file keeps
 * the pure logic regression-tested without needing the bash backend.
 */

import { describe, it, expect } from "bun:test";

import {
  checkExploreCommand,
  checkExecuteSQL,
  createPublicDatasetToolRegistry,
} from "../public-dataset-tools";

const allow = new Set(["customers", "orders"]);

describe("checkExploreCommand", () => {
  it("returns null when no entity file is referenced (pure navigation)", () => {
    expect(checkExploreCommand("ls entities/", allow)).toBeNull();
    expect(checkExploreCommand("cat catalog.yml", allow)).toBeNull();
    expect(
      checkExploreCommand("grep -r revenue . --include=*.yml", allow),
    ).toBeNull();
  });

  it("returns null when every referenced entity is allowed", () => {
    expect(
      checkExploreCommand("cat entities/customers.yml", allow),
    ).toBeNull();
    expect(
      checkExploreCommand(
        "head entities/customers.yml entities/orders.yaml",
        allow,
      ),
    ).toBeNull();
  });

  it("returns the first refused entity name when an out-of-allowlist entity is referenced", () => {
    expect(checkExploreCommand("cat entities/billing.yml", allow)).toBe(
      "billing",
    );
    // Mixed allowed + refused: the FIRST refused name wins.
    expect(
      checkExploreCommand(
        "head entities/customers.yml entities/billing.yml",
        allow,
      ),
    ).toBe("billing");
  });

  it("is case-insensitive on entity name comparison", () => {
    expect(
      checkExploreCommand("cat entities/Customers.yml", allow),
    ).toBeNull();
  });
});

describe("checkExecuteSQL", () => {
  it("returns null when every referenced table is allowed", () => {
    expect(checkExecuteSQL("SELECT COUNT(*) FROM customers", allow)).toBeNull();
    expect(
      checkExecuteSQL(
        "SELECT c.id, o.total FROM customers c JOIN orders o ON o.customer_id = c.id",
        allow,
      ),
    ).toBeNull();
  });

  it("returns the table name when an out-of-allowlist table is referenced", () => {
    expect(checkExecuteSQL("SELECT * FROM billing", allow)).toBe("billing");
    expect(
      checkExecuteSQL(
        "SELECT c.id FROM customers c JOIN billing b ON b.customer_id = c.id",
        allow,
      ),
    ).toBe("billing");
  });

  it("excludes CTE names from the gate", () => {
    // CTE `recent` is named in `WITH ... AS (...)`; it should NOT
    // count as a "table" the gate refuses.
    expect(
      checkExecuteSQL(
        "WITH recent AS (SELECT * FROM customers WHERE created_at > now() - interval '7 days') SELECT * FROM recent",
        allow,
      ),
    ).toBeNull();
  });

  it("returns null when SQL is unparseable (defers to downstream validator)", () => {
    // Garbage input — the downstream `validateSQL` in `tools/sql.ts`
    // owns the user-facing parse-error message, so the gate stays
    // silent rather than racing it.
    expect(checkExecuteSQL("not valid sql at all !@#", allow)).toBeNull();
  });
});

describe("createPublicDatasetToolRegistry", () => {
  it("produces a frozen registry with explore + executeSQL wrapped tools", () => {
    const registry = createPublicDatasetToolRegistry(["customers"]);
    expect(registry.size).toBe(2);
    expect(registry.get("explore")).toBeDefined();
    expect(registry.get("executeSQL")).toBeDefined();
    // Frozen — further registrations throw, matching the default
    // workspace registry shape.
    expect(() =>
      registry.register({
        name: "extra",
        description: "x",
        tool: { execute: async () => "x" } as unknown as never,
      }),
    ).toThrow(/frozen/);
  });
});
