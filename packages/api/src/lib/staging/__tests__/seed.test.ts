/**
 * StagingSeed — region-gate unit tests + real-Postgres integration tests
 * (staging slice 6, #2911).
 *
 * Two layers of coverage, mirroring the project's split between pure unit
 * tests and the `migrate-pg.test.ts` real-Postgres smoke:
 *
 *   1. Region gate (always runs, no DB): {@link ensureStagingSeed} must do
 *      ZERO DB work and emit no writes when `getApiRegion()` is not
 *      `"staging"`. Proven with a tracking pool that records every query —
 *      the assertion is `queries.length === 0` (#2911 acceptance: "skips all
 *      DB touches", unit-tested with the env var unset / set to "us").
 *
 *   2. Real Postgres (gated on `TEST_DATABASE_URL`, skipped cleanly when
 *      unset): bootstraps the full Better Auth + Atlas schema into a scratch
 *      schema via `migrateAuthTables()` — the same boot path production uses —
 *      then seeds and asserts the four created entities, idempotency (second
 *      call = zero writes), and that the seeded admin is sign-in-able with the
 *      seeded password.
 *
 * The auth instance and `internalQuery` both read the module-level pool
 * (`getInternalDB()`), so a single schema-scoped pool injected via
 * `_resetPool` serves Better Auth's migrator + createUser/createOrganization
 * AND the seed's own queries — keeping every write inside the scratch schema.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import {
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";
import { _setAuthInstance, getAuthInstance } from "@atlas/api/lib/auth/server";
import { migrateAuthTables, resetMigrationState } from "@atlas/api/lib/auth/migrate";
import {
  _seedDemoDatasource,
  ensureStagingSeed,
  STAGING_ADMIN_EMAIL,
  STAGING_ORG_SLUG,
} from "@atlas/api/lib/staging/seed";

// ───────────────────────────────────────────────────────────────────
// 1. Region gate — no DB. Proves non-staging boots are inert.
// ───────────────────────────────────────────────────────────────────

/**
 * A pool stub that records every query. If the region gate is correct, the
 * seed returns before issuing any query, so `queries` stays empty.
 */
function createTrackingPool() {
  const queries: string[] = [];
  async function queryFn(sql: string) {
    queries.push(sql);
    return { rows: [] };
  }
  const pool = {
    query: queryFn,
    async connect() {
      return { query: queryFn, release() {} };
    },
    async end() {},
    on() {},
  };
  return { pool: pool as unknown as InternalPool, queries };
}

describe("ensureStagingSeed — region gate (no DB)", () => {
  let savedRegion: string | undefined;
  let savedDbUrl: string | undefined;

  beforeEach(() => {
    savedRegion = process.env.ATLAS_API_REGION;
    savedDbUrl = process.env.DATABASE_URL;
    // No config loaded in this file, so getApiRegion() falls back to the
    // env var alone — deleting it yields the "unset" case.
    delete process.env.ATLAS_API_REGION;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (savedRegion !== undefined) process.env.ATLAS_API_REGION = savedRegion;
    else delete process.env.ATLAS_API_REGION;
    if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool();
  });

  it("returns skipped-region and touches no DB when ATLAS_API_REGION is unset", async () => {
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    const result = await Effect.runPromise(ensureStagingSeed());

    expect(result.outcome).toBe("skipped-region");
    expect(result.created).toBeUndefined();
    expect(queries.length).toBe(0);
  });

  it("returns skipped-region and touches no DB when ATLAS_API_REGION is a prod region", async () => {
    process.env.ATLAS_API_REGION = "us";
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    const result = await Effect.runPromise(ensureStagingSeed());

    expect(result.outcome).toBe("skipped-region");
    expect(queries.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────
// 1b. Demo-datasource skip paths — no DB. The #3847 failure mode is
//     persisting a urless / contradictory demo install; these branches
//     refuse to persist when there's no resolvable postgres dataset,
//     returning a non-fatal `false` and issuing ZERO queries (they return
//     before any `internalQuery`). Pure unit tests — no Postgres needed.
// ───────────────────────────────────────────────────────────────────

describe("_seedDemoDatasource — skip paths (no DB)", () => {
  let savedDatasourceUrl: string | undefined;
  let savedDemoData: string | undefined;

  beforeEach(() => {
    savedDatasourceUrl = process.env.ATLAS_DATASOURCE_URL;
    savedDemoData = process.env.ATLAS_DEMO_DATA;
  });

  afterEach(() => {
    if (savedDatasourceUrl !== undefined) process.env.ATLAS_DATASOURCE_URL = savedDatasourceUrl;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (savedDemoData !== undefined) process.env.ATLAS_DEMO_DATA = savedDemoData;
    else delete process.env.ATLAS_DEMO_DATA;
    _resetPool();
  });

  it("skips (no INSERT, returns false) when no demo URL is resolvable", async () => {
    // `resolveDatasourceUrl()` returns undefined: ATLAS_DATASOURCE_URL unset
    // and ATLAS_DEMO_DATA not "true".
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_DEMO_DATA;
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    const installed = await _seedDemoDatasource("org_test");

    expect(installed).toBe(false);
    // Persisting a urless row is exactly #3847 — assert nothing was written.
    expect(queries.length).toBe(0);
  });

  it("skips (no INSERT, returns false) when the demo URL has an unsupported scheme", async () => {
    process.env.ATLAS_DATASOURCE_URL = "redis://localhost:6379";
    delete process.env.ATLAS_DEMO_DATA;
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    const installed = await _seedDemoDatasource("org_test");

    expect(installed).toBe(false);
    expect(queries.length).toBe(0);
  });

  it("skips (no INSERT, returns false) when the demo URL is a valid-but-non-Postgres scheme", async () => {
    // `mysql://` parses as a supported dbType, but the demo-postgres catalog is
    // postgres-only — persisting `db_type:"mysql"` under it would contradict the
    // slug and fail the boot resolver, so we skip before the catalog SELECT.
    process.env.ATLAS_DATASOURCE_URL = "mysql://user:pw@localhost:3306/demo";
    delete process.env.ATLAS_DEMO_DATA;
    const { pool, queries } = createTrackingPool();
    _resetPool(pool);

    const installed = await _seedDemoDatasource("org_test");

    expect(installed).toBe(false);
    expect(queries.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────
// 2. Real Postgres — full seed against Better Auth + Atlas schema.
// ───────────────────────────────────────────────────────────────────

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// Better Auth migrations + the full Atlas migration set + the seed itself
// (which creates a user + org via Better Auth) — comfortably under a minute
// on local hardware, with headroom for shared CI runners.
const PG_TEST_TIMEOUT_MS = 60_000;

const STAGING_ADMIN_PASSWORD = "staging-admin-pw-901234";

/** Env keys this suite owns — snapshotted and restored around the block. */
const ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "ATLAS_ENCRYPTION_KEY",
  "ATLAS_API_REGION",
  "ATLAS_ADMIN_EMAIL",
  "ATLAS_DATASOURCE_URL",
  "STAGING_ADMIN_PASSWORD",
  "STAGING_TWENTY_API_KEY",
  "STAGING_TWENTY_BASE_URL",
] as const;

describeIfPg("ensureStagingSeed — real Postgres", () => {
  let pool: Pool;
  const schemaName = `staging_seed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const savedEnv: Record<string, string | undefined> = {};
  /** Result of the single first-boot seed, asserted across the cases below. */
  let firstSeed: Awaited<ReturnType<typeof runSeed>>;

  function runSeed() {
    return Effect.runPromise(ensureStagingSeed());
  }

  /** Row counts for the tables a seed writes — for the idempotency check. */
  async function seedTableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of ["user", "organization", "twenty_integrations", "workspace_plugins"]) {
      const { rows } = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::int AS c FROM "${table}"`,
      );
      out[table] = Number(rows[0]?.c ?? 0);
    }
    return out;
  }

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.BETTER_AUTH_SECRET = "staging-seed-test-better-auth-secret-0001";
    // Better Auth's oauth-provider plugin parses this at init (`new URL`) —
    // an unset value makes the instance build throw, so the auth migrator
    // never runs. A valid URL is all it needs in-test.
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    process.env.ATLAS_ENCRYPTION_KEY = "staging-seed-test-encryption-key-000001";
    process.env.ATLAS_API_REGION = "staging";
    // The demo datasource install now persists an ENCRYPTED url resolved from
    // ATLAS_DATASOURCE_URL (#3847 — empty `{}` config failed the boot resolver
    // every boot). Point it at the scratch test DB so the seed has a real,
    // pg-scheme url to encrypt and store.
    process.env.ATLAS_DATASOURCE_URL = TEST_DB_URL;
    process.env.STAGING_ADMIN_PASSWORD = STAGING_ADMIN_PASSWORD;
    process.env.STAGING_TWENTY_API_KEY = "staging-twenty-api-key";
    process.env.STAGING_TWENTY_BASE_URL = "https://staging-crm.example.com";
    // Critical: ATLAS_ADMIN_EMAIL unset so the dev-seed path in
    // migrateAuthTables() is a no-op and leaves the DB free of users —
    // the staging seed is the only thing that creates rows here.
    delete process.env.ATLAS_ADMIN_EMAIL;

    // Scratch schema, created on a one-shot client before the long-lived
    // pool so the search_path-scoped connections have a real target.
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }

    // libpq `options` pins search_path at connection startup (server-side,
    // before any query) — both the scratch schema and public so extensions
    // / system catalogs still resolve. Better Auth's migrator + every seed
    // query run on this pool, so all DDL/DML lands in the scratch schema.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });

    // Reset caches and inject the scratch pool BEFORE building the auth
    // instance, so Better Auth binds to this pool (getInternalDB()).
    resetMigrationState();
    resetAuthModeCache();
    _setAuthInstance(null);
    _resetPool(pool as unknown as InternalPool);

    // Run the production boot migration path: Better Auth schema first,
    // then the full Atlas migration set (incl. 0093's demo-postgres catalog
    // row). Dev seed is skipped (no ATLAS_ADMIN_EMAIL).
    await migrateAuthTables();

    firstSeed = await runSeed();
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    resetMigrationState();
    resetAuthModeCache();
    _setAuthInstance(null);
    _resetPool();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  it("first call reports a fresh seed of all four entities", () => {
    expect(firstSeed.outcome).toBe("seeded");
    expect(firstSeed.created).toEqual({
      org: true,
      admin: true,
      datasource: true,
      twenty: true,
    });
  });

  it("seeds the staging-internal organization", async () => {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM organization WHERE slug = $1`,
      [STAGING_ORG_SLUG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Staging Internal");
  }, PG_TEST_TIMEOUT_MS);

  it("seeds a pre-verified platform_admin user", async () => {
    const { rows } = await pool.query<{
      id: string;
      emailVerified: boolean;
      role: string | null;
    }>(
      `SELECT id, "emailVerified", role FROM "user" WHERE LOWER(email) = $1`,
      [STAGING_ADMIN_EMAIL],
    );
    expect(rows).toHaveLength(1);
    // emailVerified is what makes the admin sign-in-able with no manual step.
    expect(rows[0]?.emailVerified).toBe(true);
    expect(rows[0]?.role).toContain("platform_admin");
  }, PG_TEST_TIMEOUT_MS);

  it("installs the shared demo datasource for the staging org", async () => {
    const org = await pool.query<{ id: string }>(
      `SELECT id FROM organization WHERE slug = $1`,
      [STAGING_ORG_SLUG],
    );
    const orgId = org.rows[0]?.id as string;
    const { rows } = await pool.query<{ catalog_id: string; status: string }>(
      `SELECT catalog_id, status FROM workspace_plugins
        WHERE workspace_id = $1 AND pillar = 'datasource'`,
      [orgId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.catalog_id.includes("demo-postgres"))).toBe(true);
    expect(rows.every((r) => r.status === "published")).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  // Regression for #3847: the demo install must land at the canonical
  // `__demo__` install id (NOT `default`, which collided with the real
  // datasource install) and carry an encrypted, url-bearing config that the
  // boot bridge can resolve — the previous empty-`{}` install failed the boot
  // resolver every boot with `DatasourcePoolResolver(postgres): missing
  // required field url`.
  it("persists the demo install at the canonical __demo__ id with a resolvable url", async () => {
    const { decryptSecretFields, parseConfigSchema } = await import(
      "@atlas/api/lib/plugins/secrets"
    );
    const { resolveDatasourcePoolConfig } = await import(
      "@atlas/api/lib/db/datasource-pool-resolver"
    );
    // `describeIfPg` only runs this block when TEST_DATABASE_URL is set, so
    // the demo url the seed persisted is exactly this DSN.
    const demoUrl = TEST_DB_URL as string;

    const org = await pool.query<{ id: string }>(
      `SELECT id FROM organization WHERE slug = $1`,
      [STAGING_ORG_SLUG],
    );
    const orgId = org.rows[0]?.id as string;

    const { rows } = await pool.query<{
      install_id: string;
      catalog_slug: string;
      config: Record<string, unknown> | null;
      config_schema: unknown;
    }>(
      `SELECT wp.install_id,
              pc.slug AS catalog_slug,
              wp.config,
              pc.config_schema
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.workspace_id = $1
          AND wp.pillar = 'datasource'
          AND pc.slug = 'demo-postgres'`,
      [orgId],
    );

    // Exactly one demo-postgres install, keyed by the canonical __demo__ id.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.install_id).toBe("__demo__");

    // The persisted url is encrypted at rest, never the plaintext DSN.
    const rawUrl = rows[0]?.config?.url;
    expect(typeof rawUrl).toBe("string");
    expect(rawUrl).not.toBe(demoUrl);
    expect(rawUrl as string).toMatch(/^enc:/);

    // The exact boot path (decrypt → resolve) must succeed without throwing —
    // this is what emitted the recurring WARN before the fix.
    const schema = parseConfigSchema(rows[0]?.config_schema);
    const decrypted = decryptSecretFields(rows[0]?.config ?? {}, schema);
    const poolConfig = resolveDatasourcePoolConfig(
      {
        workspaceId: orgId,
        catalogId: "",
        installId: rows[0]?.install_id as string,
        pillar: "datasource",
        catalogSlug: rows[0]?.catalog_slug as string,
      },
      decrypted,
    );
    expect(poolConfig.dbType).toBe("postgres");
    expect((poolConfig as { url: string }).url).toBe(demoUrl);
  }, PG_TEST_TIMEOUT_MS);

  it("installs the staging Twenty integration for the staging org", async () => {
    const org = await pool.query<{ id: string }>(
      `SELECT id FROM organization WHERE slug = $1`,
      [STAGING_ORG_SLUG],
    );
    const orgId = org.rows[0]?.id as string;
    const { rows } = await pool.query<{ base_url: string; api_key_encrypted: string }>(
      `SELECT base_url, api_key_encrypted FROM twenty_integrations WHERE workspace_id = $1`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.base_url).toBe("https://staging-crm.example.com");
    // Stored encrypted at rest — never the plaintext key.
    expect(rows[0]?.api_key_encrypted).not.toBe("staging-twenty-api-key");
    expect(rows[0]?.api_key_encrypted).toMatch(/^enc:/);
  }, PG_TEST_TIMEOUT_MS);

  it("is idempotent — a second call short-circuits with zero DB writes", async () => {
    const before = await seedTableCounts();
    const second = await runSeed();
    const after = await seedTableCounts();

    expect(second.outcome).toBe("already-seeded");
    expect(second.created).toBeUndefined();
    expect(after).toEqual(before);
  }, PG_TEST_TIMEOUT_MS);

  it("seeded admin is sign-in-able with STAGING_ADMIN_PASSWORD", async () => {
    const auth = getAuthInstance();
    const api = auth.api as Record<string, unknown>;
    const signInEmail = api.signInEmail as (opts: {
      body: { email: string; password: string };
    }) => Promise<{ token?: string; user?: { email?: string } } | undefined>;

    const ok = await signInEmail({
      body: { email: STAGING_ADMIN_EMAIL, password: STAGING_ADMIN_PASSWORD },
    });
    // A successful sign-in returns a session token + the user.
    expect(ok?.token ?? ok?.user?.email).toBeTruthy();

    // Wrong password must NOT sign in.
    await expect(
      signInEmail({ body: { email: STAGING_ADMIN_EMAIL, password: "definitely-wrong" } }),
    ).rejects.toBeDefined();
  }, PG_TEST_TIMEOUT_MS);
});
