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
  ENROLLMENT_NAME_MAX,
  InvalidEnrollmentPairError,
  UnattributedEnrollmentError,
  enrollPair,
  listEnrollments,
  loadProducerReach,
  makeProducerReach,
  normalizeEnrollmentPair,
  setNamingDimension,
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
    // OPTIONS rather than two more positionals: `group` defaults to the flat
    // scope, which is what every pre-#5286 case in this file means, and the
    // group-scoped cases below say so by name instead of by position.
    { group = null, enrolledBy = "user-1" }: { group?: string | null; enrolledBy?: string } = {},
  ) {
    await pool.query(
      `INSERT INTO brain_enrollment (workspace_id, entity, connection_group_id, dimension, enrolled_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, entity, group ?? "", dimension, enrolledBy],
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
      expect(reach.has("accounts", null, "status")).toBe(false);
      // POSITIVE CONTROL, from the same call. Without this the assertion above
      // is satisfied by a reach that is empty for everything.
      expect(reach.has("accounts", null, "arr_band")).toBe(true);
      expect(reach.has("subscriptions", null, "plan")).toBe(true);

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
      expect(reach.has("accounts", null, "status")).toBe(false);
      expect(reach.has("accounts", null, "arr_band")).toBe(true);
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

      expect(reach.has("accounts", null, "arr_band")).toBe(false);
      // Positive control on the same call — otherwise a reach scoped to a
      // workspace that does not exist would pass.
      expect(reach.has("subscriptions", null, "plan")).toBe(true);
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

      expect(reach.has("customer", null, "account tier")).toBe(false);
      expect(reach.has("customer account", null, "tier")).toBe(true);
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
          group: null,
          dimension: "arr_band",
          note: "revenue tiering",
          actor: "user-1",
        }),
      ).toBe(true);

      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
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
      // ISO, not `String(Date)`. The wire schema types this as a bare
      // `z.string()`, so the `Date`-branch falling through to the `String(...)`
      // fallback would ship "Thu Aug 14 2026 …" to the page and pass every
      // schema between here and the browser.
      expect(rows[0]?.enrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "un-enrolling removes exactly one pair and reports the no-op honestly",
    async () => {
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");
      await seedEnrollment(WORKSPACE, "accounts", "tier");

      expect(
        await unenrollPair({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: "arr_band" }),
      ).toBe(true);
      // Second call: nothing to remove, and that is a no-op rather than an
      // error — the caller's intent already holds.
      expect(
        await unenrollPair({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: "arr_band" }),
      ).toBe(false);

      const reach = await loadProducerReach(WORKSPACE);
      expect(reach.has("accounts", null, "arr_band")).toBe(false);
      // The sibling survives. Without this, a `DELETE` missing its `dimension`
      // predicate — which would clear the whole entity — passes.
      expect(reach.has("accounts", null, "tier")).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "an empty half is refused before it reaches the table",
    async () => {
      // A REAL enrollment first, so the count below is a control rather than a
      // bare zero: `listEnrollments` scoped to the wrong workspace, or one whose
      // query silently returns nothing, satisfies `toHaveLength(0)` perfectly.
      await enrollPair({
        workspaceId: WORKSPACE,
        entity: "accounts",
        group: null,
        dimension: "arr_band",
        note: null,
        actor: "user-1",
      });

      await expect(
        enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension: "   ",
          note: null,
          actor: "user-1",
        }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentPairError);
      // An unattributed enrollment is refused by the seam, not left to the
      // table's CHECK — a constraint violation surfaces as a 500 carrying a
      // Postgres message.
      //
      // ⚠️ A DIFFERENT class from the two above, and the split is load-bearing:
      // the route maps `InvalidEnrollmentPairError` to a 400 by type, and an
      // empty actor is a server invariant rather than caller input, so sharing
      // one class would answer 400 for a request body with no author field to
      // fix. Asserting the class here is what stops the two being merged again.
      await expect(
        enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension: "tier",
          note: null,
          actor: "  ",
        }),
      ).rejects.toBeInstanceOf(UnattributedEnrollmentError);

      // Only the one legitimate pair landed.
      expect(await listEnrollments(WORKSPACE)).toHaveLength(1);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the length bound admits its own maximum and refuses one past it",
    async () => {
      const atBound = "a".repeat(ENROLLMENT_NAME_MAX);
      // The off-by-one control FIRST — `>` vs `>=` is the mistake this branch
      // makes, and without the at-bound case both spellings pass.
      expect(normalizeEnrollmentPair(atBound, "arr_band").entity).toHaveLength(ENROLLMENT_NAME_MAX);
      await expect(
        enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension: "a".repeat(ENROLLMENT_NAME_MAX + 1),
          note: null,
          actor: "user-1",
        }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentPairError);
      expect(await listEnrollments(WORKSPACE)).toHaveLength(0);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a NUL byte is refused by the seam rather than by Postgres",
    async () => {
      // The un-enroll verb has no semantic-layer check by design, so this is the
      // only door between a caller's NUL and a 22021 surfacing as a generic 500.
      // It is also the assumption `PAIR_SEPARATOR` rests on.
      await expect(
        unenrollPair({ workspaceId: WORKSPACE, entity: "acc\u0000ounts", group: null, dimension: "arr_band" }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentPairError);
      // Control: the same verb on a clean pair answers rather than throwing.
      expect(
        await unenrollPair({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: "arr_band" }),
      ).toBe(false);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "makeProducerReach derives the same reach the query does",
    async () => {
      // The pure derivation and the loading one must not drift: #5042 holds the
      // reach across a run, and a second derivation is how `has()` and `pairs`
      // start to disagree.
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");
      await seedEnrollment(WORKSPACE, "subscriptions", "plan");
      const loaded = await loadProducerReach(WORKSPACE);
      const derived = makeProducerReach(loaded.pairs);
      expect(derived.entities).toEqual(loaded.entities);
      expect(derived.has("accounts", null, "arr_band")).toBe(loaded.has("accounts", null, "arr_band"));
      // Both arms, so a `has` hardcoded either way goes red on one of them.
      expect(derived.has("accounts", null, "status")).toBe(false);
      expect(derived.has("accounts", null, "arr_band")).toBe(true);
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
  // (c) The connection group is part of the KEY (#5286)
  //
  // This section needs a real Postgres more than any other in the file, because
  // what it asserts is a PRIMARY KEY. An in-memory double keyed by whatever its
  // author had in mind agrees with itself by construction — the table is the
  // only thing that can disagree, and before 0205 it did: the second INSERT
  // below was an `ON CONFLICT DO NOTHING` no-op that reported `changed: false`,
  // and the admin who wrote it was told their enrollment already existed.
  // -------------------------------------------------------------------------

  it(
    "the same pair in two connection groups is TWO enrollments, not one",
    async () => {
      // The staging shape, minimally: one entity NAME published under two
      // groups. They are two different tables in two different databases that
      // happen to share a label.
      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "test_orders",
          group: "g-clickhouse",
          dimension: "status",
          note: null,
          actor: "user-1",
        }),
      ).toBe(true);

      // ⚠️ The assertion this whole change exists for. Before 0205 this returned
      // `false` — the row conflicted with the one above on `(workspace, entity,
      // dimension)` and was silently dropped, so the admin was told the pair was
      // "already enrolled" and the group they picked reached nothing.
      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "test_orders",
          group: "g-mysql",
          dimension: "status",
          note: null,
          actor: "user-1",
        }),
      ).toBe(true);

      const rows = await listEnrollments(WORKSPACE);
      expect(rows).toHaveLength(2);
      expect(
        rows.map((r) => r.group ?? "").toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["g-clickhouse", "g-mysql"]);

      // Re-enrolling ONE of them is still the idempotent no-op it always was —
      // the control that keeps "two rows" from being satisfied by a key that
      // stopped deduplicating at all.
      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "test_orders",
          group: "g-mysql",
          dimension: "status",
          note: null,
          actor: "user-2",
        }),
      ).toBe(false);
      expect(await listEnrollments(WORKSPACE)).toHaveLength(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "un-enrolling one group's copy leaves the other group's standing",
    async () => {
      // ⚠️ The over-DELETE. `unenrollPair`'s statement used to match
      // `(workspace, entity, dimension)`, which after 0205 names one row PER
      // GROUP — so an un-scoped DELETE would remove both while reporting the
      // ordinary `changed: true`. Narrowing the producer's reach is the less
      // consequential direction; narrowing it further than the admin asked is
      // not, and it is silent.
      await seedEnrollment(WORKSPACE, "test_orders", "status", { group: "g-clickhouse" });
      await seedEnrollment(WORKSPACE, "test_orders", "status", { group: "g-mysql" });

      expect(
        await unenrollPair({
          workspaceId: WORKSPACE,
          entity: "test_orders",
          group: "g-mysql",
          dimension: "status",
        }),
      ).toBe(true);

      const left = await listEnrollments(WORKSPACE);
      expect(left).toHaveLength(1);
      expect(left[0]?.group).toBe("g-clickhouse");

      // And the reach agrees, from the same read the producer takes: the
      // surviving triple is in it and the removed one is not. `has` is keyed on
      // all three parts, so a membership index that dropped the group would
      // answer `true` for both.
      const reach = await loadProducerReach(WORKSPACE);
      expect(reach.has("test_orders", "g-clickhouse", "status")).toBe(true);
      expect(reach.has("test_orders", "g-mysql", "status")).toBe(false);
      // The NAME appears once in `entities` either way — that list is the set the
      // producer's downstream keys collide in, and those keys carry no group.
      expect(reach.entities).toEqual(["test_orders"]);
      expect([...(reach.groupsByEntity.get("test_orders") ?? [])]).toEqual(["g-clickhouse"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "each group's copy carries its OWN naming dimension",
    async () => {
      // `uq_brain_enrollment_naming` is scoped `(workspace, entity, group)` since
      // 0205. Left at `(workspace, entity)` the second call here raises 23505 —
      // an index refusing an act with no sentence attached, where the producer
      // refuses the same collision and says why.
      for (const group of ["g-clickhouse", "g-mysql"]) {
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "test_orders",
          group,
          dimension: "customer_name",
          note: null,
          actor: "user-1",
        });
        expect(
          await setNamingDimension({
            workspaceId: WORKSPACE,
            entity: "test_orders",
            group,
            dimension: "customer_name",
          }),
        ).toBe(true);
      }

      const rows = await listEnrollments(WORKSPACE);
      expect(rows.filter((r) => r.naming)).toHaveLength(2);

      // ⚠️ And CLEARING one leaves the other named. The clear-then-set pair
      // inside `setNamingDimension` is scoped by group for exactly this: unscoped,
      // naming one group's copy silently un-names the other's, and the un-naming
      // half is what wipes that entity's entity-store entries on the next run.
      expect(
        await setNamingDimension({
          workspaceId: WORKSPACE,
          entity: "test_orders",
          group: "g-mysql",
          dimension: null,
        }),
      ).toBe(true);

      const after = await listEnrollments(WORKSPACE);
      expect(after.filter((r) => r.naming).map((r) => r.group)).toEqual(["g-clickhouse"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the flat scope has ONE spelling — `null` and `''` are the same row",
    async () => {
      // `''` is the storage sentinel and `null` is the TypeScript spelling, and
      // the round trip has to be total: two spellings of the flat scope would be
      // two rows under the new key, and the second would be an enrollment the
      // admin never made against a scope that does not exist.
      await seedEnrollment(WORKSPACE, "accounts", "arr_band");
      expect(
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension: "arr_band",
          note: null,
          actor: "user-1",
        }),
      ).toBe(false);

      const rows = await listEnrollments(WORKSPACE);
      expect(rows).toHaveLength(1);
      // Read back as `null`, never as `""` — a `""` on the wire would reach the
      // admin page as a group whose name is blank.
      expect(rows[0]?.group).toBeNull();
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
        group: null,
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
