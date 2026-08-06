/**
 * The alias-proposal query, against a real schema (#5034, ADR-0037 §4).
 *
 * `alias-proposal-corpus.ts` holds the fixture set; this file is the only place
 * that consumes it. Every case's rows land through `reconcileFacts`, so every
 * `predicate_key` and every `object_cmp` the query joins on is a value the
 * system produced — the corpus supplies surfaces and a claim about what a
 * reviewer should be shown, and nothing here writes a key.
 *
 * ## Why this must be a `-pg` suite
 *
 * The whole slice IS a SQL statement. An in-memory executor can observe which
 * binds it received and nothing about which rows it matches, so a fake would
 * pass identically against `ALIAS_PROPOSAL_SQL` and against a paraphrase that
 * had lost the subject arm. `alias-proposal.test.ts` is the fast-lane half and
 * owns the ranking rules, the reader's narrowing, and a lexical backstop over
 * the statement text; the MATCHING is here and nowhere else.
 *
 * ## Every prohibition has a positive control, in its own `test()`
 *
 * On day one this query returns zero rows for want of populated `object_cmp`,
 * so every prohibition below passes green against machinery that does nothing at
 * all — a query that returns the empty set satisfies all six. The controls are
 * what prove each can fire, and `inverse-relations` carries its control INSIDE
 * its own workspace for that reason rather than borrowing one from another case.
 *
 * The control and the prohibitions are separate `test()` blocks over the same
 * corpus: in a long proof the first failure hides the rest, and a positive
 * control that broke would silently mask the prohibition it licenses.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **GENERATED — see `packages/api/scripts/mutations/alias-proposal.md`**, from
 * `scripts/mutations/alias-proposal.mutations.ts`:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/alias-proposal.mutations.ts
 *
 * Read this file's column against `alias-proposal.test.ts`'s. They are
 * complements, not a superset and a subset: every SQL row is 0 over there and
 * several TypeScript rows are 0 here, because a lane that never runs SQL cannot
 * see which rows an arm admits and a lane whose assertions are about matched
 * rows cannot see a pure function's arithmetic.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { identityAlias, identityVocabulary, slotKey } from "@atlas/api/lib/brain/identity";
import {
  ALIAS_PROPOSAL_REPEAT_THRESHOLD,
  SEAM_PROPOSAL_PRODUCER,
  loadAliasCandidates,
  proposeAliasesFromCorpus,
} from "@atlas/api/lib/brain/alias-proposal";
import { decideAliasProposal } from "@atlas/api/lib/brain/vocabulary-decide";
import { withBrainTransaction } from "@atlas/api/lib/brain/reconcile";
import {
  ALIAS_PROPOSAL_CORPUS,
  type ExpectedProposal,
  type ProposalCase,
  type ProposalClaim,
} from "./alias-proposal-corpus";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// The corpus's own invariants — deliberately OUTSIDE the Postgres gate
// ---------------------------------------------------------------------------
//
// `for (const kase of firing())` over an empty array registers ZERO `it()`
// blocks and reports success, so deleting the last firing case would silently
// delete every positive control in the file. Inside `describeIfPg` this guard
// would be skipped in exactly the lane where the rest of the coverage is also
// skipped — the default local and `--affected` runs — which is where a silent
// deletion would land.

const firing = (): readonly ProposalCase[] =>
  ALIAS_PROPOSAL_CORPUS.filter((kase) => kase.proposes.length > 0);
const silent = (): readonly ProposalCase[] =>
  ALIAS_PROPOSAL_CORPUS.filter((kase) => kase.proposes.length === 0);

describe("the alias-proposal corpus itself (#5034)", () => {
  it("holds both halves of the prohibition/control pairing", () => {
    expect(
      firing().length,
      "no corpus case expects a proposal — every prohibition in this file is then vacuous, satisfied by a query that returns nothing on any input",
    ).toBeGreaterThan(0);
    expect(
      silent().length,
      "no corpus case expects zero proposals — the file has no prohibition left to license",
    ).toBeGreaterThan(0);
  });

  it("holds no duplicate id", () => {
    // The id names the case's workspace AND its episode source ids, so a
    // duplicate makes two cases share a corpus and points every failure at the
    // wrong one.
    const ids = ALIAS_PROPOSAL_CORPUS.map((kase) => kase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never expects a proposal below the repeat threshold", () => {
    // The corpus authors `subjects` by hand, and a case expecting a count the
    // gate would refuse is a fixture that can only ever fail — or, worse, one
    // that would pass if somebody lowered the threshold to make it pass.
    for (const kase of ALIAS_PROPOSAL_CORPUS) {
      for (const expected of kase.proposes) {
        expect(
          expected.subjects,
          `\`${kase.id}\` expects a proposal from ${expected.subjects} distinct subject(s), which is below ALIAS_PROPOSAL_REPEAT_THRESHOLD`,
        ).toBeGreaterThanOrEqual(ALIAS_PROPOSAL_REPEAT_THRESHOLD);
      }
    }
  });

  it("names a target that is one of the pair, or none at all", () => {
    // A `target` outside its own pair would assert a direction onto a predicate
    // the case never mentions, and the comparison below would then fail for a
    // reason that has nothing to do with the direction rule.
    for (const kase of ALIAS_PROPOSAL_CORPUS) {
      for (const expected of kase.proposes) {
        if (expected.target === null) continue;
        expect(
          expected.predicates as readonly string[],
          `\`${kase.id}\` names a direction target that is not one of the pair`,
        ).toContain(expected.target);
      }
    }
  });
});

describeIfPg("the alias-proposal query (#5034, ADR-0037 §4)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5034_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `reconcileFacts` and `withBrainTransaction` write through the module-level
    // pool when no runner is injected; `_resetPool(pool)` is what points that
    // pool at this schema. `DATABASE_URL` is set because sibling brain helpers
    // gate on `hasInternalDB()`, which reads the env var rather than the pool.
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await pool.query("DELETE FROM brain_vocabulary_proposal");
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
  });

  // ── landing the corpus ──────────────────────────────────────────────────

  /** One workspace per case, so a failure names the case that produced it. */
  const workspaceFor = (kase: ProposalCase): string => `ws-alias-${kase.id}`;

  /**
   * `source` is the episode's stored kind, which `reconcile.ts` copies into
   * `provenance.source` — the column the DIRECTION arm reads. Defaulted to the
   * ordinary extracted case.
   *
   * Bound as a PARAMETER and deliberately unvalidated: 0180 puts no CHECK on the
   * column and the region import writes out-of-vocabulary values through it, so
   * `unclassifiable-source` must be able to reach that state.
   */
  async function seedEpisode(
    workspaceId: string,
    sourceId: string,
    source = "slack",
  ): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-08-06T09:00:00.000Z");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, $4, $2, 'U123', 'evidence', $3::timestamptz, ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId, occurredAt.toISOString(), source],
    );
    return {
      id: rows[0]!.id,
      workspaceId,
      source,
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: ["org"],
    };
  }

  /**
   * Land one claim through the real stage.
   *
   * No `predicateCardinality`, unlike `identity-consumers-pg.test.ts` — the
   * proposal query has no cardinality arm and must not grow one, so passing
   * `single` here would put a configuration in the fixtures that the thing under
   * test does not read. The conservative default (`multi`) also keeps the rival
   * scan from being issued at all, which keeps these workspaces free of advisory
   * edges nothing here asserts about.
   */
  async function land(workspaceId: string, sourceId: string, claim: ProposalClaim) {
    const episode = await seedEpisode(workspaceId, sourceId, claim.source);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      // `source` is spread in with the rest and is harmless — `FactCandidate`
      // has no such field. The tier the direction arm reads comes off the
      // EPISODE above, which is the only place a producer can stamp it.
      candidates: [claim],
      producer: "alias-proposal-corpus",
      extractedAt: new Date("2026-08-06T10:00:00.000Z"),
    });
    // A PRECONDITION, asserted where every test body inherits it.
    // `reconcileFacts` returns every domain refusal as a counted outcome and
    // never throws, so a candidate that tripped `MALFORMED_CLAIM` would land
    // zero rows and every prohibition below would pass against an empty table.
    expect(
      report.outcomes[0],
      `\`${sourceId}\` was refused, not landed — every assertion downstream is vacuous`,
    ).not.toMatchObject({ kind: "blocked" });
    return report;
  }

  /** Every row of one case, into that case's own workspace. */
  async function landCase(kase: ProposalCase): Promise<string> {
    const workspaceId = workspaceFor(kase);
    for (const [index, row] of kase.rows.entries()) {
      await land(workspaceId, `${kase.id}-${index}`, row);
    }
    return workspaceId;
  }

  // ── comparing what the query said against what the corpus claims ────────

  /**
   * The norm a predicate surface keys to.
   *
   * ⚠️ This is the ONE value on the expectation side that the identity layer
   * also produced, and it is named rather than hidden. It is not the claim under
   * test: `identity-fixtures.ts` pins `lexicalNorm` against migration 0187's SQL,
   * and this file's claim is about WHICH PAIRS surface, not about what a surface
   * normalizes to. Hand-writing the expected norms instead would pin them twice
   * in one commit and drift on the first change to either.
   */
  const normOf = (surface: string): string => {
    const norm = slotKey(surface, identityAlias);
    expect(norm, `\`${surface}\` norms away to nothing — it cannot be a fixture predicate`).not
      .toBeNull();
    return norm!;
  };

  /** The shape both sides are compared in — unordered pair, target, repeat count. */
  interface Observation {
    readonly pair: readonly string[];
    readonly target: string | null;
    readonly subjects: number;
  }

  const expectedOf = (expected: ExpectedProposal): Observation => ({
    pair: [normOf(expected.predicates[0]), normOf(expected.predicates[1])].sort(),
    target: expected.target === null ? null : normOf(expected.target),
    subjects: expected.subjects,
  });

  /**
   * Run the query and describe what it said.
   *
   * The target is read off `directed` AND `toNorm` together, deliberately: a
   * candidate that set `directed` correctly and left the pair in arrival order
   * would name the wrong target, and asserting the flag alone cannot see it.
   */
  async function observe(workspaceId: string): Promise<Observation[]> {
    const candidates = await withBrainTransaction((tx) => loadAliasCandidates(tx, workspaceId));
    return candidates
      .map((candidate) => ({
        pair: [candidate.fromNorm, candidate.toNorm].sort(),
        target: candidate.directed ? candidate.toNorm : null,
        subjects: candidate.subjects,
      }))
      .sort((a, b) => a.pair.join(" ").localeCompare(b.pair.join(" ")));
  }

  // ── the controls ────────────────────────────────────────────────────────

  for (const kase of firing()) {
    it(
      `proposes exactly what \`${kase.id}\` claims — ${kase.why.split("\n")[0]!.slice(0, 90)}`,
      async () => {
        const workspaceId = await landCase(kase);
        expect(await observe(workspaceId)).toEqual(
          kase.proposes.map(expectedOf).sort((a, b) =>
            a.pair.join(" ").localeCompare(b.pair.join(" ")),
          ),
        );
      },
      PG_TEST_TIMEOUT_MS,
    );
  }

  // ── the prohibitions ────────────────────────────────────────────────────

  for (const kase of silent()) {
    it(
      `proposes nothing for \`${kase.id}\` — ${kase.why.split("\n")[0]!.slice(0, 90)}`,
      async () => {
        const workspaceId = await landCase(kase);
        expect(await observe(workspaceId)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );
  }

  // ── the query is workspace-scoped ───────────────────────────────────────

  it(
    "never reads another workspace's corpus",
    async () => {
      // The three arms are all intra-row-pair; `workspace_id` is the only thing
      // keeping two tenants' predicates from proposing an alias for each other,
      // and a workspace-wide re-key sourced from a NEIGHBOUR'S claims is the
      // worst outcome this producer has. Landed as two halves of one agreeing
      // pair in two tenants, so a dropped scope arm produces a candidate rather
      // than merely a bigger count.
      const [control] = firing();
      expect(control, "no firing case to split across two workspaces").toBeDefined();
      for (const [index, row] of control!.rows.entries()) {
        await land(`ws-alias-tenant-${index % 2}`, `${control!.id}-split-${index}`, row);
      }
      expect(await observe("ws-alias-tenant-0")).toEqual([]);
      expect(await observe("ws-alias-tenant-1")).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── the live set ────────────────────────────────────────────────────────

  it(
    "stops proposing once a human has retired one side of the evidence",
    async () => {
      // The `valid_to IS NULL` and `invalidated_at IS NULL` arms, which no
      // corpus case can reach: `reconcileFacts` writes live rows and nothing in
      // this file retires one. So the retirement is applied here, by hand, to
      // the SAME workspace that just produced a candidate — the control is the
      // first assertion rather than a separate case.
      //
      // Two reasons the arms are load-bearing, and the first is the one a reader
      // would miss: they are what puts both sides of the self-join on
      // `idx_brain_facts_subject`, which is partial on exactly this predicate —
      // the "costing no new index" claim in ADR-0037 §4 depends on them. The
      // second is the ordinary one: a belief a human retired is not evidence of
      // what this workspace's producers say now, and proposing a workspace-wide
      // re-key off it would resurrect a decision somebody already made.
      //
      // `valid_to` rather than `invalidated_at`, because it is the column a
      // human's publish-time supersession actually stamps. The two arms are one
      // decision and the mutation list treats them as one.
      const kase = controlCase();
      const workspaceId = await landCase(kase);
      expect(await observe(workspaceId)).toHaveLength(kase.proposes.length);

      const targetNorm = normOf(kase.proposes[0]!.predicates[0]);
      const { rowCount } = await pool.query(
        "UPDATE brain_facts SET valid_to = now() WHERE workspace_id = $1 AND predicate_key = $2",
        [workspaceId, targetNorm],
      );
      expect(rowCount, "the retirement matched no row — the assertion below is vacuous").toBeGreaterThan(0);

      expect(await observe(workspaceId)).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ── propose → queue, over the same corpus ───────────────────────────────

  const controlCase = (): ProposalCase => {
    const [control] = firing();
    expect(control, "no firing case — the queue assertions below have nothing to queue").toBeDefined();
    return control!;
  };

  it(
    "queues a seam-sourced PREDICATE proposal a human must direct",
    async () => {
      const kase = controlCase();
      const workspaceId = await landCase(kase);

      const counters = await proposeAliasesFromCorpus(workspaceId);
      expect(counters.queued).toBe(kase.proposes.length);
      // Never auto-approved, whatever the confidence climbs to:
      // `autoApproveEligible` refuses every non-entity position before it reads
      // the threshold, and this producer proposes at the predicate position only.
      expect(counters.autoApproved).toBe(0);

      const { rows } = await pool.query(
        `SELECT slot_position, source_class, status, directed, proposed_by, confidence
           FROM brain_vocabulary_proposal WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(rows).toHaveLength(kase.proposes.length);
      expect(rows[0]).toMatchObject({
        slot_position: "predicate",
        source_class: "seam",
        status: "pending",
        directed: kase.proposes[0]!.target !== null,
        proposed_by: SEAM_PROPOSAL_PRODUCER,
      });
      // A RANK, and the only property asserted is that it is inside 0190's
      // CHECK. Pinning the number would pin `structuralConfidence`'s curve from
      // two places at once, and the curve is deliberately uncalibrated.
      const confidence = (rows[0] as { confidence: number }).confidence;
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "re-deriving the same corpus converges on the queued row instead of duplicating it",
    async () => {
      // The producer holds no cursor and no watermark — it re-reads the whole
      // corpus every run — so idempotence is not an optimization here, it is the
      // difference between a queue and a log. `brain_vocabulary_proposal`'s
      // unordered pair constraint is what delivers it; this asserts the producer
      // actually reaches that constraint rather than inserting beside it.
      const kase = controlCase();
      const workspaceId = await landCase(kase);

      await proposeAliasesFromCorpus(workspaceId);
      const second = await proposeAliasesFromCorpus(workspaceId);
      expect(second.queued).toBe(0);
      expect(second.deduped).toBe(kase.proposes.length);

      const { rows } = await pool.query(
        "SELECT id FROM brain_vocabulary_proposal WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(rows).toHaveLength(kase.proposes.length);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "does not re-queue a pair a human rejected, however much evidence accumulates",
    async () => {
      // #4507's permanent rejection memory, reached through THIS producer. The
      // structural evidence is still in the corpus and still passes every arm —
      // the whole point is that a human's removal outranks it — so a producer
      // that re-queued would put the reviewer's own decision back in their queue
      // on the next episode, forever.
      const kase = controlCase();
      const workspaceId = await landCase(kase);

      await proposeAliasesFromCorpus(workspaceId);
      const { rows: pending } = await pool.query<{ id: string }>(
        "SELECT id FROM brain_vocabulary_proposal WHERE workspace_id = $1",
        [workspaceId],
      );
      for (const row of pending) {
        const decided = await decideAliasProposal({
          id: row.id,
          workspaceId,
          decision: "rejected",
          approver: {
            kind: "human",
            ctx: { origin: "unauthenticated-local", userId: null, workspaceId, principals: [] },
          },
        });
        expect(decided.kind).toBe("rejected");
      }

      const again = await proposeAliasesFromCorpus(workspaceId);
      expect(again.queued).toBe(0);
      expect(again.rejected).toBe(kase.proposes.length);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a hint for a pair the corpus does not support proposes nothing",
    async () => {
      // ⭐ ADR-0037 §4's *the extractor's hint rides as a rank on a candidate
      // structural evidence already found, NEVER as a candidate.* An extractor
      // asked for a canonical predicate always produces one — it cannot abstain
      // — so a hint-sourced candidate path would fill the queue with confident,
      // unfalsifiable noise.
      //
      // `led_by`/`leads` as the hint, deliberately: it is the pair a similarity
      // detector ranks FIRST and the one whose approval stamps `valid_to` across
      // the manager graph. If any path let a hint become a candidate, this is
      // the candidate it would become.
      const workspaceId = await landCase(
        ALIAS_PROPOSAL_CORPUS.find((kase) => kase.id === "inverse-relations")!,
      );

      const counters = await proposeAliasesFromCorpus(workspaceId, {
        hints: [{ fromNorm: normOf("led_by"), toNorm: normOf("leads") }],
      });

      const { rows } = await pool.query<{ from_norm: string; to_norm: string }>(
        "SELECT from_norm, to_norm FROM brain_vocabulary_proposal WHERE workspace_id = $1",
        [workspaceId],
      );
      // The control pair IS queued, from the control rows in the same workspace
      // — so a green assertion here is not "the producer did nothing".
      expect(counters.queued).toBe(1);
      expect(rows).toHaveLength(1);
      expect([rows[0]!.from_norm, rows[0]!.to_norm].sort()).toEqual(
        [normOf("is priced at"), normOf("priced at")].sort(),
      );
    },
    PG_TEST_TIMEOUT_MS,
  );
});
