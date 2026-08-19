/**
 * The entity store against a real Postgres (#5043, ADR-0037 §5).
 *
 * ## The four claims that need a database
 *
 * **(a) The store actually RESOLVES something.** ADR-0039 states why this is the
 * load-bearing test rather than a formality: *"an empty store and a
 * correctly-working store are indistinguishable from inside the code"* — every
 * read abstains in both cases, and every test passes in both cases. So the first
 * test here writes entries through the real statement and reads them back
 * through the real resolver, and every abstain assertion elsewhere sits beside a
 * surface from the same call that resolves.
 *
 * **(b) The write is a SNAPSHOT.** The DELETE half is what makes it one, and an
 * in-memory double cannot assert that a row a second run did not mention is
 * GONE — it can only assert that its own script deleted it.
 *
 * **(c) Rejection memory stops the producer re-emitting a removed edge.** This
 * is the acceptance criterion that says *"falsify it"*, and it is unfalsifiable
 * without real SQL: the memory lives in `brain_vocabulary_proposal`'s
 * `approved → rejected` transition, which `removeInForceAliasEdge` writes and
 * `proposeAliasEdge` reads. A double scripted to refuse the second proposal
 * asserts its own script (#5000's trap).
 *
 * **(d) The partial unique index really admits one naming dimension per entity.**
 * A CHECK cannot express it, so the only proof is Postgres refusing the second.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterEach, afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import {
  buildEntityEntry,
  entityEdgeProposals,
  entityStoreResolver,
  loadEntityStore,
  writeEntityEntries,
  ENTITY_EDGE_PRODUCER,
  type EntityStoreEntry,
} from "@atlas/api/lib/brain/entity-store";
import {
  InvalidEnrollmentPairError,
  enrollPair,
  loadProducerReach,
  setNamingDimension,
} from "@atlas/api/lib/brain/enrollment";
import {
  proposeAliasEdges,
  removeInForceAliasEdge,
  _resetSettingsTierWarning,
} from "@atlas/api/lib/brain/vocabulary-decide";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import { warehouseRowId } from "@atlas/api/lib/brain/warehouse-producer";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  subjectComparableValue,
  type ResolvedEntityId,
} from "@atlas/api/lib/brain/subject-cmp";
import { Effect } from "effect";
import { runBrainExtractionCycle } from "@atlas/api/lib/brain/extract";
import type { FactExtractor, ResolvedExtractionModel } from "@atlas/api/lib/brain/extract";
import { identityKeySql } from "@atlas/api/lib/brain/identity";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-entity-store";

/**
 * Both entity names this suite writes under, as `writeEntityEntries`' required
 * reach (#5320).
 *
 * BOTH of them in every call, deliberately: with each name in reach the rename
 * reconciliation never fires, so every assertion below goes on measuring exactly
 * what it measured before that parameter existed. The reconciliation's own
 * behaviour is `entity-store-reach-pg.test.ts`'s subject, where a name is left
 * OUT of reach on purpose.
 */
const STORE_REACH = ["accounts", "contacts"] as const;

describeIfPg("the entity store (#5043)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5043_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** A `ReconcileExecutor` over the raw pool — autocommit, which is fine here. */
  const exec: ReconcileExecutor = {
    query: async (sql, params) => {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows as readonly unknown[] };
    },
  };

  const FAKE_MODEL = {
    model: "fake-model" as unknown as ResolvedExtractionModel["model"],
    modelId: "fake-model",
  } satisfies ResolvedExtractionModel;

  const entry = (params: {
    entity: string;
    keySurface: string;
    canonicalSurface: string;
  }): EntityStoreEntry => {
    const built = buildEntityEntry({
      entityId: warehouseRowId(WORKSPACE, params.entity, params.keySurface),
      entity: params.entity,
      keySurface: params.keySurface,
      canonicalSurface: params.canonicalSurface,
    });
    if (built === null) throw new Error("fixture did not build an entry");
    return built;
  };

  let episodeSeq = 0;

  /**
   * One live PUBLISHED fact at the subject position.
   *
   * ⚠️ Needed by the rejection-memory test and not decoration. ADR-0037 §6's
   * positional-visibility rule is RE-DERIVED at read time — the queue joins
   * `brain_facts` on the two norms and surfaces an edge only when the reader's
   * own fail-closed predicate admits a row on EACH side — so a removal against
   * an empty corpus is refused as `not-in-force`, which is also what an absent
   * edge returns. Seeding the two populations is what makes the removal a real
   * removal rather than a refusal wearing the same word.
   *
   * `identityKeySql` is imported rather than transcribed, on
   * `vocabulary-authoring-pg.test.ts`'s reasoning: a pasted copy is a second
   * implementation of the norm rule that diverges silently.
   */
  async function seedFact(subject: string, object: string): Promise<void> {
    episodeSeq++;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, occurred_at, visible_to)
       VALUES ($1, 'manual', $2, 'seed', now(), ARRAY['org']::text[])
       RETURNING id`,
      [WORKSPACE, `ep-5043-${episodeSeq}`],
    );
    const episodeId = rows[0]?.id;
    if (episodeId === undefined) throw new Error("fixture failed to seed an episode");
    await pool.query(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status,
          visible_to, subject_key, predicate_key, object_key)
       VALUES ($1, $2, 'employs', $3, $4, '{"actor":"test"}'::jsonb, 'published', ARRAY['org']::text[],
               ${identityKeySql("$2")}, ${identityKeySql("'employs'")}, ${identityKeySql("$3")})`,
      [WORKSPACE, subject, object, episodeId],
    );
  }

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
    // ⚠️ Load settings ONCE, exactly as the real server's init path does.
    // #5162 made an unreadable settings TIER fail closed: the workspace's
    // auto-approve opt-out is a DB override, and a tier that was never read
    // cannot be honoured — so without this every proposal queues and no edge is
    // ever in force. The rejection-memory test would then see its removal
    // refused as `not-in-force`, which is the same word an absent edge returns.
    const { loadSettings, settingsCacheEverLoaded } = await import("@atlas/api/lib/settings");
    await loadSettings();
    // ASSERTED, not assumed: `loadSettings` swallows its own failure and returns
    // 0, so a missing settings table would leave the test failing for the
    // latch's reason rather than its own.
    expect(settingsCacheEverLoaded()).toBe(true);
    // The ambient environment must not decide what this suite tests.
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
    // UNSCOPED, deliberately: the isolation test above writes a second
    // workspace's row, and a scoped cleanup leaves it behind when an assertion
    // fails — which makes the FIRST failure cascade into later ones. `afterEach`
    // rather than a per-test `finally`, because a `finally` is bookkeeping the
    // next test author forgets.
    await pool.query(`DELETE FROM brain_entity`);
    await pool.query(`DELETE FROM brain_vocabulary_target WHERE workspace_id = $1`, [WORKSPACE]);
    await pool.query(`DELETE FROM brain_vocabulary_edge WHERE workspace_id = $1`, [WORKSPACE]);
    await pool.query(`DELETE FROM brain_vocabulary_proposal WHERE workspace_id = $1`, [WORKSPACE]);
    await pool.query(`DELETE FROM brain_enrollment WHERE workspace_id = $1`, [WORKSPACE]);
    await pool.query(`DELETE FROM brain_facts WHERE workspace_id = $1`, [WORKSPACE]);
    await pool.query(`DELETE FROM brain_episodes WHERE workspace_id = $1`, [WORKSPACE]);
    // The once-per-process settings warn is a process-lifetime latch; a suite
    // simulating a fresh boot has to re-arm it itself.
    _resetSettingsTierWarning();
  });

  // -------------------------------------------------------------------------

  it(
    "resolves a surface to its stable id — by name and by key",
    async () => {
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [
          entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" }),
          entry({ entity: "accounts", keySurface: "ACC-43", canonicalSurface: "Beta LLC" }),
        ],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });

      const resolve = entityStoreResolver();
      const answer = await resolve(new Set(["ACME  corp", "ACC-43", "Gamma Inc"]), {
        workspaceId: WORKSPACE,
      });

      // ⚠️ THE POSITIVE CONTROL the milestone turns on. Everything else in this
      // file could pass against a store that resolves nothing.
      expect(answer.get("ACME  corp")).toEqual({
        entityId: warehouseRowId(WORKSPACE, "accounts", "ACC-42"),
      });
      expect(answer.get("ACC-43")).toEqual({
        entityId: warehouseRowId(WORKSPACE, "accounts", "ACC-43"),
      });
      // The abstain, beside two surfaces that resolved.
      expect(answer.has("Gamma Inc")).toBe(false);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "is workspace-scoped — another workspace's entry never answers",
    async () => {
      await writeEntityEntries(exec, {
        workspaceId: "ws-other",
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" })],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [entry({ entity: "accounts", keySurface: "99", canonicalSurface: "Local Only" })],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });

      const answer = await entityStoreResolver()(new Set(["Acme Corp", "Local Only"]), {
        workspaceId: WORKSPACE,
      });
      expect(answer.has("Acme Corp")).toBe(false);

      // ⚠️ **THE ASSERTION THIS TEST WAS MISSING, and without it the test passed
      // for the OPPOSITE reason.** `writeEntityEntries` DELETEs before it
      // inserts; drop the `workspace_id` predicate from that DELETE and the
      // second write above wipes `ws-other`'s row — after which "Acme Corp does
      // not resolve here" is true because the row is GONE, not because it is
      // scoped away. One workspace's producer run would silently destroy every
      // other workspace's entries for the same entity name.
      const other = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_entity WHERE workspace_id = 'ws-other'`,
      );
      expect(other.rows[0]?.n).toBe("1");
      // The control: this workspace's own entry answers on the same call, so the
      // negative above is scoping rather than an empty read.
      expect(answer.has("Local Only")).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a re-run REPLACES the entity's entries — a vanished warehouse row stops resolving",
    async () => {
      const first = [
        entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" }),
        entry({ entity: "accounts", keySurface: "ACC-43", canonicalSurface: "Beta LLC" }),
      ];
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: first,
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });
      // `contacts` is snapshotted too, and must survive `accounts`' re-run.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "contacts",
        entityNamesInReach: STORE_REACH,
        entries: [entry({ entity: "contacts", keySurface: "7", canonicalSurface: "Alice" })],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });

      // Row 43 is gone from the warehouse; row 42 was RENAMED.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Holdings" })],
        snapshotAt: new Date("2026-08-15T10:00:00Z"),
      });

      const answer = await entityStoreResolver()(
        new Set(["Beta LLC", "Acme Holdings", "Acme Corp", "Alice"]),
        { workspaceId: WORKSPACE },
      );
      // Gone. Without the DELETE half, a deleted warehouse row resolves forever.
      expect(answer.has("Beta LLC")).toBe(false);
      // The OLD name is gone too, and the new one answers — the same id, which
      // is what makes a rename a re-key rather than a second entity.
      expect(answer.has("Acme Corp")).toBe(false);
      expect(answer.get("Acme Holdings")).toEqual({
        entityId: warehouseRowId(WORKSPACE, "accounts", "ACC-42"),
      });
      // ⚠️ The scoping control: another entity's entries are untouched. A DELETE
      // that dropped the `entity` predicate would pass every assertion above.
      expect(answer.get("Alice")).toBeDefined();

      const stored = await loadEntityStore(WORKSPACE);
      expect(stored.map((e) => `${e.entity}:${e.canonicalSurface}`).toSorted()).toEqual([
        "accounts:Acme Holdings",
        "contacts:Alice",
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "REJECTION MEMORY: a removed entity edge is never re-emitted, and the counter says so",
    async () => {
      const entries = [
        entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" }),
      ];
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries,
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });
      const { proposals } = entityEdgeProposals(entries);
      expect(proposals).toHaveLength(2);

      // Both populations the edge would merge, so the reader can see each side.
      // Without them the removal below is refused as `not-in-force` — the same
      // word an absent edge returns, which would make the falsifier pass for the
      // wrong reason.
      await seedFact("ACC-42", "Alice");
      await seedFact("Acme Corp", "Bob");

      // ── Run 1: the edges land ──
      const first = await proposeAliasEdges(WORKSPACE, proposals, ENTITY_EDGE_PRODUCER);
      // ⚠️ AUTO-APPROVED, both of them, and this is a claim about ADR-0037 §6's
      // split rather than a setup step: `warehouse_key` at an ENTITY position is
      // the one combination the auto-approve arm admits, because a warehouse
      // primary key is evidence a machine can be certain of. `queued: 0` is the
      // load-bearing half — an edge that merely queued would leave the store's
      // slot-side contribution dormant behind a review nobody asked for.
      expect(first).toEqual({
        queued: 0,
        autoApproved: 2,
        deduped: 0,
        alreadyApproved: 0,
        rejected: 0,
        refused: 0,
      });

      // The edge is REAL: `42` now keys onto `acme corp` through the closure,
      // which is the whole point of the store's slot-side contribution — a
      // surrogate-keyed warehouse row landing in the same slot as an extracted
      // mention of its name.
      const vocabulary = await loadWorkspaceVocabulary(WORKSPACE);
      expect(vocabulary.subject("acc 42")).toBe("acme corp");
      expect(vocabulary.object("acc 42")).toBe("acme corp");

      // ── A human removes the subject-position edge ──
      const removal = await removeInForceAliasEdge(
        WORKSPACE,
        { position: "subject", fromNorm: "acc 42", toNorm: "acme corp" },
        OWNER_CTX,
      );
      expect(removal.kind).toBe("removed");

      // ── Run 2: the producer re-proposes exactly the same pair ──
      const second = await proposeAliasEdges(WORKSPACE, proposals, ENTITY_EDGE_PRODUCER);

      // ⚠️ THE FALSIFIER. `rejected: 1` is the removed subject edge refused by
      // permanent memory (#4507); the object edge is still in force and lands in
      // `alreadyApproved`/`deduped`. A producer whose second pass reported
      // `rejected: 0` is one whose human removals did not stick — and the edge
      // would be silently re-created, re-keying the corpus a person had
      // deliberately un-merged.
      expect(second.rejected).toBe(1);

      // And the edge really is gone from the vocabulary, not merely uncounted.
      const after = await loadWorkspaceVocabulary(WORKSPACE);
      expect(after.subject("acc 42")).toBe("acc 42");
      // The CONTROL: the object-position edge, which nobody removed, survived —
      // so this is a positional removal rather than a wiped vocabulary.
      expect(after.object("acc 42")).toBe("acme corp");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "at most ONE naming dimension per entity, and switching it is not a 23505",
    async () => {
      for (const dimension of ["name", "legal_name", "tier"]) {
        await enrollPair({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension,
          note: null,
          actor: "user-1",
        });
      }

      expect(
        await setNamingDimension({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: "name" }),
      ).toBe(true);
      // Switching to another dimension in one call. The naive single-statement
      // form (`SET naming = (dimension = $3)`) raises 23505 here depending on the
      // order Postgres rewrites the tuples — which is why the write clears first.
      expect(
        await setNamingDimension({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension: "legal_name",
        }),
      ).toBe(true);

      const reach = await loadProducerReach(WORKSPACE);
      expect(reach.namingDimension.get("accounts")).toBe("legal_name");
      const named = await pool.query<{ dimension: string }>(
        `SELECT dimension FROM brain_enrollment WHERE workspace_id = $1 AND naming`,
        [WORKSPACE],
      );
      expect(named.rows.map((r) => r.dimension)).toEqual(["legal_name"]);

      // Idempotent: naming the same one again changes nothing.
      expect(
        await setNamingDimension({
          workspaceId: WORKSPACE,
          entity: "accounts",
          group: null,
          dimension: "legal_name",
        }),
      ).toBe(false);

      // Clearing it. The reach then has no entry for the entity — ABSENT, which
      // is what makes the store write nothing for it rather than an empty name.
      expect(
        await setNamingDimension({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: null }),
      ).toBe(true);
      const cleared = await loadProducerReach(WORKSPACE);
      expect(cleared.namingDimension.has("accounts")).toBe(false);
      // The CONTROL: the enrollments themselves are untouched by naming.
      expect(cleared.pairs).toHaveLength(3);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to name a dimension that is not enrolled",
    async () => {
      await enrollPair({
        workspaceId: WORKSPACE,
        entity: "accounts",
        group: null,
        dimension: "tier",
        note: null,
        actor: "user-1",
      });

      // The snapshot query names the ENROLLED columns only, so naming an
      // unenrolled one would look set on the surface and reach nothing — the
      // silent failure ADR-0039 warns is indistinguishable from success.
      await expect(
        setNamingDimension({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: "name" }),
      ).rejects.toBeInstanceOf(InvalidEnrollmentPairError);

      const named = await pool.query(
        `SELECT dimension FROM brain_enrollment WHERE workspace_id = $1 AND naming`,
        [WORKSPACE],
      );
      expect(named.rows).toEqual([]);
      // The control: the enrolled sibling CAN be named through the same call.
      expect(
        await setNamingDimension({ workspaceId: WORKSPACE, entity: "accounts", group: null, dimension: "tier" }),
      ).toBe(true);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "ACTIVATION: an EXTRACTED claim about the human name gets the warehouse row's id",
    async () => {
      // ⚠️ **THE test the whole slice exists for, end to end through the
      // production wiring.** The warehouse producer resolves its own subjects
      // from the snapshot it just read, so it never needed a store. Extraction
      // is the path where a person says "Acme Corp" about a row the warehouse
      // calls `42` — and until `extract.ts` was passed a resolver it used
      // `passthroughEntityResolver`, so every extracted claim landed
      // `subject_cmp` NULL with every test in the tree green. That is ADR-0037's
      // dormant machinery, and this is what wakes it.
      //
      // NO `resolveEntity` dep is injected: the PRODUCTION default is what is
      // under test. Injecting one here would test the seam and not the wiring —
      // `vocabulary-decide-pg.test.ts` makes the same call for the same reason
      // one column over.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [
          entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" }),
          entry({ entity: "accounts", keySurface: "ACC-43", canonicalSurface: "Beta LLC" }),
        ],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });

      await pool.query(
        `INSERT INTO brain_episodes
           (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', $2, 'U123', 'acme corp renewed', now(), ARRAY['org']::text[])`,
        [WORKSPACE, `C01:${episodeSeq++}.activation`],
      );

      const extract: FactExtractor = () =>
        Promise.resolve([
          // The HUMAN spelling, which is not the warehouse key — that gap is the
          // whole reason the store exists.
          { subject: "Acme Corp", predicate: "renewed on", object: "2026-08-01" },
          // A subject the store has never heard of, in the SAME episode. It is
          // the control: without it, "the store answered" is satisfied by a
          // resolver that stamps every subject with the same id.
          { subject: "Nobody Ltd", predicate: "renewed on", object: "2026-08-02" },
        ]);

      const result = await Effect.runPromise(
        runBrainExtractionCycle({
          extract,
          resolveModel: async () => FAKE_MODEL,
        }),
      );
      expect(result).toMatchObject({ status: "success" });

      const facts = await pool.query<{ subject: string; subject_cmp: string | null }>(
        `SELECT subject, subject_cmp FROM brain_facts WHERE workspace_id = $1 ORDER BY subject`,
        [WORKSPACE],
      );
      expect(
        facts.rows.map((r) => ({ subject: r.subject, subject_cmp: r.subject_cmp })),
      ).toEqual([
        // ⚠️ The id, on a claim NOBODY typed a warehouse key into. This is the
        // cross-tier collision `warehouse-producer.ts` records as not working
        // for a surrogate-keyed row.
        //
        // Built through `subjectComparableValue` rather than spelled with the
        // `entity:` prefix inline: the tag is what `comparableDifferentSql`
        // compares on, so a hand-written literal here would be a second
        // implementation of the tagging rule that drifts the day it changes.
        {
          subject: "Acme Corp",
          subject_cmp: subjectComparableValue(
            warehouseRowId(WORKSPACE, "accounts", "ACC-42") as unknown as ResolvedEntityId,
          ),
        },
        // …and the honest abstain beside it, on the same call.
        { subject: "Nobody Ltd", subject_cmp: null },
      ]);

      // The SURFACE is untouched — the resolver is key-side only, and a store
      // that rewrote `subject` would reintroduce at the entity position the
      // irreversibility ADR-0037 §8 spent a section designing out.
      expect(facts.rows.map((r) => r.subject)).toEqual(["Acme Corp", "Nobody Ltd"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a row whose id no producer could have minted never resolves — and still POISONS",
    async () => {
      // ⚠️ The guard at the site that reaches `subject_cmp` was UNFALSIFIABLE:
      // deleting it left 197 unit tests and 8 `-pg` tests green, because nothing
      // in the tree ever put a non-minted id in the table. Migration 0200 CHECKs
      // only `entity_id <> ''`, so the row is perfectly insertable — the DB is
      // not the second door, which is the other half of what this pins.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" })],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });
      // Raw INSERT: a bundle that got past an older validator, or a hand edit.
      // SAME canonical name as the row above, which is what makes the second
      // assertion mean something.
      await pool.query(
        `INSERT INTO brain_entity
           (workspace_id, entity_id, entity, key_surface, key_norm, canonical_surface, canonical_norm, snapshot_at)
         VALUES ($1, '1', 'accounts', 'ACC-99', 'acc 99', 'Acme Corp', 'acme corp', now())`,
        [WORKSPACE],
      );

      const answer = await entityStoreResolver()(new Set(["ACC-99", "ACC-42", "Acme Corp"]), {
        workspaceId: WORKSPACE,
      });
      // The forged row never answers — it would reach `subject_cmp` as a value
      // no producer minted, which compares equal to nothing and unequal to
      // everything.
      expect(answer.has("ACC-99")).toBe(false);
      // ⚠️ **AND IT STILL POISONS.** Dropping forged rows BEFORE computing
      // ambiguity was a fail-OPEN: the minted twin then owned `Acme Corp` and
      // got an edge the fail-closed rule had refused. Two entities, one name,
      // one of them unusable — the honest answer is that neither resolves.
      expect(answer.has("Acme Corp")).toBe(false);
      // The control from the same call: the minted row's KEY still resolves, so
      // this is poisoning rather than a read that returned nothing.
      expect(answer.get("ACC-42")).toEqual({
        entityId: warehouseRowId(WORKSPACE, "accounts", "ACC-42"),
      });

      // `loadEntityStore` keeps the row (poisoning needs it) and the edge
      // producer counts it apart from ordinary ambiguity, because the remedy is
      // a re-import rather than a warehouse edit.
      const stored = await loadEntityStore(WORKSPACE);
      expect(stored).toHaveLength(2);
      const batch = entityEdgeProposals(stored);
      // ⚠️ DISJOINT. The unminted row is counted ONCE, under the counter whose
      // remedy is a re-import — not also under `ambiguous`, whose remedy is a
      // warehouse edit. They overlapped in a first cut, which made `ambiguous`
      // mean three things and `unmintedIds > 0` imply `ambiguous > 0`.
      expect(batch.unmintedIds).toBe(1);
      // The MINTED row is the ambiguous one: its name is shared with the forged
      // row, which still poisons. One row in each bucket, so a fix that merged
      // them goes red.
      expect(batch.ambiguous).toBe(1);
      expect(batch.proposals).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the WRITE statement and the READ statement agree about which column is which",
    async () => {
      // ⚠️ **Nothing in the arc fed `entityEdgeProposals` the output of
      // `loadEntityStore`** — the rejection-memory test passes its in-memory
      // fixture, and the unit harness reconstructs entries from the INSERT
      // params it just recorded, which is a fixture agreeing with the writer by
      // construction. So transposing `key_norm` and `canonical_norm` in the
      // INSERT survived every suite: the resolver reads both columns
      // symmetrically and cannot notice.
      //
      // The edge producer is NOT symmetric — it reads `keyNorm → canonicalNorm`
      // as the edge DIRECTION — so a transposed store proposes
      // `acme corp → acc 42`, re-keying every human mention onto the warehouse
      // key. This is the one place the write statement, the read statement and
      // the direction rule meet.
      await writeEntityEntries(exec, {
        workspaceId: WORKSPACE,
        entity: "accounts",
        entityNamesInReach: STORE_REACH,
        entries: [entry({ entity: "accounts", keySurface: "ACC-42", canonicalSurface: "Acme Corp" })],
        snapshotAt: new Date("2026-08-14T10:00:00Z"),
      });

      const stored = await loadEntityStore(WORKSPACE);
      expect(stored[0]).toMatchObject({
        keySurface: "ACC-42",
        keyNorm: "acc 42",
        canonicalSurface: "Acme Corp",
        canonicalNorm: "acme corp",
      });

      const { proposals } = entityEdgeProposals(stored);
      expect(proposals.map((e) => `${e.fromNorm}->${e.toNorm}`)).toEqual([
        "acc 42->acme corp",
        "acc 42->acme corp",
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "the schema refuses a degenerate entry outright",
    async () => {
      // The application layer refuses these first (`buildEntityEntry` returns
      // null), and the CHECKs are the second door — which is the one that holds
      // against the region importer and against a hand-written INSERT.
      const base = [
        WORKSPACE,
        // A REAL minted id: the resolver and `loadEntityStore` now DROP a row
        // whose id is not the minted shape, so a `wh_x` placeholder would make
        // the control below assert nothing about anything readable.
        warehouseRowId(WORKSPACE, "accounts", "ACC-99"),
        "accounts",
        "ACC-99",
        "acc 99",
        "Acme",
        "acme",
        new Date(),
      ];
      const insert = `INSERT INTO brain_entity
          (workspace_id, entity_id, entity, key_surface, key_norm, canonical_surface, canonical_norm, snapshot_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
      for (const [index, label] of [
        [1, "entity_id"],
        [2, "entity"],
        [3, "key_surface"],
        [4, "key_norm"],
        [5, "canonical_surface"],
        [6, "canonical_norm"],
      ] as const) {
        const params = [...base];
        params[index] = "";
        await expect(pool.query(insert, params)).rejects.toThrow(
          // Every one of these is a CHECK violation, and naming the class rather
          // than the constraint keeps the assertion true if they are regrouped.
          /violates check constraint/,
        );
        void label;
      }
      // The control: the same statement with every column populated succeeds.
      await expect(pool.query(insert, base)).resolves.toBeDefined();
    },
    PG_TEST_TIMEOUT_MS,
  );
});

/**
 * An owner, as the vocabulary's AUTHORING bar requires — which is the bar a
 * removal takes, deliberately stricter than the approving one: dropping an edge
 * re-keys the corpus back and writes memory no producer can undo.
 */
const OWNER_CTX: BrainPrincipalContext = {
  origin: "authenticated",
  workspaceId: WORKSPACE,
  userId: "user-1",
  role: "owner",
  audienceIds: [],
};
