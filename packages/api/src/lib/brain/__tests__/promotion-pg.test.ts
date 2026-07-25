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
 *      CHECK is what refuses — at INSERT — rather than inserting an impossible
 *      row to watch the adapter reject it. There is no such row to insert.
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
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
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

  async function seedEpisode(workspaceId: string, sourceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', $2, 'evidence', ARRAY['org'])
       RETURNING id`,
      [workspaceId, sourceId],
    );
    return rows[0]!.id;
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
      // it does NOT require a element in the grant GRAMMAR, and it must never
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
});
