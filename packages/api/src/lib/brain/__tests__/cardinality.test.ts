/**
 * The cardinality store's PRODUCER half, without a database (#5027, ADR-0037 §3).
 *
 * `cardinality-pg.test.ts` owns whether the RULES are true — the collision arm,
 * the repeat gate's SQL, ADR-0037 §9's three falsification targets — because all
 * of those turn on statements rather than on control flow, and a double that
 * scripted their answers would be asserting its own script.
 *
 * This file owns everything that does NOT need one, and it exists because the
 * split had gone the wrong way: the write-path allowlist, its refusals, and the
 * degraded reads were reachable only through a suite that SKIPS SILENTLY without
 * `TEST_DATABASE_URL`. Four of the five arms that make source 2 safe — a producer
 * may not write `approved`, may not propose `multi`, may not overwrite a
 * rejection, and a drifted row must not read as human-authored — are pure
 * TypeScript over an injectable interface, and a rule whose only test skips on
 * the machine where the code is written is a rule nobody runs.
 *
 * `CardinalityExecutor` is structurally satisfied by a literal ON PURPOSE (see
 * its docstring), so the double below is the whole harness: no `mock.module`, no
 * connection mock, nothing to partial-mock.
 */

import { describe, expect, it } from "bun:test";
import {
  CARDINALITY_SOURCE_CLASSES,
  CARDINALITY_STATUSES,
  CORRECTION_EVENT_PRODUCER,
  CORRECTION_REPEAT_COUNT_SQL,
  CORRECTION_REPEAT_THRESHOLD,
  cardinalitySingleSql,
  declarePredicateCardinality,
  decidePredicateCardinality,
  proposeFromCorrectionEvents,
  proposePredicateCardinality,
  proposePredicateCardinalityForSurface,
  readPredicateCardinality,
  type CardinalityExecutor,
} from "@atlas/api/lib/brain/cardinality";
import { identityKey } from "@atlas/api/lib/brain/identity";

const WS = "ws-cardinality";
const KEY = "reports to";

/**
 * A scripted executor: statements in, canned rows out, every call recorded.
 *
 * Matched on a SUBSTRING of the statement rather than on call order, so a test
 * cannot pass by accident when a statement is added or reordered — and so an
 * unmatched statement returns `{ rows: [] }` LOUDLY through the assertions
 * rather than being silently answered by whichever script came first.
 */
function executor(script: { readonly match: string; readonly rows: readonly unknown[] }[] = []): {
  readonly exec: CardinalityExecutor;
  readonly sql: string[];
  readonly params: (readonly unknown[])[];
} {
  const sql: string[] = [];
  const params: (readonly unknown[])[] = [];
  return {
    sql,
    params,
    exec: {
      query: async (statement, bound = []) => {
        sql.push(statement);
        params.push(bound);
        const hit = script.find((s) => statement.includes(s.match));
        return { rows: hit ? [...hit.rows] : [] };
      },
    },
  };
}

/** An executor that throws — the failure the caller is required to absorb. */
const throwing: CardinalityExecutor = {
  query: async () => {
    throw new Error("internal database unreachable");
  },
};

// ---------------------------------------------------------------------------
// The write-path allowlist
// ---------------------------------------------------------------------------

describe("proposePredicateCardinality — the producer door", () => {
  it("writes `pending`, never `approved`", async () => {
    const { exec, sql, params } = executor([{ match: "INSERT INTO", rows: [{ inserted: 1 }] }]);
    const result = await proposePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "single",
      sourceClass: "correction_event",
      proposedBy: CORRECTION_EVENT_PRODUCER,
    });

    expect(result).toEqual({ ok: true, cardinality: "single" });
    // The literal is in the STATEMENT, not in a parameter, so no caller can
    // supply it. That is the arm: `cardinalitySingleSql` reads only `approved`
    // entries, so a producer able to write one would stamp `valid_to` with no
    // human anywhere in the loop.
    expect(sql[0]).toContain("'pending'");
    expect(sql[0]).not.toContain("'approved'");
    expect(params[0]).toEqual([WS, KEY, "single", "correction_event", CORRECTION_EVENT_PRODUCER]);
  });

  it("is idempotent and cannot overwrite a decided predicate", async () => {
    // `ON CONFLICT DO NOTHING` returns no row. That single clause is BOTH the
    // idempotence that lets the proposer run on every supersede without a
    // check-then-write (and therefore without a lock) AND #4507's permanent
    // rejection memory: a `rejected` row occupies the predicate's only slot.
    const { exec, sql } = executor();
    const result = await proposePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "single",
      sourceClass: "correction_event",
      proposedBy: CORRECTION_EVENT_PRODUCER,
    });

    expect(result).toMatchObject({ ok: false, refusal: "already-decided" });
    expect(sql[0]).toContain("ON CONFLICT (workspace_id, predicate_key) DO NOTHING");
  });

  it("refuses a `multi` proposal WITHOUT issuing a statement", async () => {
    // The refusal has to land before the write, not after it: a `multi` row
    // asserts nothing (absent already means `multi`) while occupying the
    // predicate's only slot, so writing it and reporting failure would still
    // block the `single` proposal that carries information.
    //
    // Cast, because `CardinalityProposalInput.cardinality` is narrowed to
    // `"single"` — a typed caller cannot reach this arm at all, which is the
    // stronger half of the guarantee and is checked by the compiler. What is
    // covered here is the untyped caller the CHECK also exists for.
    const { exec, sql } = executor();
    const result = await proposePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "multi" as "single",
      sourceClass: "correction_event",
      proposedBy: CORRECTION_EVENT_PRODUCER,
    });

    expect(result).toMatchObject({ ok: false, refusal: "producer-proposed-multi" });
    expect(sql).toEqual([]);
  });

  it.each(["Multi", "sometimes", "", "SINGLE"])(
    "refuses ANY non-`single` cardinality (%p) — not just the literal `multi`",
    async (value) => {
      // The population the guard was WIDENED for, and the reason the previous
      // fixture could not falsify the widening: `"multi"` is refused by the old
      // `=== "multi"` predicate too, so reverting `!== "single"` left every test
      // green. These are the shapes a `JSON.parse` body or a producer's config
      // actually yields, and under the old spelling each one reached the INSERT
      // and came back as a THROWN 23514 from
      // `ck_brain_predicate_cardinality_value` — breaking this module's
      // "every arm is a REFUSAL" contract for exactly the callers the runtime
      // check exists to serve.
      const { exec, sql } = executor();
      const result = await proposePredicateCardinality(exec, WS, {
        predicateKey: KEY,
        cardinality: value as "single",
        sourceClass: "correction_event",
        proposedBy: CORRECTION_EVENT_PRODUCER,
      });

      expect(result).toMatchObject({ ok: false, refusal: "producer-proposed-multi" });
      expect(sql).toEqual([]);
    },
  );

  it("refuses a write that names no author, without issuing a statement", async () => {
    // `proposed_by` is the first column an audit of a retroactive re-key reads,
    // and `NOT NULL` alone admits `''` — an unattributed row wearing the shape
    // of an attributed one. Refused at the door as well as by
    // `ck_brain_predicate_cardinality_author_present`, because a thrown 23502/23514
    // is not a refusal.
    const { exec, sql } = executor();
    const result = await proposePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "single",
      sourceClass: "correction_event",
      proposedBy: "",
    });

    expect(result).toMatchObject({ ok: false, refusal: "unattributed" });
    expect(sql).toEqual([]);
  });

  it.each([null, ""])("refuses a degenerate key (%p) without issuing a statement", async (key) => {
    // An entry under an empty key would describe EVERY degenerate predicate in
    // the workspace at once — and on a `single` row that is a workspace-wide
    // licence to supersede. The DB CHECK is the backstop; this is the door.
    const { exec, sql } = executor();
    const result = await proposePredicateCardinality(exec, WS, {
      predicateKey: key,
      cardinality: "single",
      sourceClass: "correction_event",
      proposedBy: CORRECTION_EVENT_PRODUCER,
    });

    expect(result).toMatchObject({ ok: false, refusal: "degenerate-key" });
    expect(sql).toEqual([]);
  });
});

describe("proposePredicateCardinalityForSurface — the producer's door (#5042)", () => {
  it("derives the key through the workspace's PREDICATE vocabulary, not the identity", async () => {
    // The whole reason the vocabulary is a required parameter. Curating `is priced
    // at` after `is priced at → priced at` is approved must land on `priced at` —
    // the slot the claims actually occupy. An identity default writes an entry
    // keyed on a norm no live claim carries, which `cardinalitySingleSql` then
    // never reads: a silent no-op wearing a successful proposal's face.
    const { exec, params } = executor([{ match: "INSERT INTO", rows: [{ inserted: 1 }] }]);
    const result = await proposePredicateCardinalityForSurface(exec, WS, {
      predicateSurface: "is priced at",
      cardinality: "single",
      sourceClass: "warehouse_structural",
      proposedBy: "warehouse:v1",
      predicateAlias: (norm) => (norm === "is priced at" ? "priced at" : norm),
    });

    expect(result).toEqual({ ok: true, cardinality: "single" });
    expect(params[0]?.[1]).toBe(identityKey("priced at"));
    expect(params[0]?.[1]).not.toBe(identityKey("is priced at"));
    expect(params[0]?.[3]).toBe("warehouse_structural");
  });

  it("refuses a surface that normalizes away, rather than writing an empty key", async () => {
    // Reachable from real data: `lexicalNorm` collapses `[ \t\n\v\f\r_-]`, so a
    // dimension named `_` or `--` keys to null. An entry written under an empty key
    // would describe EVERY degenerate predicate in the workspace at once.
    const { exec, sql } = executor([{ match: "INSERT INTO", rows: [{ inserted: 1 }] }]);
    const result = await proposePredicateCardinalityForSurface(exec, WS, {
      predicateSurface: "__",
      cardinality: "single",
      sourceClass: "warehouse_structural",
      proposedBy: "warehouse:v1",
      predicateAlias: (norm) => norm,
    });

    expect(result).toMatchObject({ ok: false, refusal: "degenerate-key" });
    // Refused BEFORE the statement — the assertion that separates a refusal from a
    // write that happened to fail.
    expect(sql).toEqual([]);
  });

  it("reports `already-decided` on a suppressed conflict — the producer's ordinary case", async () => {
    // `ON CONFLICT DO NOTHING` returns no row. This is what makes a re-run a no-op
    // and what makes a human's `rejected` stick, and the warehouse producer logs it
    // at `debug` rather than `warn` on exactly this verdict.
    const { exec } = executor();
    const result = await proposePredicateCardinalityForSurface(exec, WS, {
      predicateSurface: "status",
      cardinality: "single",
      sourceClass: "warehouse_structural",
      proposedBy: "warehouse:v1",
      predicateAlias: (norm) => norm,
    });
    expect(result).toMatchObject({ ok: false, refusal: "already-decided" });
  });
});

describe("declarePredicateCardinality — the human door", () => {
  it("writes `approved` in one step, and records the author on BOTH columns", async () => {
    const { exec, sql, params } = executor();
    const result = await declarePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "single",
      authoredBy: "curator-1",
    });

    expect(result).toEqual({ ok: true, cardinality: "single" });
    expect(sql[0]).toContain("'approved'");
    expect(sql[0]).toContain("'human'");
    // ⚠️ `proposed_by` is overwritten on the conflict path too. Without it, a
    // human authoring OVER a producer's pending proposal commits a row reading
    // `source_class = 'human'` beside the producer's id — a pair migration
    // 0192's own column comment makes self-contradictory, on the one column an
    // audit of a retroactive re-key reads first.
    expect(sql[0]).toContain("proposed_by = EXCLUDED.proposed_by");
    expect(params[0]).toEqual([WS, KEY, "single", "curator-1"]);
  });

  it("may write `multi` — the adjudicated record, and the only way back", async () => {
    // A producer cannot; a human can. It is the record of the question being
    // DECLINED (ADR-0037 §3(b)'s `located in`), and the only route out of a
    // `single` short of deleting the row.
    const { exec, params } = executor();
    const result = await declarePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "multi",
      authoredBy: "curator-1",
    });

    expect(result).toEqual({ ok: true, cardinality: "multi" });
    expect(params[0]?.[2]).toBe("multi");
  });

  it("upserts rather than refusing — rejection memory binds PRODUCERS, not people", async () => {
    // The asymmetry against `proposePredicateCardinality`'s `DO NOTHING` is the
    // authority posture rather than an inconsistency: a rejection is this
    // workspace's own decision, and the gate exists so a person can change it.
    // Without this a mistaken rejection would make a predicate permanently
    // un-curatable.
    const { exec, sql } = executor();
    await declarePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "single",
      authoredBy: "curator-1",
    });
    expect(sql[0]).toContain("ON CONFLICT (workspace_id, predicate_key) DO UPDATE");
  });

  it("refuses a degenerate key", async () => {
    const { exec, sql } = executor();
    const result = await declarePredicateCardinality(exec, WS, {
      predicateKey: null,
      cardinality: "single",
      authoredBy: "curator-1",
    });
    expect(result).toMatchObject({ ok: false, refusal: "degenerate-key" });
    expect(sql).toEqual([]);
  });

  it("refuses an unattributed declaration — this door's whole authority is that a person took it", async () => {
    // `CardinalityDeclarationInput.authoredBy` says so outright, and this path
    // writes `approved` in ONE step: an unattributed row here immediately makes
    // every existing published pair in the slot supersedable, with nobody
    // recorded as having asked for it.
    const { exec, sql } = executor();
    const result = await declarePredicateCardinality(exec, WS, {
      predicateKey: KEY,
      cardinality: "single",
      authoredBy: "",
    });
    expect(result).toMatchObject({ ok: false, refusal: "unattributed" });
    expect(sql).toEqual([]);
  });
});

describe("decidePredicateCardinality", () => {
  it("only moves a PENDING row, and says whether it moved", async () => {
    // `WHERE status = 'pending'` makes the statement correct on its own terms:
    // two reviewers racing one proposal produce one decision and one no-op,
    // without a lock, because the second UPDATE re-evaluates against the
    // committed row version and matches zero rows.
    const { exec, sql } = executor([{ match: "UPDATE", rows: [{ decided: 1 }] }]);
    expect(await decidePredicateCardinality(exec, WS, KEY, "approved", "curator-1")).toBe(true);
    expect(sql[0]).toContain("status = 'pending'");
  });

  it("reports `false` when the row was already decided", async () => {
    const { exec } = executor();
    expect(await decidePredicateCardinality(exec, WS, KEY, "rejected", "curator-1")).toBe(false);
  });

  it("REJECTING is an update, never a delete — the row is the memory", async () => {
    // Deleting would readmit the producer's next run, which is the one thing
    // #4507's memory exists to stop.
    const { exec, sql } = executor([{ match: "UPDATE", rows: [{ decided: 1 }] }]);
    await decidePredicateCardinality(exec, WS, KEY, "rejected", "curator-1");
    expect(sql[0]).toContain("UPDATE brain_predicate_cardinality");
    expect(sql.some((s) => /\bDELETE\b/.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The degraded reads
// ---------------------------------------------------------------------------

describe("readPredicateCardinality — every degradation is toward LESS authority", () => {
  const read = (row: Record<string, unknown>) =>
    readPredicateCardinality(executor([{ match: "SELECT", rows: [row] }]).exec, WS, KEY);

  const healthy = {
    cardinality: "single",
    status: "approved",
    source_class: "human",
    proposed_by: "curator-1",
  };

  it("reads a healthy row through — the positive control", async () => {
    expect(await read(healthy)).toEqual({
      cardinality: "single",
      status: "approved",
      sourceClass: "human",
      proposedBy: "curator-1",
    });
  });

  it("answers `null` for a predicate with no entry", async () => {
    expect(await readPredicateCardinality(executor().exec, WS, KEY)).toBeNull();
  });

  it("answers `null` for a row it cannot narrow at all — never a raw TypeError", async () => {
    // `CardinalityExecutor` is satisfied by a test literal BY DESIGN, so
    // `{ rows: [null] }` is a shape nothing upstream prevents. A bare
    // `rows[0] as Record<string, unknown>` passes `=== undefined` and then
    // throws on the first field read — from the one function whose job is
    // legibility.
    expect(
      await readPredicateCardinality(
        executor([{ match: "SELECT", rows: [null] }]).exec,
        WS,
        KEY,
      ),
    ).toBeNull();
  });

  it("does not project the predicate key — the record cannot carry one", async () => {
    // `keys-not-on-the-wire.test.ts` scans for a fact-shaped TYPE that grows a
    // key field, and this record is what #5025's review UI renders. Asserted on
    // the STATEMENT as well as the shape, because a projection that nothing
    // currently reads is exactly how the field comes back.
    const { exec, sql } = executor([{ match: "SELECT", rows: [healthy] }]);
    const record = await readPredicateCardinality(exec, WS, KEY);
    expect(record).not.toHaveProperty("predicateKey");
    // Read on the PROJECTION SPAN, not on the whole statement and not on its
    // first column: `predicate_key` is legitimately in the WHERE clause, and
    // `not.toContain("SELECT predicate_key")` would fire only if the key were
    // projected FIRST — where the realistic drift appends it. This assertion is
    // the file-local replacement for the repo-wide scan arm that
    // `keys-not-on-the-wire.test.ts` exempts this module from, so it has to
    // cover the whole span or the exemption is unbacked.
    const projection = sql[0]!.split(/\bFROM\b/)[0]!;
    expect(projection).not.toContain("predicate_key");
    // Positive control: the pattern DOES see a projected key, so the assertion
    // above is evidence rather than a split that happens to match nothing.
    expect("SELECT cardinality, predicate_key FROM x".split(/\bFROM\b/)[0]).toContain(
      "predicate_key",
    );
  });

  it("reads an out-of-vocabulary cardinality as `multi` — the arm that never supersedes", async () => {
    expect(await read({ ...healthy, cardinality: "sometimes" })).toMatchObject({
      cardinality: "multi",
    });
  });

  it("reads an out-of-vocabulary status as `pending`, NOT `rejected`", async () => {
    // Same direction as the source class below, and it was wrong here first.
    // `rejected` reads to #5025's reviewer as "a human adjudicated this and
    // declined" — authority nobody exercised — and it drops the row out of the
    // queue that would resolve it. `pending` is the least authoritative value:
    // nobody has decided. Neither arm risks a stamp, because
    // `cardinalitySingleSql` never calls this reader at all.
    expect(await read({ ...healthy, status: "applying" })).toMatchObject({ status: "pending" });
  });

  it("reads an out-of-vocabulary source class as `correction_event`, NOT `human`", async () => {
    // The direction matters and an earlier cut had it backwards. `human` reads
    // to #5025's reviewer as "a person authored this", on the screen where they
    // decide whether to approve a flag whose blast radius is retroactive and
    // irreversible. A drifted label must never inflate apparent authority —
    // and the "no automated re-proposal" property comes from the primary key's
    // `ON CONFLICT DO NOTHING`, not from the class.
    expect(await read({ ...healthy, source_class: "extractor" })).toMatchObject({
      sourceClass: "correction_event",
    });
  });

  it("answers ABSENT for a row with no usable author — drift must not read as curation", async () => {
    // A row whose projection drifted degrades to "this predicate is uncurated",
    // which supersedes nothing. Returning a record with an `undefined`
    // `proposedBy` would violate the type's own invariant at its single
    // construction point, and `CardinalityExecutor` is satisfied by a literal
    // by design, so nothing upstream stops the shape arriving.
    expect(await read({ ...healthy, proposed_by: 42 })).toBeNull();
    expect(await read({ cardinality: "single", status: "approved", source_class: "human" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The repeat gate's control flow (its SQL is `cardinality-pg.test.ts`'s)
// ---------------------------------------------------------------------------

describe("proposeFromCorrectionEvents", () => {
  const gate = (n: unknown) => [{ match: "COUNT(DISTINCT", rows: [{ n }] }];

  it("proposes at the threshold and not below it", async () => {
    const below = executor(gate(CORRECTION_REPEAT_THRESHOLD - 1));
    expect(await proposeFromCorrectionEvents(below.exec, WS, KEY)).toBe(false);
    // …and it did not even attempt the write.
    expect(below.sql.some((s) => s.includes("INSERT INTO"))).toBe(false);

    const at = executor([
      ...gate(CORRECTION_REPEAT_THRESHOLD),
      { match: "INSERT INTO", rows: [{ inserted: 1 }] },
    ]);
    expect(await proposeFromCorrectionEvents(at.exec, WS, KEY)).toBe(true);
  });

  it("binds HUMAN_SOURCE, so the publish gate's own edges are not counted as evidence", async () => {
    // Counting them would close the loop on itself: an approved `single`
    // produces `supersedes` edges, and the gate would report the system's own
    // arbitrations back to it as human evidence.
    const { exec, params } = executor(gate(0));
    await proposeFromCorrectionEvents(exec, WS, KEY);
    expect(params[0]).toEqual([WS, KEY, "human"]);
  });

  it.each([null, "3", undefined, Number.NaN])(
    "refuses to act on an unusable count (%p) rather than defaulting it",
    async (n) => {
      // Reading an unusable count as 0 would silently retire source 2 for the
      // whole deployment with NO symptom: proposals simply stop, which is
      // indistinguishable from a workspace nobody corrects. `"3"` is the
      // realistic drift — dropping the `::int` makes `pg` hand back a string.
      const { exec, sql } = executor(gate(n));
      expect(await proposeFromCorrectionEvents(exec, WS, KEY)).toBe(false);
      expect(sql.some((s) => s.includes("INSERT INTO"))).toBe(false);
    },
  );

  it("returns false for a degenerate key without touching the store", async () => {
    const { exec, sql } = executor();
    expect(await proposeFromCorrectionEvents(exec, WS, null)).toBe(false);
    expect(sql).toEqual([]);
  });

  it("THROWS on a store failure — the absorb decision belongs to the caller", async () => {
    // `correction.ts` catches, logs, and still returns `corrected`, because it
    // is the only layer that knows the correction is already committed.
    // Swallowing here would also make the tests unable to tell a refused
    // proposal from a broken one.
    await expect(proposeFromCorrectionEvents(throwing, WS, KEY)).rejects.toThrow(/unreachable/);
  });
});

// ---------------------------------------------------------------------------
// The statements' load-bearing arms, pinned lexically
// ---------------------------------------------------------------------------

describe("the arms that decide an irreversible write", () => {
  it("`cardinalitySingleSql` reads ONE approved entry on the shared predicate", () => {
    const sql = cardinalitySingleSql("d");
    expect(sql).toContain("FROM brain_predicate_cardinality c");
    expect(sql).toContain("c.workspace_id = d.workspace_id");
    expect(sql).toContain("c.predicate_key = d.predicate_key");
    expect(sql).toContain("c.cardinality = 'single'");
    expect(sql).toContain("c.status = 'approved'");
  });

  it("the repeat gate counts DISTINCT SUBJECTS, provably-different, human-sourced", () => {
    // Three arms, three failure modes, and none of them is visible in the
    // shipped behaviour — a gate that counts the wrong thing still proposes,
    // just wrongly. `cardinality-pg.test.ts` falsifies each behaviourally; these
    // pins mean a local run catches a deletion without a database.
    expect(CORRECTION_REPEAT_COUNT_SQL).toContain("COUNT(DISTINCT n.subject_key)");
    expect(CORRECTION_REPEAT_COUNT_SQL).toContain("ep.source = $3");
    expect(CORRECTION_REPEAT_COUNT_SQL).toContain("e.edge_type = 'supersedes'");
    // The provable-difference arm — what stands between a typo run and a
    // spurious `single` (ADR-0037 §3(d)'s carried risk).
    expect(CORRECTION_REPEAT_COUNT_SQL).toContain("n.object_cmp <> o.object_cmp");
  });

  it("the vocabularies are what the CHECKs are, and there are exactly three sources", () => {
    // ADR-0037 §3(d) names three and no others; a fourth must earn its arm in a
    // migration rather than inherit one.
    expect([...CARDINALITY_SOURCE_CLASSES]).toEqual([
      "warehouse_structural",
      "correction_event",
      "human",
    ]);
    expect([...CARDINALITY_STATUSES]).toEqual(["pending", "approved", "rejected"]);
  });

  it("pins the repeat threshold at 3 — the ADR argued the number, so a test should hold it", () => {
    // Every other assertion in this file is RELATIVE to the constant
    // (`CORRECTION_REPEAT_THRESHOLD - 1`), which is right for testing the gate
    // and useless for testing the VALUE: dropping it to 1 leaves them all green.
    // Its only other pin lives in a suite that skips silently without
    // `TEST_DATABASE_URL`, which is the "green on my machine" hazard the -pg
    // split exists to avoid, entered from the other side.
    //
    // ADR-0037 §3(d) argues the number: one subject is an anecdote, two is a
    // coincidence a single confused reviewer can produce in an afternoon.
    expect(CORRECTION_REPEAT_THRESHOLD).toBe(3);
  });
});
