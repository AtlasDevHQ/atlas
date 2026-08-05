import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAIN_EDGE_TYPES,
  BRAIN_FACT_STATUSES,
  PREDICATE_CARDINALITIES,
  TRUST_TIERS,
} from "@atlas/api/lib/brain/types";
import {
  CARDINALITY_SOURCE_CLASSES,
  CARDINALITY_STATUSES,
} from "@atlas/api/lib/brain/cardinality";

// Source-level drift guard between the TypeScript vocabulary and migration
// 0180's CHECK constraints (#4767, ADR-0036).
//
// Why this is worth a test rather than a comment: the enum and the constraint
// are the SAME decision written twice, and they fail asymmetrically. Widen the
// TS union and forget the CHECK, and the extra value is rejected at INSERT
// with a 23514 that surfaces to a user as a failed ingest. Widen the CHECK and
// forget the TS union, and rows land that no reader can narrow — the far worse
// direction, because it's silent. Neither shows up in a type-check.
//
// These run in every shard: no Postgres required, just the SQL text.
const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "..", "..", "db", "migrations", "0180_brain_substrate.sql"),
  "utf8",
);

/**
 * Pull the quoted values out of a `CHECK (... IN ('a', 'b'))` constraint.
 * Line comments are stripped first — the migration's prose header names these
 * same values repeatedly, and a comment must never be able to satisfy (or
 * corrupt) the assertion.
 */
function checkConstraintValues(constraintName: string): string[] {
  const withoutComments = MIGRATION_SQL.replace(/--.*$/gm, "");
  const constraint = new RegExp(
    `CONSTRAINT\\s+${constraintName}\\s*CHECK\\s*\\(([^)]*)\\)`,
    "i",
  ).exec(withoutComments);
  if (!constraint) {
    throw new Error(
      `constraint ${constraintName} not found in 0180_brain_substrate.sql — ` +
        `renamed or dropped? The TS vocabulary in lib/brain/types.ts is now unpinned.`,
    );
  }
  return [...constraint[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe("brain substrate vocabulary (#4767)", () => {
  it("BRAIN_EDGE_TYPES matches the migration's edge-type CHECK exactly", () => {
    expect(checkConstraintValues("chk_brain_edges_type").toSorted()).toEqual(
      [...BRAIN_EDGE_TYPES].toSorted(),
    );
  });

  it("pins the four ADR-0036 edge types — extending needs a migration, not an edit here", () => {
    // Spelled out rather than derived: this is the committed set from the ADR,
    // and a future slice widening the union should have to change a line that
    // says so out loud.
    expect([...BRAIN_EDGE_TYPES].toSorted()).toEqual([
      "derives-from",
      "in-tension-with",
      "provenance",
      "supersedes",
    ]);
  });

  it("BRAIN_FACT_STATUSES matches the migration's status CHECK exactly", () => {
    expect(checkConstraintValues("chk_brain_facts_status").toSorted()).toEqual(
      [...BRAIN_FACT_STATUSES].toSorted(),
    );
  });

  it("carries the content-mode triple so facts can join the review gate (#4769)", () => {
    expect([...BRAIN_FACT_STATUSES].toSorted()).toEqual(["archived", "draft", "published"]);
  });

  it("PREDICATE_CARDINALITIES matches the migration's cardinality CHECK exactly", () => {
    expect(checkConstraintValues("chk_brain_facts_predicate_cardinality").toSorted()).toEqual(
      [...PREDICATE_CARDINALITIES].toSorted(),
    );
  });

  it("defaults predicate cardinality to the conservative arm in the schema", () => {
    // Coexisting wrongly is recoverable at the review gate; superseding
    // wrongly destroys a belief. If someone flips this default to 'single',
    // the M2 engine starts silently overwriting history.
    expect(MIGRATION_SQL).toContain("predicate_cardinality text NOT NULL DEFAULT 'multi'");
  });

  it("orders trust tiers warehouse < fact < episode (the arbitration order)", () => {
    expect(TRUST_TIERS.warehouse).toBeLessThan(TRUST_TIERS.fact);
    expect(TRUST_TIERS.fact).toBeLessThan(TRUST_TIERS.episode);
  });

  it("keeps tier-1 out of the brain tables — no table stores a warehouse fact", () => {
    // ADR-0036: warehouse facts resolve live through the semantic layer and
    // are gated by warehouse RLS. If a `trust_tier`/`tier` column ever appears
    // on brain_facts, tier-1 has been given a home here and the no-double-
    // gating decision (T5) needs revisiting before this test is updated.
    expect(MIGRATION_SQL).not.toMatch(/^\s*(trust_)?tier\s+(int|smallint|text)/mi);
  });
});

// ---------------------------------------------------------------------------
// The same guard for migration 0192's vocabularies (#5027, ADR-0037 §3)
// ---------------------------------------------------------------------------

/**
 * Cardinality's three source classes and three statuses are each written twice
 * — a TS tuple and a CHECK — and they fail asymmetrically for exactly the
 * reason the block above gives, with one arm strictly worse here.
 *
 * Widen the TS tuple and forget the CHECK: #5042's warehouse producer compiles,
 * type-checks, passes every suite, and then fails at runtime on a `23514` the
 * first time it runs against a real database — which is precisely the failure
 * `lib/brain/cardinality.ts` says the CHECK exists to force EARLY.
 *
 * Widen the CHECK and forget the tuple: rows land that `narrowSourceClass`
 * cannot narrow, so they degrade to `correction_event` with a warning, and a
 * producer's authority is silently relabelled. Silent, and on the table that
 * gates an irreversible write.
 */
const MIGRATION_0192_SQL = readFileSync(
  join(import.meta.dir, "..", "..", "db", "migrations", "0192_brain_predicate_cardinality.sql"),
  "utf8",
);

function checkValues0192(constraintName: string): string[] {
  const withoutComments = MIGRATION_0192_SQL.replace(/--.*$/gm, "");
  const constraint = new RegExp(
    `CONSTRAINT\\s+${constraintName}\\s*CHECK\\s*\\(([^)]*)\\)`,
    "i",
  ).exec(withoutComments);
  if (!constraint) {
    throw new Error(
      `constraint ${constraintName} not found in 0192_brain_predicate_cardinality.sql — ` +
        "renamed or dropped? The TS vocabulary in lib/brain/cardinality.ts is now unpinned.",
    );
  }
  return [...constraint[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe("cardinality vocabulary (#5027)", () => {
  it("CARDINALITY_SOURCE_CLASSES matches 0192's source-class CHECK exactly", () => {
    expect(checkValues0192("ck_brain_predicate_cardinality_source_class").toSorted()).toEqual(
      [...CARDINALITY_SOURCE_CLASSES].toSorted(),
    );
  });

  it("CARDINALITY_STATUSES matches 0192's status CHECK exactly", () => {
    expect(checkValues0192("ck_brain_predicate_cardinality_status").toSorted()).toEqual(
      [...CARDINALITY_STATUSES].toSorted(),
    );
  });

  it("the cardinality CHECK is the same two values as the row column's", () => {
    // Two tables, one vocabulary — and they have to agree while both exist,
    // because #5028 drops the row column and a mismatch would surface as a
    // migration failure rather than as a decision.
    expect(checkValues0192("ck_brain_predicate_cardinality_value").toSorted()).toEqual(
      [...PREDICATE_CARDINALITIES].toSorted(),
    );
  });

  it("pins ADR-0037 §3(d)'s three sources — a fourth needs a migration, not an edit here", () => {
    // Spelled out rather than derived, on `BRAIN_EDGE_TYPES`' precedent: this is
    // the committed set from the ADR, and a slice widening it should have to
    // change a line that says so out loud. `single` may enter by these three
    // doors and no others.
    expect([...CARDINALITY_SOURCE_CLASSES].toSorted()).toEqual([
      "correction_event",
      "human",
      "warehouse_structural",
    ]);
  });

  it("has NO default cardinality — absence is the answer, not a stored `multi`", () => {
    // The inverse of the row column's `DEFAULT 'multi'` guard above, and the
    // whole positive-evidence rule: a default would make every INSERT that
    // omitted the column assert something, where absence from the TABLE is what
    // means `multi`. There must also be no backfill.
    expect(MIGRATION_0192_SQL).toMatch(/cardinality text NOT NULL,/);
    expect(MIGRATION_0192_SQL).not.toMatch(/cardinality text NOT NULL DEFAULT/);
    expect(MIGRATION_0192_SQL.replace(/--.*$/gm, "")).not.toMatch(/\bUPDATE\b|\bINSERT\b/i);
  });
});
