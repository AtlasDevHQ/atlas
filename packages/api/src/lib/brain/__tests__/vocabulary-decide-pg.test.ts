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
 * | rejection-memory identity made ORDERED | 2 |
 * | the `rejected` arm reports `already_pending` instead of refusing | 4 |
 * | removal stops writing `rejected` (edge dropped, row left `approved`) | 6 |
 * | `removeAliasEdge` dropped from the reject arm | 4 |
 * | the removal's did-nothing THROW downgraded to a silent stamp | 1 |
 * | the pending-dedup arm dropped | 3 |
 * | `autoApproveEligible`'s entity-position conjunct dropped | 1 |
 * | `autoApproveEligible`'s source-class conjunct dropped | 3 |
 * | `autoApproveEligible`'s threshold conjunct dropped | 4 |
 * | the threshold's 0–1 range guard dropped | 1 |
 * | the knob read platform-wide (`workspaceId` dropped from both reads) | 1 |
 * | the `warehouse_key`-at-predicate refusal dropped | 1 |
 * | the auto arm's re-check at decide time dropped | 1 |
 * | `direction-required` dropped | 1 |
 * | `direction-not-in-pair` dropped | 2 |
 * | `direction-conflict` dropped | 1 |
 * | `lexicalNorm` dropped from the supplied direction | 1 |
 * | the approval STAMPS the proposed direction instead of the resolved one | 1 |
 * | the EDGE is written in the proposed direction instead of the resolved one | 2 |
 * | `approverEntitled`'s entity-position owner/admin bar dropped | 3 |
 * | `approverEntitled` made owner/admin at EVERY position | 2 |
 * | the `unresolved`-origin arm admitted | 1 |
 * | the `unauthenticated-local` arm dropped (the local operator locked out) | 1 |
 * | the workspace-mismatch guard dropped | 2 |
 * | the machine-may-not-reject backstop dropped | 1 |
 * | the local operator recorded as a machine | 1 |
 * | the human approver never recorded (`approved_by`/`reviewed_by` always NULL) | 4 |
 * | the apply refusal RETURNED instead of thrown | 4 |
 * | the catch broadened — every error becomes a refusal | 3 |
 * | the claim's `status = 'pending'` predicate dropped | 1 |
 * | the `applying`-not-rejectable arm dropped | 2 |
 * | the vocabulary lock taken AFTER the proposal read | 1 |
 * | the lock taken in the WRONG namespace | 2 |
 * | the lock keyed on a CONSTANT instead of the workspace | 2 |
 * | `slot_position` asserted instead of narrowed | 1 |
 * | the eligible-but-refused row stops counting as `queued` | 1 |
 * | `deduped` and `refused` swapped | 1 |
 * | the ingest path reverts to `identityVocabulary` | 3 |
 * | the correctFact TOOL reverts to `identityVocabulary` | 2 |
 * | the admin route reverts to `identityVocabulary` | 2 |
 * | the pair lookup loses its `slot_position` arm | 1 |
 * | `approverEntitled` narrowed to owner only (admins locked out) | 1 |
 * | `resolveDirection`'s same-norm conjunct dropped | 1 |
 * | the ingest load DEGRADED to the empty vocabulary on failure | 2 |
 * | the correctFact TOOL hands over an inline identity vocabulary | 2 |
 * | the admin route hands over an inline identity vocabulary | 2 |
 * | `recordedApprover` collapses every human onto the local-operator sentinel | 3 |
 * | the machine-may-not-reject refusal downgraded to `not-entitled` | 1 |
 * | the entitlement bar scoped to the APPROVE verb only | 1 |
 * | the workspace-mismatch guard scoped to the APPROVE verb only | 1 |
 *
 * 51 mutations, 51 caught, zero survivors. TWELVE rows, in five groups, need
 * reading with care rather than at face value:
 *
 * **The ordered-identity row** is NOT caught by the headline producer test:
 * that one re-emits the pair in the same order it was removed in, so an ordered
 * identity still suppresses it and the test passes. The reverse-direction case
 * is the only thing separating them, which is why it exists as its own `test()`
 * instead of an extra assertion.
 *
 * **The entity-position conjunct** is DEAD CODE under the shipped knob — the
 * only eligible source class is `warehouse_key`, and that is refused at the
 * predicate position before eligibility is consulted. The one test that kills
 * it widens the knob AND carries confidence 1; at this suite's default 0.8 the
 * threshold conjunct refuses first and the mutation survives, which is what the
 * first cut of that test did.
 *
 * **The three lock rows** are caught STRUCTURALLY, by recording each
 * transaction's first statement AND ITS PARAMS. The text alone could not tell a
 * correctly-keyed lock from one in the wrong namespace or on a constant key —
 * which is the failure that matters, since a wrong namespace stops the seam
 * being mutually exclusive with `approveAliasEdge` and the region importer. The
 * ordering row is separate again, and structural for a different reason: what
 * it guards is an invariant, not a deadlock a single-process test can provoke.
 *
 * **`slot_position` asserted instead of narrowed** is reachable only by
 * DROPPING 0190's CHECK, which its test does — the same move
 * `vocabulary-pg.test.ts` makes to write a cyclic pair the primitives refuse
 * to. Simulating a row written outside this seam is the point: the mutation's
 * failure direction is permissive (an unknown position takes the PREDICATE
 * entitlement bar), so leaving it unreachable-and-untested would have left an
 * entitlement bypass behind a constraint nobody re-checks.
 *
 * **The six `identityVocabulary` rows are the PR's other half** — the four call
 * sites that used to name it, plus the two ways to revert one (a reverted
 * import, and an inline identity vocabulary at the call site). Named by their
 * content rather than by position, because they are not contiguous in the table
 * and an earlier version of this line said "the last six rows", which points at
 * a different set. Before these
 * landed, reverting ANY of them left every suite in this repo green: every
 * fixture workspace had an empty vocabulary, so the loaded answer and the empty
 * one were byte-identical and no assertion could tell them apart. The ingest
 * revert and its degrade-on-failure twin are caught behaviourally; the two
 * `correctFact` sites are caught by asserting the vocabulary the caller
 * actually handed over, which is why the inline-identity mutation dies too — a
 * source-level import tripwire alone would not have caught it, and the suite
 * keeps one anyway as the cheap backstop for a fifth site.
 *
 * NOT in the table, deliberately — two spellings whose mutations kill NOTHING
 * and cannot, listed so a later reader does not mistake the silence for an
 * oversight:
 *
 *   - the eligibility threshold `!(confidence >= t)` vs `confidence < t`. The
 *     two differ only on NaN, which propose refuses outright and the stored
 *     column cannot hold (Postgres orders NaN above every value, so 0190's
 *     `confidence <= 1` CHECK rejects it — and unlike the position CHECK,
 *     dropping this one does not make the value storable).
 *   - a threshold above 1, and an unparseable one. `confidence` is bounded at 1,
 *     so "disabled" and "compares against an impossible bar" are
 *     observationally identical; only the `-1` case can kill the range guard,
 *     and it has its own `test()` for that reason.
 *
 * Both are defensive style, not tested properties. A row claiming otherwise
 * would be a fabricated measurement.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
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
  runBrainExtractionCycle,
  type FactExtractor,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";
import {
  ALIAS_SOURCE_CLASSES,
  decideAliasProposal,
  proposeAliasEdge,
  proposeAliasEdges,
  REKEY_DRIFTED_FACTS_SQL,
  type AliasDecideDeps,
  type AliasProposalInput,
} from "@atlas/api/lib/brain/vocabulary-decide";
import { VOCABULARY_LOCK_NAMESPACE } from "@atlas/api/lib/brain/vocabulary";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  IDENTITY_MUTATION_LOCK_NAMESPACE,
  SLOT_POSITIONS,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";

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
    // Also here, not only in `afterEach`: otherwise the FIRST test in the file
    // runs under whatever the ambient environment holds, and a developer with
    // either knob exported would see a different suite than CI does.
    delete process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD;
    delete process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES;
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
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
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

  });

  it("the approved row RECORDS the direction the approval set", async () => {
    // Split from the edge assertion above rather than bundled with it: the two
    // are separate mutations (the edge written in the proposed direction, and
    // the row stamped with it), and in one body the first failure hides the
    // second. The row also keeps its pair identity across the swap — one row,
    // not two — which is what makes a re-proposal converge rather than queue.
    const id = await queue(
      proposal({ fromNorm: "priced at", toNorm: "is priced at", directed: false }),
    );
    await approveAs(id, owner(), { fromNorm: "is priced at", toNorm: "priced at" });

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

  it("refuses a direction whose two sides are the same norm", async () => {
    // Backstopped by `approveAliasEdge`'s own `self-edge` refusal, so the only
    // thing this conjunct changes is WHICH refusal the caller gets — and a
    // `self-edge` on a transaction that also rolled back a claim sends the
    // operator to the wrong repair. Defence in depth, worth one test.
    const id = await queue(
      proposal({ fromNorm: "priced at", toNorm: "is priced at", directed: false }),
    );
    expect(
      await approveAs(id, owner(), { fromNorm: "priced at", toNorm: "Priced  At" }),
    ).toMatchObject({ kind: "refused", refusal: "direction-not-in-pair" });
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
    // T11 §3(d) (#5016): an entity edge's evidence is a warehouse row, and the
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

  it("an ADMIN may approve an entity-position edge too", async () => {
    // ADR-0037 §6 says "the owner/admin entitlement" and this suite had only an
    // `owner` fixture — so narrowing the bar to `owner` alone, which would lock
    // every admin out of entity approval on every deployment, shipped green.
    const admin: BrainPrincipalContext = {
      origin: "authenticated",
      workspaceId: WS,
      userId: "user-admin",
      role: "admin",
      audienceIds: [],
    };
    const id = await queue(warehouseEdge("project atlas", "nova"));
    expect(await approveAs(id, admin)).toEqual({ kind: "approved", id });
  });

  it("the entity bar holds at the OBJECT position, not just at subject", async () => {
    // Every other entitlement assertion here uses `subject`. `isEntityPosition`
    // losing its `object` arm is caught on the ELIGIBILITY side, but nothing
    // pinned it on the ENTITLEMENT side — so a repair to that one propose test
    // would have reopened "a member may approve an object-position entity edge"
    // with nothing watching.
    const id = await queue({ ...warehouseEdge("nova", "project nova"), position: "object" });
    expect(await approveAs(id, member())).toMatchObject({
      kind: "refused",
      refusal: "not-entitled",
    });
    expect(await storedEdges()).toEqual([]);
  });

  it("a member MAY approve a predicate-position edge — the postures do not collapse", async () => {
    // The half that a "just require owner/admin everywhere" simplification
    // deletes. A predicate alias is proposed from evidence inside the brain's
    // own ACL'd corpus and its content is a verb phrase that discloses nothing
    // an approver could not guess, so its bar is genuinely lower. Collapsing the
    // two is what T11 §3(d) (#5016) withdraws T5's claim in order to prevent.
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

  it("one POSITION's decision never governs another's", async () => {
    // The third dimension of 0190's unique index — `(workspace_id,
    // slot_position, pair_low, pair_high)` — and the only one nothing pinned:
    // the workspace arm has its own test below and the unordered-pair arm has
    // three. Dropping `slot_position` from the lookup is silent and permissive
    // in the wrong direction: a rejection at `predicate` would suppress the same
    // pair at `subject` and `object` forever, and the lookup returns BEFORE the
    // (correctly scoped) unique index, so the constraint cannot backstop it.
    const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
    await rejectAs(id, owner());

    const elsewhere = await proposeAliasEdge(
      WS,
      proposal({ fromNorm: "led by", toNorm: "leads", position: "subject" }),
      {},
    );
    expect(elsewhere.kind).toBe("queued");
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

  // Three malformed shapes, each in its OWN test() — the file's own rule, and
  // the first cut of this section broke it: bundled into one body, a broken
  // `degenerate-norm` arm hid whether the other two ran at all.

  it("refuses a degenerate norm", async () => {
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "___", toNorm: "price" }), {}),
    ).toMatchObject({ kind: "refused", refusal: "degenerate-norm" });
    expect(await proposalRows()).toHaveLength(0);
  });

  it("refuses a self-edge across two spellings that norm together", async () => {
    // Both sides spelled off normal form, so a one-sided normalization cannot
    // reach the same conclusion by accident.
    expect(
      await proposeAliasEdge(WS, proposal({ fromNorm: "Priced At", toNorm: "priced  at" }), {}),
    ).toMatchObject({ kind: "refused", refusal: "self-edge" });
    expect(await proposalRows()).toHaveLength(0);
  });

  it("refuses a confidence outside 0–1", async () => {
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
    function recordingRunner(): {
      runner: ReconcileTransactionRunner;
      statements: { sql: string; params: unknown[] }[];
    } {
      const statements: { sql: string; params: unknown[] }[] = [];
      const runner: ReconcileTransactionRunner = (fn) =>
        withBrainTransaction((tx) =>
          fn({
            query: (sql: string, params?: unknown[]) => {
              // PARAMS too, not only the statement text. Recording the SQL alone
              // was the first cut and it could not tell a correctly-keyed lock
              // from one taken in the wrong NAMESPACE or on a constant key —
              // and a wrong namespace is precisely the failure this test exists
              // to prevent, because it stops being mutually exclusive with
              // `approveAliasEdge` and the region importer.
              statements.push({ sql: sql.trim().split("\n")[0]!.trim(), params: params ?? [] });
              return tx.query(sql, params);
            },
          } satisfies VocabularyExecutor),
        );
      return { runner, statements };
    }

    const expectLockedFirst = (statements: { sql: string; params: unknown[] }[]) => {
      expect(statements[0]?.sql).toContain("pg_advisory_xact_lock");
      expect(statements[0]?.params).toEqual([VOCABULARY_LOCK_NAMESPACE, WS]);
    };

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
      expectLockedFirst(statements);
    });

    it("decide locks first", async () => {
      const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
      const { runner, statements } = recordingRunner();
      const decided = await decideAliasProposal(
        {
          id,
          workspaceId: WS,
          decision: "approved",
          approver: { kind: "human", ctx: owner() },
        },
        { withTransaction: runner },
      );
      expect(decided).toEqual({ kind: "approved", id });
      expectLockedFirst(statements);
      // TWO locks since #5024, in the fixed order 5022 → 5024, and only then the
      // proposal READ. "Locks first" is an ordering claim rather than "a lock
      // appears somewhere", and the ORDER between the two is the part a
      // redundancy argument gets wrong — #5022's review produced a real 40P01
      // from exactly that reasoning.
      //
      // Asserted directly rather than provoked, for the reason the recorder's
      // own header gives: no single-process test can reliably race two
      // transactions into a cycle, and one that cannot form a cycle passes
      // against a broken implementation. Stated plainly because it is a real
      // limit — nothing here would notice if publish stopped taking 5024
      // altogether; `vocabulary-rekey-pg.test.ts` carries that half.
      expect(statements[1]?.sql).toContain("pg_advisory_xact_lock");
      expect(statements[1]?.params).toEqual([IDENTITY_MUTATION_LOCK_NAMESPACE, WS]);
      expect(statements[2]?.sql).toContain("SELECT");
    });

    it("the two lock namespaces are distinct — one lock taken twice is not two locks", async () => {
      // Without this, `lockIdentityMutation` taking 5022 twice satisfies every
      // positional assertion above while serializing nothing new.
      expect(IDENTITY_MUTATION_LOCK_NAMESPACE).not.toBe(VOCABULARY_LOCK_NAMESPACE);
    });

    it("propose takes the vocabulary lock ONLY — it writes no brain_facts row", async () => {
      // The identity lock serializes against PUBLISH, and propose has nothing to
      // serialize: it queues a row and never re-keys. Taking it here would wedge
      // every publish in the workspace behind a producer's batch loop, which is
      // the cost `brain-facts.ts` refuses at length ("Refuse the row, never the
      // workspace").
      const { runner, statements } = recordingRunner();
      const outcome = await proposeAliasEdge(
        WS,
        proposal({ fromNorm: "owned by", toNorm: "owns" }),
        { withTransaction: runner },
      );
      expect(outcome.kind).toBe("queued");
      const locks = statements.filter((s) => s.sql.includes("pg_advisory_xact_lock"));
      expect(locks).toHaveLength(1);
      expect(locks[0]?.params).toEqual([VOCABULARY_LOCK_NAMESPACE, WS]);
    });
  });

  // ── 10. The knob's range guard, and that it is workspace-scoped ─────────

  it("an out-of-range threshold DISABLES rather than defaulting to the shipped one", async () => {
    // A garbled knob must never be more permissive than the operator who
    // garbled it intended. `-1` is the dangerous direction: without the range
    // guard it clears every confidence, so every warehouse-derived entity edge
    // in the workspace auto-approves on a typo.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "-1";
    expect(
      await proposeAliasEdge(WS, { ...warehouseEdge("project atlas", "nova"), confidence: 0 }, {}),
    ).toMatchObject({ kind: "queued", autoApprove: false });
  });

  it("a threshold above 1, and an unparseable one, also queue", async () => {
    // Deliberately ONE test for both, and deliberately not credited with
    // killing the range guard — because neither can. `confidence` is bounded at
    // 1 by 0190's CHECK, so a threshold of `2` is unreachable whether the guard
    // rejects it or not; and an unparseable value yields NaN, against which
    // `!(confidence >= NaN)` is already false. "Disabled" and "compares against
    // an impossible bar" are observationally identical here.
    //
    // Kept because the OUTCOME is still the contract a caller depends on, and
    // separated from the `-1` case above so the mutation table does not credit
    // this one with a kill it cannot make.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "2";
    expect(await proposeAliasEdge(WS, warehouseEdge("project atlas", "nova"), {})).toMatchObject({
      kind: "queued",
      autoApprove: false,
    });

    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "yes please";
    expect(await proposeAliasEdge(WS, warehouseEdge("globex inc", "globex"), {})).toMatchObject({
      kind: "queued",
      autoApprove: false,
    });
  });

  it("an in-range threshold at the boundary still approves (the control)", async () => {
    // Without this the three prohibitions above are satisfied by a range guard
    // that rejects everything — including the shipped `1`.
    process.env.ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD = "1";
    expect(await proposeAliasEdge(WS, warehouseEdge("project atlas", "nova"), {})).toMatchObject({
      kind: "queued",
      autoApprove: true,
    });
  });

  it("the knob is read for THIS workspace, not platform-wide", async () => {
    // Both keys are `scope: "workspace"`, and the whole point of that scope is
    // the per-workspace DB override the admin settings page writes (#3392). The
    // env tier this suite otherwise uses is workspace-agnostic, so dropping the
    // `orgId` argument from `getSettingAuto` changes nothing there and survives
    // every other test in this file. A DB override is the only tier that can
    // tell the two apart, so this writes one.
    const { loadSettings } = await import("@atlas/api/lib/settings");
    await pool.query(
      `INSERT INTO settings (key, value, org_id, updated_by) VALUES ($1, $2, $3, 'test')`,
      ["ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES", "extractor", WS],
    );
    await loadSettings();
    // `finally`, because the settings cache is MODULE-level: a failed assertion
    // here would otherwise leave `WS → extractor` cached for every later test in
    // the file and turn one failure into a cascade — the first-failure-hides-
    // the-rest hazard this file's header takes care to avoid elsewhere.
    try {
      // WS resolves through its own override — `warehouse_key` is no longer
      // eligible there…
      expect(await proposeAliasEdge(WS, warehouseEdge("project atlas", "nova"), {})).toMatchObject({
        kind: "queued",
        autoApprove: false,
      });
      // …while a workspace with no override still gets the shipped default.
      // Same process, same call, different workspace: the only thing that can
      // produce both answers is the workspace argument reaching the read.
      expect(
        await proposeAliasEdge(OTHER_WS, warehouseEdge("project atlas", "nova"), {}),
      ).toMatchObject({ kind: "queued", autoApprove: true });
    } finally {
      await pool.query("DELETE FROM settings WHERE org_id = $1", [WS]);
      await loadSettings();
      await pool.query("DELETE FROM brain_vocabulary_proposal WHERE workspace_id = $1", [OTHER_WS]);
    }
  });

  // ── 11. Errors are not decisions ────────────────────────────────────────

  it("a transaction failure PROPAGATES rather than becoming a refusal", async () => {
    // The catch in `decideAliasProposal` owns exactly one class — the vocabulary
    // refusal it throws itself, to reach the ROLLBACK. Everything else is not a
    // decision, and a caller has to be able to tell "this workspace's vocabulary
    // is corrupt" and "the database is unreachable" from "the reviewer may not
    // do that". Broadening the catch is a one-word edit and nothing else here
    // would notice it.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    const boom = new Error("connection terminated unexpectedly");
    await expect(
      decideAliasProposal(
        {
          id,
          workspaceId: WS,
          decision: "approved",
          approver: { kind: "human", ctx: owner() },
        },
        {
          withTransaction: () => {
            throw boom;
          },
        },
      ),
    ).rejects.toThrow("connection terminated unexpectedly");
    expect(await statusOf(id)).toBe("pending");
  });

  it("a removal that removes nothing THROWS rather than stamping a rejection", async () => {
    // The proposal says `approved` and the edge is gone — a vocabulary written
    // outside this seam (a hand-written DELETE, a restore). Stamping `rejected`
    // would tell the operator a removal ran when none did, and would ALSO burn
    // the pair's only slot into rejection memory on the strength of it.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());
    await pool.query("DELETE FROM brain_vocabulary_target WHERE workspace_id = $1", [WS]);
    await pool.query("DELETE FROM brain_vocabulary_edge WHERE workspace_id = $1", [WS]);

    await expect(rejectAs(id, owner())).rejects.toThrow(/no approved edge/);
    // Rolled back: still approved, so an operator can repair the store and
    // retry rather than finding the pair permanently rejected.
    expect(await statusOf(id)).toBe("approved");
  });

  // ── 12. Attribution — who did it, at every column an audit reads ────────

  it("records the human approver on the edge and on the proposal", async () => {
    // Migration 0189 calls `approved_by` "the one column an audit of a
    // workspace-wide re-key reads first". The auto path's NULL is asserted
    // above; this is the half that says a HUMAN re-key does not read as a
    // machine one.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());

    const { rows } = await pool.query<{ approved_by: string | null }>(
      "SELECT approved_by FROM brain_vocabulary_edge WHERE workspace_id = $1",
      [WS],
    );
    expect(rows).toEqual([{ approved_by: "user-owner" }]);
    expect((await proposalRows())[0]?.reviewed_by).toBe("user-owner");
  });

  it("records the remover on a removal", async () => {
    // A removal with no recorded remover is the same audit hole one verb later,
    // and `rejectProposal` writes `reviewed_by` on its own statement.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());
    await rejectAs(id, owner());
    expect((await proposalRows())[0]?.reviewed_by).toBe("user-owner");
  });

  it("the local operator is recorded as a human, not as a machine", async () => {
    // On a self-hosted no-auth deployment `unauthenticated-local` is the ONLY
    // origin, and its `userId` is null — so `ctx.userId` alone would write
    // `approved_by = NULL`, which 0189 defines as "auto-approved, no human".
    // Every human re-key on every such deployment would be indistinguishable
    // from a machine one, permanently. `correction.ts` already carries this
    // sentinel; this is the same decision at the same kind of column.
    const local: BrainPrincipalContext = {
      origin: "unauthenticated-local",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    const id = await queue(warehouseEdge("project atlas", "nova"));
    expect(await approveAs(id, local)).toEqual({ kind: "approved", id });

    const { rows } = await pool.query<{ approved_by: string | null }>(
      "SELECT approved_by FROM brain_vocabulary_edge WHERE workspace_id = $1",
      [WS],
    );
    expect(rows).toEqual([{ approved_by: "local-operator" }]);
  });

  // ── 13. A machine may approve and must never reject ─────────────────────

  it("the auto approver may not REJECT — on an approved row that is a removal", async () => {
    // The inversion this seam exists to prevent: a machine undoing a human
    // decision and, through rejection memory, making it unrepeatable. The type
    // forbids it; this proves the runtime does too, because #5025's route will
    // build a request out of a parsed HTTP body where the compiler is not in
    // the room.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());

    const decided = await decideAliasProposal(
      // The cast is the point of the test — it stands in for the untyped
      // request a route would hand in.
      {
        id,
        workspaceId: WS,
        decision: "rejected",
        approver: { kind: "auto", producer: PRODUCER },
      } as unknown as Parameters<typeof decideAliasProposal>[0],
    );
    // Its OWN refusal, not a second meaning for `not-entitled`: #5025's route
    // has to tell "wrong role" (a 403 a different user could satisfy) from "no
    // actor of this class may ever do this".
    expect(decided).toMatchObject({ kind: "refused", refusal: "machine-may-not-reject" });
    expect(await statusOf(id)).toBe("approved");
    expect(await storedEdges()).toHaveLength(1);
  });

  it("a member may NOT reject an owner-approved entity edge", async () => {
    // The graver verb, and the one nothing pinned: every other `rejectAs` in
    // this file passes `owner()`, so scoping either authority guard to
    // `decision === "approved"` — a one-token edit, and the natural shape of a
    // refactor that hoists the reject dispatch above the preamble — shipped
    // green.
    //
    // What it lets through is worse than the approval case the seam spends two
    // blocks arguing about: a member drops an edge an owner approved,
    // recomputes the workspace closure, and burns the pair's only slot into
    // PERMANENT rejection memory, and the outcome reads as a success.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());

    expect(await rejectAs(id, member())).toMatchObject({
      kind: "refused",
      refusal: "not-entitled",
    });
    // The decision the member could not undo is intact, in both relations.
    expect(await statusOf(id)).toBe("approved");
    expect(await storedEdges()).toHaveLength(1);
  });

  it("an approver from another workspace may not reject either", async () => {
    // The workspace guard's twin, on the same verb. The proposal is loaded from
    // the REQUEST's workspace, so a foreign owner's `ctx` never has to match
    // unless the guard makes it — and this is a cross-tenant destructive write.
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());

    expect(await rejectAs(id, owner(OTHER_WS))).toMatchObject({
      kind: "refused",
      refusal: "workspace-mismatch",
    });
    expect(await statusOf(id)).toBe("approved");
    expect(await storedEdges()).toHaveLength(1);
  });

  it("a HUMAN may reject the same row (the control)", async () => {
    const id = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(id, owner());
    expect(await rejectAs(id, owner())).toMatchObject({ kind: "rejected", removedEdge: true });
  });

  // ── 14. Producer counters ───────────────────────────────────────────────

  it("counts a queued proposal, a dedup, and a malformed refusal separately", async () => {
    // Three counters nothing else asserts. Swapping any pair of increments is a
    // one-token edit that every other test in this file survives, and the
    // counters are the producer's only report of what a run did.
    const first = await runProducer([
      proposal({ fromNorm: "is priced at", toNorm: "priced at" }),
      proposal({ fromNorm: "___", toNorm: "price" }),
    ]);
    expect(first).toMatchObject({ queued: 1, refused: 1, deduped: 0 });

    const second = await runProducer([proposal({ fromNorm: "is priced at", toNorm: "priced at" })]);
    expect(second).toMatchObject({ deduped: 1, queued: 0, refused: 0 });
  });

  it("an eligible proposal the vocabulary refuses counts as BOTH queued and refused", async () => {
    // It really is queued — a human can still decide it — so a `queued` that
    // excluded it would stop meaning "rows awaiting review". And `refused` is
    // what says the auto-approval was attempted and did not land, which is the
    // signal that a producer is emitting edges contradicting the store.
    const held = await queue(warehouseEdge("project atlas", "nova"));
    await approveAs(held, owner());

    // A second parent for `project atlas` — `approveAliasEdge` refuses
    // `already-aliased`, so the auto-approval cannot land.
    const counters = await runProducer([warehouseEdge("project atlas", "nova corp")]);
    expect(counters).toMatchObject({ queued: 1, refused: 1, autoApproved: 0 });
    const stillPending = (await proposalRows()).filter((r) => r.status === "pending");
    expect(stillPending).toHaveLength(1);
  });

  // ── 15. The decide path re-norms the direction it is handed ─────────────

  it("re-norms a supplied direction, so a display form still approves", async () => {
    // #5025's UI renders the canonical DISPLAY form and will send it back. Every
    // other direction in this file is already normed, so dropping `lexicalNorm`
    // from `resolveDirection` changes nothing in them — and the failure it lets
    // through is every human approval refusing `direction-not-in-pair`.
    const id = await queue(
      proposal({ fromNorm: "priced at", toNorm: "is priced at", directed: false }),
    );
    expect(
      await approveAs(id, owner(), { fromNorm: "Is  Priced-At", toNorm: "Priced At" }),
    ).toEqual({ kind: "approved", id });
    expect((await loadClaimVocabulary(pool, WS)).predicate("is priced at")).toBe("priced at");
  });

  // ── 16. An `applying` row is not rejectable ─────────────────────────────

  it("a row mid-decision is not rejectable", async () => {
    // `applying` is unobservable through the seam (claim, apply and stamp share
    // one transaction), so the state is written by hand here — which is the
    // only way to reach the arm at all, and worth having because #5024 is what
    // makes it observable for real.
    const id = await queue(proposal({ fromNorm: "led by", toNorm: "leads" }));
    await pool.query(
      "UPDATE brain_vocabulary_proposal SET status = 'applying', claimed_at = now() WHERE id = $1",
      [id],
    );
    expect(await rejectAs(id, owner())).toEqual({ kind: "not_decidable", id });
    expect(await statusOf(id)).toBe("applying");
  });

  // ── 17. A position the deployment does not know is refused, not decided ─

  it("refuses a proposal whose slot_position is outside the enum", async () => {
    // The CHECK makes this unreachable through this seam, so the constraint is
    // DROPPED for the duration — the same move `vocabulary-pg.test.ts` makes to
    // write a cyclic pair the primitives refuse to. The state being simulated is
    // one the module names out loud: a row written outside this seam, by a
    // hand-written INSERT or a restore onto a deployment whose CHECK is gone.
    //
    // Worth reaching for, because the failure direction is PERMISSIVE:
    // `approverEntitled` answers `isEntityPosition(...) === false` for an
    // unknown position and hands it the PREDICATE bar, so a member would clear
    // the owner/admin gate ADR-0037 §6 puts in front of entity edges. An
    // unreadable authority input has to be refused, not assumed.
    await pool.query(
      "ALTER TABLE brain_vocabulary_proposal DROP CONSTRAINT ck_brain_vocabulary_proposal_slot_position",
    );
    try {
      await pool.query(
        `INSERT INTO brain_vocabulary_proposal
           (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
            confidence, status, proposed_by)
         VALUES ('corrupt-1', $1, 'qualifier', 'a', 'b', TRUE, 'human', 1, 'pending', 'restore')`,
        [WS],
      );

      await expect(approveAs("corrupt-1", member())).rejects.toThrow(/not subject, predicate or object/);
      // Refused before any write, including the claim — the row is exactly as
      // the restore left it.
      expect(await statusOf("corrupt-1")).toBe("pending");
      expect(await storedEdges()).toEqual([]);
    } finally {
      await pool.query("DELETE FROM brain_vocabulary_proposal WHERE id = 'corrupt-1'");
      await pool.query(
        `ALTER TABLE brain_vocabulary_proposal ADD CONSTRAINT ck_brain_vocabulary_proposal_slot_position
           CHECK (slot_position IN ('subject', 'predicate', 'object'))`,
      );
    }
  });

  it("a known position on the same shape decides normally (the control)", async () => {
    // Without this, a `toProposalRow` that threw on every row would satisfy the
    // prohibition above — and nothing would be decidable at all.
    const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
    expect(await approveAs(id, member())).toEqual({ kind: "approved", id });
  });

  // ── 18. The vocabulary is WIRED into ingest ─────────────────────────────

  describe("the approved vocabulary reaches the ingest path", () => {
    const FAKE_MODEL = {
      model: "fake-model" as unknown as ResolvedExtractionModel["model"],
      modelId: "fake-model",
    } satisfies ResolvedExtractionModel;

    async function insertEpisode(sourceId: string): Promise<void> {
      await pool.query(
        `INSERT INTO brain_episodes
           (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', $2, 'U123', 'the widget is priced at nine dollars',
                 '2026-06-21T09:00:00.000Z'::timestamptz, ARRAY['org']::text[])`,
        [WS, sourceId],
      );
    }

    it("two spellings of one predicate land in ONE slot once the alias is approved", async () => {
      // THE test for #5023's other half. `extract.ts` is the ingest path, and
      // until this slice it named `identityVocabulary` — so reverting that one
      // line left every suite green, because every fixture workspace had an
      // empty vocabulary and the two answers were byte-identical.
      //
      // Here they are not: the workspace has an APPROVED alias, so the loaded
      // vocabulary answers `priced at` for both spellings and the identity one
      // answers each with itself. One fact plus a corroboration, or two facts —
      // and nothing but the production default decides which.
      const id = await queue(proposal({ fromNorm: "is priced at", toNorm: "priced at" }));
      await approveAs(id, owner());

      await insertEpisode(`C01:${Date.now()}.a`);
      await insertEpisode(`C01:${Date.now()}.b`);

      let call = 0;
      const extract: FactExtractor = () => {
        call++;
        return Promise.resolve([
          {
            subject: "widget",
            predicate: call === 1 ? "is priced at" : "priced at",
            object: "nine dollars",
          },
        ]);
      };

      const result = await Effect.runPromise(
        // NO `loadVocabulary` dep — the production default is what is under
        // test. Injecting one here would test the seam and not the wiring.
        runBrainExtractionCycle({ extract, resolveModel: async () => FAKE_MODEL }),
      );

      expect(result).toMatchObject({ status: "success", inspected: 2, extracted: 2 });
      expect(result.factsCreated).toBe(1);
      expect(result.factsCorroborated).toBe(1);

      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM brain_facts WHERE workspace_id = $1",
        [WS],
      );
      expect(rows[0]?.n).toBe("1");
    });

    it("a load failure fails the episode rather than degrading to the empty vocabulary", async () => {
      // The failure semantics `extract.ts` spends twenty lines forbidding, with
      // no test until now: wrapping the load in `catch { vocabulary =
      // identityVocabulary }` left every suite green. That fallback keys the
      // whole episode into the slot the vocabulary exists to move it OUT of —
      // an under-match today, an over-match the moment an entry merges two
      // spellings, and neither visible at rest.
      //
      // Injected here, unlike the two tests around it: what is under test is
      // what happens WHEN the load throws, and the production loader cannot be
      // made to throw without corrupting the store.
      await insertEpisode(`C01:${Date.now()}.e`);

      const result = await Effect.runPromise(
        runBrainExtractionCycle({
          extract: () =>
            Promise.resolve([{ subject: "widget", predicate: "priced at", object: "nine" }]),
          resolveModel: async () => FAKE_MODEL,
          loadVocabulary: () =>
            Promise.reject(new Error("vocabulary closure is incomplete for this workspace")),
        }),
      );

      // Inspected, not extracted — and no fact was written under a vocabulary
      // nobody could load.
      expect(result).toMatchObject({ inspected: 1, extracted: 0, factsCreated: 0 });
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM brain_facts WHERE workspace_id = $1",
        [WS],
      );
      expect(rows[0]?.n).toBe("0");
      // UNSTAMPED, which is the half that matters: the episode is still queued,
      // so repairing the closure is enough and there is no backfill to run.
      const stamped = await pool.query<{ extracted_at: Date | null }>(
        "SELECT extracted_at FROM brain_episodes WHERE workspace_id = $1",
        [WS],
      );
      expect(stamped.rows[0]?.extracted_at).toBeNull();
    });

    it("the same two spellings stay TWO facts without the alias (the control)", async () => {
      // The control that makes the test above non-vacuous: if the two predicates
      // corroborated anyway — a stemmer, a looser join — the assertion would say
      // nothing about the vocabulary at all.
      await insertEpisode(`C01:${Date.now()}.c`);
      await insertEpisode(`C01:${Date.now()}.d`);

      let call = 0;
      const extract: FactExtractor = () => {
        call++;
        return Promise.resolve([
          {
            subject: "widget",
            predicate: call === 1 ? "is priced at" : "priced at",
            object: "nine dollars",
          },
        ]);
      };

      const result = await Effect.runPromise(
        runBrainExtractionCycle({ extract, resolveModel: async () => FAKE_MODEL }),
      );
      expect(result.factsCreated).toBe(2);
      expect(result.factsCorroborated).toBe(0);
    });
  });

  // ── 19. No call site has quietly reverted to the empty vocabulary ───────

  it("the allowlisted decide seam writes the identity keys and NO other gated column", () => {
    // ## This assertion REPLACED a stronger one, deliberately (#5024)
    //
    // Until #5024 this test asserted `vocabulary-decide.ts` did not name
    // `brain_facts` in code AT ALL. That was the right gate for the window in
    // which the allowlist entry was a pre-registration, and it could not survive
    // the write it was pre-registering: #5024's drift re-key names the table by
    // construction. Retired on purpose rather than deleted quietly, and narrowed
    // rather than dropped — the cost it guarded is unchanged.
    //
    // The cost: `check-brain-fact-promotion.sh` allowlists a FILE, not a column,
    // so the seam is exempt for `status`, `visible_to` and `valid_to` too —
    // columns it has no business writing. The script records that and the
    // register repeats it, but a recorded cost is a policy, not a gate. THIS is
    // the gate: the seam may name the three identity keys and nothing else.
    //
    // Weaker than its predecessor and stated plainly: absence-of-a-table-name
    // needs no list to stay correct, where this one is only as good as the list
    // below. The list is `check-brain-fact-promotion.sh`'s own gated set, and a
    // new gated column added there without a line here is a real gap — which is
    // why the guard script is READ rather than paraphrased.
    const source = readFileSync(join(import.meta.dir, "..", "vocabulary-decide.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    // Non-vacuous on both sides: the stripper must have left real code behind,
    // AND the re-key must still be in it. Without the second line this test
    // passes loudest at the moment the re-key is deleted.
    expect(code).toContain("brain_vocabulary_proposal");
    expect(code).toContain("UPDATE brain_facts");

    // EXACTLY ONE `UPDATE brain_facts` in the source, and it is the re-key
    // template. The generated statements are asserted below; this half is what
    // catches a SECOND `brain_facts` writer appearing in the file, which the
    // column assertions cannot see because they only ever read the one constant
    // they are handed.
    expect(
      [...code.matchAll(/UPDATE\s+brain_facts\b/g)],
      "vocabulary-decide.ts has more than one `UPDATE brain_facts` statement. The allowlist entry " +
        "in check-brain-fact-promotion.sh argues for ONE — the drift re-key — so a second writer " +
        "needs its own argument, not an inherited one.",
    ).toHaveLength(1);

    // The gated set, read from the guard rather than restated, so a column added
    // there cannot be silently missing here.
    const guard = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "..", "..", "scripts", "check-brain-fact-promotion.sh"),
      "utf8",
    );
    const forbidden = ["status", "visible_to", "pre_widening_visible_to", "valid_to"];
    for (const column of [...SLOT_POSITIONS.map((p) => `${p}_key`), ...forbidden]) {
      expect(guard, `check-brain-fact-promotion.sh no longer gates \`${column}\``).toContain(column);
    }

    // The GENERATED statements, not the source: the template writes `${key}`, so
    // the column names exist only after interpolation and a source-level grep
    // for them would pass while writing anything at all.
    for (const position of SLOT_POSITIONS) {
      const statement = REKEY_DRIFTED_FACTS_SQL[position];
      // Everything between `SET` and the statement's OWN `WHERE`, and neither
      // boundary can be found positionally. The assignment embeds a closure
      // subquery, so `indexOf("WHERE ")` lands inside it (clause cut short — the
      // forbidden check would then pass by truncation rather than by absence)
      // and `lastIndexOf("WHERE ")` lands inside the second copy in the
      // `IS DISTINCT FROM` guard (clause overruns into the WHERE — the scoping
      // is gone). The statement's own `WHERE` is the only one on the `f` alias;
      // the subqueries are all on `t`.
      const setAt = statement.indexOf("SET ");
      const whereAt = statement.indexOf("WHERE f.");
      expect(setAt).toBeGreaterThanOrEqual(0);
      expect(whereAt).toBeGreaterThan(setAt);
      // Unambiguous: exactly one `WHERE` on the updated alias, so the slice above
      // is the whole SET clause and nothing else.
      expect([...statement.matchAll(/WHERE f\./g)]).toHaveLength(1);
      const written = statement.slice(setAt, whereAt);

      expect(written, `the ${position} re-key no longer writes \`${position}_key\``).toContain(
        `${position}_key =`,
      );
      // Its OWN column and no other position's — a copy-paste that left every
      // statement writing `subject_key` would otherwise pass the line above.
      for (const other of SLOT_POSITIONS.filter((p) => p !== position)) {
        expect(
          new RegExp(`\\b${other}_key\\s*=`).test(written),
          `the ${position} re-key writes \`${other}_key\` — one position's approval must never ` +
            "re-key another's (ADR-0037 §6: a position-agnostic vocabulary COMPELS cross-position " +
            "composition).",
        ).toBe(false);
      }
      for (const column of forbidden) {
        expect(
          new RegExp(`\\b${column}\\s*=`).test(written),
          `the ${position} re-key writes \`brain_facts.${column}\`. The allowlist entry in ` +
            "check-brain-fact-promotion.sh exempts the FILE, so the guard cannot fire on it — and " +
            "the entry's argument covers the identity keys ONLY. A gated column beyond those " +
            "three is a NEW carve-out and needs its own argument, not an inherited one.",
        ).toBe(false);
      }
      // `updated_at` is not gated by the guard, so it is not in `forbidden` — but
      // it is the line ADR-0037 §7 singles out and the one a future tidy-up puts
      // back, because every other UPDATE in the brain's write path stamps it.
      // Behaviourally pinned in `vocabulary-rekey-pg.test.ts`; pinned here too,
      // because that suite needs a live Postgres and this one catches it in the
      // diff.
      expect(
        /\bupdated_at\s*=/.test(written),
        `the ${position} re-key stamps \`updated_at\`. It sorts the publish preview ` +
          "(`brainFactPreviewSql`), so a workspace-wide re-key stamping it reshuffles every " +
          "reviewer's draft queue into re-key order. A key recomputation moves neither the " +
          "claim's content nor its review state.",
      ).toBe(false);
    }
  });

  it("no production consumer of a ClaimVocabulary names `identityVocabulary`", () => {
    // A source-level tripwire, kept as the CHEAP BACKSTOP rather than as the
    // coverage — that claim was true when it was written and is not any more.
    // All four sites are now covered behaviourally: ingest by the two-spellings-
    // one-slot test above, and both `correctFact` entry points by asserting the
    // vocabulary the caller handed over (`correct-fact-tool.test.ts`,
    // `admin-brain-facts.test.ts`, whose mocked pools return a real alias row).
    //
    // What this still buys is a FIFTH site: a new consumer that names the empty
    // vocabulary has no behavioural test of its own yet, and the fixture
    // workspaces have empty vocabularies, so the loaded answer and the empty one
    // are byte-identical and nothing else would notice.
    //
    // Backstopped: each file is proven to still CONSUME a vocabulary before it
    // is asserted not to name the empty one, so a rename or a deletion fails
    // here loudly instead of passing vacuously.
    const consumers = [
      "lib/brain/extract.ts",
      "lib/tools/correct-fact.ts",
      "api/routes/admin-brain-facts.ts",
    ];
    const root = join(import.meta.dir, "..", "..", "..");
    for (const relative of consumers) {
      const source = readFileSync(join(root, relative), "utf8");
      expect(
        source.includes("loadWorkspaceVocabulary"),
        `${relative} no longer loads a vocabulary at all — re-point this guard, or it asserts nothing`,
      ).toBe(true);
      // Matched on the IMPORT rather than on any mention, and that is not
      // laxity: a bare `includes("identityVocabulary")` fires on the prose in
      // `extract.ts` that explains why a load failure is NOT degraded to the
      // empty vocabulary — a comment worth keeping, and a guard that forces its
      // deletion is a guard that makes the codebase worse. The import is what a
      // real revert needs (`identity.ts` says so: "every such site is `grep
      // identityVocabulary` and every new one is a compile error"), and a site
      // cannot reach the value without one.
      expect(
        /import\s[^;]*\bidentityVocabulary\b[^;]*from/s.test(source),
        `${relative} imports \`identityVocabulary\`. Since #5023 every production consumer loads ` +
          "the workspace's real vocabulary; the empty one keys rows under a DIFFERENT identity " +
          "function than the ingest path, which is an under-match spread corpus-wide, invisible at " +
          "rest, and unfixable without a re-key.",
      ).toBe(false);
    }
  });

  // ── 20. The source-class vocabulary is closed ───────────────────────────

  it("every declared source class is accepted by the propose path", async () => {
    // The enum and migration 0190's CHECK are two lists that must stay one, and
    // this iterates the EXPORTED value rather than a hand-written copy. That is
    // the whole guard: a copy is still a valid `AliasSourceClass[]` after a
    // fifth member lands, so the new class is never exercised and the first
    // production insert is what discovers the CHECK does not know it. Iterating
    // the system's own list is what makes the drift fail here instead.
    for (const [i, sourceClass] of ALIAS_SOURCE_CLASSES.entries()) {
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
