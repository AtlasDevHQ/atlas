/**
 * Behavioral unit tests for the pure Source-catalog builder (ADR-0022 §4,
 * slice (b) #3894). Pure — no DB, no IO. The named `describe` blocks line up
 * with the issue's acceptance criteria: one entry per source, description
 * fallback, REST inclusion, deterministic ordering, and bounded size.
 */

import { describe, it, expect } from "bun:test";
import {
  buildSourceCatalog,
  deriveGroupDescription,
  type CatalogSource,
} from "../index";

function sql(id: string, over: Partial<CatalogSource> = {}): CatalogSource {
  return { kind: "sql", id, name: id, ...over };
}
function rest(id: string, over: Partial<CatalogSource> = {}): CatalogSource {
  return { kind: "rest", id, name: id, ...over };
}

describe("buildSourceCatalog — empty", () => {
  it("returns '' for no sources (safe unconditional append)", () => {
    expect(buildSourceCatalog([])).toBe("");
  });
});

describe("buildSourceCatalog — one entry per source", () => {
  it("renders exactly one bullet per source", () => {
    const out = buildSourceCatalog([
      sql("orders", { entities: ["orders", "customers"] }),
      sql("analytics", { entities: ["events"] }),
      rest("stripe", { entities: ["ListCharges"] }),
    ]);
    const bullets = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(3);
  });

  it("includes the header + routing guidance once", () => {
    const out = buildSourceCatalog([sql("orders", { entities: ["orders"] })]);
    expect(out).toContain("## Source catalog");
    expect(out.match(/## Source catalog/g)).toHaveLength(1);
    expect(out).toContain("executeSQL");
    expect(out).toContain("executeRestOperation");
  });

  it("surfaces each source's routing id verbatim", () => {
    const out = buildSourceCatalog([
      sql("orders-prod", { entities: ["orders"] }),
      rest("stripe_install_1", { entities: ["ListCharges"] }),
    ]);
    expect(out).toContain("[id: `orders-prod`]");
    expect(out).toContain("[id: `stripe_install_1`]");
  });

  it("falls back to the id when a name is blank", () => {
    const out = buildSourceCatalog([sql("g1", { name: "  ", entities: ["t"] })]);
    expect(out).toContain("**g1**");
  });
});

describe("buildSourceCatalog — description vs entity-name fallback", () => {
  it("uses the provided description when present", () => {
    const out = buildSourceCatalog([
      sql("orders", {
        description: "Production order & fulfillment data.",
        entities: ["orders", "customers"],
      }),
    ]);
    expect(out).toContain("Production order & fulfillment data.");
  });

  it("falls back to an entity-name summary when no description is set", () => {
    const out = buildSourceCatalog([
      sql("orders", { entities: ["orders", "customers", "shipments", "refunds"] }),
    ]);
    // Fallback summarizes the first few entity names alphabetically.
    expect(out).toContain("Covers customers, orders, refunds, and 1 more.");
  });

  it("treats a blank/whitespace description as absent (falls back)", () => {
    const out = buildSourceCatalog([
      sql("orders", { description: "   ", entities: ["orders"] }),
    ]);
    expect(out).toContain("Covers orders.");
  });

  it("reports 'no entities profiled yet' when neither description nor entities exist", () => {
    const out = buildSourceCatalog([sql("fresh")]);
    expect(out).toContain("No entities profiled yet.");
  });

  it("still lists headline entities even when a description is present", () => {
    const out = buildSourceCatalog([
      sql("orders", { description: "Order data.", entities: ["orders", "customers"] }),
    ]);
    expect(out).toContain("Key entities: customers, orders.");
  });
});

describe("buildSourceCatalog — REST inclusion", () => {
  it("renders REST datasources in their own section, labeled 'operations'", () => {
    const out = buildSourceCatalog([
      sql("orders", { entities: ["orders"] }),
      rest("stripe", { description: "Payments.", entities: ["ListCharges", "ListInvoices"] }),
    ]);
    expect(out).toContain("### SQL connection groups");
    expect(out).toContain("### REST datasources");
    expect(out).toContain("Key operations: ListCharges, ListInvoices.");
  });

  it("omits the SQL section when there are only REST datasources", () => {
    const out = buildSourceCatalog([rest("stripe", { entities: ["ListCharges"] })]);
    expect(out).not.toContain("### SQL connection groups");
    expect(out).toContain("### REST datasources");
  });

  it("REST fallback summary uses 'operations' as the noun", () => {
    const out = buildSourceCatalog([rest("fresh")]);
    expect(out).toContain("No operations profiled yet.");
  });
});

describe("buildSourceCatalog — deterministic ordering", () => {
  it("orders SQL groups before REST, each sorted by id case-insensitively", () => {
    const out = buildSourceCatalog([
      rest("zeta", { entities: ["x"] }),
      sql("Beta", { entities: ["x"] }),
      rest("alpha", { entities: ["x"] }),
      sql("alpha", { entities: ["x"] }),
    ]);
    const ids = [...out.matchAll(/\[id: `([^`]+)`\]/g)].map((m) => m[1]);
    expect(ids).toEqual(["alpha", "Beta", "alpha", "zeta"]);
  });

  it("is order-independent — shuffled input yields identical output", () => {
    const a: CatalogSource[] = [
      sql("b", { entities: ["t2", "t1"] }),
      sql("a", { entities: ["z"] }),
      rest("c", { entities: ["op"] }),
    ];
    const b: CatalogSource[] = [a[2], a[0], a[1]];
    expect(buildSourceCatalog(a)).toBe(buildSourceCatalog(b));
  });

  it("dedupes + sorts headline items deterministically", () => {
    const out = buildSourceCatalog([
      sql("g", { entities: ["Orders", "orders", "customers", "orders"] }),
    ]);
    // Case-insensitive dedupe keeps first spelling; alphabetical order.
    expect(out).toContain("Key entities: customers, Orders.");
  });
});

describe("buildSourceCatalog — bounded size", () => {
  it("caps headline items per source with an explicit +N more", () => {
    const out = buildSourceCatalog(
      [sql("g", { entities: ["a", "b", "c", "d", "e", "f", "g", "h"] })],
      { maxItemsPerSource: 3 },
    );
    expect(out).toContain("Key entities: a, b, c (+5 more).");
  });

  it("truncates an over-long description at a word boundary with an ellipsis", () => {
    const long = "word ".repeat(80).trim(); // 400+ chars
    const out = buildSourceCatalog([sql("g", { description: long })], {
      maxDescriptionChars: 40,
    });
    const line = out.split("\n").find((l) => l.startsWith("- **g**"))!;
    expect(line).toContain("…");
    // Bounded under the cap + the bullet/name/id scaffolding.
    expect(line.length).toBeLessThan(120);
  });

  it("caps total sources, reports the overflow, and never silently drops", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      sql(`g${String(i).padStart(2, "0")}`, { entities: ["t"] }),
    );
    const out = buildSourceCatalog(many, { maxSources: 10 });
    const bullets = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(10);
    expect(out).toContain("Showing 10 of 50 sources");
  });

  it("prioritizes SQL groups over REST when the total cap bites", () => {
    const sources = [
      ...Array.from({ length: 8 }, (_, i) => sql(`s${i}`, { entities: ["t"] })),
      ...Array.from({ length: 8 }, (_, i) => rest(`r${i}`, { entities: ["t"] })),
    ];
    const out = buildSourceCatalog(sources, { maxSources: 10 });
    // 8 SQL + 2 REST kept; remaining 6 REST overflow.
    expect(out).toContain("### SQL connection groups");
    expect(out).toContain("### REST datasources");
    expect(out).toContain("Showing 10 of 16 sources");
    const restBullets = out
      .split("### REST datasources")[1]
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(restBullets).toHaveLength(2);
  });
});

describe("deriveGroupDescription — auto-generated seed", () => {
  it("returns '' for an empty group", () => {
    expect(deriveGroupDescription([])).toBe("");
    expect(deriveGroupDescription([{ name: "  " }])).toBe("");
  });

  it("weaves in entity descriptions when present (richer than the live fallback)", () => {
    const out = deriveGroupDescription([
      { name: "orders", description: "customer purchases" },
      { name: "customers", description: "account records" },
    ]);
    expect(out).toBe("2 tables: customers (account records); orders (customer purchases).");
  });

  it("names tables without descriptions and counts the remainder", () => {
    const out = deriveGroupDescription(
      [
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
        { name: "e" },
      ],
      { maxNamed: 2 },
    );
    expect(out).toBe("5 tables: a; b, and 3 more.");
  });

  it("uses singular 'table' for a single-entity group", () => {
    expect(deriveGroupDescription([{ name: "orders" }])).toBe("1 table: orders.");
  });

  it("is deterministic regardless of input order", () => {
    const a = deriveGroupDescription([{ name: "b" }, { name: "a" }]);
    const b = deriveGroupDescription([{ name: "a" }, { name: "b" }]);
    expect(a).toBe(b);
  });
});
