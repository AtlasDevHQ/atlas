/**
 * The enrollment surface against a real Postgres (#5196, ADR-0039).
 *
 * ## The two claims that need a database, and why the doubles cannot own them
 *
 * **(a) The producer's reach is EMPTY for an unenrolled dimension, and NOT empty
 * for an enrolled sibling in the same run.** The negative alone is worthless and
 * the AC says so: an enrollment read that returned nothing at all — a broken
 * query, a wrong workspace, a table that was never created — satisfies *"the
 * unenrolled pair is out of reach"* perfectly. Every negative assertion below
 * therefore sits beside a positive control taken from the same
 * {@link loadProducerReach} call.
 *
 * The sharpest version is the pair-versus-entity one. `accounts` IS enrolled
 * — twice — and `accounts / status` is still out of reach, because the unit is
 * the PAIR. An implementation that keyed the reach on the entity would pass a
 * test that only checked an entirely unenrolled entity, and would hand the
 * producer every column of every enrolled table: the exact sweep ADR-0039
 * exists to prevent, reintroduced one column of the primary key at a time.
 *
 * **(b) Un-enrolling does not delete or invalidate an already-published fact.**
 * This is the one an in-memory double structurally cannot answer, because the
 * thing being asserted is that a statement did NOT reach a table it never names.
 * A fake `unenrollPair` scripted to leave facts alone is asserting its own
 * script (#5000's trap). The published fact here is seeded through real SQL and
 * re-read through real SQL, with a positive control on the same call proving the
 * un-enrolment actually happened — otherwise "the fact survived" is satisfied by
 * an un-enrolment that did nothing at all.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import {
  InvalidEnrollmentPairError,
  enrollPair,
  listEnrollments,
  loadProducerReach,
  unenrollPair,
} from "@atlas/api/lib/brain/enrollment";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-enrollment";
const OTHER_WORKSPACE = "ws-enrollment-other";

describeIfPg("enrollment — the warehouse producer's reach (#5196)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5196_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    await pool.query(`DELETE FROM brain_enrollment`);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Enroll directly, bypassing the seam, so the seam's own reads are the subject. */
  async function seedEnrollment(
    workspaceId: string,
    entity: string,
    dimension: string,
    enrolledBy = "user-1",
  ) {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, entity, dimension, enrolledBy],
    );
  }

  /**
   * A PUBLISHED fact, inserted directly.
   *
   * Direct rather than through the extractor because the subject is what
   * un-enrolment does to a fact that is already through the review gate, and
   * driving the whole pipeline to reach that state would put a dozen unrelated
   * failure modes between the fixture and the assertion.
   */
  async function seedPublishedFact(claim: {
    subject: string;
    predicate: string;
    object: string;
  }): Promise<string> {
    const { rows: episodeRows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'warehouse', $2, 'producer', 'evidence', now(), ARRAY['org'])
       RETURNING id`,
      [WORKSPACE, `ep-${claim.subject}-${claim.predicate}`],
    );
    const episodeId = episodeRows[0]!.id;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance,
          visible_to, status, subject_key, predicate_key, object_key)
       VALUES ($1, $2, $3, $4, $5, '{"source":"warehouse","actor":"producer"}'::jsonb,
               ARRAY['org'], 'published', $6, $7, $8)
       RETURNING id`,
      [
        WORKSPACE,
        claim.subject,
        claim.predicate,
        claim.object,
        episodeId,
        slotKey(claim.subject, identityAlias),
        slotKey(claim.predicate, identityAlias),
        slotKey(claim.object, identityAlias),
      ],
    );
    return rows[0]!.id;
  }

  // -------------------------------------------------------------------------
  // (a) The reach — every negative beside a positive control
  // -------------------------------------------------------------------------

  it(
    "the reach is empty for an unenrolled dimension and non-empty for an enrolled sibling",
    async () => {
      // THREE pairs across TWO entities, deliberately unequal: a `pairs.length`
      // and an `entities.length` that agreed would be satisfied by an
      // implementation that returned either one for both.
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");
      await seedEnrollment(WORKSPACE, "accounts", "tier");
      await seedEnrollment(WORKSPACE, "subscriptions", "plan");

      const reach = await loadProducerReach(WORKSPACE);

      // NEGATIVE — `accounts / status` was never enrolled.
      expect(reach.has("accounts", "status")).toBe(false);
      // POSITIVE CONTROL, from the same call. Without this the assertion above
      // is satisfied by a reach that is empty for everything.
      expect(reach.has("accounts", "arr_band")).toBe(true);
      expect(reach.has("subscriptions", "plan")).toBe(true);

      expect(reach.pairs).toHaveLength(3);
      expect(reach.entities).toEqual(["accounts", "subscriptions"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the unit is the PAIR — an enrolled entity does not put its other dimensions in reach",
    async () => {
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");

      const reach = await loadProducerReach(WORKSPACE);

      // `accounts` IS enrolled, and `accounts / status` is still out of reach.
      // A reach keyed on the entity would hand the producer every column of
      // every enrolled table — the sweep ADR-0039 exists to prevent, rebuilt one
      // column of the primary key at a time.
      expect(reach.has("accounts", "status")).toBe(false);
      expect(reach.has("accounts", "arr_band")).toBe(true);
      // And the entity list still names it once. `entities` exists so the
      // producer can evaluate ADR-0037 §4's ambiguity rule across the enrolled
      // set, so an entity dropping out of it because only one of its dimensions
      // is enrolled would break the refusal rather than the reach.
      expect(reach.entities).toEqual(["accounts"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the reach is workspace-scoped",
    async () => {
      await seedEnrollment(OTHER_WORKSPACE, "accounts", "arr_band");
      await seedEnrollment(WORKSPACE, "subscriptions", "plan");

      const reach = await loadProducerReach(WORKSPACE);

      expect(reach.has("accounts", "arr_band")).toBe(false);
      // Positive control on the same call — otherwise a reach scoped to a
      // workspace that does not exist would pass.
      expect(reach.has("subscriptions", "plan")).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "names containing spaces cannot be confused across the pair boundary",
    async () => {
      // The separator falsifier. With a SPACE joining the two halves,
      // `("customer account", "tier")` and `("customer", "account tier")` build
      // the same membership key, so enrolling the first would put the second in
      // reach — a pair nobody enrolled, emitted against an entity that may not
      // exist.
      await seedEnrollment(WORKSPACE, "customer account", "tier");

      const reach = await loadProducerReach(WORKSPACE);

      expect(reach.has("customer", "account tier")).toBe(false);
      expect(reach.has("customer account", "tier")).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // The write verbs
  // -------------------------------------------------------------------------

  it(
    "enrolling twice is a no-op that does not re-attribute the first author",
    async () => {
      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          dimension: "arr_band",
          note: "revenue tiering",
          actor: "user-1",
        }),
      ).toBe(true);

      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          dimension: "arr_band",
          note: "someone else's reason",
          actor: "user-2",
        }),
      ).toBe(false);

      const rows = await listEnrollments(WORKSPACE);
      expect(rows).toHaveLength(1);
      // Author AND note. An `ON CONFLICT DO UPDATE` would keep the row count at
      // one and quietly re-file the decision under `user-2`, so a count-only
      // assertion would pass against the conflation this split exists to stop.
      expect(rows[0]?.enrolledBy).toBe("user-1");
      expect(rows[0]?.note).toBe("revenue tiering");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "un-enrolling removes exactly one pair and reports the no-op honestly",
    async () => {
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");
      await seedEnrollment(WORKSPACE, "accounts", "tier");

      expect(
        await unenrollPair({ workspaceId: WORKSPACE, entity: "accounts", dimension: "arr_band" }),
      ).toBe(true);
      // Second call: nothing to remove, and that is a no-op rather than an
      // error — the caller's intent already holds.
      expect(
        await unenrollPair({ workspaceId: WORKSPACE, entity: "accounts", dimension: "arr_band" }),
      ).toBe(false);

      const reach = await loadProducerReach(WORKSPACE);
      expect(reach.has("accounts", "arr_band")).toBe(false);
      // The sibling survives. Without this, a `DELETE` missing its `dimension`
      // predicate — which would clear the whole entity — passes.
      expect(reach.has("accounts", "tier")).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an empty half is refused before it reaches the table",
    async () => {
      await expect(
        enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          dimension: "   ",
          note: null,
          actor: "user-1",
        }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentPairError);
      // An unattributed enrollment is refused by the seam, not left to the
      // table's CHECK — a constraint violation surfaces as a 500 carrying a
      // Postgres message.
      await expect(
        enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          dimension: "arr_band",
          note: null,
          actor: "  ",
        }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentPairError);
      expect(await listEnrollments(WORKSPACE)).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the table refuses an unattributed row even when the seam is bypassed",
    async () => {
      // The seam's guard is the message; the CHECK is the guarantee. Asserting
      // only the first would leave the region importer — which does not go
      // through `enrollPair` — able to land authority nobody granted.
      await expect(
        pool.query(
          `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by)
           VALUES ($1, 'accounts', 'arr_band', '')`,
          [WORKSPACE],
        ),
      ).rejects.toThrow(/ck_brain_enrollment_attributed/);
      await expect(
        pool.query(
          `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by)
           VALUES ($1, '', 'arr_band', 'user-1')`,
          [WORKSPACE],
        ),
      ).rejects.toThrow(/ck_brain_enrollment_names_present/);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // (b) Un-enrolling is not an invalidation authority
  // -------------------------------------------------------------------------

  it(
    "un-enrolling leaves an already-published fact published, visible, and valid",
    async () => {
      const factId = await seedPublishedFact({
        subject: "Acme Corp",
        predicate: "arr band",
        object: "enterprise",
      });
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");

      const before = await pool.query<{
        status: string;
        valid_to: Date | null;
        visible_to: string[];
      }>(`SELECT status, valid_to, visible_to FROM brain_facts WHERE id = $1`, [factId]);

      const removed = await unenrollPair({
        workspaceId: WORKSPACE,
        entity: "accounts",
        dimension: "arr_band",
      });

      // ⚠️ POSITIVE CONTROL, and this test is worthless without it: "the fact
      // is unchanged" is satisfied perfectly by an un-enrolment that did
      // nothing at all.
      expect(removed).toBe(true);
      expect(await listEnrollments(WORKSPACE)).toHaveLength(0);

      const after = await pool.query<{
        status: string;
        valid_to: Date | null;
        visible_to: string[];
      }>(`SELECT status, valid_to, visible_to FROM brain_facts WHERE id = $1`, [factId]);

      // The row is still THERE — checked before the field comparison, because
      // `rows[0]` being undefined on both sides would make a `toEqual` of the
      // two pass on a fact that was deleted.
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.status).toBe("published");
      // `valid_to` explicitly, not just via the object compare: a stamped
      // `valid_to` retires the belief and every as-of-now read then HIDES the
      // row, so the damage is invisible in both directions (#4912). A machine
      // stamping it is forbidden outright (#4759 §2).
      expect(after.rows[0]?.valid_to).toBeNull();
      expect(after.rows[0]).toEqual(before.rows[0]!);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
