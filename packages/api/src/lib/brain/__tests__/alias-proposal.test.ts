/**
 * The alias-proposal producer's non-SQL half (#5034, ADR-0037 §4).
 *
 * The lane that runs WITHOUT `TEST_DATABASE_URL`, which is the default local and
 * `--affected` lane — so what lands here is deliberately chosen rather than
 * "whatever was easy to unit test":
 *
 *   - the RANKING rules, including the prohibition that an extractor hint can
 *     never become a candidate. That one is a property of a pure function, so
 *     proving it needs no schema and gets a stronger proof here than in the
 *     `-pg` suite (which can only show it did not happen for one corpus);
 *   - the reader's NARROWING, which decides what a drifted statement does;
 *   - the direction SWAP, which is a TypeScript decision about a boolean pair;
 *   - a lexical backstop over `ALIAS_PROPOSAL_SQL`'s text, because the
 *     prohibition it enforces is *never build a near-miss detector* and a
 *     similarity function spliced into that statement is the shape that
 *     violates it.
 *
 * ⚠️ **What is NOT here, and must never move here: the MATCHING.** Which rows
 * the three arms admit is a property of a real Postgres against a real schema,
 * and an in-memory executor sees only which binds it was handed —
 * `alias-proposal-pg.test.ts` owns every one of those assertions, over
 * `alias-proposal-corpus.ts`. A behavioural test written here would pass
 * identically against the shipped statement and against a paraphrase that had
 * lost the subject arm.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **GENERATED — see `packages/api/scripts/mutations/alias-proposal.md`**, from
 * `scripts/mutations/alias-proposal.mutations.ts`:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/alias-proposal.mutations.ts
 *
 * ⚠️ Two rows are 0 here for a reason that is not a gap and is worth knowing
 * before adding a test to close them: the repeat THRESHOLD and the candidate CAP
 * are read from the shipped constants by the bind assertion, so changing a
 * constant changes both sides of that comparison at once. They are falsified by
 * the `-pg` corpus, where the number is a property of the fixtures instead.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALIAS_HINT_RANK_BONUS,
  ALIAS_PROPOSAL_CANDIDATE_CAP,
  ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL,
  ALIAS_PROPOSAL_REPEAT_THRESHOLD,
  ALIAS_PROPOSAL_SQL,
  ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL,
  SEAM_PROPOSAL_PRODUCER,
  applyHintRanks,
  loadAliasCandidates,
  proposeAliasesFromCorpus,
  structuralConfidence,
  type AliasCandidate,
  type AliasProposalExecutor,
  type SubjectCount,
} from "@atlas/api/lib/brain/alias-proposal";

/** A row shaped as `ALIAS_PROPOSAL_SQL` selects it. */
function row(over: Record<string, unknown> = {}) {
  return {
    from_norm: "is priced at",
    to_norm: "priced at",
    subjects: 2,
    from_warehouse: false,
    to_warehouse: false,
    ...over,
  };
}

/** Records what it was asked and answers with whatever the test scripted. */
function fakeExecutor(rows: readonly unknown[]): AliasProposalExecutor & {
  readonly calls: { sql: string; params?: unknown[] }[];
} {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

/**
 * Mint a checked repeat count.
 *
 * `SubjectCount` is branded so `structuralConfidence`'s codomain is provable
 * from its signature, and `toCandidate` is production's only mint site. A test
 * that CONSTRUCTS a candidate is deliberately going round that check, so the
 * cast is named once here rather than sprinkled — and the fact that it takes a
 * named helper is the friction the brand exists to create.
 */
const subjectCount = (n: number): SubjectCount => n as SubjectCount;

const candidate = (over: Partial<AliasCandidate> = {}): AliasCandidate => ({
  fromNorm: "is priced at",
  toNorm: "priced at",
  subjects: subjectCount(2),
  directed: false,
  ...over,
});

/** A hint, in the tuple shape that stops one being spread into a candidate. */
const hint = (a: string, b: string) => ({ norms: [a, b] as const });

describe("the structural rank (#5034)", () => {
  it("stays inside migration 0190's confidence CHECK for every count a corpus can produce", () => {
    // The column is `NOT NULL double precision` with `confidence >= 0 AND
    // confidence <= 1`, and `proposeAliasEdge` refuses anything outside that
    // range as a producer bug. A rank that escaped the range would not queue a
    // low-confidence edge — it would queue NOTHING, and the refusal would be
    // logged as `confidence-out-of-range` on a producer that is behaving.
    for (const subjects of [ALIAS_PROPOSAL_REPEAT_THRESHOLD, 3, 10, 1_000, 1e9]) {
      const confidence = structuralConfidence(subjectCount(subjects));
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("sorts more independent subjects higher", () => {
    // The ONLY property the rank promises. It is not calibrated and nothing may
    // read it as a probability — see `structuralConfidence`'s docstring — so
    // this is deliberately an ordering assertion and not a value one.
    const ranks = [2, 3, 4, 8].map((n) => structuralConfidence(subjectCount(n)));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("keeps the hint bonus smaller than one step of structural evidence", () => {
    // The quantitative form of *the hint ranks, the corpus decides*: a hint may
    // re-order two pairs whose structural evidence is equal, and may never lift
    // a two-subject pair above a three-subject one. Measured against the SHIPPED
    // curve rather than asserted as a constant, so tuning either one without the
    // other turns this red.
    const step = structuralConfidence(subjectCount(3)) - structuralConfidence(subjectCount(2));
    expect(ALIAS_HINT_RANK_BONUS).toBeLessThan(step);
  });
});

describe("an extractor hint ranks a candidate and can never be one (#5034)", () => {
  it("raises the rank of a pair the corpus already produced", () => {
    // The positive control. Without it every prohibition below is satisfied by
    // an `applyHintRanks` that ignores its `hints` argument entirely.
    const [ranked] = applyHintRanks(
      [candidate()],
      [hint("is priced at", "priced at")],
    );
    expect(ranked!.confidence).toBeGreaterThan(structuralConfidence(subjectCount(2)));
  });

  it("matches a hint in either orientation", () => {
    // `brain_vocabulary_proposal`'s pair identity is unordered (`LEAST` /
    // `GREATEST`), and an extractor's guess about DIRECTION is worth even less
    // than its guess about equivalence — so an orientation-sensitive match would
    // drop half the hints for a reason no producer could see.
    const [ranked] = applyHintRanks(
      [candidate()],
      [hint("priced at", "is priced at")],
    );
    expect(ranked!.confidence).toBeGreaterThan(structuralConfidence(subjectCount(2)));
  });

  it("adds NOTHING for a pair with no structural evidence", () => {
    // ⭐ THE prohibition. An extractor asked for a canonical predicate always
    // produces one — it cannot abstain — so a hint that could become a candidate
    // fills the queue with confident, unfalsifiable noise. `led_by`/`leads` is
    // the hint deliberately: it is the pair every similarity detector ranks
    // first and the one whose approval stamps `valid_to` across the manager
    // graph.
    const ranked = applyHintRanks([candidate()], [hint("led_by", "leads")]);
    expect(ranked).toHaveLength(1);
    expect(ranked.map((r) => [r.candidate.fromNorm, r.candidate.toNorm])).toEqual([
      ["is priced at", "priced at"],
    ]);
    expect(ranked[0]!.confidence).toBe(structuralConfidence(subjectCount(2)));
  });

  it("does not let two DIFFERENT pairs share one key", () => {
    // The pair key joins two norms, and `lexicalNorm` unifies every separator to
    // a single SPACE — so norms are full of spaces (`is priced at`) and a
    // space-joined key makes `{"a", "b c"}` and `{"a b", "c"}` the same string.
    // A hint for one pair would then rank the OTHER, which is a hint reaching a
    // candidate it does not name: the one thing `applyHintRanks` exists to make
    // impossible.
    //
    // ⚠️ The hint's second norm is contrived and that is stated rather than
    // dressed up — the collision needs one pair to be a prefix split of the
    // other, and no two NATURAL predicate pairs collide. What the case shows is
    // that the ambiguity is REPRESENTABLE at all, which is enough: a producer
    // emitting an odd surface is not a scenario anything here can rule out, and
    // the separator is what makes ruling it out unnecessary.
    const ranked = applyHintRanks(
      [candidate({ fromNorm: "has office in", toNorm: "located in" })],
      [hint("has", "office in located in")],
    );
    expect(ranked[0]!.confidence).toBe(structuralConfidence(subjectCount(2)));
  });

  it("clamps a hinted rank into the CHECK's range", () => {
    // A rank pushed past 1 is not a very confident proposal — it is a REFUSED
    // insert (`confidence-out-of-range`), so the pair silently never queues.
    const [ranked] = applyHintRanks(
      [candidate({ subjects: subjectCount(Number.MAX_SAFE_INTEGER) })],
      [hint("is priced at", "priced at")],
    );
    expect(ranked!.confidence).toBeLessThanOrEqual(1);
  });
});

describe("reading the query back (#5034)", () => {
  it("binds the workspace, the repeat threshold and the cap, in that order", async () => {
    const executor = fakeExecutor([]);
    await loadAliasCandidates(executor, "ws-1");
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]!.sql).toBe(ALIAS_PROPOSAL_SQL);
    expect(executor.calls[0]!.params).toEqual([
      "ws-1",
      ALIAS_PROPOSAL_REPEAT_THRESHOLD,
      ALIAS_PROPOSAL_CANDIDATE_CAP,
    ]);
  });

  it("names the WAREHOUSE side as the target when exactly one side is one", async () => {
    // The swap is the whole of the direction rule on this side of the seam: the
    // query emits the pair in norm order, and `to_norm` has to end up holding
    // the warehouse norm whichever order that was. A rule that set `directed`
    // and left the pair alone would re-key the warehouse's own rows onto a
    // phrase nobody's schema contains.
    const executor = fakeExecutor([
      row({ from_norm: "price", to_norm: "is priced at", from_warehouse: true }),
    ]);
    const [found] = await loadAliasCandidates(executor, "ws-1");
    expect(found).toEqual({
      fromNorm: "is priced at",
      toNorm: "price",
      subjects: subjectCount(2),
      directed: true,
    });
  });

  it("leaves a candidate undirected when BOTH sides are warehouse-derived", async () => {
    // *EXACTLY one.* With two closed, typed, described spaces nothing in the
    // evidence prefers one, and a rule reading `from || to` would direct at
    // whichever side the byte ordering put second.
    const executor = fakeExecutor([row({ from_warehouse: true, to_warehouse: true })]);
    const [found] = await loadAliasCandidates(executor, "ws-1");
    expect(found!.directed).toBe(false);
  });

  it("drops a row that does not read back, rather than defaulting it", async () => {
    // Both permissive fallbacks are wrong in the expensive direction: a
    // defaulted `subjects` manufactures a repeat count nothing measured, and a
    // coerced norm proposes a workspace-wide re-key of a predicate nobody said.
    // The good row beside it is the control — a reader that threw, or that
    // dropped the whole batch, would pass a bare "no candidate" assertion.
    const executor = fakeExecutor([row({ subjects: "2" }), row({ from_norm: "unit price" })]);
    const found = await loadAliasCandidates(executor, "ws-1");
    expect(found.map((c) => c.fromNorm)).toEqual(["unit price"]);
  });
});

describe("what the producer hands the queue (#5034)", () => {
  it("proposes at the PREDICATE position, seam-sourced, under this producer's name", async () => {
    const proposed: unknown[] = [];
    await proposeAliasesFromCorpus(
      "ws-1",
      {},
      {
        // One runner for the read and for every proposal — `proposeAliasEdge`
        // takes `deps.withTransaction` too, so a single fake covers both halves
        // and no statement escapes to the real pool.
        withTransaction: async (fn) =>
          fn({
            query: async (sql: string, params?: unknown[]) => {
              if (sql === ALIAS_PROPOSAL_SQL) return { rows: [row()] };
              if (sql.includes("INSERT INTO brain_vocabulary_proposal")) {
                proposed.push(params);
                return { rows: [] };
              }
              // The per-transaction bounds, the vocabulary lock, and the
              // rejection-memory lookup that finds no prior row. Anything else
              // is a statement this test does not know about, and answering it
              // with an empty result would let a new arm land silently.
              if (
                sql === ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL ||
                sql === ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL ||
                sql.includes("pg_advisory_xact_lock") ||
                sql.includes("FROM brain_vocabulary_proposal")
              ) {
                return { rows: [] };
              }
              throw new Error(`unexpected statement: ${sql}`);
            },
          }),
      },
    );
    expect(proposed).toHaveLength(1);
    // The INSERT's own bind order: id, workspace, position, from, to, directed,
    // source_class, confidence, proposed_by.
    const params = proposed[0] as unknown[];
    expect(params[2]).toBe("predicate");
    expect(params[6]).toBe("seam");
    expect(params[8]).toBe(SEAM_PROPOSAL_PRODUCER);
  });

  it("costs one bounded read and nothing more when the corpus supports nothing", async () => {
    // The steady state, and it must cost one SELECT rather than one SELECT plus
    // a lock per candidate. Asserted because `proposeAliasEdges` over an empty
    // list is a silent no-op that would look identical from the counters.
    //
    // ⚠️ It also pins the BOUNDS onto the read, which is the guard against
    // wedging the extraction fiber — `extract.ts` awaits this inside a
    // `concurrency: 1` loop with no per-tick timeout, so a statement that never
    // returns stops the whole drain with no error to catch. Exact-list, so
    // deleting either `SET LOCAL` turns this red rather than merely making the
    // producer unbounded again.
    const seen: string[] = [];
    const counters = await proposeAliasesFromCorpus(
      "ws-1",
      {},
      {
        withTransaction: async (fn) =>
          fn({
            query: async (sql: string) => {
              seen.push(sql);
              return { rows: [] };
            },
          }),
      },
    );
    expect(seen).toEqual([
      ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL,
      ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL,
      ALIAS_PROPOSAL_SQL,
    ]);
    expect(counters).toEqual({
      queued: 0,
      autoApproved: 0,
      deduped: 0,
      alreadyApproved: 0,
      rejected: 0,
      refused: 0,
    });
  });
});

describe("the statement text is not a near-miss detector (#5034)", () => {
  // A LEXICAL backstop, and it is worth having precisely because it is lexical:
  // ADR-0037 §4 states *no stemming, no edit distance, no copula- or
  // stopword-stripping* as a PROHIBITION, and the shape that violates it is a
  // similarity function spliced into this statement. A behavioural test cannot
  // see the difference between "this workspace has no near-misses" and "the
  // detector is switched off"; a grep over the shipped SQL can.
  //
  // ⚠️ It is a backstop and NOT the proof. `alias-proposal-pg.test.ts`'s
  // `inverse-relations` case is what shows the shipped statement does not
  // surface `led_by`/`leads` over a corpus that contains them — this only
  // catches the obvious spelling of the violation.
  const FORBIDDEN = [
    "similarity(",
    "levenshtein",
    "soundex",
    "metaphone",
    "difference(",
    "ILIKE",
    "to_tsvector",
    "regexp_replace",
  ];

  for (const forbidden of FORBIDDEN) {
    it(`does not reach for \`${forbidden}\``, () => {
      expect(ALIAS_PROPOSAL_SQL).not.toContain(forbidden);
    });
  }

  it("still joins on the three structural arms", () => {
    // The control for the greps above: they all pass against an empty string.
    expect(ALIAS_PROPOSAL_SQL).toContain("b.subject_key = a.subject_key");
    expect(ALIAS_PROPOSAL_SQL).toContain("b.object_cmp = a.object_cmp");
    expect(ALIAS_PROPOSAL_SQL).toContain("b.predicate_key > a.predicate_key");
  });
});

describe("no identity key graduates into the result (#5019, #5034)", () => {
  // ⚠️ THE COMPENSATING PIN for this module's entry in
  // `keys-not-on-the-wire.test.ts`'s `DECLARATION_SITES`. That exemption
  // switches the repo-wide SELECT arm off for `alias-proposal.ts`, because the
  // query genuinely projects `predicate_key` — and it is affordable only because
  // these two assertions replace it file-locally.
  //
  // `subject_key` and `object_cmp` really do appear inside the statement: one is
  // a join arm and the other is a `COUNT(DISTINCT …)` input. Neither may
  // graduate into what the query RETURNS, and that is the whole distinction the
  // exemption rests on — this query hands back two norms and a count, never a
  // key beside its claim.

  /** The outer projection — everything between the last `SELECT` and its `FROM`. */
  const outerProjection = (): string => {
    const select = ALIAS_PROPOSAL_SQL.lastIndexOf("SELECT");
    const from = ALIAS_PROPOSAL_SQL.indexOf("FROM", select);
    expect(select, "ALIAS_PROPOSAL_SQL has no outer SELECT — this pin is reading nothing").toBeGreaterThan(-1);
    expect(from, "ALIAS_PROPOSAL_SQL's outer SELECT has no FROM").toBeGreaterThan(select);
    return ALIAS_PROPOSAL_SQL.slice(select, from);
  };

  for (const column of ["object_key", "object_cmp", "subject_cmp"]) {
    it(`does not name \`${column}\` in the projection at all`, () => {
      expect(outerProjection()).not.toContain(column);
    });
  }

  it("names `subject_key` only as an aggregate INPUT, never as a result column", () => {
    // ⚠️ The one key the projection is allowed to mention, and the distinction
    // is the same one `keys-not-on-the-wire.test.ts` draws for `COUNT(*)`: an
    // aggregate OVER a key is not a projection OF a key. `COUNT(DISTINCT
    // subject_key)` is how the repeat gate counts distinct subjects, and the
    // number that leaves is a count — a bare `subject_key` beside it would hand
    // a consumer the identity of the claims behind the proposal.
    const projection = outerProjection();
    expect(projection).toContain("COUNT(DISTINCT subject_key)");
    expect(projection.replaceAll("COUNT(DISTINCT subject_key)", "")).not.toContain("subject_key");
  });

  it("projects the two predicate norms and the count, and that is all", () => {
    // The control for the four prohibitions above, which all pass against an
    // empty projection. Named columns rather than a shape assertion, because a
    // sixth column added to the SELECT is exactly the edit that would put a key
    // on the wire, and it should turn this red rather than pass by resemblance.
    // Split on commas at paren depth 0 — `COALESCE(bool_or(x), false)` holds a
    // comma of its own, and a naive split turns one column into two.
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of outerProjection().replace("SELECT", "")) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
      if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    parts.push(current);
    const columns = parts
      .map((part) => part.trim().split(/\s+AS\s+/i).at(-1)!.trim())
      .filter(Boolean);
    expect(columns).toEqual([
      "from_norm",
      "to_norm",
      "subjects",
      "from_warehouse",
      "to_warehouse",
    ]);
  });

  it("holds exactly ONE statement against `brain_facts`", () => {
    // ⚠️ The `DECLARATION_SITES` entry removes this file from the repo-wide scan
    // ENTIRELY, which switches off three arms — the key projection, the Drizzle
    // spelling, and `SELECT *`. The assertions above restore the first for
    // `ALIAS_PROPOSAL_SQL` and restore it more strictly (an exact column list
    // beats a key-name regex), but they restore nothing for a SECOND statement
    // added later.
    //
    // So the exemption's affordability rests on this module staying
    // single-statement, and that is now a test rather than a property of the
    // file's current length.
    const source = readFileSync(
      join(import.meta.dir, "..", "alias-proposal.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(
      source.match(/FROM brain_facts/g) ?? [],
      "`alias-proposal.ts` now holds more than one statement against `brain_facts`, and only the first is pinned here — either pin the new one or drop the `keys-not-on-the-wire.test.ts` exemption",
    ).toHaveLength(1);
  });

  it("hands back no fact id and no claim surface", () => {
    // The TypeScript half. A candidate that carried a fact id would let a
    // consumer walk back to the claim — a key beside its claim, assembled one
    // hop later — and one that carried a SURFACE would make the vocabulary's
    // display form a property of the proposal rather than of the row a reviewer
    // is shown.
    const executor = fakeExecutor([row()]);
    return loadAliasCandidates(executor, "ws-1").then(([found]) => {
      expect(Object.keys(found!).sort()).toEqual(["directed", "fromNorm", "subjects", "toNorm"]);
    });
  });
});
