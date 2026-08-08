/**
 * The blast-radius preview against a real schema (#5025 / #5086, ADR-0037 §6).
 *
 * `vocabulary-preview.test.ts` pins the SQL shapes and the refusals. This file
 * is where the only claim that actually matters can be made, because it is a
 * claim about two statements agreeing with a WRITE:
 *
 *   **the preview equals what the decision actually does.**
 *
 * ## What "equals" means here, stated precisely because the AC's wording is loose
 *
 * #5025's AC reads *"the preview total equals what the re-key actually
 * changes"*. Taken literally that compares a PAIR count to a ROW count, which
 * are different quantities — the re-key moves keys, the preview counts
 * supersedable pairs. The property that carries the AC's intent, and the one
 * asserted below, is the DELTA:
 *
 *   `supersedesAfter − supersedesBefore  ==  preview.arming.total`
 *   `supersedesBefore − supersedesAfter  ==  preview.disarming.total`
 *
 * measured through `WILL_SUPERSEDE_TOTAL_SQL` — the publish gate's own
 * disclosure, not a restatement — taken before and after the real decide seam
 * runs. That is one level up from `oversight.ts:800-803`: the preview and the
 * transaction agree because the preview PREDICTED the transaction, rather than
 * because both were built from the same string.
 *
 * ## The fixtures are landed under the EMPTY vocabulary, deliberately
 *
 * `vocabulary-rekey-pg.test.ts`'s reason, and it is the same trap: landing rows
 * under the post-approval vocabulary makes the re-key a no-op and every
 * assertion vacuously true.
 *
 * ## A fixture per arm of the request union
 *
 * #5030's lesson — *a disjunction needs a fixture per arm, and the gap is found
 * by MEASURING rather than by reading*. The union has four arms
 * (alias-approval, alias-removal, cardinality-flip, cardinality-removal) and
 * three positions, and the object position's arm is a structural claim rather
 * than a count.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityVocabulary, type SlotPosition } from "@atlas/api/lib/brain/identity";
import {
  decideAliasProposal,
  proposeAliasEdge,
} from "@atlas/api/lib/brain/vocabulary-decide";
import { declarePredicateCardinality } from "@atlas/api/lib/brain/cardinality";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import {
  WILL_SUPERSEDE_TOTAL_SQL,
} from "@atlas/api/lib/brain/oversight";
import {
  STORED_COLLISION_EXPRS,
  cardinalityHeldBackCountSql,
  supersedingDraftPredicate,
  supersessionCollisionPredicate,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { loadBlastRadius } from "@atlas/api/lib/brain/vocabulary-preview";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-preview-5086";

describeIfPg("the blast-radius preview against a real schema (#5086)", () => {
  let pool: Pool;
  const schemaName = `brain_5086_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await pool.query("DELETE FROM brain_predicate_cardinality");
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
    const sourceId = `C01:5086.${episodeSeq++}`;
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
   * Land one claim through the real ingest stage, under the EMPTY vocabulary.
   *
   * ⚠️ **Asserts the object parses to a COMPARABLE VALUE, and that assertion is
   * the difference between this suite and a vacuous one.** The collision
   * requires the two objects to be PROVABLY DIFFERENT (#5030), which is
   * `object_cmp <> object_cmp` under a shared known tag — and a bare name
   * ABSTAINS, leaving `object_cmp` NULL. Measured: `bob`, `carol`, `berlin`,
   * `munich` all abstain; `10`, `20`, `10 USD`, `12 USD` resolve.
   *
   * A fixture built from names therefore collides with NOTHING, so every
   * before/after count is 0 and every assertion of the form
   * `after - before === radius.total` holds at `0 === 0`. Four tests in the
   * first cut of this file were exactly that, and the object-position test was
   * the dangerous one: it "proved" an object alias arms nothing while the
   * fixture made every alias arm nothing.
   */
  async function land(claim: Claim, workspaceId = WS): Promise<string> {
    const episode = await seedEpisode(workspaceId);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [{ ...claim, predicateCardinality: "single" }],
      producer: "preview-5086",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    expect(
      report.outcomes[0],
      `"${claim.subject} ${claim.predicate} ${claim.object}" was refused, not landed`,
    ).not.toMatchObject({ kind: "blocked" });
    const { rows } = await pool.query<{ id: string; object_cmp: string | null }>(
      `SELECT id::text AS id, object_cmp FROM brain_facts
        WHERE workspace_id = $1 AND subject = $2 AND predicate = $3 AND object = $4`,
      [workspaceId, claim.subject, claim.predicate, claim.object],
    );
    expect(rows).toHaveLength(1);
    expect(
      rows[0]!.object_cmp,
      `"${claim.object}" abstained — it has no comparable value, so this row can never be ` +
        "provably different from anything and every collision count below would be a vacuous 0",
    ).not.toBeNull();
    return rows[0]!.id;
  }

  /** Promote one row to `published` — the side a draft supersedes. */
  async function publish(id: string): Promise<void> {
    await pool.query(`UPDATE brain_facts SET status = 'published' WHERE id = $1::uuid`, [id]);
  }

  /** The publish gate's OWN disclosure — never a restatement of it. */
  async function supersedesNow(workspaceId = WS): Promise<number> {
    const { rows } = await pool.query(WILL_SUPERSEDE_TOTAL_SQL, [workspaceId]);
    return Number((rows[0] as { will_supersede_total: number }).will_supersede_total);
  }

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

  async function removeEdge(proposalId: string, workspaceId = WS): Promise<void> {
    const decided = await decideAliasProposal({
      id: proposalId,
      workspaceId,
      decision: "rejected",
      approver: { kind: "human", ctx: owner(workspaceId) },
    });
    expect(decided).toMatchObject({ kind: "rejected", removedEdge: true });
  }

  /**
   * Curate one canonical predicate `single`, through the real seam.
   *
   * ONE call, not propose-then-decide: `declarePredicateCardinality` is the
   * direct-human-authoring path (ADR-0037 §3(d)3) and writes `approved` in one
   * step, *because the human IS the approval*. Routing the fixture through
   * `decidePredicateCardinality` instead would be exercising the PRODUCER path,
   * which writes `pending` — and a pending row is deliberately invisible to
   * `cardinalitySingleSql`, so every fixture below would have silently
   * collided with nothing.
   */
  async function curate(predicateSurface: string, workspaceId = WS): Promise<void> {
    const declared = await declarePredicateCardinality(pool, workspaceId, {
      predicateKey: predicateSurface,
      cardinality: "single",
      authoredBy: "user-owner",
    });
    expect(declared.ok, `declaring ${predicateSurface} single failed`).toBe(true);
  }

  // ── 1. the parity property ──────────────────────────────────────────────

  describe("the preview equals what the decision actually does", () => {
    it("an ALIAS approval arms exactly the pairs the preview promised", async () => {
      // Two spellings of one predicate, in one subject slot, with provably
      // different objects. Today they key apart, so nothing collides.
      const published = await land({
        subject: "widget",
        predicate: "is priced at",
        object: "10 USD",
      });
      await publish(published);
      await land({ subject: "widget", predicate: "priced at", object: "12 USD" });
      // The merged slot's canonical predicate must be curated, or the
      // cardinality gate holds the pair back and the merge arms nothing.
      await curate("priced at");

      const before = await supersedesNow();
      const radius = await loadBlastRadius(pool, owner(), {
        kind: "alias-approval",
        position: "predicate",
        fromNorm: "is priced at",
        toNorm: "priced at",
      });

      await approve("is priced at", "priced at");
      const after = await supersedesNow();

      // THE property. Not "the preview returned a plausible number" — the
      // preview predicted the transaction, and the transaction is measured
      // through its own disclosure statement.
      expect(after - before).toBe(radius.arming.total);
      // And the preview was not trivially zero, which would satisfy the
      // equation while proving nothing.
      expect(radius.arming.total).toBeGreaterThan(0);
      expect(radius.disarming.total).toBe(0);
    }, PG_TEST_TIMEOUT_MS);

    it("…and follows the CARDINALITY lookup to the merged slot (the compound case)", async () => {
      // ⚠️ The fixture the test above CANNOT express, found by mutation: there,
      // the moving row is the PUBLISHED one and the draft already sits on the
      // curated predicate, so the stored cardinality lookup and the
      // re-pointed one agree and deleting the re-point kills nothing.
      //
      // Here the DRAFT is the row that moves. `is priced at` is uncurated, so
      // the stored lookup says "not single" and the pair cannot collide today;
      // `priced at` IS curated, so after the merge it can. This is exactly the
      // case ADR-0037 §6's amendment exists for — *supersession is armed for
      // claims that were safe a moment earlier* — and a bundle that moved only
      // the slot arm reports it as zero.
      const published = await land({ subject: "widget", predicate: "priced at", object: "10 USD" });
      await publish(published);
      await land({ subject: "widget", predicate: "is priced at", object: "12 USD" });
      await curate("priced at");

      const before = await supersedesNow();
      expect(before, "the draft's own predicate is uncurated, so nothing collides yet").toBe(0);

      const radius = await loadBlastRadius(pool, owner(), {
        kind: "alias-approval",
        position: "predicate",
        fromNorm: "is priced at",
        toNorm: "priced at",
      });
      await approve("is priced at", "priced at");
      const after = await supersedesNow();

      expect(after - before).toBe(radius.arming.total);
      expect(radius.arming.total).toBeGreaterThan(0);
    }, PG_TEST_TIMEOUT_MS);

    it("…and resolves the target through an EXISTING chain, not to the norm as typed", async () => {
      // ⚠️ Mutation survivor: substituting `toNorm` instead of its effective
      // target passes every single-edge fixture, because with no chain the two
      // are the same string. `approvalKeyExpr`'s ⚠️ names this; only a
      // two-level chain measures it.
      //
      // `priced at → unit price` is already approved, so approving
      // `is priced at → priced at` lands the merged population on **unit
      // price**, and a preview keyed on `priced at` computes a slot the re-key
      // never writes.
      const published = await land({ subject: "widget", predicate: "unit price", object: "10 USD" });
      await publish(published);
      await land({ subject: "widget", predicate: "is priced at", object: "12 USD" });
      await curate("unit price");
      await approve("priced at", "unit price");

      const before = await supersedesNow();
      expect(before, "the draft is not yet in the merged slot").toBe(0);

      const radius = await loadBlastRadius(pool, owner(), {
        kind: "alias-approval",
        position: "predicate",
        fromNorm: "is priced at",
        toNorm: "priced at",
      });
      await approve("is priced at", "priced at");
      const after = await supersedesNow();

      expect(after - before).toBe(radius.arming.total);
      expect(radius.arming.total).toBeGreaterThan(0);
    }, PG_TEST_TIMEOUT_MS);

    it("an ALIAS removal disarms exactly the pairs the preview promised", async () => {
      const published = await land({
        subject: "widget",
        predicate: "is priced at",
        object: "10 USD",
      });
      await publish(published);
      await land({ subject: "widget", predicate: "priced at", object: "12 USD" });
      await curate("priced at");
      const proposalId = await approve("is priced at", "priced at");

      const before = await supersedesNow();
      expect(before, "the fixture must be colliding before the removal").toBeGreaterThan(0);

      const radius = await loadBlastRadius(pool, owner(), {
        kind: "alias-removal",
        position: "predicate",
        fromNorm: "is priced at",
      });

      await removeEdge(proposalId);
      const after = await supersedesNow();

      // The mirror. This is the arm a key-to-key substitution gets WRONG —
      // `REKEY_DRIFTED_FACTS_SQL`'s header says why, and the removal
      // counterfactual re-derives from the surface for exactly this test.
      expect(before - after).toBe(radius.disarming.total);
      expect(radius.disarming.total).toBeGreaterThan(0);
      expect(radius.arming.total).toBe(0);
    }, PG_TEST_TIMEOUT_MS);

    it("a CARDINALITY flip arms exactly the pairs the preview promised", async () => {
      const published = await land({ subject: "alice", predicate: "headcount is", object: "10" });
      await publish(published);
      await land({ subject: "alice", predicate: "headcount is", object: "20" });

      // ⚠️ A SECOND collidable-but-uncurated predicate, and it is not scenery.
      // Mutation survivor: forcing the flip's cardinality gate to `TRUE`
      // globally — rather than scoping it to the one key — passes every
      // single-predicate fixture, because with nothing else in the workspace
      // "all predicates" and "this predicate" are the same set. This row is
      // what makes the flip's scoping measurable.
      const otherPublished = await land({ subject: "dan", predicate: "budget is", object: "100 USD" });
      await publish(otherPublished);
      await land({ subject: "dan", predicate: "budget is", object: "200 USD" });

      const before = await supersedesNow();
      expect(before, "an uncurated predicate supersedes nothing").toBe(0);

      const radius = await loadBlastRadius(pool, owner(), {
        kind: "cardinality-flip",
        predicateSurface: "headcount is",
      });

      await curate("headcount is");
      const after = await supersedesNow();

      expect(after - before).toBe(radius.arming.total);
      expect(radius.arming.total).toBeGreaterThan(0);
      // ⚠️ The flip is the ONLY kind whose `total` and `pairs` come from two
      // DIFFERENT statements, so it is the only one where they can disagree.
      // If `cardinalityFlipExpr` drifted `OR` → `AND`, the delta returns no
      // pairs while the imported total stays positive → `withheld = total`,
      // i.e. "N pairs are hidden from you by ACL" shown to an owner who can see
      // everything. Nothing else in the suite would fail.
      expect(radius.arming.pairs).toHaveLength(radius.arming.total);
      expect(radius.arming.withheld).toBe(0);
      expect(radius.arming.countsConsistent).toBe(true);
      // ⚠️ NOT `expect(await supersedesNow()).toBe(after)` — that re-read the
      // same query against an unchanged database and compared it to itself. The
      // scoping is already caught by the equality above (a globally-TRUE gate
      // makes `arming.total` 2 against a real delta of 1); what is asserted here
      // is the complement, that the OTHER predicate's pair is still held back.
      const otherHeld = await pool.query(
        cardinalityHeldBackCountSql("d.predicate_key = $2"),
        [WS, "budget is"],
      );
      expect(Number((otherHeld.rows[0] as { held_back: number }).held_back)).toBeGreaterThan(0);
    }, PG_TEST_TIMEOUT_MS);
  });

  // ── 2. the imported statement and the delta agree ───────────────────────

  it("the imported held-back count and the delta spelling agree on a real corpus", async () => {
    // #5025's handoff requires the flip's total to IMPORT
    // `CARDINALITY_HELD_BACK_COUNT_SQL` rather than re-derive the cardinality
    // half. That reuse is only meaningful if the two spellings answer the same
    // question — asserted here rather than claimed in a docstring.
    const published = await land({ subject: "alice", predicate: "headcount is", object: "10" });
    await publish(published);
    await land({ subject: "alice", predicate: "headcount is", object: "20" });
    const otherPublished = await land({ subject: "dan", predicate: "budget is", object: "100 USD" });
    await publish(otherPublished);
    await land({ subject: "dan", predicate: "budget is", object: "200 USD" });

    const imported = await pool.query(cardinalityHeldBackCountSql("d.predicate_key = $2"), [
      WS,
      "headcount is",
    ]);
    const importedTotal = Number((imported.rows[0] as { held_back: number }).held_back);

    // The delta spelling, built from the same public seam the preview uses.
    const flipExprs = {
      ...STORED_COLLISION_EXPRS,
      cardinalitySingle: (alias: string) =>
        `(${alias}.predicate_key = $2 OR ${STORED_COLLISION_EXPRS.cardinalitySingle(alias)})`,
    };
    const delta = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM brain_facts d
         JOIN brain_facts p ON ${supersessionCollisionPredicate("d", "p", flipExprs)}
        WHERE d.workspace_id = $1
          AND ${supersedingDraftPredicate("d")}
          AND (${supersessionCollisionPredicate("d", "p")}) IS NOT TRUE
          AND d.predicate_key = $2`,
      [WS, "headcount is"],
    );
    const deltaTotal = Number((delta.rows[0] as { n: number }).n);

    expect(importedTotal).toBe(deltaTotal);
    // Non-vacuous, and scoped: the OTHER predicate's collidable pair must not
    // be in either count, or the agreement would hold for the wrong reason.
    expect(importedTotal).toBeGreaterThan(0);
  }, PG_TEST_TIMEOUT_MS);

  // ── 3. the object position, as a structural claim ───────────────────────

  it("an OBJECT-position alias arms nothing, and the preview says why rather than returning 0", async () => {
    // The finding the design pass did not have: the collision joins on
    // `subject_key`, `predicate_key` and `object_cmp` — `object_key` is nowhere
    // in it. Proved against the real schema by merging two object surfaces and
    // measuring the gate's own disclosure across the approval.
    // ⚠️ TYPED objects, and this is the whole design of the test. With
    // abstaining objects (`nova` / `project atlas`) the pair could not collide
    // for a reason that has nothing to do with the object POSITION, so
    // `after === before` would hold at `0 === 0` and prove nothing. Typed
    // objects make the pair genuinely collidable, so the count is positive on
    // BOTH sides and the invariance is a real measurement.
    const published = await land({ subject: "widget", predicate: "ships in", object: "10" });
    await publish(published);
    await land({ subject: "widget", predicate: "ships in", object: "20" });
    await curate("ships in");

    const before = await supersedesNow();
    expect(before, "the fixture must be genuinely collidable, or the invariance is vacuous").toBeGreaterThan(0);

    const radius = await loadBlastRadius(pool, owner(), {
      kind: "alias-approval",
      position: "object",
      fromNorm: "10",
      toNorm: "20",
    });
    await approve("10", "20", "object");
    const after = await supersedesNow();

    // The structural claim, measured: merging two object SURFACES moved
    // `object_key`, which the collision does not read — so the supersession
    // count is unchanged, and unchanged at a NON-ZERO value.
    expect(after).toBe(before);
    // ...and the preview reported a REASON rather than a zero, which is the
    // whole point — "0 pairs" and "this position cannot produce pairs" are the
    // same number and opposite facts.
    expect(radius.structurallyEmpty).toBe("object-position");
  }, PG_TEST_TIMEOUT_MS);

  // ── 4. the IS NOT TRUE equivalence, measured rather than claimed ────────

  it("a `{\"source\": null}` pair is excluded by the JOIN, not by the exclusion arm", async () => {
    // ⚠️ The falsifier for an OVERCLAIM this module's docstrings originally
    // made. `supersedableTierSql` is SQL NULL for this provenance, the shape
    // that makes `NOT (…)` the repo's recurring bug — but the tier guard is
    // carried by the JOIN as well, so such a pair never reaches the exclusion
    // and the two spellings are extensionally identical.
    //
    // ⚠️⚠️ The FIRST cut of this test was vacuous, and vacuous in the subtler
    // way: it landed both rows under `priced at` and then previewed
    // `is priced at → priced at`. No row was keyed `is priced at`, so the
    // hypothetical CASE was the identity on every row, `joinExprs ≡
    // excludeExprs`, and `arming.total === 0` held BY CONSTRUCTION — with the
    // tier guard deleted, with the exclusion spelled `NOT (…)`, and with
    // `provenance` untouched. It measured nothing about the preview.
    //
    // The shape below is a genuine cross-vocabulary pair, asserted TWICE on the
    // same fixture: positive before the provenance mutation, zero after. That
    // is what makes the zero attributable to the tier guard.
    const published = await land({ subject: "widget", predicate: "is priced at", object: "10 USD" });
    await publish(published);
    const draft = await land({ subject: "widget", predicate: "priced at", object: "12 USD" });
    await curate("priced at");

    const request = {
      kind: "alias-approval",
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
    } as const;

    // The positive control: this pair IS armable while both rows carry a
    // recognised source.
    const before = await loadBlastRadius(pool, owner(), request);
    expect(
      before.arming.total,
      "the fixture must be armable before the provenance is nulled, or the zero below proves nothing",
    ).toBeGreaterThan(0);

    await pool.query(
      `UPDATE brain_facts SET provenance = jsonb_set(provenance, '{source}', 'null'::jsonb)
        WHERE id = ANY($1::uuid[])`,
      [[published, draft]],
    );

    // ⚠️ NO separate "is the tier arm NULL" probe here, and its absence is
    // deliberate. Two earlier drafts tried one and both measured the wrong
    // thing: evaluating `supersessionCollisionPredicate` over this pair returns
    // FALSE rather than NULL, because the two rows sit in DIFFERENT predicate
    // slots until the alias is approved, so the identity arm is false and
    // `FALSE AND NULL` is FALSE. A probe that has to be set up differently from
    // the fixture it explains is measuring a different pair.
    //
    // The before/after on ONE fixture is the attribution, and it is stronger:
    // the only thing that changed between the two calls is the provenance.
    const after = await loadBlastRadius(pool, owner(), request);
    expect(after.arming.total).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // ── 4b. the subtree walk, past the seed ─────────────────────────────────

  it("a REMOVAL walks the whole subtree, not just the removed norm", async () => {
    // ⚠️ Every other removal fixture approves ONE edge, whose subtree is the
    // seed alone — so the recursive arm never returns a row in any test, in any
    // suite. Measured: reversing the walk's direction (`e.from_norm` →
    // `e.to_norm`) survives them all. This is the arm the whole "removal
    // re-derives from the SURFACE" design exists for.
    //
    // Chain: `list price → is priced at → priced at`. Removing `is priced at`'s
    // edge must return BOTH `is priced at` and its child `list price` to the
    // `is priced at` slot — the grandchild is the row a seed-only substitution
    // misses.
    const published = await land({ subject: "widget", predicate: "priced at", object: "10 USD" });
    await publish(published);
    await land({ subject: "widget", predicate: "list price", object: "12 USD" });
    await curate("priced at");

    await approve("is priced at", "priced at");
    await approve("list price", "is priced at");

    const before = await supersedesNow();
    expect(before, "the grandchild must be colliding through the chain").toBeGreaterThan(0);

    const radius = await loadBlastRadius(pool, owner(), {
      kind: "alias-removal",
      position: "predicate",
      fromNorm: "is priced at",
    });

    // The grandchild is in the disarming set — it resolves through the removed
    // norm even though no edge names it.
    expect(radius.disarming.total).toBe(before);
    expect(radius.disarming.countsConsistent).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  // ── 4c. the pair projection's orientation ───────────────────────────────

  it("a pair's draft label is the DRAFT's claim, not the published one", async () => {
    // ⚠️ No test anywhere asserted a pair's CONTENT — `radius.arming.pairs`
    // appeared zero times in this file. Measured: swapping `d.subject || …` for
    // `p.subject || …` in `draft_label` survives the entire suite, and the
    // preview would then tell an approver the superseded claim is the incoming
    // one — the disclosure read backwards, on the surface whose entire job is
    // the disclosure. `pairsSelect` is also the one projection NOT byte-pinned.
    const published = await land({ subject: "widget", predicate: "priced at", object: "10 USD" });
    await publish(published);
    await land({ subject: "widget", predicate: "is priced at", object: "12 USD" });
    await curate("priced at");

    const radius = await loadBlastRadius(pool, owner(), {
      kind: "alias-approval",
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
    });

    expect(radius.arming.pairs).toHaveLength(1);
    const pair = radius.arming.pairs[0]!;
    // The DRAFT is the incoming `12 USD` claim; the SUPERSEDED side is the
    // published `10 USD` one. Reversed, an approver reads the retirement
    // backwards.
    expect(pair.draftLabel).toBe("widget is priced at 12 USD");
    expect(pair.supersededLabel).toBe("widget priced at 10 USD");
    // And no key rides along on the projection.
    expect(JSON.stringify(pair)).not.toContain("_key");
  }, PG_TEST_TIMEOUT_MS);

  // ── 4d. a restricted reader ─────────────────────────────────────────────

  it("withholds a pair whose PUBLISHED side the reader cannot see, and counts it", async () => {
    // Nothing measured that the reader scoping works against real SQL — the
    // unit tests only assert `visible_to &&` appears as a substring.
    const published = await land({ subject: "widget", predicate: "priced at", object: "10 USD" });
    await publish(published);
    await land({ subject: "widget", predicate: "is priced at", object: "12 USD" });
    await curate("priced at");
    // Narrow the published row to an audience the reader below does not hold.
    await pool.query(`UPDATE brain_facts SET visible_to = ARRAY['audience:secret'] WHERE id = $1::uuid`, [
      published,
    ]);

    const restricted: BrainPrincipalContext = {
      origin: "authenticated",
      workspaceId: WS,
      userId: "user-restricted",
      role: "member",
      audienceIds: [],
    };
    const radius = await loadBlastRadius(pool, restricted, {
      kind: "alias-approval",
      position: "predicate",
      fromNorm: "is priced at",
      toNorm: "priced at",
    });

    // The supersession happens regardless of who is looking — the unscoped
    // total sees it...
    expect(radius.arming.total).toBe(1);
    // ...but the reader may not read the published side, so no pair is listed
    // and the difference is disclosed as `withheld` rather than omitted.
    expect(radius.arming.pairs).toHaveLength(0);
    expect(radius.arming.withheld).toBe(1);
    expect(radius.arming.countsConsistent).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  // ── 5. the fourth arm of the union ──────────────────────────────────────

  it("a CARDINALITY removal disarms exactly the pairs the preview promised", async () => {
    const published = await land({ subject: "alice", predicate: "headcount is", object: "10" });
    await publish(published);
    await land({ subject: "alice", predicate: "headcount is", object: "20" });
    await curate("headcount is");

    const before = await supersedesNow();
    expect(before, "the curated fixture must be colliding").toBeGreaterThan(0);

    const radius = await loadBlastRadius(pool, owner(), {
      kind: "cardinality-removal",
      predicateSurface: "headcount is",
    });
    expect(radius.disarming.total).toBe(before);
    expect(radius.arming.total).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  it("a SUBJECT-position alias arms pairs — the position the predicate fixtures cannot probe", async () => {
    // Round 2 of #5024's panel: a suite whose fixtures all share one value of a
    // parameter cannot probe that parameter at all. Every fixture above is at
    // the predicate position.
    const published = await land({ subject: "acme", predicate: "headcount is", object: "10" });
    await publish(published);
    await land({ subject: "acme corp", predicate: "headcount is", object: "20" });
    await curate("headcount is");

    const before = await supersedesNow();
    const radius = await loadBlastRadius(pool, owner(), {
      kind: "alias-approval",
      position: "subject",
      fromNorm: "acme corp",
      toNorm: "acme",
    });
    await approve("acme corp", "acme", "subject");
    const after = await supersedesNow();

    expect(after - before).toBe(radius.arming.total);
    expect(radius.arming.total).toBeGreaterThan(0);
  }, PG_TEST_TIMEOUT_MS);
});
