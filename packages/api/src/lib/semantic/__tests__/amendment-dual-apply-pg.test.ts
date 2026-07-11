/**
 * LIVE-Postgres regression for the content-mode dual-apply carve-out (#4517).
 *
 * The hazard: semantic-improve amendment approval is the publish gate — it
 * writes the entity's `status='published'` row directly. If a developer-mode
 * `draft` row shadows the same entity, a later `/api/v1/admin/publish`
 * (`promoteDraftEntities`: delete published, flip draft → published) would
 * CLOBBER the approved change with the older draft body.
 *
 * The fix (`applyAmendmentToEntity` → `dualApplyToDraftSibling`): after writing
 * the published row, apply the SAME amendment to the draft sibling, so publish
 * carries the approved change forward. This test pins the end-to-end invariant
 * the unit test can't: draft exists → approve → publish → the approved change
 * SURVIVES. The no-draft baseline (published-only) is the control.
 *
 * Skips cleanly when `TEST_DATABASE_URL` is unset (CI sets it; opt in locally
 * with `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool, type PoolClient } from "pg";
import * as yaml from "js-yaml";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import {
  upsertEntityForGroup,
  upsertDraftEntityForGroup,
  promoteDraftEntities,
  type TransactionalClient,
} from "@atlas/api/lib/semantic/entities";
import { applyAmendmentToEntity } from "@atlas/api/lib/semantic/expert/apply";
import { _resetOrgWhitelists, _resetWhitelists } from "@atlas/api/lib/semantic/whitelist";
import type { AnalysisResult } from "@atlas/api/lib/semantic/expert/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  console.warn(
    "amendment-dual-apply-pg: TEST_DATABASE_URL unset — skipping live dual-apply test (set it to opt in).",
  );
}

const PG_TEST_TIMEOUT_MS = 30_000;

/** A minimal but shape-valid entity YAML (`table:` required by the post-apply gate). */
function entityYaml(opts: { description: string; extraDims?: Array<{ name: string; sql: string; type: string }> }): string {
  const dims = [{ name: "id", sql: "id", type: "number" }, ...(opts.extraDims ?? [])];
  return yaml.dump({ table: "orders", description: opts.description, dimensions: dims }, { lineWidth: 120, noRefs: true });
}

function addDimensionAmendment(dim: { name: string; sql: string; type: string }): AnalysisResult {
  return {
    category: "coverage_gaps",
    entityName: "orders",
    group: "default",
    amendmentType: "add_dimension",
    amendment: dim,
    rationale: "add region dimension",
    impact: 0.6,
    confidence: 0.9,
    staleness: 0,
    score: 0.5,
  };
}

describeIfPg("semantic amendment dual-apply → publish can't clobber (#4517)", () => {
  let pool: Pool;
  const schemaName = `dualapply_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let prevDatabaseUrl: string | undefined;

  /** Run a publish (promote drafts → published) in one transaction, as admin-publish does. */
  async function publish(orgId: string): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      await promoteDraftEntities(client as unknown as TransactionalClient, orgId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** The published row's parsed YAML for entity "orders". */
  async function publishedDoc(orgId: string): Promise<Record<string, unknown> | null> {
    const rows = await pool.query<{ yaml_content: string }>(
      `SELECT yaml_content FROM semantic_entities
        WHERE org_id = $1 AND entity_type = 'entity' AND name = 'orders' AND status = 'published'`,
      [orgId],
    );
    const y = rows.rows[0]?.yaml_content;
    return y ? (yaml.load(y) as Record<string, unknown>) : null;
  }

  const dimNames = (doc: Record<string, unknown> | null): string[] =>
    ((doc?.dimensions as Array<{ name: string }> | undefined) ?? []).map((d) => d.name);

  beforeAll(async () => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;

    // Scratch schema, created on a one-shot bootstrap client BEFORE the
    // long-lived pool so the search_path-pinned connections have a real target.
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }

    // Pin search_path server-side via libpq `options` — applied at connection
    // STARTUP, before any query — so every migration/DDL lands in the scratch
    // schema and `public` stays a read fallback for catalogs/extensions. A
    // post-connect `SET search_path` handler is NOT awaited by pg, so under this
    // suite's concurrent runner an early `runMigrations` query (the advisory
    // lock, `CREATE TABLE __atlas_migrations`, and the first migrations run on a
    // dedicated connection) can race the SET and create bookkeeping/tables in
    // shared `public` — corrupting a CONCURRENTLY-running -pg test in the same
    // shard (e.g. staging/seed.test.ts, whose own search_path falls back to
    // `public`). The `options` pin closes that race. (#4517)
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool as unknown as InternalPool);
  }, PG_TEST_TIMEOUT_MS * 2);

  beforeEach(() => {
    _resetWhitelists();
    _resetOrgWhitelists();
  });

  afterAll(async () => {
    _resetPool(null);
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`amendment-dual-apply-pg: schema cleanup failed: ${message}`);
    });
    await pool.end();
  });

  it("draft exists → approve → publish → the approved change SURVIVES (no clobber)", async () => {
    const orgId = `org-dualapply-${Math.floor(Math.random() * 1e6)}`;
    // Published baseline + a draft carrying its own unpublished work.
    await upsertEntityForGroup(orgId, "entity", "orders", entityYaml({ description: "Orders" }), null);
    await upsertDraftEntityForGroup(
      orgId, "entity", "orders",
      entityYaml({ description: "Orders (draft edit)", extraDims: [{ name: "draft_only", sql: "draft_only", type: "string" }] }),
      null,
    );

    // Approve an add_dimension amendment (the publish gate).
    const result = await applyAmendmentToEntity(orgId, addDimensionAmendment({ name: "region", sql: "region", type: "string" }), "req-pg-1");
    expect(result.draftDualApply.kind).toBe("applied");

    // The approved change landed on the published row immediately.
    expect(dimNames(await publishedDoc(orgId))).toContain("region");

    // Now publish: promote the draft → published. WITHOUT the dual-apply the
    // draft body (which lacked `region`) would overwrite the published row and
    // drop the approved change. WITH it, the draft carries `region` forward.
    await publish(orgId);

    const afterPublish = await publishedDoc(orgId);
    expect(dimNames(afterPublish)).toContain("region"); // the approved change survived
    expect(dimNames(afterPublish)).toContain("draft_only"); // the draft's own work is now live too
  });

  it("no draft → approve → the published row carries the change (control)", async () => {
    const orgId = `org-nodraft-${Math.floor(Math.random() * 1e6)}`;
    await upsertEntityForGroup(orgId, "entity", "orders", entityYaml({ description: "Orders" }), null);

    const result = await applyAmendmentToEntity(orgId, addDimensionAmendment({ name: "region", sql: "region", type: "string" }), "req-pg-2");
    expect(result.draftDualApply.kind).toBe("no-draft");
    expect(dimNames(await publishedDoc(orgId))).toContain("region");
  });
});
