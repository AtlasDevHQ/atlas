/**
 * Real-Postgres tests for the decide-seam claim helpers (#4506).
 *
 * The seam's entire anti-double-apply story rests on the conditional WHERE
 * clauses of `claimPendingAmendment` / `stampClaimedAmendmentApproved` /
 * `releaseClaimedAmendment` / `rejectPendingAmendment`. The unit/route suites
 * model those conditions with stateful mocks; these run the exact production
 * SQL against real Postgres and assert the properties the mocks assume:
 *   - two competing claims on one pending row → exactly one wins;
 *   - a FRESH `applying` claim is not claimable, not rejectable (the interval
 *     comparison direction — a flipped `<` would re-open the double-apply
 *     race while every substring assertion stayed green);
 *   - a STALE claim (updated_at backdated past the window) resurfaces: it is
 *     claimable again and visible to the pending reads;
 *   - reject after a claim matches zero rows (an applied change can never be
 *     stamped rejected);
 *   - insertSemanticAmendment lands `pending` even when auto-approve
 *     eligibility is met — eligibility is reported, never stamped (#4506).
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches the other
 * `-pg` suites). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  AMENDMENT_CLAIM_STALE_MINUTES,
  _resetPool,
  claimPendingAmendment,
  stampClaimedAmendmentApproved,
  releaseClaimedAmendment,
  rejectPendingAmendment,
  insertSemanticAmendment,
  getPendingAmendments,
  getPendingAmendmentCount,
  getRecentlyDecidedAmendments,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import type { ResolvedConfig } from "@atlas/api/lib/config";
import { _setConfigForTest, _resetConfig } from "@atlas/api/lib/config";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-decide-seam-test";

/** Fully-typed `ResolvedConfig` so `amendmentOrgScope` (via `isSaasModeForGuard`)
 * resolves the intended deploy-mode clause in the `getRecentlyDecidedAmendments`
 * scope tests. Mirrors the builder in semantic-amendment-saas-scoping.test.ts. */
function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}
const selfHostedConfig = () => configWithDeployMode("self-hosted");
const saasConfig = () => configWithDeployMode("saas");

describeIfPg("decide-seam claim helpers (real Postgres, #4506)", () => {
  let pool: Pool;
  const schemaName = `decide_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  // The helpers gate on hasInternalDB() === !!process.env.DATABASE_URL, so
  // point DATABASE_URL at the test DB for the run (promote-decay-pg pattern).
  let origDbUrl: string | undefined;

  beforeAll(async () => {
    origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`semantic-amendment-decide-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool as unknown as InternalPool);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (origDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDbUrl;
    if (!pool) return;
    _resetPool(null);
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM learned_patterns");
  });

  /** Insert a semantic_amendment row directly and return its uuid. */
  async function seed(opts: { status?: string; payload?: unknown }): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO learned_patterns
        (org_id, pattern_sql, source_entity, status, type, confidence, amendment_payload)
       VALUES ($1, $2, 'orders', $3, 'semantic_amendment', 0.9, $4)
       RETURNING id`,
      [
        ORG,
        `amendment:orders:${Date.now()}`,
        opts.status ?? "pending",
        JSON.stringify(
          opts.payload ?? { amendmentType: "add_dimension", amendment: { name: "region" } },
        ),
      ],
    );
    return res.rows[0].id;
  }

  async function statusOf(id: string): Promise<string> {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM learned_patterns WHERE id = $1`,
      [id],
    );
    return res.rows[0].status;
  }

  /** Backdate a row's updated_at by `minutes` to simulate claim staleness. */
  async function backdate(id: string, minutes: number): Promise<void> {
    await pool.query(
      `UPDATE learned_patterns SET updated_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [id, String(minutes)],
    );
  }

  it(
    "competing claims on one pending row: exactly one wins",
    async () => {
      const id = await seed({});

      const [a, b] = await Promise.all([
        claimPendingAmendment(id, ORG, "admin-a"),
        claimPendingAmendment(id, ORG, "admin-b"),
      ]);

      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await statusOf(id)).toBe("applying");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "a FRESH claim is not re-claimable and not rejectable (interval direction)",
    async () => {
      const id = await seed({});
      const claimed = await claimPendingAmendment(id, ORG, "admin-a");
      expect(claimed?.id).toBe(id);

      // The row was just claimed — updated_at is now(), well inside the stale
      // window. A flipped comparison (`>` instead of `<`) would make this
      // succeed and re-open the double-apply race.
      expect(await claimPendingAmendment(id, ORG, "admin-b")).toBeNull();
      expect(await rejectPendingAmendment(id, ORG, "admin-b")).toBe(false);
      expect(await statusOf(id)).toBe("applying");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "a STALE claim resurfaces: claimable again and visible to the pending reads",
    async () => {
      const id = await seed({});
      await claimPendingAmendment(id, ORG, "admin-a");
      await backdate(id, AMENDMENT_CLAIM_STALE_MINUTES + 1);

      // Visible again so a crash can't strand the row…
      const listed = await getPendingAmendments(ORG);
      expect(listed.map((r) => r.id)).toContain(id);
      expect(await getPendingAmendmentCount(ORG)).toBe(1);

      // …and re-claimable.
      const retaken = await claimPendingAmendment(id, ORG, "admin-b");
      expect(retaken?.id).toBe(id);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "stamp → approved only from THIS claim; reject after approve matches zero rows",
    async () => {
      const id = await seed({});

      // Stamping without a claim is a no-op.
      expect(await stampClaimedAmendmentApproved(id, "2000-01-01T00:00:00+00")).toBe(false);
      expect(await statusOf(id)).toBe("pending");

      const claimed = await claimPendingAmendment(id, ORG, "admin-a");
      expect(claimed).not.toBeNull();
      expect(await stampClaimedAmendmentApproved(id, claimed!.claimed_at)).toBe(true);
      expect(await statusOf(id)).toBe("approved");

      // An applied change can never be stamped rejected.
      expect(await rejectPendingAmendment(id, ORG, "admin-b")).toBe(false);
      expect(await statusOf(id)).toBe("approved");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "a stale-claim takeover invalidates the original claim token (no cross-claim stamp/release)",
    async () => {
      const id = await seed({});
      const original = await claimPendingAmendment(id, ORG, "admin-a");
      expect(original).not.toBeNull();

      // The original apply outlives the stale window; a takeover re-claims.
      await backdate(id, AMENDMENT_CLAIM_STALE_MINUTES + 1);
      const takeover = await claimPendingAmendment(id, ORG, "admin-b");
      expect(takeover).not.toBeNull();
      expect(takeover!.claimed_at).not.toBe(original!.claimed_at);

      // The original's stamp AND release both observe "claim lost" — the
      // takeover's live claim can be neither approved-over nor yanked back.
      expect(await stampClaimedAmendmentApproved(id, original!.claimed_at)).toBe(false);
      expect(await releaseClaimedAmendment(id, original!.claimed_at, "late")).toBe(false);
      expect(await statusOf(id)).toBe("applying");

      // The takeover's own token still works.
      expect(await stampClaimedAmendmentApproved(id, takeover!.claimed_at)).toBe(true);
      expect(await statusOf(id)).toBe("approved");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "release compensates a held claim back to pending with the visible reason",
    async () => {
      const id = await seed({});
      const claimed = await claimPendingAmendment(id, ORG, "admin-a");
      expect(claimed).not.toBeNull();

      expect(await releaseClaimedAmendment(id, claimed!.claimed_at, "version snapshot failed")).toBe(true);
      expect(await statusOf(id)).toBe("pending");

      const listed = await getPendingAmendments(ORG);
      const row = listed.find((r) => r.id === id);
      expect(row?.last_apply_error).toBe("version snapshot failed");

      // The next claim clears the reason so a retried approve starts clean.
      await claimPendingAmendment(id, ORG, "admin-b");
      const res = await pool.query<{ last_apply_error: string | null }>(
        `SELECT last_apply_error FROM learned_patterns WHERE id = $1`,
        [id],
      );
      expect(res.rows[0].last_apply_error).toBeNull();
    },
    PG_TIMEOUT_MS,
  );

  it(
    "insertSemanticAmendment lands 'pending' even when auto-approve eligibility is met",
    async () => {
      // Meets the default threshold + type eligibility — the OLD behavior
      // stamped 'approved' at insert; the seam contract is pending + reported
      // eligibility (#4506).
      process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";
      try {
        const result = await insertSemanticAmendment({
          orgId: ORG,
          description: "test",
          sourceEntity: "orders",
          confidence: 0.95,
          connectionGroupId: null,
          amendmentPayload: { amendmentType: "add_dimension", amendment: { name: "region" } },
        });

        // Fresh identity → a real insert (#4507), reported eligible (#4506).
        expect(result.outcome).toBe("inserted");
        if (result.outcome !== "inserted") throw new Error("unreachable");
        expect(result.autoApprove).toBe(true);
        expect(await statusOf(result.id)).toBe("pending");
      } finally {
        delete process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD;
      }
    },
    PG_TIMEOUT_MS,
  );

  // ── getRecentlyDecidedAmendments — the briefing's "recent panel decisions"
  //    feed (#4514). The unit/route suites mock this reader; here the exact
  //    production SQL runs against real Postgres so its column list, the
  //    `status IN ('approved','rejected')` filter, `reviewed_at DESC` ordering,
  //    the LIMIT clamp, and the `amendmentOrgScope` clause splice are executed.
  // ---------------------------------------------------------------------------

  /** Insert a DECIDED semantic_amendment (approved/rejected) with an explicit
   * org and reviewed_at offset (minutes ago) so ordering is deterministic. */
  async function seedDecided(opts: {
    org: string | null;
    status: "approved" | "rejected";
    reviewedMinutesAgo: number;
    entity?: string;
  }): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO learned_patterns
        (org_id, pattern_sql, source_entity, status, type, confidence, amendment_payload, reviewed_at)
       VALUES ($1, $2, $3, $4, 'semantic_amendment', 0.9, $5, now() - ($6 || ' minutes')::interval)
       RETURNING id`,
      [
        opts.org,
        `amendment:${opts.entity ?? "orders"}:${Date.now()}:${Math.random()}`,
        opts.entity ?? "orders",
        opts.status,
        JSON.stringify({ amendmentType: "add_dimension", amendment: { name: "region" } }),
        String(opts.reviewedMinutesAgo),
      ],
    );
    return res.rows[0].id;
  }

  it(
    "returns decided rows newest-first, excludes pending, honors the self-hosted org scope",
    async () => {
      _setConfigForTest(selfHostedConfig());
      try {
        const approvedOld = await seedDecided({ org: ORG, status: "approved", reviewedMinutesAgo: 30 });
        const rejectedNew = await seedDecided({ org: ORG, status: "rejected", reviewedMinutesAgo: 5 });
        const nullOwner = await seedDecided({ org: null, status: "approved", reviewedMinutesAgo: 15 });
        const otherOrg = await seedDecided({ org: "org-someone-else", status: "rejected", reviewedMinutesAgo: 1 });
        await seed({ status: "pending" }); // must be excluded (not decided)

        const rows = await getRecentlyDecidedAmendments(ORG, 10);
        const ids = rows.map((r) => r.id);

        // Newest reviewed_at first: rejectedNew (5m) → nullOwner (15m) → approvedOld (30m).
        // On self-hosted the NULL-owner row is in scope; org-someone-else is NOT;
        // the pending row is filtered out by status.
        expect(ids).toEqual([rejectedNew, nullOwner, approvedOld]);
        expect(ids).not.toContain(otherOrg);
        expect(rows.every((r) => r.status === "approved" || r.status === "rejected")).toBe(true);
        expect(rows[0].reviewed_at).toBeTruthy();
      } finally {
        _resetConfig();
      }
    },
    PG_TIMEOUT_MS,
  );

  it(
    "on SaaS, a NULL-owner row never surfaces in a tenant and the org-less path withholds",
    async () => {
      _setConfigForTest(saasConfig());
      try {
        const orgRow = await seedDecided({ org: ORG, status: "approved", reviewedMinutesAgo: 5 });
        await seedDecided({ org: null, status: "approved", reviewedMinutesAgo: 1 }); // must NOT leak

        const tenant = await getRecentlyDecidedAmendments(ORG, 10);
        // Only the tenant's own decided row — the NULL-owner "global scope" row
        // is invisible on SaaS (the #4487 leak guard, via amendmentOrgScope).
        expect(tenant.map((r) => r.id)).toEqual([orgRow]);

        // The org-less path withholds entirely on SaaS (no global tenant).
        expect(await getRecentlyDecidedAmendments(null, 10)).toEqual([]);
      } finally {
        _resetConfig();
      }
    },
    PG_TIMEOUT_MS,
  );

  it(
    "clamps an invalid or oversized limit without erroring",
    async () => {
      _setConfigForTest(selfHostedConfig());
      try {
        await seedDecided({ org: ORG, status: "approved", reviewedMinutesAgo: 5 });
        // limit <= 0 and non-integer fall back to 10; > 100 clamps to 100 — none
        // of these should produce a SQL error from the interpolated LIMIT.
        expect((await getRecentlyDecidedAmendments(ORG, 0)).length).toBe(1);
        expect((await getRecentlyDecidedAmendments(ORG, 500)).length).toBe(1);
        expect((await getRecentlyDecidedAmendments(ORG, 2.5)).length).toBe(1);
      } finally {
        _resetConfig();
      }
    },
    PG_TIMEOUT_MS,
  );
});
