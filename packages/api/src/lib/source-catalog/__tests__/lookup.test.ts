/**
 * Behavioral tests for the impure Source-catalog loader (ADR-0022 §4,
 * slice (b) #3894). Mocks the three inputs — visible SQL groups
 * (`loadVisibleGroups`), group descriptions (`getGroupDescriptionMap`), and
 * entity summaries (`listEntities`) — and asserts the assembled catalog:
 * SQL groups carry their description + headline entities, REST datasources are
 * appended, and an assembly failure degrades to REST-only rather than throwing.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { VisibleGroup } from "@atlas/api/lib/group-reach/index";

// Mutable fixtures the mocks read each call.
let visibleGroups: readonly VisibleGroup[];
let descriptions: Map<string, string>;
let entityEntries: ReadonlyArray<{ name: string; source: string }>;
let visibleThrows = false;
let autoUpserts: Array<{ orgId: string; groupId: string; description: string }> = [];

void mock.module("@atlas/api/lib/group-reach/lookup", () => ({
  loadVisibleGroups: async () => {
    if (visibleThrows) throw new Error("visible groups failed");
    return visibleGroups;
  },
}));

void mock.module("@atlas/api/lib/db/connection-group-descriptions", () => ({
  getGroupDescriptionMap: async () => descriptions,
  listGroupDescriptions: async () => [],
  upsertAutoGroupDescription: async (orgId: string, groupId: string, description: string) => {
    autoUpserts.push({ orgId, groupId, description });
  },
  setManualGroupDescription: async () => false,
}));

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: async () => entityEntries,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { loadSourceCatalog, refreshGroupAutoDescription } = await import("../lookup");

function g(id: string): VisibleGroup {
  return { id, members: [id], primary: id };
}

describe("loadSourceCatalog", () => {
  beforeEach(() => {
    visibleGroups = [];
    descriptions = new Map();
    entityEntries = [];
    visibleThrows = false;
    autoUpserts = [];
  });

  it("returns '' when there are no sources at all", async () => {
    expect(await loadSourceCatalog("org", "published", [])).toBe("");
  });

  it("renders SQL groups with their description and headline entities", async () => {
    visibleGroups = [g("orders")];
    descriptions = new Map([["orders", "Production order data."]]);
    entityEntries = [
      { name: "orders", source: "orders" },
      { name: "customers", source: "orders" },
    ];
    const out = await loadSourceCatalog("org", "published", []);
    expect(out).toContain("**orders** [id: `orders`] — Production order data.");
    expect(out).toContain("Key entities: customers, orders.");
  });

  it("#3895 — Focus reach narrows the SQL half to the focused group only", async () => {
    visibleGroups = [g("orders"), g("analytics")];
    entityEntries = [
      { name: "orders", source: "orders" },
      { name: "events", source: "analytics" },
    ];
    // All sources (default) lists every visible group.
    const all = await loadSourceCatalog("org", "published", []);
    expect(all).toContain("[id: `orders`]");
    expect(all).toContain("[id: `analytics`]");
    // Focus → orders lists only orders (matching what executeSQL will allow).
    const focused = await loadSourceCatalog("org", "published", [], {}, {
      kind: "focus",
      groupId: "orders",
    });
    expect(focused).toContain("[id: `orders`]");
    expect(focused).not.toContain("[id: `analytics`]");
  });

  it("#3895 — Focus on an invisible group drops the SQL half entirely (no substitution)", async () => {
    visibleGroups = [g("orders")];
    entityEntries = [{ name: "orders", source: "orders" }];
    const out = await loadSourceCatalog("org", "published", [
      { id: "stripe_1", displayName: "Stripe", operationNames: ["ListCharges"] },
    ], {}, { kind: "focus", groupId: "gone" });
    // The focused group isn't visible → no SQL section; REST (separate axis) stays.
    expect(out).not.toContain("### SQL connection groups");
    expect(out).toContain("**Stripe** [id: `stripe_1`]");
  });

  it("falls back to an entity-name summary when a group has no description", async () => {
    visibleGroups = [g("analytics")];
    entityEntries = [{ name: "events", source: "analytics" }];
    const out = await loadSourceCatalog("org", "published", []);
    expect(out).toContain("Covers events.");
  });

  it("appends REST datasources handed in by the caller", async () => {
    visibleGroups = [g("orders")];
    entityEntries = [{ name: "orders", source: "orders" }];
    const out = await loadSourceCatalog("org", "published", [
      { id: "stripe_1", displayName: "Stripe", operationNames: ["ListCharges"] },
    ]);
    expect(out).toContain("### SQL connection groups");
    expect(out).toContain("### REST datasources");
    expect(out).toContain("**Stripe** [id: `stripe_1`]");
  });

  it("degrades to REST-only when SQL group assembly throws", async () => {
    visibleThrows = true;
    const out = await loadSourceCatalog("org", "published", [
      { id: "stripe_1", displayName: "Stripe", operationNames: ["ListCharges"] },
    ]);
    expect(out).not.toContain("### SQL connection groups");
    expect(out).toContain("**Stripe** [id: `stripe_1`]");
  });

  it("renders REST-only (skips SQL enumeration) when there is no orgId", async () => {
    visibleThrows = true; // would throw if SQL enumeration were attempted
    const out = await loadSourceCatalog(undefined, "published", [
      { id: "stripe_1", displayName: "Stripe", operationNames: ["ListCharges"] },
    ]);
    expect(out).toContain("**Stripe** [id: `stripe_1`]");
  });
});

describe("refreshGroupAutoDescription", () => {
  beforeEach(() => {
    autoUpserts = [];
  });

  it("derives a description from the saved batch's YAML and persists it", async () => {
    await refreshGroupAutoDescription("org", "orders", [
      { name: "orders", yaml: "table: orders\nname: orders\ndescription: customer purchases\n" },
      { name: "customers", yaml: "table: customers\ndescription: account records\n" },
    ]);
    expect(autoUpserts).toHaveLength(1);
    expect(autoUpserts[0]).toMatchObject({ orgId: "org", groupId: "orders" });
    expect(autoUpserts[0].description).toBe(
      "2 tables: customers (account records); orders (customer purchases).",
    );
  });

  it("falls back to the table name when an entity's YAML is unparseable", async () => {
    await refreshGroupAutoDescription("org", "g", [
      { name: "good", yaml: "table: good\ndescription: ok\n" },
      { name: "bad", yaml: ":\n  - [unbalanced" },
    ]);
    expect(autoUpserts).toHaveLength(1);
    // The bad row still contributes its table name; the good row its description.
    expect(autoUpserts[0].description).toBe("2 tables: bad; good (ok).");
  });

  it("does not persist when the batch yields no nameable entities", async () => {
    await refreshGroupAutoDescription("org", "g", []);
    expect(autoUpserts).toHaveLength(0);
  });
});
