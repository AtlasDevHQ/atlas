import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import {
  adminGet,
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

const INTERNAL_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas";

async function withInternalDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: INTERNAL_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    // intentionally ignored: best-effort teardown.
    await client.end().catch(() => {});
  }
}

/**
 * Real-API e2e — multi-group semantic 409 ambiguity surface (#2412).
 *
 * #2443's deferred item: when the same entity name exists at two different
 * `connection_group_id`s in the same org, a fetch without a `?connectionGroupId`
 * disambiguator returns 409 with the candidate groups listed. The unit
 * coverage (`semantic-entities.test.ts`) asserts the lib function; this layer
 * asserts the route surfaces the error with the documented payload shape
 * (`error: "entity_ambiguous"`, `groups: [...]`) so the FE has the data it
 * needs to render the picker.
 */

// Per-run name so a prior run's synced-to-disk entity (`syncEntityToDisk`
// in the route handler writes the file alongside the DB row) doesn't
// shadow this run's DB-only state and force the GET into a single-result
// disk read. Combined with the cleanup below, this keeps the suite
// re-runnable without manual DB / FS surgery.
const ENTITY_NAME = `rt_ambig_users_${Date.now()}`;

interface AmbigResp {
  error: string;
  message: string;
  groups: Array<string | null>;
  requestId: string;
}
interface EntityDetailResp { entity?: unknown }

test.describe("multi-env semantic — 409 ambiguity surface", () => {
  test.use({ baseURL: undefined });

  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test("two same-name entities in different groups → GET without scope returns 409 entity_ambiguous", async () => {
    const { dev, staging } = await requireSeededGroups(request);

    // Plant draft rows directly in `semantic_entities`. The PUT route's
    // semantics around scope are intentionally read-oriented (#2412: the
    // body's `connectionGroupId` is the read-scope for the version
    // snapshot fetch, not the write-scope — which resolves from
    // `connectionId` via the connections 1:1 map). For an e2e that wants
    // to assert the 409 surface specifically, planting two rows directly
    // is the most reliable way to set up the ambiguity precondition.
    // The route's read-path 409 contract is then exercised by the GET.
    const orgRow = await withInternalDb(async (c) => {
      const { rows } = await c.query<{ org_id: string }>(
        `SELECT org_id FROM connection_groups WHERE id = $1 LIMIT 1`,
        [dev.id],
      );
      return rows[0];
    });
    expect(orgRow?.org_id).toBeTruthy();
    const orgId = orgRow!.org_id;

    const yaml = `table: ${ENTITY_NAME}\ndimensions:\n  - name: id\n    sql: id\n    type: number\n`;
    try {
      await withInternalDb(async (c) => {
        await c.query(
          `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_group_id, status)
           VALUES ($1, 'entity', $2, $3, $4, 'draft'),
                  ($1, 'entity', $2, $3, $5, 'draft')
           ON CONFLICT DO NOTHING`,
          [orgId, ENTITY_NAME, yaml, dev.id, staging.id],
        );
      });

      // Fetch WITHOUT the disambiguator. Backend should 409 with both
      // candidate groups listed so the FE picker has the data to ask.
      const ambiguous = await adminGet<AmbigResp>(
        request,
        `/api/v1/admin/semantic/entities/${ENTITY_NAME}`,
      );
      expect(ambiguous.status, ambiguous.rawText).toBe(409);
      expect(ambiguous.body?.error).toBe("entity_ambiguous");
      const surfaced = new Set(ambiguous.body?.groups ?? []);
      expect(surfaced.has(dev.id), "dev group must appear in candidates").toBe(true);
      expect(surfaced.has(staging.id), "staging group must appear in candidates").toBe(true);

      // Sanity: scoping the same fetch to one group resolves cleanly.
      const scoped = await adminGet<EntityDetailResp>(
        request,
        `/api/v1/admin/semantic/entities/${ENTITY_NAME}`,
        { query: `connectionGroupId=${encodeURIComponent(dev.id)}` },
      );
      expect(scoped.status, "scoped fetch must resolve").toBe(200);
    } finally {
      // Direct sweep — the route's DELETE is scope-aware and would itself
      // 409 on the ambiguous state we just plant. Also unlink the disk
      // file the PUT route would normally maintain; this spec bypasses
      // that route, but a leftover from a prior attempt would silently
      // shadow the DB state on the next run.
      await withInternalDb(async (c) => {
        await c.query(
          `DELETE FROM semantic_entities
            WHERE org_id = $1 AND entity_type = 'entity' AND name = $2`,
          [orgId, ENTITY_NAME],
        );
      });
      const diskPath = resolve(
        process.cwd(),
        "semantic",
        ".orgs",
        orgId,
        "entities",
        `${ENTITY_NAME}.yml`,
      );
      if (existsSync(diskPath)) {
        try {
          unlinkSync(diskPath);
        } catch {
          // intentionally ignored: a missing-on-disk after our test
          // wouldn't shadow the next run, so cleanup is best-effort.
        }
      }
    }
  });
});
