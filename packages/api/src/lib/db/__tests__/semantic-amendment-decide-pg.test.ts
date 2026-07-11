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
  reconsiderRejectedAmendment,
  getRejectedAmendments,
  insertSemanticAmendment,
  getPendingAmendments,
  getPendingAmendmentCount,
  type InternalPool,
} from "@atlas/api/lib/db/internal";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-decide-seam-test";

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

  // -------------------------------------------------------------------------
  // Rejected view + Reconsider (#4512) — the reader SELECT and the atomic
  // rejected → pending flip run against real Postgres, same as the sibling
  // writers above. The stub-pool saas-scoping suite only string-matches the
  // SQL; these execute the `reviewed_at::text` cast, the `ORDER BY reviewed_at
  // DESC NULLS LAST`, the `RETURNING`, and — critically — the conditional
  // `status = 'rejected'` atomicity.
  // -------------------------------------------------------------------------

  it(
    "getRejectedAmendments returns only rejected rows, most-recently-rejected first, with reviewer metadata",
    async () => {
      // A pending row must never leak into the rejected view.
      await seed({ status: "pending" });
      const older = await seed({ status: "rejected" });
      const newer = await seed({ status: "rejected" });
      await pool.query(
        `UPDATE learned_patterns SET reviewed_by = 'admin', reviewed_at = now() - interval '2 hours' WHERE id = $1`,
        [older],
      );
      await pool.query(
        `UPDATE learned_patterns SET reviewed_by = 'admin', reviewed_at = now() WHERE id = $1`,
        [newer],
      );

      const rows = await getRejectedAmendments(ORG);
      // ORDER BY reviewed_at DESC — newest rejection first; the pending row absent.
      expect(rows.map((r) => r.id)).toEqual([newer, older]);
      expect(rows[0].reviewed_by).toBe("admin");
      expect(typeof rows[0].reviewed_at).toBe("string");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "reconsiderRejectedAmendment flips a rejected row to a clean pending row, and only ever lifts a rejection",
    async () => {
      const rejected = await seed({ status: "rejected" });
      await pool.query(
        `UPDATE learned_patterns SET reviewed_by = 'admin', reviewed_at = now(), last_apply_error = 'stale' WHERE id = $1`,
        [rejected],
      );

      expect(await reconsiderRejectedAmendment(rejected, ORG)).toBe(true);
      expect(await statusOf(rejected)).toBe("pending");

      // Reviewer fields + any stale apply error are cleared → indistinguishable
      // from a freshly-queued pending Amendment.
      const cleaned = await pool.query<{
        reviewed_by: string | null;
        reviewed_at: string | null;
        last_apply_error: string | null;
      }>(
        `SELECT reviewed_by, reviewed_at::text AS reviewed_at, last_apply_error FROM learned_patterns WHERE id = $1`,
        [rejected],
      );
      expect(cleaned.rows[0].reviewed_by).toBeNull();
      expect(cleaned.rows[0].reviewed_at).toBeNull();
      expect(cleaned.rows[0].last_apply_error).toBeNull();

      // It re-enters the pending queue and leaves the rejected view.
      expect((await getPendingAmendments(ORG)).map((r) => r.id)).toContain(rejected);
      expect((await getRejectedAmendments(ORG)).map((r) => r.id)).not.toContain(rejected);

      // Conditional on `status = 'rejected'`: a pending row and an absent row
      // both match zero rows — reconsider can only ever LIFT a rejection.
      const pending = await seed({ status: "pending" });
      expect(await reconsiderRejectedAmendment(pending, ORG)).toBe(false);
      expect(await reconsiderRejectedAmendment("00000000-0000-0000-0000-000000000000", ORG)).toBe(false);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "reconsider makes a rejected identity proposable again (#4512 AC #2): a re-proposal converges instead of being refused",
    async () => {
      const payload = { amendmentType: "add_dimension", amendment: { name: "region" } };
      const base = {
        orgId: ORG,
        sourceEntity: "orders",
        confidence: 0.5,
        connectionGroupId: null as string | null,
        amendmentPayload: payload,
      };

      const first = await insertSemanticAmendment({ ...base, description: "first" });
      expect(first.outcome).toBe("inserted");

      // Reject it → this identity is now in permanent rejection memory.
      expect(await rejectPendingAmendment(first.id, ORG, "admin")).toBe(true);

      // Re-proposing the SAME identity is refused (permanent rejection memory).
      const refused = await insertSemanticAmendment({ ...base, description: "refused" });
      expect(refused.outcome).toBe("rejected");
      expect(refused.id).toBe(first.id);

      // Reconsider lifts the rejection…
      expect(await reconsiderRejectedAmendment(first.id, ORG)).toBe(true);

      // …and now the identity is proposable again: the re-proposal converges on
      // the now-pending row instead of being refused. This is the load-bearing
      // half of AC #2 — it fails the moment rejection memory stops being "the
      // set of status='rejected' rows" (e.g. a refactor to a separate table or
      // an `archived` status), which reconsider's whole design rests on.
      const proposable = await insertSemanticAmendment({ ...base, description: "proposable" });
      expect(proposable.outcome).toBe("already_pending");
      expect(proposable.id).toBe(first.id);
    },
    PG_TIMEOUT_MS,
  );
});
