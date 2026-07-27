/**
 * Real-Postgres coverage for the fact class's content-mode review gate
 * (#4769, ADR-0036 §Temporal, conflict & provenance).
 *
 * `promotion.test.ts` pins the classifier and `adapters/__tests__/brain-facts.test.ts`
 * pins the adapter's statement plan. Neither can answer the questions that
 * decide whether this slice is honest, and all four need a real database:
 *
 *   1. **Is the refusable state actually reachable?** `GRANT_UNUSABLE` is only
 *      a real rule if `visible_to = ['everyone']` is genuinely storable. If
 *      migration 0180's CHECK refused it, the refusal would be theatre and this
 *      file would say so by failing.
 *   2. **Is the UNREFUSABLE state actually unreachable?** The provenance rules
 *      are defense in depth, and the honest way to test that is to assert the
 *      SCHEMA is what refuses — at INSERT — rather than inserting an impossible
 *      row to watch the adapter reject it. There is no such row to insert.
 *      (`NOT NULL` + the composite FK for a missing episode; a CHECK for the
 *      empty payload — they are different mechanisms and the tests say which.)
 *   3. **Does the gate actually gate reads?** `ContentModeRegistry.readFilter`
 *      emits text; only a query proves a draft fact is invisible in published
 *      mode and visible in the developer overlay.
 *   4. **Does the whole transaction behave?** Promote the good, leave the bad
 *      a draft, keep it counted, commit anyway.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import {
  brainFactsCountSql,
  promoteBrainFacts,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import {
  aclVisibilityClause,
  resolvePrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { FACT_REFUSAL_REASONS } from "@atlas/api/lib/brain/promotion";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("brain fact review gate (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_promo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const registry = makeService(CONTENT_MODE_TABLES);

  beforeAll(async () => {
    // `search_path` baked into the connection string, not SET from an unawaited
    // `pool.on("connect")` handler — see the note in `acl-visibility-pg.test.ts`
    // and `api/__tests__/admin-last-admin-pg.test.ts`.
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
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  async function seedEpisode(
    workspaceId: string,
    sourceId: string,
    visibleTo: readonly string[] = ["org"],
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', $2, 'evidence', $3::text[])
       RETURNING id`,
      [workspaceId, sourceId, [...visibleTo]],
    );
    return rows[0]!.id;
  }

  /** The `provenance` edge `reconcile.ts` writes for every episode behind a fact. */
  async function seedProvenanceEdge(
    workspaceId: string,
    factId: string,
    episodeId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
       VALUES ($1, 'provenance', $2::uuid, $3::uuid)`,
      [workspaceId, factId, episodeId],
    );
  }

  async function grantOf(id: string): Promise<readonly (string | null)[]> {
    const { rows } = await pool.query<{ visible_to: (string | null)[] }>(
      `SELECT visible_to FROM brain_facts WHERE id = $1`,
      [id],
    );
    return rows[0]!.visible_to;
  }

  /**
   * Run one publish in its own committed transaction, as `admin-publish.ts`
   * does. Rolls back on failure — releasing a client with an open or aborted
   * transaction poisons the pool and makes every later test in this file fail
   * somewhere other than the cause.
   */
  async function publish(workspaceId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, workspaceId));
      await client.query("COMMIT");
      return report;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function seedDraftFact(opts: {
    workspaceId: string;
    episodeId: string;
    subject: string;
    visibleTo?: readonly (string | null)[];
    status?: "draft" | "published";
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status, visible_to)
       VALUES ($1, $2, 'is', 'thing', $3, '{"actor":"test"}'::jsonb, $4, $5::text[])
       RETURNING id`,
      [
        opts.workspaceId,
        opts.subject,
        opts.episodeId,
        opts.status ?? "draft",
        opts.visibleTo ?? ["org"],
      ],
    );
    return rows[0]!.id;
  }

  async function statusOf(id: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM brain_facts WHERE id = $1`,
      [id],
    );
    return rows[0]!.status;
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. The refusable state IS reachable — the whole slice rests on this
  // ══════════════════════════════════════════════════════════════════

  it(
    "an entirely-malformed grant is STORABLE — the refusal has something real to refuse",
    async () => {
      // `chk_brain_facts_grant_nonempty` requires one non-NULL, non-'' element;
      // it does NOT require an element in the grant GRAMMAR, and it must never
      // be tightened (`acl.ts`: a row Postgres stores but Atlas refuses is a
      // workspace that cannot be migrated between regions). So `['everyone']`
      // lands at rest, grants nobody access, and is exactly the row the
      // promotion gate exists to catch. If this INSERT ever starts failing, the
      // GRANT_UNUSABLE refusal became dead code and should be reconsidered.
      const ws = "ws-storable";
      const ep = await seedEpisode(ws, "storable");
      const id = await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "ungranted",
        visibleTo: ["everyone"],
      });
      expect(id).toBeTruthy();
      expect(await statusOf(id)).toBe("draft");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 2. The provenance states are NOT reachable — the CHECK is the refusal
  // ══════════════════════════════════════════════════════════════════

  describe("no-provenance-no-promotion is enforced AT REST, so promotion never sees it", () => {
    it(
      "a fact with no source episode cannot be inserted (source_episode_id NOT NULL)",
      async () => {
        const ws = "ws-noprov";
        await expect(
          pool.query(
            `INSERT INTO brain_facts (workspace_id, subject, predicate, object, provenance, visible_to)
             VALUES ($1, 's', 'is', 'o', '{"a":1}'::jsonb, ARRAY['org'])`,
            [ws],
          ),
        ).rejects.toThrow(/source_episode_id/);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a fact with an empty provenance object cannot be inserted (chk_brain_facts_provenance_nonempty)",
      async () => {
        const ws = "ws-emptyprov";
        const ep = await seedEpisode(ws, "emptyprov");
        await expect(
          pool.query(
            `INSERT INTO brain_facts
               (workspace_id, subject, predicate, object, source_episode_id, provenance, visible_to)
             VALUES ($1, 's', 'is', 'o', $2, '{}'::jsonb, ARRAY['org'])`,
            [ws, ep],
          ),
        ).rejects.toThrow(/chk_brain_facts_provenance_nonempty/);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a fact whose episode belongs to ANOTHER workspace cannot be inserted (fk_brain_facts_episode)",
      async () => {
        // The composite FK is the other half of "no-provenance": evidence that
        // is not the tenant's own is not evidence the tenant may cite.
        const ep = await seedEpisode("ws-owner", "cross");
        await expect(
          pool.query(
            `INSERT INTO brain_facts
               (workspace_id, subject, predicate, object, source_episode_id, provenance, visible_to)
             VALUES ('ws-thief', 's', 'is', 'o', $1, '{"a":1}'::jsonb, ARRAY['org'])`,
            [ep],
          ),
        ).rejects.toThrow(/fk_brain_facts_episode/);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a grant with no usable element at all cannot be inserted (chk_brain_facts_grant_nonempty)",
      async () => {
        // The half of no-grant that IS structural: `[NULL, '']` has cardinality
        // 2 while granting nobody. Contrast with `['everyone']` above, which
        // the CHECK admits and promotion refuses.
        const ws = "ws-nogrant";
        const ep = await seedEpisode(ws, "nogrant");
        await expect(
          pool.query(
            `INSERT INTO brain_facts
               (workspace_id, subject, predicate, object, source_episode_id, provenance, visible_to)
             VALUES ($1, 's', 'is', 'o', $2, '{"a":1}'::jsonb, ARRAY[NULL, '']::text[])`,
            [ws, ep],
          ),
        ).rejects.toThrow(/chk_brain_facts_grant_nonempty/);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. The read gate
  // ══════════════════════════════════════════════════════════════════

  it(
    "draft facts are invisible to a published-mode read and visible in the developer overlay",
    async () => {
      const ws = "ws-readgate";
      const ep = await seedEpisode(ws, "readgate");
      await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "live", status: "published" });
      await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "pending" });

      const read = async (mode: "published" | "developer") => {
        // Through the REGISTRY, not a hand-written clause — this is also a live
        // check that `brain_facts` is registered at all (an unregistered table
        // fails with `UnknownTableError` rather than silently serving rows).
        const clause = await Effect.runPromise(registry.readFilter("brain_facts", mode, "f"));
        const { rows } = await pool.query<{ subject: string }>(
          `SELECT f.subject FROM brain_facts f
            WHERE f.workspace_id = $1 AND ${clause}
            ORDER BY f.subject COLLATE "C"`,
          [ws],
        );
        return rows.map((r) => r.subject);
      };

      expect(await read("published")).toEqual(["live"]);
      expect(await read("developer")).toEqual(["live", "pending"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 4. The promotion transaction
  // ══════════════════════════════════════════════════════════════════

  it(
    "promotes the compliant drafts, leaves the ungranted one a draft, and still commits",
    async () => {
      const ws = "ws-promote";
      const ep = await seedEpisode(ws, "promote");
      const good = await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "good" });
      const alsoGood = await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "also-good",
        visibleTo: ["user:u1"],
      });
      const bad = await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "bad",
        visibleTo: ["everyone"],
      });

      const client = await pool.connect();
      let report;
      try {
        await client.query("BEGIN");
        report = await Effect.runPromise(promoteBrainFacts(client, ws));
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      expect(report.promoted).toBe(2);
      expect(report.refused?.map((r) => r.rowId)).toEqual([bad]);
      expect(report.refused?.[0]?.reasons).toEqual([FACT_REFUSAL_REASONS.grantUnusable]);
      // The message names the CLAIM, read back out of the database — a uuid
      // alone would leave the admin nothing to look for.
      expect(report.refused?.[0]?.detail).toContain("bad is thing");
      expect(report.refused?.[0]?.detail).toContain("everyone");

      // The commit stands — the refusal quarantined the claim, not the publish.
      expect(await statusOf(good)).toBe("published");
      expect(await statusOf(alsoGood)).toBe("published");
      expect(await statusOf(bad)).toBe("draft");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a refused fact stays in draftCounts, so the backlog is visible and re-offered",
    async () => {
      // The refusal must not read as "done". If it dropped out of the count,
      // the pending-changes banner would go quiet and the fact would be lost
      // in practice even though the row survives.
      const ws = "ws-counts";
      const ep = await seedEpisode(ws, "counts");
      await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "ok" });
      await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "no-grant",
        visibleTo: ["everyone"],
      });

      const countDrafts = async () => {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM brain_facts WHERE workspace_id = $1 AND status = 'draft'`,
          [ws],
        );
        return rows[0]!.n;
      };

      expect(await countDrafts()).toBe(2);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await Effect.runPromise(promoteBrainFacts(client, ws));
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      expect(await countDrafts()).toBe(1);

      // And a second publish re-offers it — refusal is repeatable, not a
      // one-shot verdict that quietly forgets the row.
      const client2 = await pool.connect();
      try {
        await client2.query("BEGIN");
        const second = await Effect.runPromise(promoteBrainFacts(client2, ws));
        expect(second.promoted).toBe(0);
        expect(second.refused).toHaveLength(1);
        await client2.query("COMMIT");
      } finally {
        client2.release();
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "never promotes another workspace's drafts",
    async () => {
      const mine = "ws-scope-mine";
      const theirs = "ws-scope-theirs";
      const epMine = await seedEpisode(mine, "scope-mine");
      const epTheirs = await seedEpisode(theirs, "scope-theirs");
      const ours = await seedDraftFact({ workspaceId: mine, episodeId: epMine, subject: "ours" });
      const notOurs = await seedDraftFact({
        workspaceId: theirs,
        episodeId: epTheirs,
        subject: "not-ours",
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await Effect.runPromise(promoteBrainFacts(client, mine));
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      expect(await statusOf(ours)).toBe("published");
      expect(await statusOf(notOurs)).toBe("draft");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "every grant form it ACCEPTS is genuinely visible to some reader",
    async () => {
      // The refusal's whole justification is "it would be invisible to every
      // reader" — which makes the CONVERSE the thing that must be pinned. Today
      // that is asserted only against `parseGrant`; if `parseGrant` and
      // `aclVisibilityClause` ever drift, promotion would publish a fact nobody
      // can see and every existing test would stay green. So: publish each
      // accepted grant form, then read it back through the ENFORCING predicate.
      const ws = "ws-visible";
      const ep = await seedEpisode(ws, "visible");
      await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "g-org", visibleTo: ["org"] });
      await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "g-role",
        visibleTo: ["role:admin"],
      });
      await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "g-user",
        visibleTo: ["user:u1"],
      });
      await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "g-aud",
        visibleTo: ["audience:exec"],
      });
      await pool.query(
        `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
         VALUES ($1, 'exec', 'u1', 'test')`,
        [ws],
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const report = await Effect.runPromise(promoteBrainFacts(client, ws));
        expect(report.promoted).toBe(4);
        expect(report.refused).toEqual([]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      // An owner in `exec` satisfies all four arms (owner ⊇ admin via
      // `impliedRoles`), so every promoted fact must come back.
      const reader = await resolvePrincipalContext(pool, {
        workspaceId: ws,
        mode: "managed",
        userId: "u1",
        resolvedRole: { role: "owner", orgId: ws },
      });
      const clause = aclVisibilityClause(reader, {
        table: "brain_facts",
        alias: "f",
        paramIndex: 1,
      });
      const { rows } = await pool.query<{ subject: string }>(
        `SELECT f.subject FROM brain_facts f
          WHERE ${clause.sql} AND f.status = 'published'
          ORDER BY f.subject COLLATE "C"`,
        [...clause.params],
      );
      expect(rows.map((r) => r.subject)).toEqual(["g-aud", "g-org", "g-role", "g-user"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "GRANT_UNUSABLE is an invariant of the PROMOTION PATH, not of published facts",
    async () => {
      // Deliberate asymmetry, pinned so a future "fix" of one side has to argue
      // with a test. A region import writes `status` verbatim (the guard's one
      // allowlisted writer) and its own validation mirrors the 0180 CHECK, not
      // `parseGrant` — because an importer stricter than the CHECK would make a
      // legally-stored workspace unmigratable, which `acl.ts` forbids. So a
      // published fact with an unusable grant CAN exist; what cannot happen is
      // this gate creating one.
      const ws = "ws-asymmetry";
      const ep = await seedEpisode(ws, "asymmetry");
      const imported = await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "imported",
        visibleTo: ["everyone"],
        status: "published",
      });
      expect(await statusOf(imported)).toBe("published");

      // The same grant, arriving as a draft, is refused by promotion.
      const viaGate = await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "via-gate",
        visibleTo: ["everyone"],
      });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const report = await Effect.runPromise(promoteBrainFacts(client, ws));
        expect(report.refused?.map((r) => r.rowId)).toEqual([viaGate]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(await statusOf(viaGate)).toBe("draft");
      // And the imported one is untouched — promotion never revisits it.
      expect(await statusOf(imported)).toBe("published");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "a RETRACTED draft is neither promoted, counted, nor previewed",
    async () => {
      // `invalidated_at` is the tombstone; retraction is not a status flip
      // (ADR-0036: supersession is not deletion). All four brain_facts surfaces
      // must agree, or an excluded row becomes a backlog nobody is told about.
      const ws = "ws-retracted";
      const ep = await seedEpisode(ws, "retracted");
      const live = await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "live-draft" });
      const gone = await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "retracted-draft" });
      await pool.query(`UPDATE brain_facts SET invalidated_at = now() WHERE id = $1`, [gone]);

      // (1) draftCounts — the exact SQL the registry emits for this segment.
      const counted = await pool.query<{ n: number }>(brainFactsCountSql("$1"), [ws]);
      expect(counted.rows[0]!.n).toBe(1);

      // (2) the publish preview projection, run against the live schema. The
      // route has no unit test, so a bad column here 500s it in production
      // (the #4209 lesson from the knowledge surface).
      const previewed = await pool.query<{ id: string; label: string }>(
        `SELECT id::text AS id,
                subject || ' ' || predicate || ' ' || object AS label,
                updated_at
           FROM brain_facts
          WHERE workspace_id = $1 AND status = 'draft' AND invalidated_at IS NULL
          ORDER BY updated_at DESC`,
        [ws],
      );
      expect(previewed.rows.map((r) => r.id)).toEqual([live]);
      expect(previewed.rows[0]!.label).toBe("live-draft is thing");

      // (3) promotion.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const report = await Effect.runPromise(promoteBrainFacts(client, ws));
        expect(report.promoted).toBe(1);
        expect(report.refused).toEqual([]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(await statusOf(live)).toBe("published");
      expect(await statusOf(gone)).toBe("draft");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "two concurrent publishes cannot double-count or drop a draft (FOR UPDATE)",
    async () => {
      // The invariant: under concurrency each draft is promoted exactly once
      // and reported by exactly one publisher — never double-counted, never
      // promoted-but-unreported. This is the only read-then-write adapter and
      // there is no advisory or table lock anywhere else in the publish path,
      // so it is worth a real race rather than the string-match on "FOR UPDATE"
      // that was the only coverage before.
      //
      // MUTATION-TESTED, and the result corrected the adapter's comment: the
      // `FOR UPDATE` lock and the promote UPDATE's `status = 'draft'` predicate
      // are REDUNDANT. Removing either one alone leaves this test green (each
      // independently makes the second publisher promote nothing); removing
      // BOTH makes it fail with `promoted: 2`, a double-promote. So this test
      // pins the INVARIANT, not either mechanism — if you delete one of them,
      // this will not catch you, and the adapter comment says so.
      const ws = "ws-concurrent";
      const ep = await seedEpisode(ws, "concurrent");
      const a = await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "c-a" });
      const b = await seedDraftFact({ workspaceId: ws, episodeId: ep, subject: "c-b" });

      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");

        // Publisher 1 classifies and locks both drafts.
        const report1 = await Effect.runPromise(promoteBrainFacts(first, ws));
        expect(report1.promoted).toBe(2);

        // Publisher 2 starts while 1 still holds the lock. Its SELECT ... FOR
        // UPDATE must BLOCK rather than read the pre-promotion snapshot; if it
        // did not, it would classify the same two rows and race the UPDATE.
        let secondSettled = false;
        const race = Effect.runPromise(promoteBrainFacts(second, ws)).then((r) => {
          secondSettled = true;
          return r;
        });
        // Give it a real chance to finish if it were NOT blocking.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(secondSettled).toBe(false);

        await first.query("COMMIT");

        // Once the lock is released, publisher 2 sees the COMMITTED state:
        // both rows are `published`, so there is nothing left to promote. The
        // work is reported exactly once, by exactly one publisher.
        const report2 = await race;
        expect(report2.promoted).toBe(0);
        expect(report2.refused).toEqual([]);
        await second.query("COMMIT");
      } finally {
        first.release();
        second.release();
      }

      expect(await statusOf(a)).toBe("published");
      expect(await statusOf(b)).toBe("published");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves archived facts alone — promotion is draft→published, never a resurrection",
    async () => {
      const ws = "ws-archived";
      const ep = await seedEpisode(ws, "archived");
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance, status, visible_to)
         VALUES ($1, 'retired', 'is', 'thing', $2, '{"a":1}'::jsonb, 'archived', ARRAY['org'])
         RETURNING id`,
        [ws, ep],
      );
      const archived = rows[0]!.id;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const report = await Effect.runPromise(promoteBrainFacts(client, ws));
        expect(report.promoted).toBe(0);
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      expect(await statusOf(archived)).toBe("archived");
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 5. Publish-time grant widening (#4823) — cross-grant corroboration
  // ══════════════════════════════════════════════════════════════════
  //
  // Nothing short of a real database answers these. The widening statement
  // round-trips a per-row grant through jsonb into `text[]`, and the payoff is
  // a change in what `aclVisibilityClause` — a push-down Postgres predicate —
  // returns for a reader who was excluded a moment earlier. A double cannot
  // fake either half.

  const CHANNEL_AUDIENCE = "chat-channel:slack:C0BKTMEDUN9";
  const PRIVATE_GRANT = `audience:${CHANNEL_AUDIENCE}`;

  /** A reader resolved the way production resolves one — never hand-assembled (#4775). */
  async function readerIn(workspaceId: string, userId: string) {
    return resolvePrincipalContext(pool, {
      workspaceId,
      mode: "managed",
      userId,
      resolvedRole: { role: "member", orgId: workspaceId },
    });
  }

  async function subjectsVisibleTo(
    ctx: Awaited<ReturnType<typeof readerIn>>,
    extraSql = "",
  ): Promise<string[]> {
    const clause = aclVisibilityClause(ctx, {
      table: "brain_facts",
      alias: "f",
      paramIndex: 1,
    });
    const { rows } = await pool.query<{ subject: string }>(
      `SELECT f.subject FROM brain_facts f WHERE ${clause.sql} ${extraSql}
        ORDER BY f.subject COLLATE "C"`,
      [...clause.params],
    );
    return rows.map((r) => r.subject);
  }

  it(
    "publishes a privately-granted fact with the ORG grant its public evidence carries",
    async () => {
      // The exact shape the 2026-07-26 staging soak hit by accident: the same
      // sentence posted in a private channel and, four minutes later, a public
      // one. The second episode CORROBORATED (one fact, two provenance edges)
      // and the fact stayed locked to the private audience — fail-closed, but
      // it made org-wide information invisible to the org.
      const ws = "ws-c3";
      const privateEp = await seedEpisode(ws, "c3-private", [PRIVATE_GRANT]);
      const publicEp = await seedEpisode(ws, "c3-public", ["org"]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "prod-branch",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, fact, privateEp);
      await seedProvenanceEdge(ws, fact, publicEp);

      // `insider` is in the private channel; `outsider` is only in the org.
      await pool.query(
        `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
         VALUES ($1, $2, 'insider', 'test')`,
        [ws, CHANNEL_AUDIENCE],
      );
      const insider = await readerIn(ws, "insider");
      const outsider = await readerIn(ws, "outsider");

      // Before: the grant genuinely excludes the outsider. Asserted WITHOUT the
      // status filter, or "invisible because it is a draft" would masquerade as
      // "invisible because of the grant" and the test would prove nothing.
      expect(await subjectsVisibleTo(outsider)).toEqual([]);
      expect(await subjectsVisibleTo(insider)).toEqual(["prod-branch"]);

      const report = await publish(ws);
      expect(report.promoted).toBe(1);
      expect(report.refused).toEqual([]);

      // Append-only: the private token keeps its place and `org` follows it.
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT, "org"]);
      expect(await statusOf(fact)).toBe("published");

      // After: the outsider reads it through the real push-down predicate…
      expect(await subjectsVisibleTo(outsider, "AND f.status = 'published'")).toEqual([
        "prod-branch",
      ]);
      // …and the insider did not lose it.
      expect(await subjectsVisibleTo(insider, "AND f.status = 'published'")).toEqual([
        "prod-branch",
      ]);

      // The invariant the M1 soak corpus pins for this case: ONE fact survives cross-grant
      // corroboration, and `brain_edges` still holds BOTH episodes.
      const { rows: facts } = await pool.query(
        `SELECT id FROM brain_facts WHERE workspace_id = $1 AND subject = 'prod-branch'`,
        [ws],
      );
      expect(facts).toHaveLength(1);
      const { rows: edges } = await pool.query<{ to_episode_id: string }>(
        `SELECT to_episode_id FROM brain_edges
          WHERE workspace_id = $1 AND edge_type = 'provenance' AND from_fact_id = $2
          ORDER BY to_episode_id`,
        [ws, fact],
      );
      // Explicit comparator — a bare `.sort()` stringifies through `toString()`
      // and the type-aware lint gate refuses it (`require-array-sort-compare`).
      const byString = (a: string, b: string) => a.localeCompare(b);
      expect(edges.map((e) => e.to_episode_id).sort(byString)).toEqual(
        [privateEp, publicEp].sort(byString),
      );
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "never narrows — a private episode behind a public fact leaves `org` in place",
    async () => {
      // The direction `reconcile.ts` was already safe in, re-proved at the gate
      // that now writes the column. Widening is a union, so the audience token
      // is added; what must never happen is `org` being displaced by it.
      const ws = "ws-c3-narrow";
      const publicEp = await seedEpisode(ws, "narrow-public", ["org"]);
      const privateEp = await seedEpisode(ws, "narrow-private", [PRIVATE_GRANT]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: publicEp,
        subject: "public-claim",
        visibleTo: ["org"],
      });
      await seedProvenanceEdge(ws, fact, publicEp);
      await seedProvenanceEdge(ws, fact, privateEp);

      expect((await publish(ws)).promoted).toBe(1);
      const grant = await grantOf(fact);
      expect(grant[0]).toBe("org");
      expect(grant).toContain(PRIVATE_GRANT);
      expect(await subjectsVisibleTo(await readerIn(ws, "anyone"), "AND f.status = 'published'"))
        .toEqual(["public-claim"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "widens only from `provenance` edges — a `derives-from` episode is lineage, not testimony",
    async () => {
      // The edge filter is #4823's own narrowing (ADR-0036 constrains WHEN a
      // grant may widen, not which edge feeds it), so nothing but this test
      // holds it: drop `AND e.edge_type = 'provenance'` and every other case in
      // this section still passes, because they all seed provenance edges.
      const ws = "ws-c3-edge-type";
      const privateEp = await seedEpisode(ws, "edge-private", [PRIVATE_GRANT]);
      const derivedFrom = await seedEpisode(ws, "edge-derived", ["org"]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "lineage-only",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, fact, privateEp);
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
         VALUES ($1, 'derives-from', $2::uuid, $3::uuid)`,
        [ws, fact, derivedFrom],
      );

      expect((await publish(ws)).promoted).toBe(1);
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT]);
      expect(
        await subjectsVisibleTo(await readerIn(ws, "outsider"), "AND f.status = 'published'"),
      ).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "widens only from episodes EDGED to the fact — a stray workspace episode is not evidence",
    async () => {
      // Guards the mutation that would hurt most: "union in every episode in
      // the workspace" instead of "every episode on an edge to THIS fact".
      // That is mass over-disclosure of every draft on the next publish, and it
      // passes every other test here, where the unedged episodes happen to
      // carry the grant the fact already has.
      const ws = "ws-c3-unlinked";
      const privateEp = await seedEpisode(ws, "unlinked-private", [PRIVATE_GRANT]);
      await seedEpisode(ws, "unlinked-public", ["org"]); // deliberately no edge
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "unlinked",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, fact, privateEp);

      expect((await publish(ws)).promoted).toBe(1);
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT]);
      expect(
        await subjectsVisibleTo(await readerIn(ws, "outsider"), "AND f.status = 'published'"),
      ).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "widening to another AUDIENCE still excludes a reader in neither",
    async () => {
      // Every other case widens to `org`, where "everyone can now read it" is
      // the expected answer and the predicate is only ever proved permissive
      // enough. This is the negative: the round trip through
      // `jsonb_array_elements_text` must produce a grant that still DENIES.
      const ws = "ws-c3-audience";
      const audienceA = "chat-channel:slack:CAAAAAAAA";
      const audienceB = "chat-channel:slack:CBBBBBBBB";
      const epA = await seedEpisode(ws, "aud-a", [`audience:${audienceA}`]);
      const epB = await seedEpisode(ws, "aud-b", [`audience:${audienceB}`]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: epA,
        subject: "two-rooms",
        visibleTo: [`audience:${audienceA}`],
      });
      await seedProvenanceEdge(ws, fact, epA);
      await seedProvenanceEdge(ws, fact, epB);
      await pool.query(
        `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
         VALUES ($1, $2, 'in-a', 'test'), ($1, $3, 'in-b', 'test')`,
        [ws, audienceA, audienceB],
      );

      const inA = await readerIn(ws, "in-a");
      const inB = await readerIn(ws, "in-b");
      const inNeither = await readerIn(ws, "in-neither");
      expect(await subjectsVisibleTo(inB)).toEqual([]);

      expect((await publish(ws)).promoted).toBe(1);
      const published = "AND f.status = 'published'";

      expect(await subjectsVisibleTo(inA, published)).toEqual(["two-rooms"]);
      expect(await subjectsVisibleTo(inB, published)).toEqual(["two-rooms"]);
      // The one that matters: a plain org member in neither room still reads
      // nothing. A widening that leaked `org` in would show up only here.
      expect(await subjectsVisibleTo(inNeither, published)).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "widens TWO facts in one statement without crossing their grants",
    async () => {
      // `WIDEN_AND_PROMOTE_FACTS_SQL` joins a jsonb set of `{id, grant}` to the
      // rows on `f.id = w.id`. With one entry that join is vacuous — every
      // other widening case here has exactly one, so dropping the predicate
      // passes all of them. With two DIFFERENTLY-widened facts it is the whole
      // statement: a mis-join publishes fact A's claim under fact B's grant,
      // which is an ACL write to the wrong row in the direction that discloses.
      const ws = "ws-c3-pair";
      const audienceB = "audience:chat-channel:slack:CBBBBBBBB";
      const epOnePriv = await seedEpisode(ws, "pair-1-priv", [PRIVATE_GRANT]);
      const epOneWide = await seedEpisode(ws, "pair-1-wide", [audienceB]);
      const epTwoPriv = await seedEpisode(ws, "pair-2-priv", [PRIVATE_GRANT]);
      const epTwoWide = await seedEpisode(ws, "pair-2-wide", ["org"]);

      const one = await seedDraftFact({
        workspaceId: ws,
        episodeId: epOnePriv,
        subject: "pair-one",
        visibleTo: [PRIVATE_GRANT],
      });
      const two = await seedDraftFact({
        workspaceId: ws,
        episodeId: epTwoPriv,
        subject: "pair-two",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, one, epOnePriv);
      await seedProvenanceEdge(ws, one, epOneWide);
      await seedProvenanceEdge(ws, two, epTwoPriv);
      await seedProvenanceEdge(ws, two, epTwoWide);

      const report = await publish(ws);
      expect(report.promoted).toBe(2);
      // Each fact got ITS OWN union, and neither carries the other's token.
      expect(await grantOf(one)).toEqual([PRIVATE_GRANT, audienceB]);
      expect(await grantOf(two)).toEqual([PRIVATE_GRANT, "org"]);
      // The report the durable audit row is built from describes what Postgres
      // actually did — asserted here, where both sides are real.
      expect(report.widened).toEqual([
        { rowId: one, added: [audienceB] },
        { rowId: two, added: ["org"] },
      ]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "commits both promote statements in one publish and counts each row once",
    async () => {
      // The adapter sums `rowCount` across two UPDATEs. Elsewhere only the
      // doubles exercise that split, and a double always agrees with itself —
      // only a real database proves the two statements sum to the row count.
      const ws = "ws-c3-mixed";
      const publicEp = await seedEpisode(ws, "mixed-public", ["org"]);
      const privateEp = await seedEpisode(ws, "mixed-private", [PRIVATE_GRANT]);
      const plain = await seedDraftFact({
        workspaceId: ws,
        episodeId: publicEp,
        subject: "a-plain",
        visibleTo: ["org"],
      });
      const wide = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "b-wide",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, plain, publicEp);
      await seedProvenanceEdge(ws, wide, privateEp);
      await seedProvenanceEdge(ws, wide, publicEp);

      expect((await publish(ws)).promoted).toBe(2);
      expect(await statusOf(plain)).toBe("published");
      expect(await statusOf(wide)).toBe("published");
      expect(await grantOf(plain)).toEqual(["org"]);
      expect(await grantOf(wide)).toEqual([PRIVATE_GRANT, "org"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "does not rewrite an ALREADY-PUBLISHED fact's grant on a later publish",
    async () => {
      // ADR-0036 §T5 makes a grant an immutable per-version snapshot; the gate
      // is the one moment it is computed. New evidence arriving after a fact is
      // published must not retroactively re-open it — that is supersession's
      // job (M2), and it is what the `status = 'draft'` predicate on the
      // widening UPDATE is holding shut.
      const ws = "ws-c3-immutable";
      const privateEp = await seedEpisode(ws, "imm-private", [PRIVATE_GRANT]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "sealed",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, fact, privateEp);

      expect((await publish(ws)).promoted).toBe(1);
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT]);

      // Now a public episode corroborates the already-published claim.
      const publicEp = await seedEpisode(ws, "imm-public", ["org"]);
      await seedProvenanceEdge(ws, fact, publicEp);

      expect((await publish(ws)).promoted).toBe(0);
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "preserves a NULL element through the jsonb round-trip the widening does",
    async () => {
      // `visible_to` may legally hold NULL alongside a usable token
      // (`chk_brain_facts_grant_nonempty` counts only the usable ones), and the
      // widening statement is the one write that sends an existing grant OUT to
      // JSON and back. A round-trip that dropped or stringified the NULL would
      // be a silent rewrite of a row the publish was only supposed to extend.
      const ws = "ws-c3-null";
      const privateEp = await seedEpisode(ws, "null-private", [PRIVATE_GRANT]);
      const publicEp = await seedEpisode(ws, "null-public", ["org"]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "ragged",
        visibleTo: [PRIVATE_GRANT, null],
      });
      await seedProvenanceEdge(ws, fact, privateEp);
      await seedProvenanceEdge(ws, fact, publicEp);

      expect((await publish(ws)).promoted).toBe(1);
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT, null, "org"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "cannot be fed another tenant's episode — the edge itself is unstorable",
    async () => {
      // The widening query is workspace-scoped on both sides of its join, but
      // the primary guarantee is structural: `brain_edges`' composite FKs mean
      // a cross-tenant evidence edge never lands, so there is no such row for
      // the query to be careless about. Asserted here because "the SQL has a
      // predicate" is a weaker claim than "the state is unrepresentable".
      const wsA = "ws-c3-tenant-a";
      const wsB = "ws-c3-tenant-b";
      const epA = await seedEpisode(wsA, "tenant-a", [PRIVATE_GRANT]);
      const factA = await seedDraftFact({
        workspaceId: wsA,
        episodeId: epA,
        subject: "theirs",
        visibleTo: [PRIVATE_GRANT],
      });
      const epB = await seedEpisode(wsB, "tenant-b", ["org"]);

      await expect(
        pool.query(
          `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
           VALUES ($1, 'provenance', $2::uuid, $3::uuid)`,
          [wsA, factA, epB],
        ),
      ).rejects.toThrow(/foreign key|violates/i);

      expect((await publish(wsA)).promoted).toBe(1);
      expect(await grantOf(factA)).toEqual([PRIVATE_GRANT]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
