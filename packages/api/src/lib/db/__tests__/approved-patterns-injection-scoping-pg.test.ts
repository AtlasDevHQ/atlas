/**
 * Real-Postgres behavioral regression for `getApprovedPatterns` injection
 * scoping (#4534) — the two isolation gaps proven against real rows, which the
 * stub-pool SQL-shape test (`approved-patterns-injection-scoping.test.ts`)
 * pins structurally:
 *
 *   - an approved `semantic_amendment` row is never returned as a query pattern
 *     (the `type = 'query_pattern'` filter, behaviorally);
 *   - on SaaS, a NULL-org approved `query_pattern` is not returned for a tenant
 *     `orgId` (the #4487 cross-tenant guard, behaviorally);
 *   - on self-hosted, that same NULL-org row IS returned for a tenant — the
 *     legacy global scope is preserved, so the guard didn't over-tighten.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches
 * `pattern-latency-pg` / `migrate-pg`). CI's api-tests workflow provides the
 * Postgres service.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  getApprovedPatterns,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { _setConfigForTest, _resetConfig, type ResolvedConfig } from "@atlas/api/lib/config";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TIMEOUT_MS = 30_000;

// `getApprovedPatterns` short-circuits to `[]` when `hasInternalDB()` is false,
// which reads `process.env.DATABASE_URL`. When this suite runs (TEST_DATABASE_URL
// set) point DATABASE_URL at the same DB so the query path — not the no-DB
// guard — executes. `??=` respects an already-set value.
if (TEST_DB_URL) process.env.DATABASE_URL ??= TEST_DB_URL;

/** Fully-typed `ResolvedConfig` so a `deployMode` typo can't compile silently. */
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

describeIfPg("getApprovedPatterns injection scoping (real Postgres, #4534)", () => {
  let pool: Pool;
  const schemaName = `approved_patterns_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Pin search_path at connection STARTUP (libpq `options`), not via a
    // fire-and-forget `SET` on the pool's `connect` event: this test inserts on
    // one pooled connection and reads back on another, and an unawaited `SET`
    // can lose the race so a fresh connection reads the wrong schema (empty →
    // false-negative `[]`). Startup `options` applies to EVERY connection before
    // its first query, deterministically. `CREATE SCHEMA` below is explicit, so
    // pointing at a not-yet-created schema is fine.
    pool = new Pool({ connectionString: TEST_DB_URL, options: `-c search_path=${schemaName}` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Point the production internal-DB helpers at this pool so the exact
    // getApprovedPatterns SQL under test runs against this schema.
    _resetPool(pool as unknown as InternalPool);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    _resetPool(null);
    _resetConfig();
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    _resetConfig();
    await pool.query("DELETE FROM learned_patterns");
  });

  async function insertRow(row: {
    orgId: string | null;
    type: string;
    status: string;
    patternSql: string;
    description: string;
    sourceEntity: string;
    confidence?: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO learned_patterns
         (org_id, type, status, pattern_sql, description, source_entity, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.orgId,
        row.type,
        row.status,
        row.patternSql,
        row.description,
        row.sourceEntity,
        row.confidence ?? 0.9,
      ],
    );
  }

  it(
    "excludes an approved semantic_amendment row from a tenant's approved patterns",
    async () => {
      _setConfigForTest(configWithDeployMode("self-hosted"));
      await insertRow({
        orgId: "org-a",
        type: "query_pattern",
        status: "approved",
        patternSql: "SELECT SUM(revenue) FROM orders",
        description: "Revenue total",
        sourceEntity: "orders",
      });
      // An approved amendment: its `pattern_sql` is the identity-key sentinel
      // `<group>:<entity>:<amendmentType>[:<target>]` (see `amendmentIdentityKey`),
      // not a runnable query; the description carries real keywords.
      const amendmentSentinel = "default:orders:add_dimension:region";
      await insertRow({
        orgId: "org-a",
        type: "semantic_amendment",
        status: "approved",
        patternSql: amendmentSentinel,
        description: "adds region dimension to orders revenue",
        sourceEntity: "orders",
      });

      const rows = await getApprovedPatterns("org-a");
      expect(rows.map((r) => r.pattern_sql)).toEqual(["SELECT SUM(revenue) FROM orders"]);
      expect(rows.some((r) => r.pattern_sql === amendmentSentinel)).toBe(false);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "on SaaS, a NULL-org approved query_pattern is NOT returned for a tenant",
    async () => {
      _setConfigForTest(configWithDeployMode("saas"));
      await insertRow({
        orgId: null,
        type: "query_pattern",
        status: "approved",
        patternSql: "SELECT * FROM other_tenant_shape",
        description: "global revenue leak",
        sourceEntity: "other_tenant_shape",
      });
      await insertRow({
        orgId: "org-a",
        type: "query_pattern",
        status: "approved",
        patternSql: "SELECT * FROM tenant_a_orders",
        description: "tenant a orders",
        sourceEntity: "tenant_a_orders",
      });

      const rows = await getApprovedPatterns("org-a");
      expect(rows.map((r) => r.pattern_sql)).toEqual(["SELECT * FROM tenant_a_orders"]);
      expect(rows.some((r) => r.org_id === null)).toBe(false);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "on self-hosted, the NULL-org approved query_pattern IS returned (legacy global scope)",
    async () => {
      _setConfigForTest(configWithDeployMode("self-hosted"));
      await insertRow({
        orgId: null,
        type: "query_pattern",
        status: "approved",
        patternSql: "SELECT * FROM shared_shape",
        description: "shared revenue",
        sourceEntity: "shared_shape",
      });
      await insertRow({
        orgId: "org-a",
        type: "query_pattern",
        status: "approved",
        patternSql: "SELECT * FROM tenant_a_orders",
        description: "tenant a orders",
        sourceEntity: "tenant_a_orders",
      });

      const rows = await getApprovedPatterns("org-a");
      expect(rows.map((r) => r.pattern_sql).sort()).toEqual([
        "SELECT * FROM shared_shape",
        "SELECT * FROM tenant_a_orders",
      ]);
    },
    PG_TIMEOUT_MS,
  );
});
