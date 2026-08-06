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
  brainFactPreviewSql,
  brainFactsCountSql,
  promoteBrainFacts,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import {
  aclVisibilityClause,
  resolvePrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import { declarePredicateCardinality } from "@atlas/api/lib/brain/cardinality";
import { comparableValue } from "@atlas/api/lib/brain/object-cmp";
import { FACT_REFUSAL_REASONS } from "@atlas/api/lib/brain/promotion";
import { CORROBORATION_LOOKUP_SQL } from "@atlas/api/lib/brain/reconcile";
import { loadSupersessionPreview } from "@atlas/api/lib/brain/oversight";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import { buildFactQuery } from "@atlas/api/lib/brain/search";

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
    /** Set only when ROLLBACK itself failed — passing it to `release` destroys the client. */
    let destroyReason: Error | undefined;
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, workspaceId));
      await client.query("COMMIT");
      return report;
    } catch (err) {
      // The ROLLBACK must not REPLACE the failure the test was about, and a
      // client with an open transaction must not return to the pool for the
      // next test to inherit — passing a reason to `release` destroys it
      // instead. Same shape as `identity-consumers-pg.test.ts`'s helper (#5021).
      await client.query("ROLLBACK").catch((cause: unknown) => {
        destroyReason = cause instanceof Error ? cause : new Error(String(cause));
        console.warn(
          `publish(${workspaceId}): ROLLBACK failed after "${
            err instanceof Error ? err.message : String(err)
          }" — destroying the connection: ${destroyReason.message}`,
        );
      });
      throw err;
    } finally {
      client.release(destroyReason);
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
      "a NON-OBJECT provenance cannot be inserted either — the half #5033's tier guard rests on",
      async () => {
        // `chk_brain_facts_provenance_nonempty` is TWO conjuncts, and the test
        // above exercises only the second (`<> '{}'`). The FIRST —
        // `jsonb_typeof(provenance) = 'object'` — is what makes the tier guard's
        // `NOT jsonb_exists(p.provenance, 'source')` carve-out mean "no `source`
        // key" rather than "any provenance that cannot have keys": a jsonb array
        // has no `source` either, so if one were storable, a mangled
        // warehouse-derived row would read as supersedable and the guard would
        // fail OPEN on the irreversible column.
        //
        // Without this case the `jsonb_typeof` half could be dropped from the
        // CHECK with every test in the repo staying green, which is exactly the
        // dependency `supersedableTierSql`'s docstring says a future migration
        // must trip over.
        const ws = "ws-arrayprov";
        const ep = await seedEpisode(ws, "arrayprov");
        for (const notAnObject of ["[1]", '"a string"', "42"]) {
          await expect(
            pool.query(
              `INSERT INTO brain_facts
                 (workspace_id, subject, predicate, object, source_episode_id, provenance, visible_to)
               VALUES ($1, 's', 'is', 'o', $2, $3::jsonb, ARRAY['org'])`,
              [ws, ep, notAnObject],
            ),
          ).rejects.toThrow(/chk_brain_facts_provenance_nonempty/);
        }
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

      // (2) the publish preview projection, run against the live schema — and
      // now THE statement the route ships rather than a hand-copy of it, which
      // is how this assertion silently outlived the shape it was written for.
      // The route has no unit test, so a bad column here 500s it in production
      // (the #4209 lesson from the knowledge surface).
      const previewAcl = aclVisibilityClause(
        await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u-preview",
          resolvedRole: { role: "admin", orgId: ws },
        }),
        { table: "brain_facts", alias: "f", paramIndex: 1 },
      );
      const previewed = await pool.query<{ id: string; label: string }>(
        brainFactPreviewSql(previewAcl.sql),
        [...previewAcl.params],
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

  // -------------------------------------------------------------------------
  // The pre-widening grant is PERSISTED (#4836)
  // -------------------------------------------------------------------------

  /** `brain_facts.pre_widening_visible_to` — `null` when it was never widened. */
  async function preWideningGrantOf(id: string): Promise<readonly (string | null)[] | null> {
    const { rows } = await pool.query<{ pre_widening_visible_to: (string | null)[] | null }>(
      `SELECT pre_widening_visible_to FROM brain_facts WHERE id = $1`,
      [id],
    );
    return rows[0]!.pre_widening_visible_to;
  }

  it(
    "records the pre-widening grant on the same UPDATE that overwrites it",
    async () => {
      // #4836's whole premise: nothing at rest could tell "visible to org
      // because it always was" from "visible to org because evidence widened
      // it". `EvidenceWidenedGrant` knows in memory and is discarded one
      // statement later, and `visible_to` is overwritten in place — so this
      // column is the only surviving copy, and this test is the only place
      // Postgres's OLD-row evaluation of the SET list is actually proven.
      const ws = "ws-4836-persist";
      const privateEp = await seedEpisode(ws, "4836-private", [PRIVATE_GRANT]);
      const publicEp = await seedEpisode(ws, "4836-public", ["org"]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "widened-claim",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, fact, privateEp);
      await seedProvenanceEdge(ws, fact, publicEp);

      // Nothing recorded before publish — widening happens at the review gate.
      expect(await preWideningGrantOf(fact)).toBeNull();

      expect((await publish(ws)).promoted).toBe(1);

      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT, "org"]);
      // The narrow grant survived its own overwrite. Without this the read
      // path has no input and discloses to everyone.
      expect(await preWideningGrantOf(fact)).toEqual([PRIVATE_GRANT]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the column NULL for a fact nothing widened",
    async () => {
      // The negative, and it is load-bearing rather than tidy: NULL is what
      // the read path treats as "disclose". A `PROMOTE_FACTS_SQL` that started
      // stamping this column would withhold attribution across the entire
      // corpus and pass every positive assertion above.
      const ws = "ws-4836-plain";
      const ep = await seedEpisode(ws, "4836-plain", ["org"]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "plain-claim",
        visibleTo: ["org"],
      });
      await seedProvenanceEdge(ws, fact, ep);

      expect((await publish(ws)).promoted).toBe(1);
      expect(await grantOf(fact)).toEqual(["org"]);
      expect(await preWideningGrantOf(fact)).toBeNull();
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the NARROWEST pre-widening grant when a fact is widened twice",
    async () => {
      // Unreachable on the normal path — the widening UPDATE writes
      // `status = 'published'` under a `status = 'draft'` predicate. But a
      // region import writes `status` verbatim (ADR-0024) and can legitimately
      // land an already-widened fact back in `draft`. Overwriting would then
      // record the WIDER grant as the original and disclose attribution to
      // readers the FIRST widening admitted, which is the failure this column
      // exists to prevent — so `COALESCE` keeps the first.
      const ws = "ws-4836-rewiden";
      const audienceB = "audience:chat-channel:slack:CBBBBBBBB";
      const privateEp = await seedEpisode(ws, "rewiden-private", [PRIVATE_GRANT]);
      const secondEp = await seedEpisode(ws, "rewiden-second", [audienceB]);
      const fact = await seedDraftFact({
        workspaceId: ws,
        episodeId: privateEp,
        subject: "rewidened-claim",
        visibleTo: [PRIVATE_GRANT],
      });
      await seedProvenanceEdge(ws, fact, privateEp);
      await seedProvenanceEdge(ws, fact, secondEp);

      expect((await publish(ws)).promoted).toBe(1);
      expect(await preWideningGrantOf(fact)).toEqual([PRIVATE_GRANT]);

      // A region import demotes it and a third episode arrives, wider again.
      const thirdEp = await seedEpisode(ws, "rewiden-third", ["org"]);
      await seedProvenanceEdge(ws, fact, thirdEp);
      await pool.query(`UPDATE brain_facts SET status = 'draft' WHERE id = $1`, [fact]);

      expect((await publish(ws)).promoted).toBe(1);
      expect(await grantOf(fact)).toEqual([PRIVATE_GRANT, audienceB, "org"]);
      // Still the FIRST grant, not `[PRIVATE_GRANT, audienceB]`.
      expect(await preWideningGrantOf(fact)).toEqual([PRIVATE_GRANT]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  // ══════════════════════════════════════════════════════════════════
  // 6. Human-gated supersession (#4912) — the live semantics
  // ══════════════════════════════════════════════════════════════════

  describe("human-gated supersession at the publish gate (#4912)", () => {
    /** A private channel's grant, for the ACL-withholding case below. */
    const SUPERSEDE_PRIVATE_GRANT = "audience:chat-channel:slack:C04912PRIV";

    /** A fact with the SPO + cardinality the collision join actually reads. */
    async function seedFact(opts: {
      workspaceId: string;
      episodeId: string;
      subject: string;
      object: string;
      /** Defaults to `manager`; override to vary the PREDICATE slot. */
      predicate?: string;
      /**
       * The CANONICAL PREDICATE's cardinality, declared in the vocabulary
       * (#5027) — no longer a column on the row.
       *
       * The option survives the move because every test here still means "this
       * predicate can/cannot supersede", but WHERE it is recorded changed
       * completely: `brain_facts.predicate_cardinality` is not written by this
       * fixture any more (it falls to its schema default, exactly as
       * `INSERT_FACT_SQL` now leaves it), and the publish gate reads
       * `brain_predicate_cardinality` instead.
       *
       * ⚠️ It is therefore PER PREDICATE, not per row: two `seedFact` calls in
       * one workspace at one predicate share an entry, and the last one wins.
       * A test that needs two cardinalities at once needs two predicates.
       */
      cardinality?: "single" | "multi";
      status?: "draft" | "published";
      /** Defaults to org-wide; override for the ACL-withholding cases. */
      visibleTo?: readonly string[];
      /**
       * Land the row UNKEYED — all three key columns NULL — which is what a
       * region import produces today (`admin-migrate.ts`'s 18-column INSERT
       * names none of them, #5035) and what every row written between migration
       * 0187 and #5020 looked like before 0188's backfill repeat.
       */
      unkeyed?: boolean;
      /**
       * The entity id a store resolved this object to, which is what makes the
       * object COMPARABLE and therefore what the publish gate now reads (#5030).
       *
       * Defaults to one id per distinct normalized object surface — i.e. these
       * rows behave as though a real entity store had resolved every object,
       * which is what #5031 wires up. Pass `null` to model the SHIPPED default
       * (`passthroughEntityResolver` resolves nothing) and land an object that
       * cannot be compared at all.
       *
       * ⚠️ **Why a default and not a per-call-site value.** Supersession now
       * requires POSITIVE evidence of difference — `object_key <> object_key`
       * proves only that two surfaces did not normalize together, which is also
       * true of `$499` and `499 USD`. Every test in this block predates that and
       * is about the SLOT, the cardinality gate, the ACL withholding or the
       * disclosure, none of which changed; without a comparable object they
       * would all silently stop exercising supersession at all and pass as
       * prohibitions. Deriving the id from the KEY rather than the raw surface
       * is what keeps `bob`/`Bob` reading as one entity, so the object-slot test
       * below still proves what it says it does.
       *
       * The cost, recorded rather than hidden: with the default in force
       * `object_cmp` mirrors `object_key` for every row here, so this file can
       * no longer tell the two columns apart. It is not the file that ever
       * could — `identity-consumers-pg.test.ts` runs one corpus past all three
       * consumers and owns that proof, and `the abstain band` test below is what
       * keeps THIS file from being blind to the change it is adapting to.
       */
      entityId?: string | null;
      /**
       * The stored `provenance`, whose `source` key #5033's tier guard reads.
       *
       * ⚠️ **The default carries NO `source` key, and that is load-bearing
       * rather than laziness.** The guard is an allowlist over the source
       * vocabulary with one carve-out: a provenance with no `source` at all is
       * still supersedable, because that shape predates the tier lane, nothing
       * structurally guarantees the key, and retiring it would break
       * supersession for facts no region import ever touched.
       * `correction.ts`'s `unrecognizedSourceKind` makes the identical
       * carve-out for the correction path and calls closing it *a regression
       * dressed as a fix*.
       *
       * So six prior tests in this block assert a STAMP through a `source`-less
       * provenance, and the ACL-withheld preview test and the carve-out test at
       * the end reach the same default — eight in all, which is the carve-out's
       * coverage and the number the mutation table below records. Do not "fix" this
       * default by adding a source: it would leave the carve-out asserted
       * nowhere, and the tier guard's absent-key disjunct would become
       * unfalsifiable.
       */
      provenance?: Record<string, unknown>;
    }): Promise<string> {
      const predicate = opts.predicate ?? "manager";
      const objectKey = slotKey(opts.object, identityAlias);
      // `objectKey === null` — a surface that norms away (`-`, `___`) — resolves
      // to NO entity, and the arm is load-bearing rather than defensive: without
      // it the default mints the id `ent:` for every degenerate object, so two
      // unrelated placeholder claims become one provably-different pair and the
      // partially-keyed test below starts stamping `valid_to`. A surface that
      // asserts nothing cannot name an entity.
      const resolvedEntity =
        opts.entityId === undefined
          ? (objectKey === null ? undefined : `ent:${objectKey}`)
          : (opts.entityId ?? undefined);
      // Keyed like an ingested row (#5020): the collision join and the
      // corroboration lookup both match on `*_key`, so a seed that omitted them
      // would be an UNKEYED row — a legitimate corpus state (0187's interval,
      // and a region import until #5035) but not the one these tests are about,
      // and one that collides with nothing. Derived through `slotKey`, the same
      // function `INSERT_FACT_SQL` calls, rather than hand-written beside the
      // surface where the two could quietly disagree. (`INSERT_FACT_SQL` is a
      // string constant; the function is what `reconcile.ts` calls when binding
      // it.)
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id,
            provenance, status, visible_to,
            subject_key, predicate_key, object_key, object_cmp)
         VALUES ($1, $2, $3, $4, $5, $12::jsonb, $6, $10::text[],
                 $7, $8, $9, $11)
         RETURNING id`,
        [
          opts.workspaceId,
          opts.subject,
          predicate,
          opts.object,
          opts.episodeId,
          opts.status ?? "draft",
          opts.unkeyed === true ? null : slotKey(opts.subject, identityAlias),
          opts.unkeyed === true ? null : slotKey(predicate, identityAlias),
          opts.unkeyed === true ? null : objectKey,
          opts.visibleTo ?? ["org"],
          // Through `comparableValue`, the same function `reconcile.ts` calls,
          // rather than a hand-written `entity:…` literal beside the surface —
          // a fixture that spelled the tag itself would agree with a producer
          // that stopped emitting one.
          opts.unkeyed === true
            ? null
            : comparableValue({ surface: opts.object, entityId: resolvedEntity }),
          JSON.stringify(opts.provenance ?? { actor: "test" }),
        ],
      );
      // Declared AFTER the row lands, and through the shipped authoring door
      // rather than a raw INSERT, so a change to what the write path admits
      // reaches this suite instead of being routed around.
      //
      // Unconditional, including for an `unkeyed` row: its NULL `predicate_key`
      // matches no entry, which is the fail-closed behaviour those tests are
      // about, and skipping the declaration would make them pass for the wrong
      // reason.
      const declared = await declarePredicateCardinality(pool, opts.workspaceId, {
        predicateKey: slotKey(predicate, identityAlias),
        cardinality: opts.cardinality ?? "single",
        authoredBy: "curator-1",
      });
      expect(
        declared.ok,
        `declaring "${predicate}" ${opts.cardinality ?? "single"} failed — supersession would then never fire and every prohibition here would pass vacuously`,
      ).toBe(true);
      return rows[0]!.id;
    }

    async function factState(id: string) {
      const { rows } = await pool.query<{
        status: string;
        invalidated_at: Date | null;
        valid_to: Date | null;
      }>(`SELECT status, invalidated_at, valid_to FROM brain_facts WHERE id = $1`, [id]);
      return rows[0]!;
    }

    async function supersedesEdges(ws: string) {
      const { rows } = await pool.query<{ f: string; t: string }>(
        `SELECT from_fact_id::text AS f, to_fact_id::text AS t
           FROM brain_edges
          WHERE workspace_id = $1 AND edge_type = 'supersedes'
          ORDER BY f, t`,
        [ws],
      );
      return rows;
    }

    it(
      "stamps valid_to and writes the supersedes edge atomically — and it is NOT a retraction",
      async () => {
        const ws = "ws-4912-stamp";
        const ep = await seedEpisode(ws, "stamp");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([{ rowId: draft, superseded: [old] }]);

        const oldState = await factState(old);
        expect(oldState.valid_to).not.toBeNull();
        // Supersession is not deletion: the review verdict stands and the
        // tombstone is untouched, so as-of reads still serve the row.
        expect(oldState.status).toBe("published");
        expect(oldState.invalidated_at).toBeNull();
        expect((await factState(draft)).status).toBe("published");
        expect(await supersedesEdges(ws)).toEqual([{ f: draft, t: old }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "hides the superseded fact from an as-of-now read exactly as a tombstoned one",
      async () => {
        const ws = "ws-4912-hide";
        const ep = await seedEpisode(ws, "hide");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });
        await publish(ws);

        // Not a paraphrase: run the EXACT statement `searchBrain` builds, so a
        // predicate dropped from `buildFactQuery` fails here, not only in the
        // unit test that pins the clause as a string.
        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        const aclClause = aclVisibilityClause(reader, {
          table: "brain_facts",
          alias: "f",
          paramIndex: 1,
        });
        if (aclClause.decision === "deny-all") throw new Error("reader should resolve");
        const built = buildFactQuery("published", {
          limit: 10,
          aclSql: aclClause.sql,
          aclParams: aclClause.params,
        });
        const { rows } = await pool.query<{ id: string }>(built.sql, built.params);
        expect(rows.map((r) => r.id)).toEqual([draft]);
        expect(rows.map((r) => r.id)).not.toContain(old);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a `multi` predicate coexists — never superseded by publish (#5027)",
      async () => {
        // This test used to seed FOUR rows to cover both directions of a
        // disagreement: a `multi` incumbent under a `single` draft, and the
        // reverse. Both directions are gone, and their absence is the slice:
        // cardinality belongs to the canonical predicate, so two rows in one
        // slot cannot disagree about it — the state those two pairs modelled is
        // unrepresentable rather than handled.
        //
        // What remains is the rule itself, plus a control in the same shape so
        // "0" is evidence rather than a fixture that could never have collided.
        const ws = "ws-4912-multi";
        const ep = await seedEpisode(ws, "multi");
        const coexisting = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          predicate: "speaks",
          object: "python",
          cardinality: "multi",
          status: "published",
        });
        await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          predicate: "speaks",
          object: "rust",
          cardinality: "multi",
        });
        // The control, on its OWN predicate so the two entries do not overwrite
        // each other — the one way this fixture can now be got wrong.
        const retired = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "bob",
          predicate: "manager",
          object: "go",
          cardinality: "single",
          status: "published",
        });
        await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "bob",
          predicate: "manager",
          object: "zig",
          cardinality: "single",
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(2);
        expect((await factState(coexisting)).valid_to).toBeNull();
        expect(
          (await factState(retired)).valid_to,
          "the `single` control was not superseded either — this test is then a prohibition against a fixture that could never have collided",
        ).not.toBeNull();
        expect(await supersedesEdges(ws)).toEqual([{ f: expect.any(String), t: retired }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "an UNCURATED predicate coexists too — absent means `multi` (#5027)",
      async () => {
        // The positive-evidence rule at the gate that actually stamps. An
        // explicit `multi` entry is a human declining the question; ABSENCE is
        // nobody having asked, and the two must behave identically here.
        const ws = "ws-5027-uncurated-publish";
        const ep = await seedEpisode(ws, "uncurated");
        const incumbent = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          predicate: "manager",
          object: "bob",
          status: "published",
        });
        await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          predicate: "manager",
          object: "carol",
        });
        // Remove the entry `seedFact` wrote, leaving the corpus in the state a
        // workspace that has curated nothing is in. Deleting is the only way to
        // reach it: the fixture declares on every seed precisely so no OTHER
        // test can be silently uncurated.
        await pool.query(`DELETE FROM brain_predicate_cardinality WHERE workspace_id = $1`, [ws]);

        const report = await publish(ws);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([]);
        expect((await factState(incumbent)).valid_to).toBeNull();
        expect(await supersedesEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "two same-batch rivals coexist in tension rather than destroying each other",
      async () => {
        // Neither is "already published" when the batch begins, so neither is
        // superseded — there is no temporal order between them to arbitrate,
        // and stamping both would destroy both beliefs.
        const ws = "ws-4912-batch";
        const ep = await seedEpisode(ws, "batch");
        const a = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
        });
        const b = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(2);
        expect(report.superseded).toEqual([]);
        expect((await factState(a)).valid_to).toBeNull();
        expect((await factState(b)).valid_to).toBeNull();
        expect(await supersedesEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a re-observation after supersession corroborates NOTHING — the flip-back mints a fresh draft",
      async () => {
        const ws = "ws-4912-flip";
        const ep = await seedEpisode(ws, "flip");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });
        await publish(ws);
        expect((await factState(old)).valid_to).not.toBeNull();

        // The exact string `reconcile.ts` runs, bound the way it binds it — the
        // SLOT KEYS, not the surfaces (#5020). "alice manager bob" flips back:
        // the superseded row must NOT absorb the evidence — it is hidden from
        // every as-of-now read, so corroborating it would swallow the flip.
        //
        // FIVE binds since #5032 — the three slot keys, the OBJECT's comparable
        // value (#5030) and the SUBJECT's (#5032) — and neither `_cmp` is
        // optional padding. `reconcile.ts` corroborates on
        // `object_key = $4 OR object_cmp = $5`, so a re-observation whose typed
        // value matches would corroborate through the second arm even when the
        // keys disagree; and `$6` is vetoed by proven SUBJECT difference, whose
        // polarity is INVERTED (a match there suppresses rather than enables).
        // Binding fewer would test a statement this repo does not run — and pg
        // says so, rather than silently answering: an arity mismatch is a bind
        // error, which is why this call site had to move with the statement.
        //
        // `null` at the subject, which is what a claim with no entity store
        // carries and therefore what the shipped default writes on every row.
        const back = await pool.query(CORROBORATION_LOOKUP_SQL, [
          ws,
          slotKey("alice", identityAlias),
          slotKey("manager", identityAlias),
          slotKey("bob", identityAlias),
          comparableValue({ surface: "bob", entityId: "ent:bob" }),
          null,
        ]);
        expect(back.rows).toEqual([]);
        // The CURRENT claim still corroborates normally.
        const current = await pool.query<{ id: string }>(CORROBORATION_LOOKUP_SQL, [
          ws,
          slotKey("alice", identityAlias),
          slotKey("manager", identityAlias),
          slotKey("carol", identityAlias),
          comparableValue({ surface: "carol", entityId: "ent:carol" }),
          null,
        ]);
        expect(current.rows.map((r) => r.id)).toEqual([draft]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "the will-supersede disclosure lists exactly what the transaction then stamps",
      async () => {
        const ws = "ws-4912-preview";
        const ep = await seedEpisode(ws, "preview");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });

        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        const preview = await loadSupersessionPreview(pool, reader);
        expect(preview).toEqual({
          total: 1,
          pairs: [
            {
              draftId: draft,
              draftLabel: "alice manager carol",
              supersededId: old,
              supersededLabel: "alice manager bob",
            },
          ],
          withheld: 0,
          truncated: false,
        });

        const report = await publish(ws);
        expect(report.superseded).toEqual([{ rowId: draft, superseded: [old] }]);
        // …and afterwards the disclosure reports a clean slate, not a stale one.
        expect((await loadSupersessionPreview(pool, reader)).total).toBe(0);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "⭐ supersedes across a phrasing difference — the collision is the SLOT (#5020)",
      async () => {
        // The third consumer's half of #5020, end to end. On the surface
        // columns this pair did not collide: `p.subject = d.subject` is false
        // for `alice` vs `Alice`, so publish left TWO current `single` values
        // standing, the will-supersede disclosure showed nothing, and nothing
        // anywhere said so. Nothing about the two rows changed — only what
        // counts as the same slot.
        const ws = "ws-5020-phrasing";
        const ep = await seedEpisode(ws, "phrasing");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          // Same slot, different spelling — case AND separator, on BOTH the
          // subject and the predicate, so each key arm is load-bearing here.
          subject: "Alice",
          predicate: "Manager",
          object: "carol",
        });

        // Disclosed before the admin confirms, and disclosed as the SAME pair
        // the transaction then stamps — the two must not drift.
        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        const preview = await loadSupersessionPreview(pool, reader);
        expect(preview.total).toBe(1);
        expect(preview.pairs.map((p) => [p.draftId, p.supersededId])).toEqual([[draft, old]]);
        // Both LABELS carry the surfaces the producers actually used — the keys
        // decide the collision and never reach the reviewer's screen.
        expect(preview.pairs[0]).toMatchObject({
          draftLabel: "Alice Manager carol",
          supersededLabel: "alice manager bob",
        });

        const report = await publish(ws);
        expect(report.superseded).toEqual([{ rowId: draft, superseded: [old] }]);
        expect((await factState(old)).valid_to).not.toBeNull();
        expect(await supersedesEdges(ws)).toEqual([{ f: draft, t: old }]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "does NOT supersede a rival whose OBJECT is the same slot spelled differently",
      async () => {
        // The object arm, and the direction that actually costs something. On
        // the surfaces `p.object <> d.object` is TRUE for `Bob` vs `bob`, so
        // publishing the draft stamped `valid_to` on a published fact asserting
        // THE SAME THING — retiring a belief nobody contradicted, invisibly,
        // because every as-of-now read then hides the row it touched. On the
        // keys the pair is one claim and the two coexist.
        //
        // Reachable without reconcile ever minting the pair: every row written
        // before #5020 was stored under byte-exact identity, so `Bob` and `bob`
        // were two claims and both are live — and migration 0187's backfill then
        // keyed them into ONE slot. (NOT via a region import, which is the
        // obvious guess and is wrong: `admin-migrate.ts`'s 18-column INSERT
        // names no key column, so an imported row lands UNKEYED and drops out of
        // this join entirely rather than colliding.)
        const ws = "ws-5020-object";
        const ep = await seedEpisode(ws, "object-slot");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "Bob",
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([]);
        expect((await factState(old)).valid_to).toBeNull();
        expect((await factState(draft)).valid_to).toBeNull();
        expect(await supersedesEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "does NOT supersede a rival it cannot PROVE it differs from — the abstain band (#5030)",
      async () => {
        // The shipped configuration, and the one every other test in this block
        // now opts OUT of via `seedFact`'s default. `passthroughEntityResolver`
        // supplies no entity id, `bob` and `carol` parse to no typed value, so
        // both `object_cmp`s are NULL and the agreement is UNKNOWN — a human can
        // see two managers, and nothing on either row proves it.
        //
        // Supersession therefore abstains. Not a gap: the pair already carries
        // the advisory `in-tension-with` edge `reconcile.ts` wrote, the publish
        // preview says there is nothing to stamp, and a reviewer arbitrates. The
        // alternative is inferring difference from two strings failing to match,
        // which is the same inference that reads `$499` and `499 USD` as a
        // contradiction — and there is no un-supersede verb to walk it back.
        //
        // ⚠️ This is the test that stops the seeder's convenience default from
        // hiding the change. Delete it and every remaining supersession case in
        // this file runs with comparable objects, so an implementation that
        // stamped on `object_key <>` again would pass the whole block.
        const ws = "ws-5030-abstain";
        const ep = await seedEpisode(ws, "abstain");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
          entityId: null,
        });
        const draft = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
          entityId: null,
        });

        // The disclosure agrees with the transaction, which is the #4912
        // invariant this arm has to keep as much as any other.
        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        expect(await loadSupersessionPreview(pool, reader)).toMatchObject({
          total: 0,
          withheld: 0,
          pairs: [],
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([]);
        expect((await factState(old)).valid_to).toBeNull();
        expect((await factState(draft)).valid_to).toBeNull();
        expect(await supersedesEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "…and DOES stamp once a store resolved the same two surfaces — the positive control (#5030)",
      async () => {
        // Its own `it()`, sharing nothing with the prohibition above. In a long
        // proof the first failure hides the rest, so a control living in the
        // prohibition's body never runs on the one run where it matters — and
        // then "supersession over-fires" and "supersession is broken entirely"
        // are indistinguishable, which is the single distinction this pair
        // exists to make.
        //
        // Same two surfaces, same slot, same cardinality as `ws-5030-abstain`.
        // The ONLY difference is that a store resolved them, so the difference
        // is evidence instead of an inference from two strings failing to match.
        const ws = "ws-5030-abstain-control";
        const ep = await seedEpisode(ws, "abstain-control");
        const old = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });

        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        expect(await loadSupersessionPreview(pool, reader)).toMatchObject({ total: 1 });
        expect((await publish(ws)).superseded).toHaveLength(1);
        expect((await factState(old)).valid_to).not.toBeNull();
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "an UNKEYED row supersedes nothing and is superseded by nothing — fail-closed, in both directions",
      async () => {
        // The state that dominates the corpus this deploys onto, and the one
        // the new seeder would otherwise have erased from the suite: a row a
        // region import landed (#5035), or one written in the 0187→#5020 window
        // that 0188's backfill has not reached. `=` and `<>` are both UNKNOWN
        // against NULL, so such a row drops out of `supersessionCollisionJoin`
        // entirely — from BOTH sides, which is the half the docstring claims
        // and nothing pinned.
        //
        // Fail-closed is the right direction (no collision ⇒ no `valid_to`
        // stamp ⇒ nothing irreversible), but it is not free: the pair below
        // WOULD collide if either row were keyed, and the reviewer is shown an
        // affirmative "this publish supersedes nothing".
        const ws = "ws-5020-unkeyed";
        const ep = await seedEpisode(ws, "unkeyed");

        // (a) unkeyed PUBLISHED incumbent, keyed draft that would replace it.
        const oldUnkeyed = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
          unkeyed: true,
        });
        const draftKeyed = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "carol",
        });
        // (b) the converse — keyed incumbent, unkeyed draft.
        const oldKeyed = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "dana",
          object: "erin",
          status: "published",
        });
        const draftUnkeyed = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "dana",
          object: "frank",
          unkeyed: true,
        });

        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        // Disclosed as "nothing to supersede", because the check could not run.
        expect(await loadSupersessionPreview(pool, reader)).toMatchObject({
          total: 0,
          pairs: [],
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(2);
        expect(report.superseded).toEqual([]);
        for (const id of [oldUnkeyed, draftKeyed, oldKeyed, draftUnkeyed]) {
          expect((await factState(id)).valid_to).toBeNull();
        }
        expect(await supersedesEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "a PARTIALLY keyed row does not collide either — the `<>` arm's own NULL case",
      async () => {
        // The unkeyed case above is decided by the `=` arms before the object
        // arm is ever consulted, so it leaves `object_key <> object_key`
        // unfalsified. This is that arm: both rows are in the SAME slot
        // (`alice` / `manager`), and only the OBJECT key is NULL.
        //
        // Reachable straight off the ingest path — `reconcile.ts` stores
        // `alice manager -` with two real keys and `object_key IS NULL`, and
        // nothing in `classifyFactForPromotion` refuses it, so it is a
        // promotable draft. Under a NULL-safe arm (`IS DISTINCT FROM`)
        // publishing it would stamp `valid_to` on the real published belief in
        // its slot — the irreversible write, spent on a placeholder.
        const ws = "ws-5020-partial";
        const ep = await seedEpisode(ws, "partial");
        const published = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "bob",
          status: "published",
        });
        // `slotKey("-")` is null, so the seeder keys subject and predicate and
        // leaves `object_key` NULL — exactly what the ingest path produces.
        const placeholder = await seedFact({
          workspaceId: ws,
          episodeId: ep,
          subject: "alice",
          object: "-",
        });

        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "u1",
          resolvedRole: { role: "owner", orgId: ws },
        });
        expect(await loadSupersessionPreview(pool, reader)).toMatchObject({
          total: 0,
          pairs: [],
        });

        const report = await publish(ws);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([]);
        expect((await factState(published)).valid_to).toBeNull();
        expect((await factState(placeholder)).valid_to).toBeNull();
        expect(await supersedesEdges(ws)).toEqual([]);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "withholds a pair whose PUBLISHED side the reader may not see — counted, never listed",
      async () => {
        const ws = "ws-4912-withheld";
        const privateEp = await seedEpisode(ws, "withheld-private", [SUPERSEDE_PRIVATE_GRANT]);
        // The incumbent lives in a private channel; the draft is org-wide.
        // Through `seedFact` like every other row here (#5021): a second inline
        // INSERT spelling the SPO as SQL literals is a second definition of what
        // this corpus contains, and the pair below only collides if the two
        // agree — which nothing would have checked.
        await seedFact({
          workspaceId: ws,
          episodeId: privateEp,
          subject: "alice",
          object: "bob",
          status: "published",
          visibleTo: [SUPERSEDE_PRIVATE_GRANT],
        });
        await seedFact({
          workspaceId: ws,
          episodeId: privateEp,
          subject: "alice",
          object: "carol",
        });

        // A member outside the private audience: sees the draft, not the rival.
        const reader = await resolvePrincipalContext(pool, {
          workspaceId: ws,
          mode: "managed",
          userId: "outsider",
          resolvedRole: { role: "member", orgId: ws },
        });
        const preview = await loadSupersessionPreview(pool, reader);
        expect(preview.total).toBe(1);
        expect(preview.pairs).toEqual([]);
        expect(preview.withheld).toBe(1);
      },
      PG_TEST_TIMEOUT_MS,
    );

    // ── the tier guard's absent-`source` carve-out (#5033) ─────────────────
    //
    // `identity-consumers-pg.test.ts`'s `tier-guarded-rival` block owns the
    // guard's five vocabulary fixtures, and every one of them lands through
    // `reconcileFacts` — which spreads `source: episode.source` onto every fact
    // it writes. So the corpus CANNOT produce a provenance with no `source` key
    // at all, and that shape is precisely the one the guard's first disjunct
    // exists for. It needs a direct INSERT, which is what this file has.
    //
    // The tests below are the prohibitions and the control they share,
    // differing in ONE field; the last additionally proves the count is
    // per-PAIR rather than per-workspace. Separate `test()` bodies rather than arms of one,
    // for the reason `identity-consumers-pg.test.ts` states: in a long proof the
    // first failure hides the rest, and a broken control would silently mask the
    // prohibitions it licenses.
    //
    // MUTATIONS THIS FILE CATCHES on the tier guard: `scripts/mutations/tier-guard.md`,
    // GENERATED by `scripts/mutate.ts` from `scripts/mutations/tier-guard.mutations.ts`.
    // Regenerate with:
    //   cd packages/api && bun run scripts/mutate.ts scripts/mutations/tier-guard.mutations.ts
    //
    // ⚠️ It used to be a hand-typed table right here, and #5027 is why it is
    // not. That slice REWROTE a test in the #4912 supersession block so its
    // control now asserts a stamp, moving the `absent-key disjunct removed` row
    // from 8 to 9 and falsifying the prose paragraph that enumerated the 8 —
    // without touching the guard. (The test it ADDED asserts no stamp and moved
    // nothing, so "a slice added a test" is the wrong lesson: ANY edit to the
    // population a cell counts can invalidate it.) Three sites had to agree
    // about one number and two of them were wrong for a slice. That is the failure mode #5060 built the runner for: a
    // hand-measured cell is a claim nothing can falsify, published under a
    // comment that reads as measurement.
    //
    // The reason both files carry tier coverage is still worth stating here,
    // because the generated table shows it rather than explaining it: this file
    // seeds provenance DIRECTLY and reads `PromotionReport.supersessionHeldBack`,
    // while the corpus suite lands every pair through `reconcileFacts` (which
    // always writes `source`) and reads no report field. Four rows are non-zero
    // only here; delete this block and four arms of the guard become
    // unfalsifiable while the corpus suite stays green.

    async function seedTierPair(ws: string, publishedProvenance?: Record<string, unknown>) {
      const ep = await seedEpisode(ws, `tier-${ws}`);
      const old = await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "alice",
        object: "bob",
        status: "published",
        provenance: publishedProvenance,
      });
      const draft = await seedFact({
        workspaceId: ws,
        episodeId: ep,
        subject: "alice",
        object: "carol",
      });
      return { old, draft };
    }

    async function previewTotalFor(ws: string): Promise<number> {
      const reader = await resolvePrincipalContext(pool, {
        workspaceId: ws,
        mode: "managed",
        userId: "owner",
        resolvedRole: { role: "owner", orgId: ws },
      });
      return (await loadSupersessionPreview(pool, reader)).total;
    }

    it(
      "⭐ still supersedes a published fact whose provenance names NO source — the carve-out",
      async () => {
        // The accepted shape, and the control that keeps the prohibition below
        // honest: without it, a guard that refused EVERY pair passes that test
        // green. Deliberately spelled out even though every other test in this
        // block relies on the same default, because an emergent property of a
        // fixture default is not a contract — the next author to add
        // `source: "slack"` to `seedFact` would delete the only coverage the
        // disjunct has without a red test anywhere.
        const ws = "ws-5033-carveout";
        const { old, draft } = await seedTierPair(ws, { actor: "test" });

        expect(await previewTotalFor(ws)).toBe(1);
        const report = await publish(ws);
        expect(report.superseded).toEqual([{ rowId: draft, superseded: [old] }]);
        expect((await factState(old)).valid_to).not.toBeNull();
        expect(await supersedesEdges(ws)).toEqual([{ f: draft, t: old }]);
        // …and NOTHING was held back. The report's fourth axis is what lets a
        // caller tell "no collision" from "a collision whose consequence was
        // withheld", so a control that only asserted the stamp would leave a
        // diagnostic that always answered 1 indistinguishable from a correct one.
        expect(report.supersessionHeldBack).toBe(0);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "refuses to stamp a published WAREHOUSE-derived fact — tier-1 has no correction path",
      async () => {
        // The same two claims as the control above; `source` is the only field
        // that differs. Everything else about the collision is unchanged — the
        // slot matches, the objects are provably different, both sides are
        // `single` — so a stamp here would be an LLM guess irreversibly
        // retiring a fact that is authoritative by construction, with no verb
        // anywhere able to undo it (`correction.ts` refuses every verb on a
        // warehouse-derived target, and `supersede` refuses a closed window).
        const ws = "ws-5033-warehouse";
        const { old, draft } = await seedTierPair(ws, {
          actor: "test",
          source: WAREHOUSE_SOURCE,
        });

        // The disclosure agrees with the transaction — it is built from the
        // same join, so an admin is never shown a supersession that will not
        // happen.
        expect(await previewTotalFor(ws)).toBe(0);
        const report = await publish(ws);
        // The DRAFT still publishes. The guard withholds the consequence, not
        // the review: both claims end up live and in visible tension, which is
        // the recoverable state ADR-0037 §4 chooses.
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([]);
        expect((await factState(old)).valid_to).toBeNull();
        expect((await factState(draft)).status).toBe("published");
        expect(await supersedesEdges(ws)).toEqual([]);
        // ⭐ The pair was HELD BACK, not absent. Asserted on the report rather
        // than only on the absence of a stamp, because those two states are
        // byte-identical everywhere else — and because it is the only assertion
        // in the slice that can falsify the diagnostic's VALUE. Hard-coding
        // `TIER_HELD_BACK_COUNT_SQL` to `SELECT 0` leaves every other test in
        // every suite green.
        expect(report.supersessionHeldBack).toBe(1);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "refuses to stamp a published fact whose `source` is PRESENT but null — not the carve-out",
      async () => {
        // The third population, and the one that separates the two spellings of
        // the carve-out. `NOT jsonb_exists(p.provenance, 'source')` is FALSE
        // here (the key exists), so the row is refused; the obvious
        // "simplification" to `p.provenance->>'source' IS NULL` reads as the
        // same thing, is behaviourally identical on every OTHER fixture in this
        // slice, and ADMITS this one — a `valid_to` stamp on a row whose tier
        // nothing can establish.
        //
        // Reachable through exactly one lane, which is the lane the whole
        // allowlist exists for: `admin-migrate.ts` validates bundle provenance
        // as "a non-empty object" and restores it verbatim, so
        // `{"source": null, "producer": "…"}` imports. `correction.ts` refuses
        // the same shape under `malformedSourceKind`, and this is that refusal's
        // supersession-side twin.
        //
        // Its positive control is the carve-out test two above — same claims,
        // same seeder, `source` key absent instead of null.
        const ws = "ws-5033-null-source";
        const { old, draft } = await seedTierPair(ws, { actor: "test", source: null });

        expect(await previewTotalFor(ws)).toBe(0);
        const report = await publish(ws);
        expect(report.promoted).toBe(1);
        expect(report.superseded).toEqual([]);
        expect((await factState(old)).valid_to).toBeNull();
        expect((await factState(draft)).status).toBe("published");
        expect(await supersedesEdges(ws)).toEqual([]);
        // Held back, and COUNTED — which additionally pins the diagnostic's own
        // `IS NOT TRUE`. A `NOT (…)` there is NULL for exactly this provenance,
        // so the count would read 0 while the pair really was withheld: the
        // guard working and the diagnostic blind, reported as "nothing
        // collided".
        expect(report.supersessionHeldBack).toBe(1);
      },
      PG_TEST_TIMEOUT_MS,
    );

    it(
      "counts PAIRS, not workspaces — two held-back collisions report 2",
      async () => {
        // The prohibitions above only ever prove 0 or 1, so a count that collapsed
        // pairs — `COUNT(DISTINCT d.id)`, or anything `LIMIT 1`-shaped — is
        // green in both. An operator reading "1 held back" when three
        // authoritative beliefs were defended is a quieter version of the
        // silence the count was added to remove.
        const ws = "ws-5033-two-pairs";
        const ep = await seedEpisode(ws, "two-pairs");
        for (const [subject, incumbent, challenger] of [
          ["alice", "bob", "carol"],
          ["dave", "erin", "frank"],
        ]) {
          await seedFact({
            workspaceId: ws,
            episodeId: ep,
            subject: subject!,
            object: incumbent!,
            status: "published",
            provenance: { actor: "test", source: WAREHOUSE_SOURCE },
          });
          await seedFact({ workspaceId: ws, episodeId: ep, subject: subject!, object: challenger! });
        }

        const report = await publish(ws);
        expect(report.promoted).toBe(2);
        expect(report.superseded).toEqual([]);
        expect(report.supersessionHeldBack).toBe(2);
        expect(await previewTotalFor(ws)).toBe(0);
      },
      PG_TEST_TIMEOUT_MS,
    );
  });
});
