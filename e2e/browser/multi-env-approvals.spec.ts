import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import {
  adminGet,
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

/**
 * Real-API e2e — approvals per-group bleed (#2344, #2443 deferred item).
 *
 * The current GET `/admin/approval/queue` route doesn't take a
 * `connectionGroupId` query filter — it surfaces every pending request
 * for the org and the FE filters client-side. What we CAN assert here:
 *
 *   - Each row in the queue carries its `connectionGroupId` on the wire
 *     so a client-side filter has the data it needs (PRD #2336 acceptance).
 *   - Two pending requests, one per group, both surface with their
 *     correct `connectionGroupId` (no row collapses or null-coalesces).
 *
 * If the route grows a server-side group filter later, this spec is the
 * right place to extend it. Track that work via the open issue (#2441 if
 * not separated out) — out of scope for this PR.
 */

const INTERNAL_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas";
const SYNTH_PREFIX = "rt_appr_";

interface QueueResp {
  requests: Array<{ id: string; ruleName: string; connectionGroupId: string | null; status: string }>;
}

async function withInternalDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: INTERNAL_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch (err) {
    test.skip(true, `Internal Postgres not reachable: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("unreachable");
  }
  try {
    return await fn(client);
  } finally {
    // intentionally ignored: best-effort socket teardown.
    await client.end().catch(() => {});
  }
}

test.describe("multi-env approvals — group pointer round-trips through queue read path", () => {
  test.use({ baseURL: undefined });

  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test("two pending requests in different groups both surface with their connectionGroupId", async () => {
    const { dev, staging } = await requireSeededGroups(request);

    const stamp = Date.now();
    const ruleNameDev = `${SYNTH_PREFIX}rule_${stamp}_dev`;
    const ruleNameStaging = `${SYNTH_PREFIX}rule_${stamp}_staging`;

    const orgRow = await withInternalDb(async (c) => {
      const { rows } = await c.query<{ org_id: string }>(
        `SELECT org_id FROM connection_groups WHERE id = $1 LIMIT 1`,
        [dev.id],
      );
      return rows[0];
    });
    expect(orgRow?.org_id).toBeTruthy();
    const orgId = orgRow!.org_id;

    const ids = await withInternalDb(async (c) => {
      // Insert two pending approvals — one per group. ruleId is a
      // placeholder UUID; the queue read path doesn't dereference it,
      // it surfaces the stored rule_name verbatim. Migration 0069 dropped
      // the legacy `connection_id` column — the row keys on
      // `connection_group_id` only.
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO approval_queue
           (org_id, rule_id, rule_name, requester_id, requester_email,
            query_sql, connection_group_id, status)
         VALUES
           ($1, gen_random_uuid(), $2, 'test-user', 'rt@example.com',
            'SELECT 1', $3, 'pending'),
           ($1, gen_random_uuid(), $4, 'test-user', 'rt@example.com',
            'SELECT 1', $5, 'pending')
         RETURNING id`,
        [orgId, ruleNameDev, dev.id, ruleNameStaging, staging.id],
      );
      return rows.map((r) => r.id);
    });

    try {
      const queue = await adminGet<QueueResp>(
        request,
        "/api/v1/admin/approval/queue",
        { query: "status=pending" },
      );
      expect(queue.status, queue.rawText).toBe(200);
      const ours = (queue.body?.requests ?? []).filter((r) => ids.includes(r.id));
      expect(ours.length, "both synthetic rows must surface in the queue").toBe(2);

      const byRule = new Map(ours.map((r) => [r.ruleName, r]));
      expect(byRule.get(ruleNameDev)?.connectionGroupId, "dev request keeps its group pointer").toBe(dev.id);
      expect(byRule.get(ruleNameStaging)?.connectionGroupId, "staging request keeps its group pointer").toBe(
        staging.id,
      );
    } finally {
      if (ids.length > 0) {
        await withInternalDb(async (c) => {
          await c.query(`DELETE FROM approval_queue WHERE id = ANY($1::uuid[])`, [ids]);
        });
      }
    }
  });
});
