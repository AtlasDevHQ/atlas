/**
 * ADR-0032 pin (#4521) — amendments refine the semantic layer; they never grow
 * the queryable table set.
 *
 * The column-anchored coverage view makes "just add the table from here" very
 * tempting, and someone will suggest it (ADR-0032's rejected alternative). The
 * containment — no Amendment type may add an entity or touch `table:` — is what
 * makes auto-approve and the autonomous scheduler safe to contemplate: with it,
 * the blast radius of any LLM-authored change is bounded to *how well existing
 * tables are described*. This test fails the instant a whitelist-expanding type
 * is added to the proposable set, so nobody "fixes" the deliberate gap.
 *
 * The structural enforcement lives in `apply.ts` / `whitelist.ts` (amendment
 * types simply have no vocabulary for tables); `AMENDMENT_TYPES` is the SSOT for
 * what the expert agent + scheduler may propose, so pinning it is pinning the
 * proposable surface.
 */

import { describe, it, expect } from "bun:test";
import { AMENDMENT_TYPES } from "@useatlas/types";

/**
 * The refine-only allowlist. Every proposable amendment type must be here — each
 * touches descriptions / dimensions / measures / joins / query patterns /
 * glossary terms of an entity that ALREADY exists. None names a table or entity.
 */
const REFINE_ONLY_TYPES = new Set<string>([
  "add_dimension",
  "add_measure",
  "add_join",
  "add_query_pattern",
  "update_description",
  "update_dimension",
  "add_glossary_term",
  "add_virtual_dimension",
]);

describe("ADR-0032 — amendments refine, never grow (#4521)", () => {
  it("every proposable amendment type is in the refine-only allowlist", () => {
    for (const type of AMENDMENT_TYPES) {
      expect(REFINE_ONLY_TYPES.has(type)).toBe(true);
    }
  });

  it("no amendment type carries whitelist-expanding (entity/table) vocabulary", () => {
    // A type that adds an entity or a table would expand the whitelisted, queryable
    // surface — the security boundary SQL validation enforces. None may.
    for (const type of AMENDMENT_TYPES) {
      expect(type).not.toMatch(/entity|table|whitelist|source|connection/i);
    }
  });

  it("has no `add_entity` / `add_table` / `create_entity` type", () => {
    const forbidden = ["add_entity", "add_table", "create_entity", "add_source", "add_connection"];
    for (const f of forbidden) {
      expect(AMENDMENT_TYPES as readonly string[]).not.toContain(f);
    }
  });
});
