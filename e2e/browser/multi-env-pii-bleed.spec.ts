import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import {
  adminGet,
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

/**
 * Real-API e2e — PII per-group bleed (#2341, #2443 deferred item).
 *
 * The masking layer has no public POST route — classifications come from
 * the auto-detection pipeline. To exercise the per-group filter on the
 * read path (`?connectionGroupId=<group>`) we INSERT two rows directly
 * into `pii_column_classifications`, one bound to `dev` and one to
 * `staging`, then assert each filter returns exactly its row. The
 * cross-tenant FK story is covered by the migrate-pg smoke; this layer
 * proves the route honors the filter end-to-end so the admin UI can rely
 * on it.
 */

const INTERNAL_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas";
const SYNTH_PREFIX = "rt_pii_";

interface ClassificationRow {
  id: string;
  tableName: string;
  columnName: string;
  connectionGroupId: string | null;
}
interface ClassificationsResp { classifications: ClassificationRow[] }

async function withInternalDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: INTERNAL_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch (err) {
    test.skip(
      true,
      `Internal Postgres not reachable at ${INTERNAL_DATABASE_URL} (${err instanceof Error ? err.message : String(err)}). ` +
        `Run \`bun run db:up\` and retry.`,
    );
    throw new Error("unreachable");
  }
  try {
    return await fn(client);
  } finally {
    // intentionally ignored: best-effort teardown; the test result is
    // already decided by this point.
    await client.end().catch(() => {});
  }
}

test.describe("multi-env PII — per-group filter does not bleed across groups", () => {
  test.use({ baseURL: undefined });

  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test("classifications filtered by connectionGroupId surface exactly the matching scope", async () => {
    const { dev, staging } = await requireSeededGroups(request);

    // Resolve the org of the signed-in admin so the synthetic rows are
    // visible to the same caller. The connection-groups list already
    // surfaces only the caller's-org rows, so any seeded group id we
    // hand to the INSERT is by definition this admin's.
    const stamp = Date.now();
    const tableDev = `${SYNTH_PREFIX}t_${stamp}_dev`;
    const tableStaging = `${SYNTH_PREFIX}t_${stamp}_staging`;

    // Grab the org id off the group row — `connection_groups` carries it,
    // and we've already resolved both target groups in this org.
    const orgRow = await withInternalDb(async (c) => {
      const { rows } = await c.query<{ org_id: string }>(
        `SELECT org_id FROM connection_groups WHERE id = $1 LIMIT 1`,
        [dev.id],
      );
      return rows[0];
    });
    expect(orgRow?.org_id, "couldn't resolve org id off dev group").toBeTruthy();
    const orgId = orgRow!.org_id;

    await withInternalDb(async (c) => {
      // Plant one row per group. Migration 0069 dropped the legacy
      // `connection_id` column — the natural key is now (org_id,
      // table_name, column_name, COALESCE(connection_group_id,
      // '__default__')) per 0064's partial unique index.
      await c.query(
        `INSERT INTO pii_column_classifications
           (org_id, table_name, column_name, category, confidence, masking_strategy, connection_group_id)
         VALUES ($1, $2, 'email', 'email', 'high', 'full', $3),
                ($1, $4, 'email', 'email', 'high', 'full', $5)`,
        [orgId, tableDev, dev.id, tableStaging, staging.id],
      );
    });

    try {
      const devOnly = await adminGet<ClassificationsResp>(
        request,
        "/api/v1/admin/compliance/classifications",
        { query: `connectionGroupId=${encodeURIComponent(dev.id)}` },
      );
      expect(devOnly.status, devOnly.rawText).toBe(200);
      const devNames = (devOnly.body?.classifications ?? []).map((c) => c.tableName);
      expect(devNames, `dev filter returned: ${JSON.stringify(devNames)}`).toContain(tableDev);
      expect(devNames, "dev filter must NOT surface staging row").not.toContain(tableStaging);

      const stagingOnly = await adminGet<ClassificationsResp>(
        request,
        "/api/v1/admin/compliance/classifications",
        { query: `connectionGroupId=${encodeURIComponent(staging.id)}` },
      );
      expect(stagingOnly.status).toBe(200);
      const stagingNames = (stagingOnly.body?.classifications ?? []).map((c) => c.tableName);
      expect(stagingNames).toContain(tableStaging);
      expect(stagingNames, "staging filter must NOT surface dev row").not.toContain(tableDev);
    } finally {
      await withInternalDb(async (c) => {
        await c.query(
          `DELETE FROM pii_column_classifications
            WHERE org_id = $1 AND table_name = ANY($2::text[])`,
          [orgId, [tableDev, tableStaging]],
        );
      });
    }
  });
});
