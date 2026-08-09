/**
 * The OBJECT-position blast radius against a real schema (#5088).
 *
 * `vocabulary-preview-pg.test.ts` measures the claim that an object alias arms
 * NO supersession — the collision never reads `object_key`. This file measures
 * the other half, which is the one #5025's 2026-08-08 checkpoint left open:
 * **what it does change instead.**
 *
 * ## Why this cannot be a stub suite
 *
 * Every assertion here turns on PostgreSQL's three-valued logic through
 * `objectSameSql` and `objectNotSameSql`, whose whole subtlety is which arms go
 * NULL. A hand-written fixture answering `{rows: [...]}` proves the TypeScript
 * around the statement, and nothing about the statement — and the statement is
 * the disclosure.
 *
 * ## The two sides are measured on fixtures chosen to SEPARATE them
 *
 * The obvious fixture makes them coincide, and a suite built on it would pass
 * with the tension side deleted. So there are two:
 *
 *   - **`Bob` / `Bobby`** — neither parses to a comparable value, so nothing
 *     proves them different. Merging their object keys makes the pair corroborate
 *     AND takes it out of tension. Both sides fire.
 *   - **`10` / `20`** — both parse, and `comparableDifferentSql` PROVES they
 *     differ. Merging the keys puts them in one slot and they stay contested:
 *     `objectSameSql`'s veto keeps them out of corroboration, and the tension
 *     arm's own `comparableDifferent` disjunct keeps them in tension. Neither
 *     side fires.
 *
 * That second case is the informative one and it is the reason the disclosure
 * carries two numbers rather than one: an approver reading *"3 pairs would agree,
 * 5 flags would go stale"* can see that two of the flagged contradictions survive
 * the merge, which a single number cannot say.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { loadBlastRadius, type BlastRadius } from "@atlas/api/lib/brain/vocabulary-preview";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-object-radius-5088";

function objectRadius(radius: BlastRadius): Extract<BlastRadius, { kind: "object-position" }> {
  expect(
    radius.kind,
    `expected an object-position radius, got ${JSON.stringify(radius)}`,
  ).toBe("object-position");
  if (radius.kind !== "object-position") throw new Error("unreachable");
  return radius;
}

describeIfPg("the object-position blast radius against a real schema (#5088)", () => {
  let pool: Pool;
  const schemaName = `brain_5088_obj_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_vocabulary_proposal");
    await pool.query("DELETE FROM brain_predicate_cardinality");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
  });

  const owner = (): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-owner",
    role: "owner",
    audienceIds: ["eng"],
  });

  /**
   * A reader entitled to nothing — the both-sides gate's negative control.
   *
   * ⚠️ `member`, NOT `admin`. An entitled workspace admin takes
   * `aclVisibilityClause`'s `audit-override` arm — workspace containment only —
   * so an admin "stranger" sees every row and the control is vacuous. Measured:
   * the first cut of this test used `admin` and the withheld count was 0.
   */
  const stranger = (): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-stranger",
    role: "member",
    audienceIds: [],
  });

  let episodeSeq = 0;
  /**
   * ⚠️ The default grant is `audience:eng`, NOT `org`.
   *
   * `ORG_PRINCIPAL` is the workspace-wide token — every member of the workspace
   * matches it — so a fixture granted `['org']` makes the reader-scoping control
   * vacuous. Measured: the first cut used `['org']` and the "stranger" saw every
   * pair with `withheld: 0`.
   */
  async function seedEpisode(
    visibleTo: readonly string[] = ["audience:eng"],
  ): Promise<ReconcileEpisodeRef> {
    const occurredAt = new Date("2026-06-21T09:00:00.000Z");
    const sourceId = `C01:5088obj.${episodeSeq++}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'evidence', $3::timestamptz, $4::text[])
       RETURNING id`,
      [WS, sourceId, occurredAt.toISOString(), visibleTo],
    );
    return {
      id: rows[0]!.id,
      workspaceId: WS,
      source: "slack",
      sourceId,
      sourceActor: "U123",
      occurredAt,
      visibleTo: [...visibleTo],
    };
  }

  /**
   * Land one claim through the real ingest stage, under the EMPTY vocabulary.
   *
   * ⚠️ Deliberately WITHOUT the sibling suite's "the object must parse to a
   * comparable value" assertion: half this file's fixtures depend on the object
   * ABSTAINING, which is exactly what makes the merge able to create agreement.
   * The assertion there guards a supersession count; here it would delete the
   * corroborating side's only fixture.
   */
  async function land(
    claim: { subject: string; predicate: string; object: string },
    visibleTo: readonly string[] = ["audience:eng"],
  ): Promise<string> {
    const episode = await seedEpisode(visibleTo);
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode,
      candidates: [{ ...claim, predicateCardinality: "multi" }],
      producer: "object-radius-5088",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    expect(
      report.outcomes[0],
      `"${claim.subject} ${claim.predicate} ${claim.object}" was refused, not landed`,
    ).not.toMatchObject({ kind: "blocked" });
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM brain_facts
        WHERE workspace_id = $1 AND subject = $2 AND predicate = $3 AND object = $4`,
      [WS, claim.subject, claim.predicate, claim.object],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }

  /** Write the advisory edge directly — reconcile's own gating is its test, not this one. */
  async function tensionEdge(fromId: string, toId: string): Promise<void> {
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
       VALUES ($1, 'in-tension-with', $2::uuid, $3::uuid)`,
      [WS, fromId, toId],
    );
  }

  const request = (fromNorm: string, toNorm: string) =>
    ({ kind: "alias-approval", position: "object", fromNorm, toNorm }) as const;

  // ── the corroborating side ──────────────────────────────────────────────

  it("⚠️ reports the CORROBORATION change rather than a zero, and never a supersession delta", async () => {
    // Neither object parses, so nothing proves them different — the merge is
    // able to create agreement. This is the fixture the whole disclosure exists
    // for, and #5025's checkpoint recorded that the alternative ("0 pairs") and
    // the truth ("this position cannot produce pairs") are the same number and
    // opposite facts.
    const bob = await land({ subject: "widget", predicate: "reports to", object: "Bob" });
    const bobby = await land({ subject: "widget", predicate: "reports to", object: "Bobby" });
    expect(bob).not.toBe(bobby);

    const radius = objectRadius(await loadBlastRadius(pool, owner(), request("bob", "bobby")));

    expect(radius.corroborating.total).toBe(1);
    // Empty on the removal's side: an approval only creates agreement. Without
    // this the swap could be a no-op and both sides would report the same set.
    expect(radius.separating.total).toBe(0);
    expect(radius.corroborating.pairs).toHaveLength(1);
    // ⚠️ SYMMETRIC pair fields. Reusing the supersession pair type would have put
    // `supersededLabel` on a claim nothing supersedes.
    const pair = radius.corroborating.pairs[0]!;
    expect(`${pair.leftLabel} | ${pair.rightLabel}`).toContain("Bob");
    expect(`${pair.leftLabel} | ${pair.rightLabel}`).toContain("Bobby");
    expect(radius.corroborating.countsConsistent).toBe(true);
    expect(radius.corroborating.withheld).toBe(0);
    // The floor and the persistence sentence are LITERALS so a renderer's copy
    // is assertable rather than merely intended.
    expect(radius.floor).toBe(true);
    expect(radius.staleEdgesPersist).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("POSITIVE CONTROL — a pair the store PROVES differs is on NEITHER side", async () => {
    // ⚠️ Without this the suite would pass with `objectSameSql`'s veto deleted
    // and with the tension side reduced to "the complement of corroboration".
    // `10` and `20` both parse, `comparableDifferentSql` is TRUE, so merging
    // their object keys puts two claims in one slot that the store has already
    // proven disagree — and they stay contested. That is the case an approver
    // most needs to not be told otherwise about.
    const ten = await land({ subject: "widget", predicate: "ships in", object: "10" });
    const twenty = await land({ subject: "widget", predicate: "ships in", object: "20" });
    await tensionEdge(ten, twenty);

    const radius = objectRadius(await loadBlastRadius(pool, owner(), request("10", "20")));

    expect(radius.corroborating.total).toBe(0);
    expect(radius.separating.total).toBe(0);
    // The tension edge EXISTS and is not counted: the pair remains rivals after
    // the merge, so nothing about it goes stale.
    expect(radius.tension.total).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // ── the tension side ────────────────────────────────────────────────────

  it("counts advisory edges the merge would make STALE — and they are not withdrawn", async () => {
    const bob = await land({ subject: "widget", predicate: "reports to", object: "Bob" });
    const bobby = await land({ subject: "widget", predicate: "reports to", object: "Bobby" });
    await tensionEdge(bob, bobby);

    const radius = objectRadius(await loadBlastRadius(pool, owner(), request("bob", "bobby")));
    expect(radius.tension.total).toBe(1);

    // ⚠️ THE claim the literal `staleEdgesPersist: true` stands for, measured:
    // the decision's write is a re-key of `object_key`, and nothing anywhere
    // deletes an `in-tension-with` edge. So after the merge the edge is still
    // there, contradicting two claims Atlas now treats as agreeing. A surface
    // that said "1 contradiction would be resolved" would be wrong about the
    // verb; the copy says the flag is left behind.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [WS],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("an edge whose facts are NOT both live is not counted", async () => {
    // A tension edge to a retracted claim is already stale for a different
    // reason, and reporting it here would inflate the number an approver reads
    // as "what this decision costs".
    const bob = await land({ subject: "widget", predicate: "reports to", object: "Bob" });
    const bobby = await land({ subject: "widget", predicate: "reports to", object: "Bobby" });
    await tensionEdge(bob, bobby);
    await pool.query(`UPDATE brain_facts SET invalidated_at = now() WHERE id = $1::uuid`, [bobby]);

    const radius = objectRadius(await loadBlastRadius(pool, owner(), request("bob", "bobby")));
    expect(radius.tension.total).toBe(0);
    expect(radius.corroborating.total).toBe(0);
  }, PG_TEST_TIMEOUT_MS);

  // ── the disclosure posture ──────────────────────────────────────────────

  it("⚠️ the pair sample is gated on BOTH claims, and the total is not", async () => {
    // `willSupersedePairsSql`'s rule, transferred: *"something you cannot see
    // agrees with X"* discloses half a claim's history to a reader the grant
    // excluded from the other half. The workspace-wide TOTAL is content-free and
    // stays sayable, which is what makes `withheld` mean something rather than
    // rendering as "nothing is hidden from you".
    await land({ subject: "widget", predicate: "reports to", object: "Bob" });
    await land({ subject: "widget", predicate: "reports to", object: "Bobby" });

    const seen = objectRadius(await loadBlastRadius(pool, owner(), request("bob", "bobby")));
    expect(seen.corroborating.total).toBe(1);
    expect(seen.corroborating.pairs).toHaveLength(1);
    expect(seen.corroborating.withheld).toBe(0);

    const hidden = objectRadius(await loadBlastRadius(pool, stranger(), request("bob", "bobby")));
    expect(hidden.corroborating.total, "the total is workspace-wide and content-free").toBe(1);
    expect(hidden.corroborating.pairs, "the sample is reader-scoped on both sides").toHaveLength(0);
    expect(hidden.corroborating.withheld, "a withheld count, never a silent omission").toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("a REMOVAL takes the same disclosure, re-derived from the surface", async () => {
    // `REKEY_DRIFTED_FACTS_SQL`'s header: removal is not well-defined key-to-key,
    // so the counterfactual walks the removed norm's subtree and re-derives from
    // the retained SURFACE. Landing the rows under the empty vocabulary and then
    // approving is what makes the removal's substitution non-trivial — the same
    // trap `vocabulary-rekey-pg.test.ts` names.
    await land({ subject: "widget", predicate: "reports to", object: "Bob" });
    await land({ subject: "widget", predicate: "reports to", object: "Bobby" });
    await pool.query(
      `INSERT INTO brain_vocabulary_edge
         (workspace_id, slot_position, from_norm, to_norm, approved_by, approved_at)
       VALUES ($1, 'object', 'bob', 'bobby', 'user-owner', now())`,
      [WS],
    );
    await pool.query(
      `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
       VALUES ($1, 'object', 'bob', 'bobby')`,
      [WS],
    );
    await pool.query(
      `UPDATE brain_facts SET object_key = 'bobby' WHERE workspace_id = $1 AND object = 'Bob'`,
      [WS],
    );

    const radius = objectRadius(
      await loadBlastRadius(pool, owner(), {
        kind: "alias-removal",
        position: "object",
        fromNorm: "bob",
      }),
    );
    // ⚠️ THE defect this fixture found. The delta was one-sided at first, so a
    // removal — which can only ever SPLIT — came back as three zeros, i.e.
    // *"this changes nothing about what agrees"* for the decision whose whole
    // job is splitting. `separating` is the half that was missing.
    expect(radius.separating.total).toBe(1);
    // Empty on the other side BY CONSTRUCTION: splitting a merged norm apart
    // cannot create agreement. Asserted rather than assumed, because a delta
    // whose two sides both fire means the swap is not a swap.
    expect(radius.corroborating.total).toBe(0);
    expect(radius.subtreeTruncated).toBe(false);
  }, PG_TEST_TIMEOUT_MS);
});
