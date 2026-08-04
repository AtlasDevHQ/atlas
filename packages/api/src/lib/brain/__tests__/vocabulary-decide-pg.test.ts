/**
 * The alias decision seam — proposal queue, auto-approve split, direction, and
 * permanent rejection memory (#5023, ADR-0037 §6).
 *
 * ## Why this is a `-pg` suite
 *
 * Its central property is one migration 0190 states in SQL and nothing else
 * can: the proposal's identity is the UNORDERED pair, held by a unique index
 * over two GENERATED columns. A fake that computed the pair key in TypeScript
 * would be a second implementation of the thing under test, agreeing with the
 * first by construction — the shape #5000 was, and the shape #5021 stripped
 * `FakeBrainStore` of identity answers to stop. The claim/stamp conditionals,
 * the rollback that undoes a claim, and `removeAliasEdge`'s closure rebuild are
 * all the same kind of property.
 *
 * ## The falsification target this suite exists for
 *
 * ADR-0037 §9 / T7 target (c): **a producer does not re-emit a removed edge**,
 * paired with a positive control proving the producer re-emits an edge that was
 * NEVER removed. That pair is the whole point — a `proposeAliasEdges` that
 * refused everything satisfies the prohibition alone, and a producer whose
 * second pass is a no-op satisfies it while proving nothing.
 *
 * `runProducer` below is the fixture's stand-in for #5034's proposal query. It
 * is deliberately a THIN caller of the production `proposeAliasEdges` rather
 * than a re-implementation: what is under test is the suppression, and a test
 * producer with its own dedup would be exactly the fixture-agrees-by-
 * construction defect.
 *
 * ## Every prohibition has a positive control, in its own `test()`
 *
 * Most assertions here are refusals, and a refusal passes green against
 * machinery that refuses everything. Each is paired with a control proving the
 * same call can succeed, and they are separate `test()` blocks rather than two
 * arms of one body: in a long proof the first failure hides the rest, so a
 * broken control would silently mask the prohibition it licenses.
 *
 * ## One side of every identity assertion is a value the system produced
 *
 * The closure answers below come from `loadClaimVocabulary` reading what the
 * recursive CTE wrote; the proposal statuses come from the seam. Nothing here
 * hand-writes a closure row or a `pair_low`.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * Measured against THIS tree, one mutation at a time, in a single run — not
 * carried forward from an earlier draft.
 *
 * | Mutation | Tests it kills |
 * |---|---|
 * | rejection memory dropped (`rejected` falls through to the insert) | 4 |
 * | rejection-memory identity made ORDERED (`from_norm`/`to_norm` instead of the pair) | 2 |
 * | rejection memory read AFTER the `approved` arm | 4 |
 * | removal stops writing `rejected` (edge dropped, row left `approved`) | 4 |
 * | `removeAliasEdge` dropped from the reject arm (status flips, edge survives) | 3 |
 * | the pending-dedup arm dropped (a second propose inserts a second row) | 2 |
 * | `autoApproveEligible`'s entity-position conjunct dropped | 1 |
 * | `autoApproveEligible`'s source-class conjunct dropped | 2 |
 * | `autoApproveEligible`'s threshold conjunct dropped | 2 |
 * | the `warehouse_key`-at-predicate refusal dropped | 1 |
 * | the auto arm's re-check at decide time dropped | 1 |
 * | `direction-required` dropped (an undirected proposal approves in stored order) | 1 |
 * | `direction-not-in-pair` dropped | 1 |
 * | `direction-conflict` dropped (a directed proposal is flipped) | 1 |
 * | the approval STAMPS the proposed direction instead of the resolved one | 1 |
 * | the EDGE is written in the proposed direction instead of the resolved one | 1 |
 * | `approverEntitled`'s entity-position owner/admin bar dropped | 1 |
 * | `approverEntitled` made owner/admin at EVERY position (the postures collapse) | 1 |
 * | the `unresolved`-origin arm admitted | 1 |
 * | the workspace-mismatch guard dropped | 1 |
 * | the apply refusal RETURNED instead of thrown (claim commits, row stuck `applying`) | 3 |
 * | the claim's `status = 'pending'` predicate dropped | 1 |
 * | the vocabulary lock taken AFTER the proposal read (the 40P01 inversion) | 1 |
 *
 * 23 mutations, 23 caught, zero survivors — and three rows need reading with
 * care rather than at face value:
 *
 * The ordered-identity mutation is NOT caught by the headline producer test:
 * that one re-emits the pair in the same order it was removed in, so an ordered
 * identity still suppresses it and the test passes. The reverse-direction case
 * is the only thing separating them, which is why it exists as its own `test()`
 * instead of an extra assertion.
 *
 * The entity-position conjunct is DEAD CODE under the shipped knob — the only
 * eligible source class is `warehouse_key`, and that is refused at the predicate
 * position before eligibility is consulted. The one test that kills it widens
 * the knob AND carries confidence 1; at this suite's default 0.8 the threshold
 * conjunct refuses first and the mutation survives, which is what the first cut
 * of that test did.
 *
 * The lock-order row is caught STRUCTURALLY, by asserting the first statement of
 * each transaction, because the failure it prevents is a deadlock against the
 * region importer that no single-process test can provoke.
 *
 * NOT in the table, deliberately: loosening the eligibility threshold from
 * `!(confidence >= t)` to `confidence < t` kills NOTHING, and cannot. The two
 * differ only on NaN, which propose refuses outright and the stored column
 * cannot hold (Postgres orders NaN above every value, so 0190's `confidence <=
 * 1` CHECK rejects it). The spelling is defensive style, not a tested property,
 * and a row claiming otherwise would be a fabricated measurement.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import { loadClaimVocabulary, type VocabularyExecutor } from "@atlas/api/lib/brain/vocabulary";
import {
  withBrainTransaction,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import {
  decideAliasProposal,
  proposeAliasEdge,
  proposeAliasEdges,
  type AliasDecideDeps,
  type AliasProposalInput,
  type AliasSourceClass,
} from "@atlas/api/lib/brain/vocabulary-decide";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { SlotPosition } from "@atlas/api/lib/brain/identity";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-vocab-decide-5023";
const OTHER_WS = "ws-vocab-decide-5023-other";
const PRODUCER = "test-producer";

// ---------------------------------------------------------------------------
// The no-ACL invariant — deliberately OUTSIDE the Postgres gate
// ---------------------------------------------------------------------------
//
// ADR-0037 §6 makes the vocabulary the one piece of brain state with no ACL,
// PERMANENTLY, and a proposal is vocabulary state. Proposal VISIBILITY is
// positional and belongs to the queue read (#5025 over #5034), computed from
// the evidence rows — a grant column here would be a second, drifting ACL for a
// subsystem whose design says it has none. That column would appear in a schema
// PR rather than a brain one, so this reads the Drizzle schema and needs no
// database.

describe("the alias proposal queue carries no ACL arm (#5023, ADR-0037 §6)", () => {
  it("brain_vocabulary_proposal has no grant column", () => {
    const cfg = Object.values(schema)
      .flatMap((v) => (is(v, PgTable) ? [getTableConfig(v)] : []))
      .find((t) => t.name === "brain_vocabulary_proposal");
    const columns = cfg ? cfg.columns.map((c) => c.name) : [];
    // Non-vacuous: prove the table is really in the schema before asserting
    // what it lacks — a renamed or dropped one yields [], which would otherwise
    // satisfy every assertion below.
    expect(columns.length, "brain_vocabulary_proposal is not in db/schema.ts").toBeGreaterThan(0);
    expect(columns).toContain("workspace_id");
    expect(columns).not.toContain("visible_to");
    expect(columns).not.toContain("pre_widening_visible_to");
  });
});

describeIfPg("the alias decision seam (#5023)", () => {
  let pool: Pool;
  const schemaName = `brain_5023_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  let priorDatabaseUrl: string | undefined;

  beforeAll(async () => {
    // The seam's default transaction runner reads the module-level pool, so the
    // production path is what these tests exercise. Set inside the hook, never
    // at module top level.
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
    // Targets BEFORE edges — `fk_brain_vocabulary_target_edge` is RESTRICT.
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_vocabulary_proposal");
    delete process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD;
    delete process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES;
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  /** A warehouse-derived entity proposal — the one shape the split admits. */
  const warehouseEdge = (
    fromNorm: string,
    toNorm: string,
    position: SlotPosition = "subject",
  ): AliasProposalInput => ({
    position,
    fromNorm,
    toNorm,
    directed: true,
    sourceClass: "warehouse_key",
    confidence: 1,
    proposedBy: PRODUCER,
  });

  const proposal = (
    over: Partial<AliasProposalInput> & Pick<AliasProposalInput, "fromNorm" | "toNorm">,
  ): AliasProposalInput => ({
    position: "predicate",
    directed: true,
    sourceClass: "seam",
    confidence: 0.8,
    proposedBy: PRODUCER,
    ...over,
  });

  const owner = (workspaceId = WS): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId,
    userId: "user-owner",
    role: "owner",
    audienceIds: [],
  });

  const member = (workspaceId = WS): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId,
    userId: "user-member",
    role: "member",
    audienceIds: [],
  });

  const unresolved = (workspaceId = WS): BrainPrincipalContext => ({
    origin: "unresolved",
    workspaceId,
    userId: null,
    role: null,
    audienceIds: [],
  });

  /** Approve as a human. Direction supplied only when the caller means to. */
  const approveAs = (
    id: string,
    ctx: BrainPrincipalContext,
    direction?: { fromNorm: string; toNorm: string },
    workspaceId = WS,
  ) =>
    decideAliasProposal({
      id,
      workspaceId,
      decision: "approved",
      approver: { kind: "human", ctx },
      direction,
    });

  /** Reject — or, on an approved row, REMOVE. One verb, by design. */
  const rejectAs = (id: string, ctx: BrainPrincipalContext, workspaceId = WS) =>
    decideAliasProposal({
      id,
      workspaceId,
      decision: "rejected",
      approver: { kind: "human", ctx },
    });

  /** Queue one proposal and return its id, failing loudly if it did not queue. */
  async function queue(input: AliasProposalInput, workspaceId = WS): Promise<string> {
    const outcome = await proposeAliasEdge(workspaceId, input, {});
    if (outcome.kind !== "queued") {
      throw new Error(`expected a queued proposal, got ${outcome.kind}`);
    }
    return outcome.id;
  }

  /**
   * ONE producer pass. A thin caller of the production batch helper — see the
   * header on why it must not do any deduping of its own.
   */
  const runProducer = (inputs: readonly AliasProposalInput[], workspaceId = WS) =>
    proposeAliasEdges(workspaceId, inputs, PRODUCER, {});

  async function storedEdges(workspaceId = WS) {
    const { rows } = await pool.query<{ slot_position: string; from_norm: string; to_norm: string }>(
      `SELECT slot_position, from_norm, to_norm FROM brain_vocabulary_edge
        WHERE workspace_id = $1 ORDER BY slot_position, from_norm`,
      [workspaceId],
    );
    return rows;
  }

  async function proposalRows(workspaceId = WS) {
    const { rows } = await pool.query<{
      id: string;
      from_norm: string;
      to_norm: string;
      directed: boolean;
      status: string;
      reviewed_by: string | null;
    }>(
      `SELECT id, from_norm, to_norm, directed, status, reviewed_by
         FROM brain_vocabulary_proposal WHERE workspace_id = $1 ORDER BY proposed_at, from_norm`,
      [workspaceId],
    );
    return rows;
  }

  const statusOf = async (id: string): Promise<string | undefined> =>
    (await proposalRows()).find((r) => r.id === id)?.status;

  // ── 1. The seam works at all — the file's positive control ──────────────

  it("approves a proposal, writes the edge, and `alias` answers from the closure", async () => {
    // THE control for this whole file. Every refusal below passes green against
    // a seam that refuses unconditionally; this proves one can land.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(await approveAs(id, owner())).toEqual({ kind: "approved", id });

    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
    // The answer comes from the closure the recompute wrote, not from the edge
    // row the test just asserted on.
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");
    expect(await statusOf(id)).toBe("approved");
  });

  // ── 2. T7 target (c) — a producer does not re-emit a removed edge ───────

  it("a producer re-run does NOT re-emit an edge a human removed", async () => {
    // The falsification target. Run 1 auto-approves two warehouse-derived
    // entity edges; a human removes one; run 2 emits BOTH again.
    const first = await runProducer([
      warehouseEdge("project atlas", "nova"),
      warehouseEdge("acme corp", "acme"),
    ]);
    expect(first.autoApproved).toBe(2);
    expect(await storedEdges()).toHaveLength(2);

    const removed = (await proposalRows()).find((r) => r.from_norm === "project atlas")!;
    expect(await rejectAs(removed.id, owner())).toEqual({
      kind: "rejected",
      id: removed.id,
      removedEdge: true,
    });

    const second = await runProducer([
      warehouseEdge("project atlas", "nova"),
      warehouseEdge("acme corp", "acme"),
    ]);

    // The removed pair is refused by permanent rejection memory, and the count
    // is SURFACED — #4507's own requirement. A producer that could not report
    // the suppression would leave the next operator debugging a missing alias
    // with nothing to read.
    expect(second.rejected).toBe(1);
    expect(second.autoApproved).toBe(0);

    // …and the removal really held: only the untouched edge remains.
    expect(await storedEdges()).toEqual([
      { slot_position: "subject", from_norm: "acme corp", to_norm: "acme" },
    ]);
    expect((await loadClaimVocabulary(pool, WS)).subject("project atlas")).toBe("project atlas");
  });

  it("the same re-run DOES re-see an edge that was never removed (the control)", async () => {
    // The positive control T7 asks for by name, in its own test so a broken
    // control cannot mask the prohibition it licenses. Without it, a producer
    // whose second pass did nothing at all would satisfy the test above.
    await runProducer([warehouseEdge("acme corp", "acme")]);

    const second = await runProducer([warehouseEdge("acme corp", "acme")]);
    // Reached the pair and recognized it — not refused, not re-inserted.
    expect(second.alreadyApproved).toBe(1);
    expect(second.rejected).toBe(0);
    expect(await proposalRows()).toHaveLength(1);
  });

  it("a producer can still land a NEW edge after a removal (the second control)", async () => {
    // The stronger half: rejection memory must suppress ONE pair, not disable
    // the producer. A seam that latched off after any rejection would pass the
    // prohibition and both counters above.
    await runProducer([warehouseEdge("project atlas", "nova")]);
    const removed = (await proposalRows())[0]!;
    await rejectAs(removed.id, owner());

    const second = await runProducer([
      warehouseEdge("project atlas", "nova"),
      warehouseEdge("globex inc", "globex"),
    ]);
    expect(second.rejected).toBe(1);
    expect(second.autoApproved).toBe(1);
    expect((await loadClaimVocabulary(pool, WS)).subject("globex inc")).toBe("globex");
  });

  it("rejection memory is the UNORDERED pair, so the reverse direction is refused too", async () => {
    // The hole an ordered identity leaves, and the ONLY test that separates the
    // two: the headline producer test re-emits the pair in the same order, so
    // an ordered identity suppresses it and passes. Direction is not fixed until
    // approval, so a producer could route around a rejection by emitting the
    // pair the other way — without any intent to.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(await rejectAs(id, owner())).toMatchObject({ kind: "rejected", removedEdge: false });

    const reverse = await proposeAliasEdge(
      WS,
      proposal({ fromNorm: "priced at", toNorm: "is priced at" }),
      {},
    );
    expect(reverse).toEqual({ kind: "rejected", id });
    expect(await proposalRows()).toHaveLength(1);
  });

  it("a DIFFERENT pair sharing one norm is still proposable (the control)", async () => {
    // Without this, a rejection memory keyed on either norm alone — refusing
    // anything mentioning `is priced at` — would satisfy the test above.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    await rejectAs(id, owner());

    const other = await proposeAliasEdge(
      WS,
      proposal({ fromNorm: "is priced at", toNorm: "unit price" }),
      {},
    );
    expect(other.kind).toBe("queued");
  });

  it("rejection memory outranks a pending duplicate", async () => {
    // Order matters inside the seam: a pair that has been rejected must never be
    // re-queued, so the `rejected` arm is read before every other status. With
    // one row per pair the two cannot coexist, which is exactly why the
    // ordering is asserted on the STATUS rather than on which row was found.
    const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
    await rejectAs(id, owner());
    expect(await statusOf(id)).toBe("rejected");

    expect(await proposeAliasEdge(WS, proposal({ fromNorm: "led by", toNorm: "leads" }), {})).toEqual(
      { kind: "rejected", id },
    );
  });

  // ── 3. Removal is a recomputation, through the seam ─────────────────────

  it("removing an approved edge restores what it was hiding (compressed chain)", async () => {
    // ADR-0037 §6's reversibility, reached through the DECIDE seam rather than
    // through `removeAliasEdge` directly — which is the version that matters,
    // because the seam is the only path a human has. A single-edge fixture
    // would be vacuous here for the same reason it is in `vocabulary-pg`.
    const a = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    await approveAs(a, owner());
    const b = await queue(proposal({ fromNorm: "priced at", toNorm: "unit price" }));
    await approveAs(b, owner());
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("unit price");

    expect(await rejectAs(b, owner())).toEqual({ kind: "rejected", id: b, removedEdge: true });

    const vocabulary = await loadClaimVocabulary(pool, WS);
    expect(vocabulary.predicate("is priced at")).toBe("priced at");
    expect(vocabulary.predicate("priced at")).toBe("priced at");
    // The surviving decision is untouched — removal is a recomputation, not a
    // destructive write.
    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
  });

  it("a removal leaves the pair REJECTED, not merely un-approved", async () => {
    // The link between removal and rejection memory, asserted on its own. A
    // removal that deleted the edge and left the row `approved` — or deleted the
    // row — would pass the reversibility test above and silently readmit the
    // producer.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());
    await rejectAs(id, owner());

    expect(await statusOf(id)).toBe("rejected");
    expect(await storedEdges()).toEqual([]);
  });

  it("rejecting a PENDING proposal writes no edge", async () => {
    const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
    expect(await rejectAs(id, owner())).toEqual({ kind: "rejected", id, removedEdge: false });
    expect(await storedEdges()).toEqual([]);
  });

  it("a decided proposal is not decidable again", async () => {
    const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
    await rejectAs(id, owner());
    expect(await approveAs(id, owner())).toEqual({ kind: "not_decidable", id });
    expect(await rejectAs(id, owner())).toEqual({ kind: "not_decidable", id });
    expect(await storedEdges()).toEqual([]);
  });

  it("an unknown id is not decidable, and neither is another workspace's", async () => {
    expect(await approveAs("no-such-proposal", owner())).toEqual({
      kind: "not_decidable",
      id: "no-such-proposal",
    });

    // Scoped by workspace, not merely by id: the row exists, and this workspace
    // still cannot decide it.
    const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }), OTHER_WS);
    expect(await approveAs(id, owner(), undefined, WS)).toEqual({ kind: "not_decidable", id });
    await pool.query("DELETE FROM brain_vocabulary_proposal WHERE workspace_id = $1", [OTHER_WS]);
  });

  // ── 4. The auto-approve split ───────────────────────────────────────────

  it("a warehouse-derived ENTITY edge is auto-approve eligible (the control)", async () => {
    const outcome = await proposeAliasEdge(WS, warehouseEdge("project atlas", "nova"), {});
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: true });
  });

  it("an extractor-derived entity edge always queues", async () => {
    const outcome = await proposeAliasEdge(
      WS,
      { ...warehouseEdge("project atlas", "nova"), sourceClass: "extractor" },
      {},
    );
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("a seam-proposed PREDICATE edge always queues", async () => {
    // Both conjuncts differ from the control at once on purpose — this is the
    // shape ADR-0037 §6 names as "always queue", and #5000's own case.
    const outcome = await proposeAliasEdge(
      WS,
      proposal({ fromNorm: "is priced at", toNorm: "priced at" }),
      {},
    );
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("a warehouse-derived edge at the PREDICATE position is refused outright", async () => {
    // Not "queues" — REFUSED. A warehouse primary key backs an entity instance;
    // a predicate is a verb phrase and has none, so the class cannot honestly
    // arise there, and admitting it would route a predicate alias through the
    // arm reserved for evidence outside the grant grammar.
    const outcome = await proposeAliasEdge(
      WS,
      { ...warehouseEdge("is priced at", "priced at"), position: "predicate" },
      {},
    );
    expect(outcome).toMatchObject({ kind: "refused", refusal: "warehouse-key-at-predicate" });
    expect(await proposalRows()).toHaveLength(0);
  });

  it("the same warehouse-derived pair at an OBJECT position is accepted (the control)", async () => {
    // `object` is the entity position the control above does not use, so this
    // also proves the entity test is `subject || object` rather than `subject`.
    const outcome = await proposeAliasEdge(
      WS,
      { ...warehouseEdge("nova", "project nova"), position: "object" },
      {},
    );
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: true });
  });

  it("an empty threshold switches auto-approval off entirely", async () => {
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "";
    const outcome = await proposeAliasEdge(WS, warehouseEdge("project atlas", "nova"), {});
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("a source list without `warehouse_key` switches it off too", async () => {
    // The two knob halves are independent conjuncts, and a test that only moved
    // the threshold would pass with the source arm deleted.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES = "extractor";
    const outcome = await proposeAliasEdge(WS, warehouseEdge("project atlas", "nova"), {});
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("a confidence below the threshold is not eligible", async () => {
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "0.9";
    const low = await proposeAliasEdge(
      WS,
      { ...warehouseEdge("project atlas", "nova"), confidence: 0.5 },
      {},
    );
    expect(low).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("a widened knob really does widen it (the control)", async () => {
    // The prohibitions above all pass against an `autoApproveEligible` that
    // returned false unconditionally. This is what proves the knob is read at
    // all rather than the split being hardcoded.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES = "warehouse_key,extractor";
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "0.5";
    const outcome = await proposeAliasEdge(
      WS,
      { ...warehouseEdge("project atlas", "nova"), sourceClass: "extractor", confidence: 0.6 },
      {},
    );
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: true });
  });

  it("a widened source list still does not auto-approve at the PREDICATE position", async () => {
    // The entity-position conjunct is DEAD under the shipped knob — the only
    // eligible class is `warehouse_key`, and that is refused at the predicate
    // position before eligibility is ever consulted. So it is only reachable
    // once an operator widens the source list, which is exactly when it starts
    // mattering: without it, widening to `extractor` would auto-approve
    // PREDICATE aliases too, and a predicate approval re-keys every claim in the
    // workspace that uses that verb phrase.
    //
    // Written as its own case because the widened-knob control two tests up
    // proves the knob is read, and this proves the position still bounds it.
    // Confidence 1, deliberately: the shipped threshold is 1, and this suite's
    // default proposal carries 0.8. At 0.8 the THRESHOLD conjunct refuses it
    // first and the position conjunct is never consulted — which is how the
    // first cut of this test passed while the mutation survived.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES = "warehouse_key,extractor";
    const outcome = await proposeAliasEdge(
      WS,
      proposal({
        fromNorm: "is priced at",
        toNorm: "priced at",
        sourceClass: "extractor",
        confidence: 1,
      }),
      {},
    );
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("the same widened class DOES auto-approve at an entity position (the control)", async () => {
    // Without this, an eligibility check that refused every `extractor` edge
    // would satisfy the test above while the knob did nothing at all.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES = "warehouse_key,extractor";
    const outcome = await proposeAliasEdge(
      WS,
      {
        ...warehouseEdge("project atlas", "nova"),
        sourceClass: "extractor",
      },
      {},
    );
    expect(outcome).toMatchObject({ kind: "queued", autoApprove: true });
  });

  it("the auto approver is re-checked at decide time, not trusted from propose", async () => {
    // Defence in depth, and it is not theoretical: the knob is a live workspace
    // setting, so a producer that queued a batch under one policy would
    // otherwise auto-approve under it after an operator turned it off.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "";

    const decided = await decideAliasProposal({
      id,
      workspaceId: WS,
      decision: "approved",
      approver: { kind: "auto", producer: PRODUCER },
    });
    expect(decided).toMatchObject({ kind: "refused", refusal: "not-auto-approvable" });
    // Left decidable by a human — a refused auto-approval must not consume the
    // proposal.
    expect(await statusOf(id)).toBe("pending");
    expect(await storedEdges()).toEqual([]);
  });

  it("the auto approver CAN approve an eligible proposal (the control)", async () => {
    const id = await queue(warehouseEdge("project atlas", "nova"));
    expect(
      await decideAliasProposal({
        id,
        workspaceId: WS,
        decision: "approved",
        approver: { kind: "auto", producer: PRODUCER },
      }),
    ).toEqual({ kind: "approved", id });

    // `approved_by` is NULL for the machine path — migration 0189 calls that
    // column the one an audit of a workspace-wide re-key reads first, and a
    // 'system' sentinel would be indistinguishable from a user id.
    const { rows } = await pool.query<{ approved_by: string | null }>(
      "SELECT approved_by FROM brain_vocabulary_edge WHERE workspace_id = $1",
      [WS],
    );
    expect(rows).toEqual([{ approved_by: null }]);
  });

  // ── 5. Approval sets direction where absent ─────────────────────────────

  it("refuses to approve an UNDIRECTED proposal without a direction", async () => {
    // #5000's own case: neither `priced at` nor `is priced at` is
    // warehouse-derived, so nothing in the evidence says which is canonical.
    // Picking one here would re-key the corpus on a guess nobody made.
    const id = await queue(
      proposal({ fromNorm: "priced at", toNorm: "is priced at", directed: false }),
    );
    expect(await approveAs(id, owner())).toMatchObject({
      kind: "refused",
      refusal: "direction-required",
    });
    expect(await storedEdges()).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
  });

  it("approves an undirected proposal in the direction the human supplies (the control)", async () => {
    // Supplied in the REVERSE of the stored order, which is the half that
    // matters: an approval that ignored the argument and used the stored
    // columns would pass a same-order control.
    const id = await queue(
      proposal({ fromNorm: "priced at", toNorm: "is priced at", directed: false }),
    );
    expect(
      await approveAs(id, owner(), { fromNorm: "is priced at", toNorm: "priced at" }),
    ).toEqual({ kind: "approved", id });

    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");

    // The row records the direction it set, and keeps its pair identity across
    // the swap — so the pair is still one row, not two.
    expect(await proposalRows()).toEqual([
      expect.objectContaining({
        from_norm: "is priced at",
        to_norm: "priced at",
        directed: true,
        status: "approved",
        reviewed_by: "user-owner",
      }),
    ]);
  });

  it("refuses a direction that is not an ordering of the proposal's pair", async () => {
    const id = await queue(
      proposal({ fromNorm: "priced at", toNorm: "is priced at", directed: false }),
    );
    expect(
      await approveAs(id, owner(), { fromNorm: "priced at", toNorm: "list price" }),
    ).toMatchObject({ kind: "refused", refusal: "direction-not-in-pair" });
    expect(await storedEdges()).toEqual([]);
  });

  it("refuses to FLIP an already-directed proposal", async () => {
    // A directed proposal was read by the reviewer in one direction, and
    // re-keying in the other is indistinguishable afterwards from the one they
    // approved. The repair is a rejection plus a fresh authoring, not a flip.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(
      await approveAs(id, owner(), { fromNorm: "priced at", toNorm: "is priced at" }),
    ).toMatchObject({ kind: "refused", refusal: "direction-conflict" });
    expect(await storedEdges()).toEqual([]);
  });

  it("confirming a directed proposal with its own direction is fine (the control)", async () => {
    // What a UI that always sends the direction does. Without this control, a
    // seam that refused every supplied direction on a directed proposal would
    // satisfy the prohibition above.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(
      await approveAs(id, owner(), { fromNorm: "is priced at", toNorm: "priced at" }),
    ).toEqual({ kind: "approved", id });
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");
  });

  // ── 6. Two authority postures, not one ──────────────────────────────────

  it("a member may NOT approve an entity-position edge", async () => {
    // ADR-0037 §6(d): an entity edge's evidence is a warehouse row, and the
    // brain's grant grammar has no arm for warehouse RLS — so the entitlement
    // is the owner/admin one, the only one the brain has. The content differs in
    // kind too: `project atlas → nova` IS the confidential bit.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    expect(await approveAs(id, member())).toMatchObject({
      kind: "refused",
      refusal: "not-entitled",
    });
    expect(await storedEdges()).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
  });

  it("an owner MAY approve the same entity-position edge (the control)", async () => {
    const id = await queue(warehouseEdge("project atlas", "nova"));
    expect(await approveAs(id, owner())).toEqual({ kind: "approved", id });
  });

  it("a member MAY approve a predicate-position edge — the postures do not collapse", async () => {
    // The half that a "just require owner/admin everywhere" simplification
    // deletes. A predicate alias is proposed from evidence inside the brain's
    // own ACL'd corpus and its content is a verb phrase that discloses nothing
    // an approver could not guess, so its bar is genuinely lower. Collapsing the
    // two is what ADR-0037 §6(d) withdraws T5's claim in order to prevent.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(await approveAs(id, member())).toEqual({ kind: "approved", id });
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");
  });

  it("an unresolved reader identity may approve nothing, at either position", async () => {
    // Fail-closed: an unresolvable identity is an upstream defect, and this is a
    // write that re-keys a corpus. Both positions, because the entity bar alone
    // would leave the predicate arm admitting it.
    const entity = await queue(warehouseEdge("project atlas", "nova"));
    const predicate = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));

    expect(await approveAs(entity, unresolved())).toMatchObject({
      kind: "refused",
      refusal: "not-entitled",
    });
    expect(await approveAs(predicate, unresolved())).toMatchObject({
      kind: "refused",
      refusal: "not-entitled",
    });
    expect(await storedEdges()).toEqual([]);
  });

  it("an approver from another workspace is refused before the row is read", async () => {
    const id = await queue(warehouseEdge("project atlas", "nova"));
    expect(await approveAs(id, owner(OTHER_WS))).toMatchObject({
      kind: "refused",
      refusal: "workspace-mismatch",
    });
    expect(await statusOf(id)).toBe("pending");
    expect(await storedEdges()).toEqual([]);
  });

  // ── 7. claim → apply → stamp, and the rollback ──────────────────────────

  it("a vocabulary refusal rolls the claim back and leaves the row PENDING", async () => {
    // The arm that must not be simplified into a plain `return`. The claim is
    // already written when the apply refuses, so returning would COMMIT
    // `applying` — a row invisible to the queue and undecidable forever.
    const first = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    await approveAs(first, owner());

    // A second parent for the same norm: `approveAliasEdge` refuses
    // `already-aliased`, which reaches the caller THROUGH the rollback.
    const second = await queue(proposal({ fromNorm: "is priced at", toNorm: "list price" }));
    expect(await approveAs(second, owner())).toMatchObject({
      kind: "refused",
      refusal: "already-aliased",
    });

    expect(await statusOf(second)).toBe("pending");
    // …and the first decision is untouched.
    expect(await storedEdges()).toEqual([
      { slot_position: "predicate", from_norm: "is priced at", to_norm: "priced at" },
    ]);
  });

  it("no row is ever left in `applying`", async () => {
    // `applying` is unobservable by construction today — claim, apply and stamp
    // share one transaction — and this is what pins that rather than assuming
    // it. It is also the assertion that starts failing the day #5024 moves the
    // re-key out of the transaction, which is when the compensation machinery
    // `decide.ts` carries becomes load-bearing here too.
    const ok = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    await approveAs(ok, owner());
    const refused = await queue(proposal({ fromNorm: "is priced at", toNorm: "list price" }));
    await approveAs(refused, owner());
    const rejected = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
    await rejectAs(rejected, owner());

    const statuses = (await proposalRows()).map((r) => r.status).toSorted();
    expect(statuses).toEqual(["approved", "pending", "rejected"]);
  });

  it("a cycle-closing approval is refused and rolled back", async () => {
    // The other vocabulary refusal reachable through the seam, and the one the
    // primary key does NOT also catch — so it proves the throw-through-rollback
    // path is not specific to `already-aliased`.
    //
    // THREE nodes, not two, and that is forced rather than stylistic: the
    // two-node cycle `a → b` then `b → a` is the SAME unordered pair, so the
    // queue converges the second proposal onto the first row and the decide seam
    // is never reached. A cycle test that never gets past propose would be
    // vacuous — which the first cut of this test was, and the queue caught.
    const first = await queue(proposal({ fromNorm: "emea", toNorm: "europe", position: "subject" }));
    await approveAs(first, owner());
    const second = await queue(
      proposal({ fromNorm: "europe", toNorm: "region", position: "subject" }),
    );
    await approveAs(second, owner());

    const closing = await queue(
      proposal({ fromNorm: "region", toNorm: "emea", position: "subject" }),
    );
    expect(await approveAs(closing, owner())).toMatchObject({
      kind: "refused",
      refusal: "would-cycle",
    });
    expect(await storedEdges()).toHaveLength(2);
    expect(await statusOf(closing)).toBe("pending");
    expect((await loadClaimVocabulary(pool, WS)).subject("emea")).toBe("region");
  });

  it("the two-node reverse never reaches the decide seam at all", async () => {
    // The property that forced the three-node shape above, asserted on its own
    // rather than left as a comment: `a → b` and `b → a` are one pair, so an
    // approved edge makes its own reverse un-proposable. That is the unordered
    // identity doing the cycle refusal's job one layer earlier.
    const id = await queue(proposal({ fromNorm: "owned by", toNorm: "owner" }));
    await approveAs(id, owner());
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "owner", toNorm: "owned by" }), {}),
    ).toEqual({ kind: "already_approved", id });
    expect(await proposalRows()).toHaveLength(1);
  });

  // ── 8. Queue hygiene ────────────────────────────────────────────────────

  it("a duplicate proposal converges on the pending row rather than queuing twice", async () => {
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "is priced at", toNorm: "priced at" }), {}),
    ).toEqual({ kind: "already_pending", id });
    expect(await proposalRows()).toHaveLength(1);
  });

  it("dedup is by NORM, so a display-cased re-proposal converges too", async () => {
    // The queue stores norms for `approveAliasEdge`'s reason, and one layer
    // earlier for its own: a non-normed row would dedup against nothing, so a
    // producer emitting display forms would queue a duplicate per casing.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "Is  Priced-At", toNorm: "Priced At" }), {}),
    ).toEqual({ kind: "already_pending", id });
  });

  it("one workspace's decision never governs another's", async () => {
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    await rejectAs(id, owner());

    const other = await proposeAliasEdge(
      OTHER_WS,
      proposal({ fromNorm: "is priced at", toNorm: "priced at" }),
      {},
    );
    expect(other.kind).toBe("queued");
    await pool.query("DELETE FROM brain_vocabulary_proposal WHERE workspace_id = $1", [OTHER_WS]);
  });

  it("refuses a degenerate norm, a self-edge, and an out-of-range confidence", async () => {
    // Three malformed shapes, refused before the queue. Each is paired by the
    // control immediately below rather than by an arm of this body — a refusal
    // that fired on everything would satisfy all three at once.
    expect(await proposeAliasEdge(WS, proposal({ fromNorm: "___", toNorm: "price" }), {})).toMatchObject(
      { kind: "refused", refusal: "degenerate-norm" },
    );
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "Priced At", toNorm: "priced  at" }), {}),
    ).toMatchObject({ kind: "refused", refusal: "self-edge" });
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "a", toNorm: "b", confidence: 1.5 }), {}),
    ).toMatchObject({ kind: "refused", refusal: "confidence-out-of-range" });
    expect(await proposalRows()).toHaveLength(0);
  });

  it("a NaN confidence is refused rather than compared", async () => {
    // Every NaN comparison is false, so a threshold written `confidence <
    // threshold` would read "clears the bar" for exactly the value that means
    // "this could not be read". Refused at the door, and the eligibility gate
    // spells `!(x >= t)` behind it — belt and braces at the one comparison that
    // decides whether a human ever sees the edge.
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "a", toNorm: "b", confidence: Number.NaN }), {}),
    ).toMatchObject({ kind: "refused", refusal: "confidence-out-of-range" });
  });

  it("a well-formed proposal at the same shapes is accepted (the control)", async () => {
    expect(
      (await proposeAliasEdge(WS, proposal({ fromNorm: "a", toNorm: "b", confidence: 0 }), {})).kind,
    ).toBe("queued");
    expect(
      (await proposeAliasEdge(WS, proposal({ fromNorm: "c", toNorm: "d", confidence: 1 }), {})).kind,
    ).toBe("queued");
  });

  // ── 9. Lock order — asserted structurally ───────────────────────────────

  describe("the vocabulary lock is taken before any row is touched", () => {
    /**
     * Record every statement a transaction issues, in order.
     *
     * The property under test is an ORDERING, and the failure it prevents is a
     * deadlock (40P01) against the region importer — which takes the same lock
     * before its own insert loop. No single-process test can provoke that
     * deadlock reliably, and `migrate-roundtrip-pg.test.ts` already carries the
     * importer's half. So this asserts the order directly: it is the only shape
     * that kills "lock after the read" without depending on two concurrent
     * transactions racing the way the test hopes.
     */
    function recordingRunner(): { runner: ReconcileTransactionRunner; statements: string[] } {
      const statements: string[] = [];
      const runner: ReconcileTransactionRunner = (fn) =>
        withBrainTransaction((tx) =>
          fn({
            query: (sql: string, params?: unknown[]) => {
              statements.push(sql.trim().split("\n")[0]!.trim());
              return tx.query(sql, params);
            },
          } satisfies VocabularyExecutor),
        );
      return { runner, statements };
    }

    it("propose locks first", async () => {
      const { runner, statements } = recordingRunner();
      const deps: AliasDecideDeps = { withTransaction: runner };
      const outcome = await proposeAliasEdge(
        WS,
        proposal({ fromNorm: "is priced at", toNorm: "priced at" }),
        deps,
      );
      // Non-vacuous: the recorder must have wrapped a call that really ran.
      expect(outcome.kind).toBe("queued");
      expect(statements[0]).toContain("pg_advisory_xact_lock");
    });

    it("decide locks first", async () => {
      const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
      const { runner, statements } = recordingRunner();
      const outcome = await approveAs(id, owner());
      void outcome;
      // Re-run through the recorder on a fresh proposal — the approval above
      // consumed this one, so the recorded pass is its own decision rather than
      // a replay.
      const second = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
      const decided = await decideAliasProposal(
        {
          id: second,
          workspaceId: WS,
          decision: "approved",
          approver: { kind: "human", ctx: owner() },
        },
        { withTransaction: runner },
      );
      expect(decided).toEqual({ kind: "approved", id: second });
      expect(statements[0]).toContain("pg_advisory_xact_lock");
      // …and the very next statement is the proposal READ, so "locks first" is
      // an ordering claim rather than "a lock appears somewhere".
      expect(statements[1]).toContain("SELECT");
    });
  });

  // ── 10. The source-class vocabulary is closed ───────────────────────────

  it("every declared source class is accepted by the propose path", async () => {
    // The enum and the CHECK constraint are two lists that must stay one. A
    // class added to the TypeScript union and not to migration 0190 would fail
    // here with a constraint violation rather than in production.
    const classes: readonly AliasSourceClass[] = ["warehouse_key", "extractor", "seam", "human"];
    for (const [i, sourceClass] of classes.entries()) {
      const outcome = await proposeAliasEdge(
        WS,
        {
          position: "subject",
          fromNorm: `left ${i}`,
          toNorm: `right ${i}`,
          directed: true,
          sourceClass,
          confidence: 1,
          proposedBy: PRODUCER,
        },
        {},
      );
      expect(outcome.kind, `source class ${sourceClass} was not accepted`).toBe("queued");
    }
  });
});
