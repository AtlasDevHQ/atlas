/**
 * The drift re-key, the identity-mutation lock, and the supersede stamp's
 * collision re-check (#5024, ADR-0037 §7).
 *
 * Everything here needs a real Postgres and most of it needs TWO connections.
 * That is not a preference — three of the four claims this slice makes are about
 * what happens BETWEEN two statements, and a transaction double cannot be wrong
 * about an interleaving it does not have.
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
 *   4. **The locks** — that publish and the decide seam serialize on one
 *      advisory namespace, and that a decide transaction now rewriting
 *      `brain_facts` completes beside a concurrent writer of the same table.
 *      NOT that the 5022 → 5024 order is deadlock-free; see the last section.
 *
 * ## Mutation table
 *
 * Nineteen mutations, all nineteen caught. Regenerated in ONE pass against the
 * final tree rather than edited row by row — #5022's review found numbers
 * carried forward under a header claiming they had been re-measured, twice, so
 * the harness applies each mutation, runs all three suites, records the first
 * failing test, and reverts. The "caught by" column is that recorded name, not
 * an author's guess about which test ought to have caught it.
 *
 * Three suites are in scope: this one, `vocabulary-decide-pg.test.ts` (the lock
 * ORDER and the column-scoped allowlist assertion), and
 * `content-mode/adapters/__tests__/brain-facts.test.ts` (the publish lock and
 * the two stamp arbitrations).
 *
 * | # | Mutation | First test to die |
 * |---|---|---|
 * | 1 | `rekeyDriftedFacts` call deleted from `approveProposal` | an approval re-keys an existing fact onto the target the new vocabulary decides |
 * | 2 | `rekeyDriftedFacts` call deleted from `rejectProposal` | a REMOVAL returns each row to the target the post-removal vocabulary decides |
 * | 3 | re-key gains `AND f.invalidated_at IS NULL` | covers TOMBSTONED rows |
 * | 4 | re-key gains `AND f.valid_to IS NULL` | covers SUPERSEDED rows |
 * | 5 | re-key gains `, updated_at = now()` | does NOT stamp `updated_at` |
 * | 6 | re-key's workspace scope weakened to `OR TRUE` | the allowlisted decide seam writes the identity keys and NO other gated column |
 * | 7 | every position uses the `subject` columns | an approval re-keys an existing fact onto the target the new vocabulary decides |
 * | 8 | outer `identityKeySql` dropped from the assignment | re-norms the vocabulary's answer rather than trusting it |
 * | 9 | closure subquery's position pinned to `'predicate'` | every position's re-key statement is generated from the same expression |
 * | 10 | `COALESCE(closure, norm)` → the closure alone | …and does NOT move a row the approval says nothing about (the control) |
 * | 11 | `EXISTS` arm removed from the collision stamp | stamps the rival when the collision still holds (the positive control) |
 * | 12 | `EXISTS` arm's `$3` → `$2` | stamps the rival when the collision still holds (the positive control) |
 * | 13 | collision predicate → `TRUE` inside the `EXISTS` | does NOT stamp when the collision was de-merged between the SELECT and the UPDATE |
 * | 14 | publish's identity-lock call deleted | takes the identity-mutation lock BEFORE reading the drafts |
 * | 15 | publish's namespace → `VOCABULARY_LOCK_NAMESPACE` (5022) | takes the identity-mutation lock BEFORE reading the drafts |
 * | 16 | `lockIdentityMutation` order flipped (5024 before 5022) | decide locks first |
 * | 17 | `lexicalNormSql`'s `translate()` → `lower()` | `lexicalNormSql` agrees with `lexicalNorm` on every corpus row |
 * | 18 | `chr(11)` dropped from the separator class | `lexicalNormSql` agrees with `lexicalNorm` on every corpus row |
 * | 19 | `identityKeySql`'s `NULLIF(…, '')` dropped | re-norms the vocabulary's answer rather than trusting it |
 *
 * ## What the pass found, which is the part worth carrying
 *
 * The FIRST run had **18 of 19**, and the survivor was #8 — dropping the outer
 * `identityKeySql` left every other test green. The corpus could not reach it:
 * `approveAliasEdge` re-norms both endpoints, so every closure row written
 * through the seam already holds a norm and the outer call is a no-op on all of
 * them. The defense is real and reachable from outside the seam (0189's CHECKs
 * do not constrain `effective_target` to being a norm, and the region import
 * rebuilds that table), so the answer was a test that writes the two relations
 * directly — `re-norms the vocabulary's answer rather than trusting it`.
 *
 * Recorded rather than smoothed over, because the general shape recurs: **a
 * fixture built entirely through the sanctioned seam cannot falsify the guards
 * that exist for writers which bypass it.**
 *
 * ## What this suite does NOT cover, stated so the 19 are not over-read
 *
 * The 5022 → 5024 ORDER is asserted as an invariant in
 * `vocabulary-decide-pg.test.ts` (row 16), not provoked as a deadlock. Every
 * actor takes its advisory locks before touching rows, so no wait-for cycle
 * exists for either ordering today — the inverted order is a latent hazard, not
 * a reachable one, and no interleaving here would expose it. #5022's review is
 * explicit that an interleaving which cannot form a cycle passes against a
 * broken implementation, so claiming otherwise would be the same mistake one
 * slice later.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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
  removeAliasEdge,
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

  it("is workspace-scoped", async () => {
    const mine = await land(WS, { subject: "widget", predicate: "is priced at", object: "nine" });
    const theirs = await land(OTHER_WS, {
      subject: "widget",
      predicate: "is priced at",
      object: "nine",
    });

    await approve("is priced at", "priced at");

    expect((await readFact(mine)).predicate_key).toBe("priced at");
    expect(
      (await readFact(theirs)).predicate_key,
      "the re-key crossed a workspace boundary — one tenant's alias decision re-keyed another's corpus",
    ).toBe("is priced at");
  });

  it("leaves a surface that norms away with a NULL key, never the empty string", async () => {
    // `identityKeySql`'s `NULLIF(…, '')`. A stored `''` is the ONE key value that
    // joins every other degenerate row, so two unrelated placeholder claims would
    // occupy one slot and publishing either would stamp `valid_to` on the other.
    const id = await land(WS, { subject: "widget", predicate: "is priced at", object: "-" });
    expect((await readFact(id)).object_key).toBeNull();

    await approve("is priced at", "priced at");

    const row = await readFact(id);
    expect(row.predicate_key).toBe("priced at");
    expect(row.object_key).toBeNull();
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
   * The de-merge runs on the SAME connection, which is what makes this a real
   * interleaving rather than a lock test: the advisory lock is irrelevant to
   * whether the UPDATE is correct STANDALONE, and standalone correctness is
   * precisely the property `DRAFT_FACTS_SQL`'s header argues must not depend on
   * the lock.
   */
  async function targetsThenStamp(
    draftIds: readonly string[],
    demerge: boolean,
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
        await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, WS]);
        const removed = await removeAliasEdge(client, WS, "predicate", "ships on");
        expect(removed).toBe(true);
        await client.query(REKEY_DRIFTED_FACTS_SQL.predicate, [WS]);
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
  async function seedCollidingPair(): Promise<{ draftId: string; publishedId: string }> {
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
    await approve("ships on", "delivery date");
    const p = await readFact(publishedId);
    const d = await readFact(draftId);
    expect(p.predicate_key).toBe("delivery date");
    expect(d.predicate_key).toBe("delivery date");
    return { draftId, publishedId };
  }

  it("stamps the rival when the collision still holds (the positive control)", async () => {
    const { draftId, publishedId } = await seedCollidingPair();
    const stamped = await targetsThenStamp([draftId], false);
    expect(stamped).toEqual([publishedId]);
    expect((await readFact(publishedId)).valid_to).not.toBeNull();
  });

  it("does NOT stamp when the collision was de-merged between the SELECT and the UPDATE", async () => {
    const { draftId, publishedId } = await seedCollidingPair();

    const stamped = await targetsThenStamp([draftId], true);

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

  it("publish and the decide seam serialize on the identity-mutation namespace", async () => {
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
      const blocked = waiter.query(IDENTITY_MUTATION_LOCK_SQL, [
        IDENTITY_MUTATION_LOCK_NAMESPACE,
        WS,
      ]);

      // Wait for the waiter to actually be registered as blocked rather than
      // sleeping a fixed interval and hoping.
      const observer = await pool.connect();
      try {
        let ungranted = 0;
        for (let attempt = 0; attempt < 100 && ungranted === 0; attempt++) {
          const { rows } = await observer.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND classid = $1`,
            [IDENTITY_MUTATION_LOCK_NAMESPACE],
          );
          ungranted = Number(rows[0]?.n ?? 0);
          if (ungranted === 0) await new Promise((r) => setTimeout(r, 20));
        }
        expect(
          ungranted,
          "the second session took the identity-mutation lock while the first still held it",
        ).toBe(1);
      } finally {
        observer.release();
      }

      await holder.query("COMMIT");
      await blocked; // resolves once the lock is released — hangs the test if not
      await waiter.query("COMMIT");
    } finally {
      holder.release();
      waiter.release();
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
    // 5022 → 5024 order, and it is not written as though it does. Every actor
    // in the system takes its advisory locks BEFORE it touches rows: the
    // importer takes 5022 then writes, publish takes 5024 then writes, and the
    // decide seam takes both then re-keys. With no actor holding rows while
    // asking for a lock, no wait-for cycle exists for either ordering — so the
    // inverted order is a latent hazard rather than a reachable one today, and
    // it is pinned as an INVARIANT in `vocabulary-decide-pg.test.ts` instead.
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
        // The importer's own ordering: the vocabulary lock, THEN rows.
        await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, WS]);
        await client.query(
          `UPDATE brain_facts SET status = 'published'
            WHERE workspace_id = $1 AND status = 'draft'`,
          [WS],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
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
