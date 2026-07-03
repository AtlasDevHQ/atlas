/**
 * Tests for `buildStaleCatalogQuery` (#2284, dormancy gate #2377) — the stale
 * BYOT-catalog selection SQL. Coverage added by #4195 (the periodic-DB-job
 * runner pass): the real-Postgres smoke (`migrate-pg.test.ts`) asserts the
 * dormancy predicate's ROW-SELECTION semantics against a live DB, but the pure
 * query BUILDER — which arm is emitted, and that each arm carries the right
 * parameters + ordering — had no fast unit test guarding it against drift.
 *
 * These are structural assertions on the emitted SQL string (the builder is a
 * pure function of the boolean); the semantic behavior is covered by the smoke.
 */

import { describe, expect, it } from "bun:test";
import { buildStaleCatalogQuery } from "../byot-catalog-query";

describe("buildStaleCatalogQuery", () => {
  describe("dormancy disabled (legacy TTL-only)", () => {
    const sql = buildStaleCatalogQuery(false);

    it("selects the org/provider/region tuple the scheduler walks", () => {
      expect(sql).toContain("SELECT wmc.org_id, wmc.provider, wmc.bedrock_region");
    });

    it("filters to the three BYOT providers", () => {
      expect(sql).toContain("wmc.provider IN ('anthropic', 'openai', 'bedrock')");
    });

    it("gates on the TTL ($1) and bounds by the limit ($2)", () => {
      expect(sql).toContain("wmcat.fetched_at < now() - ($1::bigint * interval '1 ms')");
      expect(sql).toContain("LIMIT $2");
    });

    it("selects never-fetched catalogs — the `fetched_at IS NULL OR` WHERE arm, not just the ordering", () => {
      // Dropping this predicate would silently stop refreshing never-fetched
      // rows while ORDER BY … NULLS FIRST stayed green.
      expect(sql).toContain("wmcat.fetched_at IS NULL OR");
    });

    it("orders least-recently-fetched first — NULLS FIRST drains never-fetched rows", () => {
      expect(sql).toContain("ORDER BY wmcat.fetched_at NULLS FIRST");
    });

    it("does NOT join organization and does NOT reference the dormancy param $3", () => {
      expect(sql).not.toContain("organization");
      expect(sql).not.toContain("last_active_at");
      expect(sql).not.toContain("$3");
    });
  });

  describe("dormancy enabled (#2377 gate)", () => {
    const sql = buildStaleCatalogQuery(true);

    it("LEFT JOINs organization and gates on last_active_at via the dormancy param $3", () => {
      expect(sql).toContain("LEFT JOIN organization org ON org.id = wmc.org_id");
      expect(sql).toContain(
        "org.last_active_at IS NULL OR org.last_active_at > now() - ($3::bigint * interval '1 ms')",
      );
    });

    it("treats a missing org row as active — the IS NULL arm keeps orphaned configs refreshing", () => {
      expect(sql).toContain("org.last_active_at IS NULL");
    });

    it("keeps the TTL ($1) + limit ($2) + never-fetched predicates from the legacy query", () => {
      expect(sql).toContain("wmcat.fetched_at < now() - ($1::bigint * interval '1 ms')");
      expect(sql).toContain("wmcat.fetched_at IS NULL OR");
      expect(sql).toContain("LIMIT $2");
    });
  });

  it("both arms are a single SELECT statement (no chaining)", () => {
    for (const sql of [buildStaleCatalogQuery(false), buildStaleCatalogQuery(true)]) {
      expect(sql.trim().startsWith("SELECT")).toBe(true);
      expect(sql).not.toContain(";");
    }
  });
});
