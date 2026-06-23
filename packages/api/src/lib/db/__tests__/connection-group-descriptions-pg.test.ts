/**
 * Real-Postgres tests for `connection_group_descriptions` data access
 * (ADR-0022 §4, #3894).
 *
 * The load-bearing invariant — an AUTO upsert must NOT clobber a MANUAL edit —
 * lives entirely in the `ON CONFLICT ... DO UPDATE ... WHERE source = 'auto'`
 * guard, which a mocked query layer never evaluates. These run the production
 * upsert/clear SQL against a real Postgres and assert provenance is preserved.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `migrate-pg` /
 * `pattern-latency-pg`). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import {
  getGroupDescriptionMap,
  listGroupDescriptions,
  setManualGroupDescription,
  upsertAutoGroupDescription,
} from "@atlas/api/lib/db/connection-group-descriptions";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const PG_TIMEOUT_MS = 30_000;
const ORG = "org-group-desc-test";

describeIfPg("connection_group_descriptions data access (real Postgres, #3894)", () => {
  let pool: Pool;
  const schemaName = `groupdesc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`connection-group-descriptions-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Point the module helpers (internalQuery) at this pool AND make
    // hasInternalDB() true — the test preload strips DATABASE_URL, which would
    // otherwise short-circuit every data-access function to its no-op branch.
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  afterEach(async () => {
    await pool.query("DELETE FROM connection_group_descriptions");
  });

  it("auto-upsert inserts a new auto row", async () => {
    await upsertAutoGroupDescription(ORG, "orders", "Auto seed.");
    const rows = await listGroupDescriptions(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ groupId: "orders", description: "Auto seed.", source: "auto" });
  });

  it("auto-upsert refreshes an existing AUTO row (re-profile updates the seed)", async () => {
    await upsertAutoGroupDescription(ORG, "orders", "First seed.");
    await upsertAutoGroupDescription(ORG, "orders", "Second seed.");
    const map = await getGroupDescriptionMap(ORG);
    expect(map.get("orders")).toBe("Second seed.");
  });

  it("auto-upsert does NOT clobber a MANUAL edit (the load-bearing invariant)", async () => {
    await setManualGroupDescription(ORG, "orders", "Operator-refined.");
    // A subsequent re-profile fires auto-upsert against the same group.
    await upsertAutoGroupDescription(ORG, "orders", "Regenerated auto text.");
    const rows = await listGroupDescriptions(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: "Operator-refined.", source: "manual" });
  });

  it("manual edit overwrites an existing AUTO row and flips source to manual", async () => {
    await upsertAutoGroupDescription(ORG, "orders", "Auto seed.");
    await setManualGroupDescription(ORG, "orders", "Now manual.");
    const rows = await listGroupDescriptions(ORG);
    expect(rows[0]).toMatchObject({ description: "Now manual.", source: "manual" });
  });

  it("manual clear (blank) deletes the row, reverting to fallback", async () => {
    await setManualGroupDescription(ORG, "orders", "Manual.");
    const existed = await setManualGroupDescription(ORG, "orders", "   ");
    expect(existed).toBe(false);
    expect(await listGroupDescriptions(ORG)).toHaveLength(0);
  });

  it("blank auto-upsert is a no-op (nothing to seed)", async () => {
    await upsertAutoGroupDescription(ORG, "orders", "   ");
    expect(await listGroupDescriptions(ORG)).toHaveLength(0);
  });

  it("scopes rows by org — one org never reads another's descriptions", async () => {
    await setManualGroupDescription(ORG, "orders", "Org A.");
    await setManualGroupDescription("other-org", "orders", "Org B.");
    const map = await getGroupDescriptionMap(ORG);
    expect(map.get("orders")).toBe("Org A.");
    expect(map.size).toBe(1);
  });

  it("truncates an over-long description at the write boundary", async () => {
    const huge = "x".repeat(5000);
    await setManualGroupDescription(ORG, "orders", huge);
    const map = await getGroupDescriptionMap(ORG);
    expect(map.get("orders")!.length).toBe(2000);
  });
});
