/**
 * The collision statements, pinned BYTE FOR BYTE against what `main` emitted
 * before #5025 parameterized them.
 *
 * ## What this file is for, stated narrowly
 *
 * #5025's blast-radius preview asks a counterfactual — *what would collide if I
 * approved this?* — and `supersessionCollisionJoin`'s header forbids the obvious
 * way to build one: *two spellings of "what collides" is a disclosure that lists
 * one set while the transaction stamps another*. So the arms stayed
 * single-spelled and the COLUMNS became a parameter ({@link CollisionExprs}),
 * with {@link STORED_COLLISION_EXPRS} as every existing caller's default.
 *
 * That refactor's entire safety claim is *"the shipped statements are
 * unchanged"* — and that is exactly the class of claim that is cheap to believe,
 * invisible when wrong, and lands on a predicate that stamps `valid_to`. A
 * `toContain` or a shape assertion cannot falsify it: a default that silently
 * dropped the cardinality gate still contains every substring anyone would think
 * to check. Only the whole string can.
 *
 * The literals below were captured by RUNNING `main`'s modules — not
 * transcribed — so a transcription error cannot make this test pass against a
 * statement `main` never emitted.
 *
 * ## What it is NOT, and how to change it
 *
 * It is not a claim that the collision rule is frozen. A future slice that
 * genuinely changes an arm SHOULD fail here, read the diff, and update the
 * literal in the same commit — that is the review moment this file exists to
 * force. What it refuses is a change that arrives as a side effect of a
 * refactor nobody meant to be observable.
 *
 * Deliberately NOT `toMatchSnapshot()`: an auto-written snapshot updates itself
 * on `--update-snapshots`, which turns the review moment above into a keystroke.
 */

import { describe, expect, it } from "bun:test";
import {
  CARDINALITY_HELD_BACK_COUNT_SQL,
  SUPERSEDE_STAMP_EXPLICIT_SQL,
  SUPERSEDE_STAMP_SQL,
  SUPERSESSION_TARGETS_SQL,
  STORED_COLLISION_EXPRS,
  TIER_HELD_BACK_COUNT_SQL,
  cardinalityHeldBackCountSql,
  supersessionCollisionJoin,
  supersessionCollisionPredicate,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { WILL_SUPERSEDE_TOTAL_SQL, willSupersedePairsSql } from "@atlas/api/lib/brain/oversight";
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";

const PINNED_CARDINALITY_HELD_BACK_COUNT_SQL =
  `
  SELECT COUNT(*)::int AS held_back
    FROM brain_facts d
    JOIN brain_facts p
      ON p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
   WHERE d.workspace_id = $1
     AND d.status = 'draft' AND d.invalidated_at IS NULL
     AND d.id = ANY($2::uuid[])
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND NOT EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
`;

const PINNED_TIER_HELD_BACK_COUNT_SQL =
  `
  SELECT COUNT(*)::int AS held_back
    FROM brain_facts d
    JOIN brain_facts p
      ON p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
   WHERE d.workspace_id = $1
     AND d.status = 'draft' AND d.invalidated_at IS NULL
     AND d.id = ANY($2::uuid[])
     AND ((NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[])) AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))) IS NOT TRUE
`;

const PINNED_SUPERSESSION_TARGETS_SQL =
  `
  SELECT d.id::text AS draft_id, p.id::text AS superseded_id
    FROM brain_facts d
    JOIN brain_facts p
      ON p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
   WHERE d.workspace_id = $1
     AND d.status = 'draft' AND d.invalidated_at IS NULL
     AND d.id = ANY($2::uuid[])
   ORDER BY d.ingested_at, d.id, p.ingested_at, p.id
`;

const PINNED_SUPERSEDE_STAMP_SQL =
  `
  UPDATE brain_facts p
     SET valid_to = now(), updated_at = now()
   WHERE p.workspace_id = $1
     AND p.id = ANY($2::uuid[])
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1
         FROM brain_facts d
        WHERE d.workspace_id = $1
          AND d.id = ANY($3::uuid[])
          AND p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[])))
   RETURNING p.id::text AS id
`;

const PINNED_SUPERSEDE_STAMP_EXPLICIT_SQL =
  `
  UPDATE brain_facts p
     SET valid_to = now(), updated_at = now()
   WHERE p.workspace_id = $1
     AND p.id = ANY($2::uuid[])
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
   RETURNING p.id::text AS id
`;

const PINNED_WILL_SUPERSEDE_TOTAL_SQL =
  `SELECT COUNT(*)::int AS will_supersede_total
    FROM brain_facts d
    JOIN brain_facts p
      ON p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
   WHERE d.workspace_id = $1
     AND d.status = 'draft' AND d.invalidated_at IS NULL`;

const PINNED_JOIN =
  `JOIN brain_facts p
      ON p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))`;

const PINNED_PREDICATE =
  `p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))`;

const PINNED_CARDINALITY =
  `EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')`;

const PINNED_PAIRS =
  `SELECT d.id::text AS draft_id,
         d.subject || ' ' || d.predicate || ' ' || d.object AS draft_label,
         p.id::text AS superseded_id,
         p.subject || ' ' || p.predicate || ' ' || p.object AS superseded_label,
         COUNT(*) OVER ()::int AS scoped_total
    FROM brain_facts d
    JOIN brain_facts p
      ON p.workspace_id = d.workspace_id
     AND p.subject_key = d.subject_key
     AND p.predicate_key = d.predicate_key
     AND (p.object_cmp <> d.object_cmp
      AND split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)
      AND split_part(p.object_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.object_cmp, ':') > 0
      AND strpos(d.object_cmp, ':') > 0)
     AND ((p.subject_cmp <> d.subject_cmp
      AND split_part(p.subject_cmp, ':', 1) = split_part(d.subject_cmp, ':', 1)
      AND split_part(p.subject_cmp, ':', 1) IN ('money', 'number', 'date', 'time', 'bool', 'entity')
      AND strpos(p.subject_cmp, ':') > 0
      AND strpos(d.subject_cmp, ':') > 0)) IS NOT TRUE
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL
     AND EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = d.workspace_id
          AND c.predicate_key = d.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')
     AND (NOT jsonb_exists(p.provenance, 'source')
      OR p.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
     AND (NOT jsonb_exists(d.provenance, 'source')
      OR d.provenance->>'source' = ANY (ARRAY['slack', 'zoom', 'outlook', 'human']::text[]))
   WHERE A
     AND B
     AND d.status = 'draft' AND d.invalidated_at IS NULL
   ORDER BY d.ingested_at, d.id, p.ingested_at, p.id
   LIMIT $3`;

describe("the shipped collision statements are unchanged by #5025's parameterization", () => {
  it("CARDINALITY_HELD_BACK_COUNT_SQL — #5027's mutation rows still address this text", () => {
    expect(CARDINALITY_HELD_BACK_COUNT_SQL).toBe(PINNED_CARDINALITY_HELD_BACK_COUNT_SQL);
  });

  it("TIER_HELD_BACK_COUNT_SQL — #5033's `IS NOT TRUE` polarity survives verbatim", () => {
    expect(TIER_HELD_BACK_COUNT_SQL).toBe(PINNED_TIER_HELD_BACK_COUNT_SQL);
  });

  it("SUPERSESSION_TARGETS_SQL — what publish actually stamps", () => {
    expect(SUPERSESSION_TARGETS_SQL).toBe(PINNED_SUPERSESSION_TARGETS_SQL);
  });

  it("SUPERSEDE_STAMP_SQL and its explicit twin", () => {
    expect(SUPERSEDE_STAMP_SQL).toBe(PINNED_SUPERSEDE_STAMP_SQL);
    expect(SUPERSEDE_STAMP_EXPLICIT_SQL).toBe(PINNED_SUPERSEDE_STAMP_EXPLICIT_SQL);
  });

  it("the oversight disclosure — the pair that must agree with the stamp", () => {
    expect(WILL_SUPERSEDE_TOTAL_SQL).toBe(PINNED_WILL_SUPERSEDE_TOTAL_SQL);
    expect(willSupersedePairsSql("A", "B", 3)).toBe(PINNED_PAIRS);
  });

  it("the two exported builders at their defaults", () => {
    expect(supersessionCollisionJoin("d", "p")).toBe(PINNED_JOIN);
    expect(supersessionCollisionPredicate("d", "p")).toBe(PINNED_PREDICATE);
  });

  it("cardinalitySingleSql at its default predicate-key expression", () => {
    expect(cardinalitySingleSql("d")).toBe(PINNED_CARDINALITY);
  });
});

describe("the default IS the stored parameterization, not merely equivalent to it", () => {
  // The pins above prove the DEFAULT path is unchanged. These prove the two
  // spellings coincide — so a future caller that passes STORED_COLLISION_EXPRS
  // explicitly (which the preview module does, to say out loud which
  // counterfactual it is not taking) cannot drift from the omitted form.
  it("passing STORED_COLLISION_EXPRS explicitly emits the same string as omitting it", () => {
    expect(supersessionCollisionPredicate("d", "p", STORED_COLLISION_EXPRS)).toBe(
      supersessionCollisionPredicate("d", "p"),
    );
    expect(supersessionCollisionJoin("d", "p", STORED_COLLISION_EXPRS)).toBe(
      supersessionCollisionJoin("d", "p"),
    );
  });

  it("STORED_COLLISION_EXPRS reads the stored columns and nothing else", () => {
    expect(STORED_COLLISION_EXPRS.subjectKey("x")).toBe("x.subject_key");
    expect(STORED_COLLISION_EXPRS.predicateKey("x")).toBe("x.predicate_key");
    expect(STORED_COLLISION_EXPRS.cardinalitySingle("x")).toBe(cardinalitySingleSql("x"));
  });

  it("the held-back builder at the publish gate's own scope IS the exported constant", () => {
    // The reuse #5025's issue requires, made checkable: the preview calls this
    // builder with a predicate scope, and the publish gate's constant is the
    // same builder with an id-list scope. One statement, two scopes.
    expect(cardinalityHeldBackCountSql("d.id = ANY($2::uuid[])")).toBe(
      CARDINALITY_HELD_BACK_COUNT_SQL,
    );
  });
});

describe("the counterfactual seam cannot weaken the rule it evaluates", () => {
  // The justification for parameterizing at all is that what varies is WHICH
  // VALUE each side's slot is read from, never WHICH CONJUNCTS must hold. If a
  // caller could drop the tier guard or the homonym suppression through this
  // seam, it would be the second spelling the header forbids after all.
  const hypothetical = {
    ...STORED_COLLISION_EXPRS,
    predicateKey: (a: string) => `CASE WHEN ${a}.predicate_key = $9 THEN $10 ELSE ${a}.predicate_key END`,
  };

  it("a substituted slot expression keeps every conjunct", () => {
    const sql = supersessionCollisionPredicate("d", "p", hypothetical);
    // The tier guard, on BOTH sides (#5033).
    expect(sql).toContain("jsonb_exists(p.provenance, 'source')");
    expect(sql).toContain("jsonb_exists(d.provenance, 'source')");
    // The homonym suppression and its inverted polarity (#5032).
    expect(sql).toContain("IS NOT TRUE");
    expect(sql).toContain("subject_cmp");
    // The cardinality gate (#5027).
    expect(sql).toContain("brain_predicate_cardinality");
    // The published row's live-and-current state.
    expect(sql).toContain("p.valid_to IS NULL");
    expect(sql).toContain("p.invalidated_at IS NULL");
    // And the substitution actually landed on both sides of the slot arm.
    expect(sql).toContain("CASE WHEN p.predicate_key = $9");
    expect(sql).toContain("CASE WHEN d.predicate_key = $9");
  });

  it("the object position has no slot expression to substitute", () => {
    // ⚠️ The load-bearing absence. `object_key` appears nowhere in the
    // collision — the object is compared through `object_cmp`, which no alias
    // moves. A preview that rendered "0 pairs" for an object-position alias
    // would be reporting a structural impossibility as an empty result.
    expect(supersessionCollisionPredicate("d", "p")).not.toContain("object_key");
    expect(Object.keys(STORED_COLLISION_EXPRS).sort()).toEqual([
      "cardinalitySingle",
      "predicateKey",
      "subjectKey",
    ]);
  });
});
