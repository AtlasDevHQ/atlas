/**
 * Pure-unit coverage for the catalog CRUD SQL builders (#4232). The
 * live-schema execution of these statements lives in
 * `catalog-crud-pg.test.ts`; this file pins the pieces that don't need
 * a database — the ADR-0006 type→pillar mapping and the shape/param
 * discipline of the dynamic UPDATE builder.
 */

import { describe, expect, it } from "bun:test";
import {
  buildCatalogCreateSql,
  buildCatalogUpdateSql,
  pillarFromCatalogType,
} from "../catalog-crud";

describe("pillarFromCatalogType", () => {
  // ADR-0006 / the 0092 trigger's CASE: chat→chat, datasource→datasource,
  // everything else→action. Covers both the CRUD route's admitted types
  // (datasource/context/interaction/action/sandbox) and the seeder's
  // (chat/integration), which share this mapping.
  it.each([
    ["chat", "chat"],
    ["datasource", "datasource"],
    ["context", "action"],
    ["interaction", "action"],
    ["action", "action"],
    ["sandbox", "action"],
    ["integration", "action"],
  ] as const)("maps %s → %s", (type, pillar) => {
    expect(pillarFromCatalogType(type)).toBe(pillar);
  });

  it("never derives the knowledge pillar (explicit-naming writers only)", () => {
    // 'knowledge' rows are type 'context' with pillar named by the
    // knowledge seeder/ingest — the derivation maps context to action.
    expect(pillarFromCatalogType("context")).not.toBe("knowledge");
  });
});

describe("buildCatalogCreateSql", () => {
  it("names pillar explicitly and derives it from type (#4232)", () => {
    const { sql, params } = buildCatalogCreateSql("id-1", {
      name: "BigQuery",
      slug: "bigquery",
      type: "datasource",
      minPlan: "starter",
      enabled: true,
    });
    expect(sql).toContain("pillar");
    // Param order is pinned by the pg test executing this verbatim; here
    // just assert the derived pillar rides along with the type.
    expect(params).toContain("datasource");
    expect(params[params.indexOf("datasource") + 1]).toBe("datasource");
  });

  it("serializes configSchema and defaults optionals to null", () => {
    const { params } = buildCatalogCreateSql("id-2", {
      name: "Email",
      slug: "email",
      type: "action",
      configSchema: { fields: [] },
      minPlan: "starter",
      enabled: false,
    });
    expect(params).toContain('{"fields":[]}');
    expect(params).toContain(null);
  });
});

describe("buildCatalogUpdateSql", () => {
  it("returns null when no updatable field is present", () => {
    expect(buildCatalogUpdateSql("id-1", {})).toBeNull();
  });

  it("does not touch pillar when type is absent", () => {
    const update = buildCatalogUpdateSql("id-1", { name: "Renamed", enabled: false });
    expect(update).not.toBeNull();
    expect(update!.sql).not.toContain("pillar");
    expect(update!.params).toEqual(["Renamed", false, "id-1"]);
  });

  it("re-derives pillar only when type actually changes (#4232)", () => {
    const update = buildCatalogUpdateSql("id-1", { type: "datasource" });
    expect(update).not.toBeNull();
    // The CASE's bare `type` reads the OLD row in an UPDATE's SET — the
    // guard that keeps a same-type PUT from clobbering an explicitly
    // named pillar (e.g. knowledge rows).
    expect(update!.sql).toContain("pillar = CASE WHEN type IS DISTINCT FROM $1 THEN $2 ELSE pillar END");
    expect(update!.params).toEqual(["datasource", "datasource", "id-1"]);
  });

  it("keeps param placeholders aligned when type rides with other fields", () => {
    const update = buildCatalogUpdateSql("id-9", {
      name: "New name",
      type: "sandbox",
      enabled: true,
    });
    expect(update).not.toBeNull();
    expect(update!.sql).toContain("name = $1");
    expect(update!.sql).toContain("type = $2");
    expect(update!.sql).toContain("pillar = CASE WHEN type IS DISTINCT FROM $2 THEN $3 ELSE pillar END");
    expect(update!.sql).toContain("enabled = $4");
    expect(update!.sql).toContain("WHERE id = $5");
    expect(update!.params).toEqual(["New name", "sandbox", "action", true, "id-9"]);
  });
});
