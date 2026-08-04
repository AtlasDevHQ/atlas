/**
 * The drift re-key, the identity-mutation lock, and the supersede stamp's
 * collision re-check (#5024, ADR-0037 §7).
 *
 * Almost everything here needs a real Postgres, and two of the four groups need
 * a SECOND connection: a transaction double cannot be wrong about an
 * interleaving it does not have. Group 3's driving transaction deliberately
 * takes no advisory lock, which is what makes it a test of the statement's
 * standalone correctness rather than of the lock — see `targetsThenStamp`.
 *
 * Two assertions need no database at all; each says so where it sits.
 *
 * ## What each group falsifies
 *
 *   1. **The re-key** — that an approval moves existing rows onto the keys the
 *      new vocabulary decides, including the tombstoned and superseded rows
 *      `idx_brain_facts_subject`'s partial predicate excludes, and that it does
 *      so without stamping `updated_at`.
 *   2. **The undo** — that a REMOVAL returns each row to the target the
 *      post-removal vocabulary decides. This is the group that falsifies a
 *      key-to-key rewrite, which is the shape the issue's own prose suggests and
 *      which is correct in the approval direction and wrong in this one.
 *   3. **The stamp** — that `SUPERSEDE_STAMP_SQL` refuses to stamp a pair whose
 *      collision no longer holds, proved by de-merging BETWEEN the targets
 *      SELECT and the UPDATE.
 *   4. **The locks** — that two sessions on this namespace serialize and that
 *      the lock is transaction-scoped, and that a decide transaction now
 *      rewriting `brain_facts` completes beside a concurrent writer of the same
 *      table. **Which code paths take the namespace** is pinned in
 *      `content-mode/adapters/__tests__/brain-facts.test.ts` and
 *      `vocabulary-decide-pg.test.ts`, not here — nothing in this file calls
 *      `promoteBrainFacts`. And NOT that the 5022 → 5024 order is deadlock-free;
 *      see the last section.
 *
 * ## Mutation table
 *
 * Twenty-five mutations, all twenty-five caught. Regenerated in ONE pass against
 * the final tree rather than edited row by row — #5022's review found numbers
 * carried forward under a header claiming they had been re-measured, twice. The
 * harness applies each mutation, runs all three suites, records the first
 * failing test, and reverts; the "first test to die" column is that recorded
 * name, not an author's guess about which test ought to have caught it.
 *
 * Three suites are in scope: this one, `vocabulary-decide-pg.test.ts` (the lock
 * bracket and the column-scoped allowlist assertion), and
 * `content-mode/adapters/__tests__/brain-facts.test.ts` (the publish lock, its
 * bound and reset, the `55P03` classification, and the two stamp arbitrations).
 *
 * | # | Mutation | First test to die |
 * |---|---|---|
 * | 1 | `rekeyDriftedFacts` call deleted from `approveProposal` | an approval re-keys an existing fact onto the target the new vocabulary decides |
 * | 2 | `rekeyDriftedFacts` call deleted from `rejectProposal` | a REMOVAL returns each row to the target the post-removal vocabulary decides |
 * | 3 | re-key gains `AND f.invalidated_at IS NULL` | covers TOMBSTONED rows — the partial index excludes them, the re-key must not |
 * | 4 | re-key gains `AND f.valid_to IS NULL` | covers SUPERSEDED rows — same exclusion, same requirement |
 * | 5 | re-key gains `, updated_at = now()` | does NOT stamp `updated_at` — it sorts the reviewer's queue, and a re-key moved nothing |
 * | 6 | re-key's workspace scope weakened to `OR TRUE` | is workspace-scoped — a foreign row with a STALE key stays stale |
 * | 7 | every position uses the `subject` columns | an approval re-keys an existing fact onto the target the new vocabulary decides |
 * | 8 | outer `identityKeySql` dropped from the assignment | re-norms the vocabulary's answer rather than trusting it |
 * | 9 | closure subquery's position pinned to `'predicate'` | re-keys at the SUBJECT position, reading that position's closure only |
 * | 10 | closure subquery's position filter DELETED | reads ONLY its own position's closure when one norm is aliased at two positions |
 * | 11 | `COALESCE(closure, norm)` -> the closure alone | …and does NOT move a row the approval says nothing about (the control) |
 * | 12 | `row.slot_position` -> hardcoded `"predicate"` (both call sites) | re-keys at the SUBJECT position, reading that position's closure only |
 * | 13 | `EXISTS` arm removed from the collision stamp | stamps the rival when the collision still holds (the positive control) |
 * | 14 | `EXISTS` arm's `$3` -> `$2` | stamps the rival when the collision still holds (the positive control) |
 * | 15 | collision predicate -> `TRUE` inside the `EXISTS` | does NOT stamp when the collision was de-merged between the SELECT and the UPDATE |
 * | 16 | publish's identity-lock call deleted | takes the identity-mutation lock BEFORE reading the drafts (#5024) |
 * | 17 | publish's `SET LOCAL lock_timeout` deleted | bounds the lock wait BEFORE taking it — an unbounded wait hangs publish with no requestId |
 * | 18 | publish's lock_timeout RESET deleted (bound leaks to the txn) | RESETS the bound immediately — `SET LOCAL` reverts at COMMIT, not at the next statement |
 * | 19 | publish's namespace -> 5022 | takes the identity-mutation lock BEFORE reading the drafts (#5024) |
 * | 20 | `isLockTimeout` always false (55P03 relayed raw) | names the contending operation when the bound expires, instead of relaying a bare 55P03 |
 * | 21 | decide's lock order flipped (5024 before 5022) | decide locks first |
 * | 22 | decide's lock_timeout RESET deleted (bound leaks past 5024) | decide locks first |
 * | 23 | `lexicalNormSql`'s `translate()` -> `lower()` | `lexicalNormSql` agrees with `lexicalNorm` on every corpus row |
 * | 24 | `chr(11)` dropped from the separator class | `lexicalNormSql` agrees with `lexicalNorm` on every corpus row |
 * | 25 | `identityKeySql`'s `NULLIF(..., '')` dropped | a re-keyed POSITION whose surface norms away reaches NULL, never the empty string |
 *
 * ## Three rounds, and what each one caught that the previous missed
 *
 * **Round 1 (19 mutations) left ONE survivor: dropping the outer
 * `identityKeySql`.** Every closure row this suite wrote went through
 * `approveAliasEdge`, which re-norms both endpoints — so the outer re-norm was a
 * no-op on every fixture. The defence is reachable from outside the seam (0189's
 * CHECKs do not constrain `effective_target` to being a norm, and the region
 * import rebuilds that table), so the fix was a test that writes the two
 * relations DIRECTLY. **A fixture built entirely through the sanctioned seam
 * cannot falsify the guards that exist for writers which bypass it.**
 *
 * **Round 2 was a review panel, and it found a hole the table had not probed at
 * all.** Every `approve()` in this file was at the `predicate` position, so
 * `rekeyDriftedFacts(tx, ws, "predicate", id)` — hardcoded — passed all 102
 * tests across this suite and `vocabulary-decide-pg`. That is subject and object
 * approvals re-keying NOTHING, with a success line in the log. Rows 10 and 12
 * exist because of it. **A mutation table only covers the mutations someone
 * thought to write, and a suite whose fixtures all share one value of a
 * parameter cannot probe that parameter at all.**
 *
 * **Round 3 was a second panel over round 2's fixes, and it caught two of them.**
 * Row 6 did not reproduce: with two identical unaliased rows, weakening the
 * statement's own `WHERE f.workspace_id = $1` changed nothing, because the
 * closure subquery carries `t.workspace_id = f.workspace_id` of its own. The row
 * had been dying on an unrelated string anchor in another suite — a measured
 * kill for the wrong reason, which is the failure mode this table's whole
 * regeneration discipline exists to catch, appearing inside the discipline. The
 * test now uses a foreign row whose stored key DISAGREES with its own
 * workspace's closure, which is the only shape an unscoped statement moves.
 *
 * And the `SET LOCAL lock_timeout` added in round 2 was never reset, so it
 * governed every later lock wait in both transactions — `DRAFT_FACTS_SQL`'s
 * `FOR UPDATE` (which exists to WAIT), the re-key's row locks, and
 * `admin-publish.ts`'s phase-4 archive loop. **A fix that turns a wait into a
 * failure is a behaviour change, not a hardening.** Rows 18 and 22 pin the reset.
 *
 * ## What this suite does NOT cover, stated so the 25 are not over-read
 *
 * The 5022 → 5024 ORDER is asserted as an invariant in
 * `vocabulary-decide-pg.test.ts` (row 21), not provoked as a deadlock. No
 * wait-for cycle is reachable for either ordering today: publish and the decide
 * seam take their advisory locks before they UPDATE, and the region importer —
 * which INSERTs `brain_facts` well before it takes 5022 — only ever INSERTs, and
 * an uncommitted INSERT blocks no UPDATE. The inverted order becomes real the
 * moment the importer UPDATEs an existing fact row. #5022's review is explicit
 * that an interleaving which cannot form a cycle passes against a broken
 * implementation, so claiming otherwise would be the same mistake one slice
 * later.
 *
 * WHICH code paths take the namespace is likewise not pinned here — nothing in
 * this file calls `promoteBrainFacts`. Rows 16–20 all die in
 * `content-mode/adapters/__tests__/brain-facts.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import {
  IDENTITY_MUTATION_LOCK_NAMESPACE,
  IDENTITY_MUTATION_LOCK_SQL,
  identityVocabulary,
  lexicalNorm,
  lexicalNormSql,
  identityKeySql,
  SLOT_POSITIONS,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";
import {
  decideAliasProposal,
  proposeAliasEdge,
  REKEY_DRIFTED_FACTS_SQL,
} from "@atlas/api/lib/brain/vocabulary-decide";
import {
  VOCABULARY_LOCK_NAMESPACE,
  VOCABULARY_LOCK_SQL,
} from "@atlas/api/lib/brain/vocabulary";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import {
  SUPERSEDE_STAMP_SQL,
  SUPERSESSION_TARGETS_SQL,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-rekey-5024";
const OTHER_WS = "ws-rekey-5024-other";

describeIfPg("the drift re-key and the identity-mutation lock (#5024)", () => {
  let pool: Pool;
  const schemaName = `brain_5024_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let priorDatabaseUrl: string | undefined;

  beforeAll(async () => {
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
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  const owner = (workspaceId = WS): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId,
    userId: "user-owner",
    role: "owner",
    audienceIds: ["org"],
  });

  let episodeSeq = 0;
  async function seedEpisode(workspaceId: string): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const sourceId = `C01:5024.${episodeSeq++}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'evidence', $3::timestamptz, ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId, occurredAt.toISOString()],
    );
    return {
      id: rows[0]!.id,
      workspaceId,
      source: "slack",
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: ["org"],
    };
  }

  interface Claim {
    readonly subject: string;
    readonly predicate: string;
    readonly object: string;
  }

  /**
   * Land one claim through the REAL ingest stage, under the EMPTY vocabulary.
   *
   * Empty on purpose: every test here is about what the re-key does to rows that
   * are already in the corpus, so the fixture must be keyed by the vocabulary
   * that was in force when they were written — which is the situation the re-key
   * exists for. Landing them under the post-approval vocabulary would make the
   * re-key a no-op and every assertion below vacuously true.
   */
  async function land(workspaceId: string, claim: Claim): Promise<string> {
    const episode = await seedEpisode(workspaceId);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [{ ...claim, predicateCardinality: "single" }],
      producer: "rekey-5024",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    // A PRECONDITION asserted where every test inherits it: `reconcileFacts`
    // reports a domain refusal as a counted outcome and never throws, so a
    // candidate that tripped `MALFORMED_CLAIM` would land zero rows and every
    // prohibition below would pass against an empty table.
    expect(
      report.outcomes[0],
      `"${claim.subject} ${claim.predicate} ${claim.object}" was refused, not landed`,
    ).not.toMatchObject({ kind: "blocked" });
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM brain_facts
        WHERE workspace_id = $1 AND subject = $2 AND predicate = $3 AND object = $4`,
      [workspaceId, claim.subject, claim.predicate, claim.object],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }

  interface FactRow {
    readonly subject_key: string | null;
    readonly predicate_key: string | null;
    readonly object_key: string | null;
    readonly updated_at: Date;
    readonly valid_to: Date | null;
    readonly invalidated_at: Date | null;
  }

  async function readFact(id: string): Promise<FactRow> {
    const { rows } = await pool.query<FactRow>(
      `SELECT subject_key, predicate_key, object_key, updated_at, valid_to, invalidated_at
         FROM brain_facts WHERE id = $1::uuid`,
      [id],
    );
    expect(rows, `fact ${id} vanished`).toHaveLength(1);
    return rows[0]!;
  }

  /** Approve one alias through the real seam, and assert it landed. */
  async function approve(
    fromNorm: string,
    toNorm: string,
    position: SlotPosition = "predicate",
    workspaceId = WS,
  ): Promise<string> {
    const queued = await proposeAliasEdge(workspaceId, {
      position,
      fromNorm,
      toNorm,
      directed: true,
      sourceClass: "human",
      confidence: 1,
      proposedBy: "user-owner",
    });
    expect(queued.kind).toBe("queued");
    if (queued.kind !== "queued") throw new Error("unreachable");
    const decided = await decideAliasProposal({
      id: queued.id,
      workspaceId,
      decision: "approved",
      approver: { kind: "human", ctx: owner(workspaceId) },
    });
    expect(decided.kind, `approving ${fromNorm} → ${toNorm} did not land`).toBe("approved");
    return queued.id;
  }

  /** Reject an APPROVED proposal — the removal verb. */
  async function remove(proposalId: string, workspaceId = WS): Promise<void> {
    const decided = await decideAliasProposal({
      id: proposalId,
      workspaceId,
      decision: "rejected",
      approver: { kind: "human", ctx: owner(workspaceId) },
    });
    expect(decided).toMatchObject({ kind: "rejected", removedEdge: true });
  }

  // ── 1. the re-key, on approval ──────────────────────────────────────────

  it("an approval re-keys an existing fact onto the target the new vocabulary decides", async () => {
    const id = await land(WS, {
      subject: "widget",
      predicate: "is priced at",
      object: "nine dollars",
    });
    // The premise, stated by the test rather than assumed: before the approval
    // the row keys to its own norm.
    expect((await readFact(id)).predicate_key).toBe("is priced at");

    await approve("is priced at", "priced at");

    expect((await readFact(id)).predicate_key).toBe("priced at");
  });

  it("…and does NOT move a row the approval says nothing about (the control)", async () => {
    // Without this, mutation 10 (`COALESCE(closure, norm)` → `closure`) reads as
    // a passing implementation: every unaliased row would go NULL and the test
    // above would never look at one.
    const aliased = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const untouched = await land(WS, { subject: "widget", predicate: "ships on", object: "friday" });

    await approve("is priced at", "priced at");

    expect((await readFact(aliased)).predicate_key).toBe("priced at");
    expect((await readFact(untouched)).predicate_key).toBe("ships on");
  });

  it("covers TOMBSTONED rows — the partial index excludes them, the re-key must not", async () => {
    const live = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const tombstoned = await land(WS, {
      subject: "gadget",
      predicate: "is priced at",
      object: "ten",
    });
    await pool.query("UPDATE brain_facts SET invalidated_at = now() WHERE id = $1::uuid", [
      tombstoned,
    ]);
    expect((await readFact(tombstoned)).invalidated_at).not.toBeNull();

    await approve("is priced at", "priced at");

    // The live row is the positive control — if the statement re-keyed NOTHING
    // the tombstone assertion alone could not tell that apart from "it correctly
    // skipped this one".
    expect((await readFact(live)).predicate_key).toBe("priced at");
    expect(
      (await readFact(tombstoned)).predicate_key,
      "a tombstoned row kept a stale key — its surface and key now disagree permanently, and the " +
        "next removal's re-derive-from-surface undo would move it somewhere neither vocabulary put it",
    ).toBe("priced at");
  });

  it("covers SUPERSEDED rows — same exclusion, same requirement", async () => {
    const live = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const superseded = await land(WS, {
      subject: "gadget",
      predicate: "is priced at",
      object: "ten",
    });
    await pool.query("UPDATE brain_facts SET valid_to = now() WHERE id = $1::uuid", [superseded]);
    expect((await readFact(superseded)).valid_to).not.toBeNull();

    await approve("is priced at", "priced at");

    expect((await readFact(live)).predicate_key).toBe("priced at");
    expect((await readFact(superseded)).predicate_key).toBe("priced at");
  });

  it("does NOT stamp `updated_at` — it sorts the reviewer's queue, and a re-key moved nothing", async () => {
    const id = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const before = await readFact(id);

    await approve("is priced at", "priced at");

    const after = await readFact(id);
    // The positive control is in the SAME assertion pair, deliberately: without
    // it, a re-key that did nothing at all would satisfy the `updated_at` claim
    // perfectly. The key must have moved AND the timestamp must not have.
    expect(after.predicate_key).toBe("priced at");
    expect(
      after.updated_at.getTime(),
      "the re-key stamped `updated_at`. It is the sort key of the publish preview " +
        "(`brainFactPreviewSql`), so a workspace-wide re-key stamping it reshuffles every " +
        "reviewer's draft queue into re-key order.",
    ).toBe(before.updated_at.getTime());
  });

  it("moves ONLY the approved position", async () => {
    // `widget` appears at the subject position and `widget` is also the alias
    // source, so a statement that applied the predicate closure to every column
    // — or pinned `t.slot_position` — would move the subject key too.
    const id = await land(WS, { subject: "widget", predicate: "widget", object: "widget" });
    await approve("widget", "gizmo", "predicate");

    const row = await readFact(id);
    expect(row.predicate_key).toBe("gizmo");
    expect(
      row.subject_key,
      "a PREDICATE approval re-keyed the SUBJECT. ADR-0037 §6: a position-agnostic vocabulary does " +
        "not merely permit cross-position composition, it COMPELS it.",
    ).toBe("widget");
    expect(row.object_key).toBe("widget");
  });

  it("re-keys at the SUBJECT position, reading that position's closure only", async () => {
    // ⭐ Added after the review panel found that every other `approve()` in this
    // file is at `predicate` — so `rekeyDriftedFacts(tx, ws, "predicate", id)`,
    // hardcoded, passed all 100 tests in this suite and `vocabulary-decide-pg`.
    // Measured, not assumed: the probe was applied and the suites run.
    //
    // Two live defects hid behind that, and neither is a near-miss:
    //   - `row.slot_position` not threaded → subject AND object approvals
    //     re-key NOTHING. Two thirds of the feature dead, silently, with a
    //     success line in the log.
    //   - the closure subquery's `AND t.slot_position = '${position}'` DELETED →
    //     one position's approval re-keys another's. `brain_vocabulary_target`'s
    //     PK is `(workspace_id, slot_position, norm)`, so the same norm
    //     legitimately carries different targets per position, and this is the
    //     cross-position composition ADR-0037 §6 calls unrecoverable.
    //
    // The structural test below cannot reach either: deleting the filter from
    // all three generated statements leaves them normalizing to the identical
    // canonical string. Only a fixture with the SAME norm aliased at ONE
    // position and read at another can.
    const id = await land(WS, { subject: "widget", predicate: "widget", object: "widget" });

    await approve("widget", "gizmo", "subject");

    const row = await readFact(id);
    expect(row.subject_key, "a SUBJECT approval did not re-key the subject").toBe("gizmo");
    expect(
      row.predicate_key,
      "a SUBJECT approval re-keyed the PREDICATE — the closure subquery is not position-scoped, so " +
        "one position's vocabulary is deciding another's keys",
    ).toBe("widget");
    expect(row.object_key).toBe("widget");
  });

  it("reads ONLY its own position's closure when one norm is aliased at two positions", async () => {
    // ⭐ The direct falsifier for the closure subquery's
    // `AND t.slot_position = '${position}'`, and it needs a fixture the two
    // tests around it cannot provide. Measured: with edges at ONE position,
    // deleting that filter still passes every test in this suite — there is
    // simply no other position's row for the subquery to over-match.
    //
    // `brain_vocabulary_target`'s PK is `(workspace_id, slot_position, norm)`,
    // so ONE norm legitimately carries DIFFERENT targets at different
    // positions. That is the only shape that distinguishes a scoped lookup from
    // an unscoped one — and unscoped, the scalar subquery matches two rows and
    // Postgres raises `more than one row returned by a subquery used as an
    // expression`, which is the loud direction.
    const id = await land(WS, { subject: "widget", predicate: "widget", object: "nine" });

    await approve("widget", "gizmo", "subject");
    await approve("widget", "doohickey", "predicate");

    const row = await readFact(id);
    expect(
      row.subject_key,
      "the subject key did not come from the SUBJECT closure — one norm, two positions, and the " +
        "lookup crossed between them",
    ).toBe("gizmo");
    expect(
      row.predicate_key,
      "the predicate key did not come from the PREDICATE closure. ADR-0037 §6: a position-agnostic " +
        "vocabulary does not merely permit cross-position composition, it COMPELS it.",
    ).toBe("doohickey");
  });

  it("re-keys at the OBJECT position too — all three statements really execute", async () => {
    // The third arm. Without it `REKEY_DRIFTED_FACTS_SQL.object` is never sent
    // to Postgres by any test in the repo, so a syntax error or a wrong column
    // in that one statement ships green.
    const id = await land(WS, { subject: "widget", predicate: "widget", object: "widget" });

    await approve("widget", "gizmo", "object");

    const row = await readFact(id);
    expect(row.object_key).toBe("gizmo");
    expect(row.subject_key).toBe("widget");
    expect(row.predicate_key).toBe("widget");
  });

  it("is workspace-scoped — a foreign row with a STALE key stays stale", async () => {
    // ⭐ Rebuilt after the review panel MEASURED the obvious version failing to
    // falsify anything. With two identical unaliased rows, weakening the
    // statement's `WHERE f.workspace_id = $1` to `OR TRUE` changed nothing: the
    // closure subquery carries `t.workspace_id = f.workspace_id` of its own, so
    // a foreign row still resolves `COALESCE(closure, norm)` to its own norm,
    // `IS DISTINCT FROM` is false, and the row is a no-op either way. The
    // mutation-table row that claimed to catch it was dying on an unrelated
    // string anchor in a different suite.
    //
    // What makes the scope observable is a foreign row whose stored key
    // DISAGREES with its own workspace's closure. An unscoped re-key repairs it
    // — visibly — where a scoped one cannot see it at all.
    const mine = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const theirs = await land(OTHER_WS, { subject: "widget", predicate: "ships on", object: "fri" });

    // Give the OTHER workspace a real vocabulary, then put its row's key back to
    // the pre-approval value by hand. Only a cross-tenant statement can move it.
    await approve("ships on", "delivery date", "predicate", OTHER_WS);
    expect((await readFact(theirs)).predicate_key).toBe("delivery date");
    await pool.query("UPDATE brain_facts SET predicate_key = 'ships on' WHERE id = $1::uuid", [
      theirs,
    ]);

    await approve("is priced at", "priced at");

    expect((await readFact(mine)).predicate_key).toBe("priced at");
    expect(
      (await readFact(theirs)).predicate_key,
      "the re-key crossed a workspace boundary — one tenant's alias decision recomputed another " +
        "tenant's keys. Scoped, this row is invisible to the statement and keeps its stale key.",
    ).toBe("ships on");
  });

  it("a re-keyed POSITION whose surface norms away reaches NULL, never the empty string", async () => {
    // `identityKeySql`'s `NULLIF(…, '')`. A stored `''` is the ONE key value that
    // joins every other degenerate row, so two unrelated placeholder claims would
    // occupy one slot and publishing either would stamp `valid_to` on the other.
    //
    // The approval is at the OBJECT position, and that is the point rather than
    // an arbitrary choice: an earlier cut approved at `predicate` and asserted on
    // `object_key`, so the object statement never ran and the NULL it checked was
    // the one `identityKey` wrote at ingest — a no-op with respect to the re-key.
    // The degenerate surface has to be at the position being re-keyed.
    const id = await land(WS, { subject: "widget", predicate: "ships on", object: "-" });
    expect((await readFact(id)).object_key).toBeNull();

    // A real object alias in the same workspace, so the object statement has
    // something to do and cannot pass by moving nothing.
    const other = await land(WS, { subject: "widget", predicate: "ships on", object: "friday" });
    await approve("friday", "fri", "object");

    expect((await readFact(other)).object_key).toBe("fri");
    expect(
      (await readFact(id)).object_key,
      "a surface that norms away was keyed to the empty string by the re-key",
    ).toBeNull();
  });

  it("re-norms the vocabulary's answer rather than trusting it", async () => {
    // ⭐ Added because the mutation pass found the outer `identityKeySql` was
    // UNTESTED — dropping it left all sixteen other tests green. The corpus
    // could not reach it: `approveAliasEdge` re-norms both endpoints, so every
    // closure row this suite writes through the seam already holds a norm, and
    // the outer call is a no-op on all of them.
    //
    // It is reachable from OUTSIDE the seam, which is the whole reason `slotKey`
    // keeps the same outer call: `brain_vocabulary_target` is rebuilt by the
    // region import's merge (#5036) and restorable by hand, and 0189's CHECKs
    // constrain the target to non-empty and not-self — NOT to being a norm. So
    // an `effective_target` of `Priced At` (an admin typing the canonical
    // DISPLAY form, the likeliest authoring mistake once this is a reviewed data
    // table) is storable, and without the re-norm it would key every affected
    // row to a string that joins nothing, workspace-wide and silently.
    //
    // Written directly to the two relations, bypassing the seam, because the
    // seam is exactly what makes the case unreachable.
    const id = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const degenerate = await land(WS, { subject: "widget", predicate: "ships on", object: "ten" });
    await pool.query(
      `INSERT INTO brain_vocabulary_edge
         (workspace_id, slot_position, from_norm, to_norm, approved_by)
       VALUES ($1, 'predicate', 'is priced at', 'Priced At', 'hand-written'),
              ($1, 'predicate', 'ships on', ' - ', 'hand-written')`,
      [WS],
    );
    await pool.query(
      `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
       VALUES ($1, 'predicate', 'is priced at', 'Priced At'),
              ($1, 'predicate', 'ships on', ' - ')`,
      [WS],
    );

    await pool.query(REKEY_DRIFTED_FACTS_SQL.predicate, [WS]);

    expect(
      (await readFact(id)).predicate_key,
      "the re-key stored the vocabulary's answer verbatim. `slotKey` is " +
        "`identityKey(alias(norm))`, not `alias(norm)` — a target that is not a norm keys nothing " +
        "to anything, and nothing anywhere would say so.",
    ).toBe("priced at");
    expect(
      (await readFact(degenerate)).predicate_key,
      "a vocabulary answer that norms AWAY must reach NULL, not the empty string — a stored `''` is " +
        "the one key value that joins every other degenerate row",
    ).toBeNull();
  });

  // ── 2. the undo, on removal ─────────────────────────────────────────────

  it("a REMOVAL returns each row to the target the post-removal vocabulary decides", async () => {
    // ⭐ THE test that falsifies a key-to-key rewrite, which is the shape the
    // issue's own prose suggests (`WHERE predicate_key = X`) and which is correct
    // in the approval direction and WRONG here.
    //
    // Both rows key to `unit price` after the approval. A rewrite driven by the
    // stored key cannot tell them apart afterwards — sharing a key is exactly
    // what it records — so it would return BOTH to `price` or leave both on
    // `unit price`. Only the retained surface distinguishes them.
    const viaAlias = await land(WS, { subject: "widget", predicate: "price", object: "nine" });
    const direct = await land(WS, { subject: "gadget", predicate: "unit price", object: "ten" });

    const proposal = await approve("price", "unit price");
    expect((await readFact(viaAlias)).predicate_key).toBe("unit price");
    expect((await readFact(direct)).predicate_key).toBe("unit price");

    await remove(proposal);

    expect(
      (await readFact(viaAlias)).predicate_key,
      "the removal did not undo the re-key — ADR-0037 §6 rests the vocabulary's whole reversibility " +
        "argument on removal being a RECOMPUTATION",
    ).toBe("price");
    expect(
      (await readFact(direct)).predicate_key,
      "the removal moved a row whose surface was ALWAYS the target. A key-to-key rewrite cannot " +
        "avoid this; recomputing from the surface is what does.",
    ).toBe("unit price");
  });

  it("a removal in a CHAIN returns the row to its nearest surviving target, not to its own norm", async () => {
    // `a → b → c`: everything keys to `c`. Dropping `b → c` must move `a`'s rows
    // to `b`, not to `a` and not leave them on `c`. This is the case migration
    // 0189's FK comment calls out as the reason RESTRICT is not CASCADE, and it
    // is the one a "reset to the surface norm" shortcut gets wrong.
    const id = await land(WS, { subject: "widget", predicate: "a", object: "nine" });
    await approve("a", "b");
    const bToC = await approve("b", "c");
    expect((await readFact(id)).predicate_key).toBe("c");

    await remove(bToC);

    expect((await readFact(id)).predicate_key).toBe("b");
  });

  // ── 3. the stamp's collision re-check ───────────────────────────────────

  /**
   * Drive the publish gate's two supersession statements by hand, with an
   * optional de-merge BETWEEN them.
   *
   * By hand rather than through `promoteBrainFacts`, because what is under test
   * is the window between the two statements and the phase does not expose one.
   *
   * The de-merge runs on a SECOND connection and COMMITS, through the real
   * `decideAliasProposal` — a genuine concurrent alias removal, not a
   * same-transaction edit. An earlier cut did it inline and was legitimate but
   * weaker: own-transaction visibility and cross-transaction visibility are
   * identical under READ COMMITTED, so it could not tell them apart, and the
   * guard would silently become a no-op if this transaction ever ran at
   * REPEATABLE READ while the test stayed green.
   *
   * This transaction deliberately does NOT take the identity lock. The lock is
   * what makes the read-then-write serial in production; what is under test here
   * is whether the UPDATE is correct STANDALONE without it — precisely the
   * property `DRAFT_FACTS_SQL`'s header argues must not depend on the lock.
   */
  async function targetsThenStamp(
    draftIds: readonly string[],
    demerge: null | { readonly proposalId: string },
  ): Promise<readonly string[]> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const targets = await client.query<{ superseded_id: string }>(SUPERSESSION_TARGETS_SQL, [
        WS,
        draftIds,
      ]);
      const oldIds = [...new Set(targets.rows.map((r) => r.superseded_id))];
      // The premise every assertion downstream rests on. Without it a de-merge
      // that happened to break the TARGETS query instead of the stamp would look
      // exactly like a working re-check.
      expect(oldIds, "the pair did not collide even before the de-merge").toHaveLength(1);

      if (demerge) {
        // Committed by an INDEPENDENT transaction on its own connection while
        // this one sits between its SELECT and its UPDATE.
        await remove(demerge.proposalId);
      }

      const stamped = await client.query<{ id: string }>(SUPERSEDE_STAMP_SQL, [
        WS,
        oldIds,
        draftIds,
      ]);
      await client.query("COMMIT");
      return stamped.rows.map((r) => r.id);
    } catch (err) {
      await client.query("ROLLBACK").catch((cause: unknown) => {
        console.warn(
          `targetsThenStamp: ROLLBACK failed — ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /** A published rival and a colliding draft, merged into one slot by an alias. */
  async function seedCollidingPair(): Promise<{
    draftId: string;
    publishedId: string;
    proposalId: string;
  }> {
    const publishedId = await land(WS, {
      subject: "widget",
      predicate: "ships on",
      object: "friday",
    });
    const draftId = await land(WS, {
      subject: "widget",
      predicate: "delivery date",
      object: "monday",
    });
    await pool.query("UPDATE brain_facts SET status = 'published' WHERE id = $1::uuid", [
      publishedId,
    ]);
    // The alias is what makes them collide: two spellings, one slot.
    const proposalId = await approve("ships on", "delivery date");
    const p = await readFact(publishedId);
    const d = await readFact(draftId);
    expect(p.predicate_key).toBe("delivery date");
    expect(d.predicate_key).toBe("delivery date");
    return { draftId, publishedId, proposalId };
  }

  it("stamps the rival when the collision still holds (the positive control)", async () => {
    const { draftId, publishedId } = await seedCollidingPair();
    const stamped = await targetsThenStamp([draftId], null);
    expect(stamped).toEqual([publishedId]);
    expect((await readFact(publishedId)).valid_to).not.toBeNull();
  });

  it("does NOT stamp when the collision was de-merged between the SELECT and the UPDATE", async () => {
    const { draftId, publishedId, proposalId } = await seedCollidingPair();

    const stamped = await targetsThenStamp([draftId], { proposalId });

    expect(
      stamped,
      "SUPERSEDE_STAMP_SQL stamped a pair that no longer collides. An alias REMOVAL landing in that " +
        "window retires a belief no arbitration supports — and every as-of-now read then hides the " +
        "row it touched, so the damage is invisible in both directions.",
    ).toEqual([]);
    expect((await readFact(publishedId)).valid_to).toBeNull();
    // …and the de-merge really did un-merge the slot, so the assertion above is
    // about the re-check rather than about a statement that matched nothing.
    expect((await readFact(publishedId)).predicate_key).toBe("ships on");
    expect((await readFact(draftId)).predicate_key).toBe("delivery date");
  });

  // ── 4. the locks ────────────────────────────────────────────────────────

  it("two sessions on the identity-mutation namespace serialize, and the lock is xact-scoped", async () => {
    // Two connections, and the second must WAIT. Asserted by observing that the
    // waiter is still blocked while the holder is open, then unblocks on COMMIT
    // — `pg_locks` rather than a timeout, so a slow machine cannot make this
    // pass or fail for the wrong reason.
    const holder = await pool.connect();
    const waiter = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, WS]);

      await waiter.query("BEGIN");
      const { rows: pidRows } = await waiter.query<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const waiterPid = pidRows[0]!.pid;
      // `.catch` attached at creation, not at the await. On the failure path
      // below `waiter` is DESTROYED while this query is still pending, and an
      // unattached rejection surfaces as "Unhandled error between tests" —
      // attributable to whichever test runs next rather than to the assertion
      // that actually broke.
      let blockedRejection: unknown;
      const blocked = waiter
        .query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, WS])
        .catch((err: unknown) => {
          blockedRejection = err;
        });

      // Wait for the waiter to actually be registered as blocked rather than
      // sleeping a fixed interval and hoping.
      const observer = await pool.connect();
      try {
        // Scoped to the WAITER's own backend pid, not just the namespace.
        // `promoteBrainFacts` now takes 5024 in six other `-pg` suites against
        // the same `TEST_DATABASE_URL`, so an unscoped count is a cross-suite
        // flake waiting to happen — and it would fail in the direction that
        // looks like a real defect.
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const { rows } = await observer.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
                AND classid = $1 AND pid = $2::int`,
            [IDENTITY_MUTATION_LOCK_NAMESPACE, waiterPid],
          );
          waiting = Number(rows[0]?.n ?? 0) > 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 20));
        }
        expect(
          waiting,
          "the second session took the identity-mutation lock while the first still held it",
        ).toBe(true);
      } finally {
        observer.release();
      }

      await holder.query("COMMIT");
      await blocked; // resolves once the lock is released — hangs the test if not
      // The happy path must not have swallowed a real error into the handler.
      expect(blockedRejection).toBeUndefined();
      await waiter.query("COMMIT");
    } finally {
      // `release(true)` DESTROYS rather than returns to the pool. node-postgres
      // does NOT roll back on a plain `release()`, so on an assertion failure
      // above these two clients would go back holding an open transaction — and
      // advisory lock 5024 with it. The next `afterEach` DELETE would then block
      // forever, and the failure a reader sees is a 60s timeout two tests later
      // rather than the assertion that actually broke. The test designed to
      // catch a lock defect must not be the one that hides it.
      holder.release(true);
      waiter.release(true);
    }
  }, PG_TEST_TIMEOUT_MS);

  it("a decide transaction and a concurrent brain_facts writer both complete — no 40P01", async () => {
    // ## What this test can and cannot prove, stated up front
    //
    // #5022's review produced a real `40P01 deadlock detected` from a lock
    // "redundancy" argument, and the lesson recorded there is that a
    // concurrency test's ORDERING is the test — an interleaving that cannot
    // form a cycle passes against a broken implementation.
    //
    // Applying that lesson honestly here says this test does NOT falsify the
    // 5022 → 5024 order, and it is not written as though it does.
    //
    // Publish takes 5024 then writes, and the decide seam takes both then
    // re-keys. The region importer does NOT fit that summary — it INSERTs
    // `brain_facts` in `admin-migrate.ts` well before it takes 5022, and takes
    // 5022 only when the bundle carries vocabulary edges at all. What keeps it
    // safe is narrower than "everyone locks first": it only ever INSERTs, and an
    // uncommitted INSERT blocks no UPDATE, so the re-key never waits on it. No
    // wait-for cycle exists for either ordering today, which makes the inverted
    // order a latent hazard rather than a reachable one — pinned as an INVARIANT
    // in `vocabulary-decide-pg.test.ts` instead.
    //
    // What this test IS: the regression guard for the shape that DID bite in
    // #5022 — a `brain_facts` writer running concurrently with a decide
    // transaction that now rewrites `brain_facts` itself. Before #5024 the
    // decide transaction touched no row the other writer could hold. It does
    // now, so the pair is worth exercising even though the current lock
    // discipline makes it safe.
    await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });

    const writer = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The importer's EDGE-write ordering — the lock, THEN rows — which is
        // what it does once it has edges to write. Deliberately not a
        // reproduction of its FACT path: that INSERTs before it locks, and an
        // uncommitted INSERT would not contend with the re-key at all, which is
        // the point of the paragraph above. This fixture UPDATEs so the pair
        // genuinely contends.
        await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, WS]);
        await client.query(
          `UPDATE brain_facts SET status = 'published'
            WHERE workspace_id = $1 AND status = 'draft'`,
          [WS],
        );
        await client.query("COMMIT");
      } finally {
        // Destroyed rather than returned, for the reason above — and here it is
        // sharper: the path that runs when a 40P01 IS detected is the path that
        // would poison the pool, so the test built to catch the deadlock would
        // destroy its own evidence.
        client.release(true);
      }
    })();

    // The real seam, concurrently. A 40P01 from either side rejects the pair.
    const [, proposalId] = await Promise.all([writer, approve("is priced at", "priced at")]);

    // Non-vacuous on both sides: the approval really landed AND the re-key
    // really ran against the row the other transaction was also writing.
    expect(proposalId).toBeTruthy();
    const { rows } = await pool.query<{ predicate_key: string; status: string }>(
      "SELECT predicate_key, status FROM brain_facts WHERE workspace_id = $1",
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.predicate_key).toBe("priced at");
    expect(rows[0]!.status).toBe("published");
  }, PG_TEST_TIMEOUT_MS);

  // ── 5. the SQL twin ─────────────────────────────────────────────────────

  it("`lexicalNormSql` agrees with `lexicalNorm` on every corpus row", async () => {
    // Migration 0187 is a second implementation of `lexicalNorm` and #5024's
    // re-key is a third; `lexicalNormSql` is what collapses the second and third
    // into one expression. This is the row-by-row proof that the expression and
    // the TypeScript are the same function.
    //
    // The two Unicode entries are the measured counter-examples from
    // `identity.ts`'s header — they are what make `translate()` vs `lower()` a
    // detectable difference rather than a style choice.
    const corpus = [
      "Ships On",
      "ships_on",
      "  is   priced  at  ",
      "is-priced-at",
      "leaves", // U+000B, the escape the readable regex spelling loses
      "İstanbul",
      "ΣΊΣΥΦΟΣ",
      "Café",
      "МОСКВА",
      "-",
      "___",
      "",
      "a\tb\nc\rd",
    ];
    const { rows } = await pool.query<{ i: number; normed: string }>(
      `SELECT ord::int - 1 AS i, ${lexicalNormSql("v")} AS normed
         FROM unnest($1::text[]) WITH ORDINALITY AS t(v, ord)`,
      [corpus],
    );
    expect(rows).toHaveLength(corpus.length);
    for (const row of rows) {
      const surface = corpus[row.i]!;
      expect(row.normed, `lexicalNormSql disagrees with lexicalNorm on ${JSON.stringify(surface)}`).toBe(
        lexicalNorm(surface),
      );
    }
    // Non-vacuous: the corpus must contain at least one input the function
    // actually changes, or an implementation returning its input would pass.
    expect(corpus.some((s) => lexicalNorm(s) !== s)).toBe(true);
  });

  it("`identityKeySql` is textually what migration 0187 already contains", () => {
    // The second of the two proofs `identity.ts`'s docstring names.
    //
    // WHITESPACE-COLLAPSED, and that is not cosmetic: 0187 column-ALIGNS its
    // arguments (`translate(subject,   '…`, three spaces; `translate(object,
    // '…`, four), so a raw `includes` holds for `predicate` and fails for the
    // other two.
    //
    // What this buys that the row-by-row corpus run does not: the corpus proves
    // `lexicalNormSql ≡ lexicalNorm` TODAY. This proves the generated expression
    // is the same text already applied to every row in every deployed database,
    // so editing `lexicalNormSql` without a migration cannot silently re-key
    // half a corpus under a function the other half never saw.
    //
    // Needs no Postgres, and left inside the `-pg` gate deliberately — unlike
    // the allowlist assertion, which `check-brain-fact-promotion.sh` DELEGATES
    // to and which therefore has to run in the local `--affected` loop, where a
    // new gated write first appears. This one guards a divergence reachable only
    // through a deliberate edit to `lexicalNormSql`, and CI sets
    // `TEST_DATABASE_URL`.
    const migration = readFileSync(
      join(import.meta.dir, "..", "..", "db", "migrations", "0187_brain_fact_identity_keys.sql"),
      "utf8",
    );
    const squash = (sql: string): string => sql.replace(/\s+/g, " ");
    // Non-vacuous: prove the file is the one we think before asserting about it.
    expect(migration).toContain("UPDATE brain_facts");
    for (const position of SLOT_POSITIONS) {
      expect(
        squash(migration),
        `migration 0187's ${position} expression is no longer what \`identityKeySql\` generates — ` +
          "the SQL twin and the day-one backfill have diverged, so rows keyed by the migration and " +
          "rows keyed by the re-key are keyed by two different functions",
      ).toContain(squash(identityKeySql(position)));
    }
  });

  it("`identityKeySql` maps a norm-away surface to NULL, matching `identityKey`", async () => {
    const { rows } = await pool.query<{ k: string | null }>(
      `SELECT ${identityKeySql("v")} AS k FROM unnest($1::text[]) AS t(v)`,
      [["-", "___", "  ", "ships on"]],
    );
    expect(rows.map((r) => r.k)).toEqual([null, null, null, "ships on"]);
  });

  it("every position's re-key statement is generated from the same expression", async () => {
    // A cheap structural pin on `REKEY_DRIFTED_FACTS_SQL`: three statements that
    // differ ONLY in the two column names and the position literal. Anything
    // else in the diff means one position was hand-edited.
    const canonical = REKEY_DRIFTED_FACTS_SQL.subject
      .replaceAll("subject_key", "«key»")
      .replaceAll("'subject'", "«pos»")
      .replaceAll("f.subject", "f.«surface»");
    for (const position of SLOT_POSITIONS) {
      const normalized = REKEY_DRIFTED_FACTS_SQL[position]
        .replaceAll(`${position}_key`, "«key»")
        .replaceAll(`'${position}'`, "«pos»")
        .replaceAll(`f.${position}`, "f.«surface»");
      expect(normalized, `the ${position} re-key is not the same statement as the subject one`).toBe(
        canonical,
      );
    }
  });
});
