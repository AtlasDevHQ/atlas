/**
 * Tool-seam governance tests for ADR-0033 (Query Cache governance principle).
 *
 * Pins the row-determining-input contract at the `executeSQL` seam, not just
 * in `buildCacheKey` units (`cache/__tests__/cache.test.ts` covers the key
 * material directly). Here the whole pipeline runs unmocked except the seams
 * we drive, so each assertion is about observable end-to-end behavior:
 *
 *   1. A change to the resolved RLS config causes a MISS for a
 *      previously-cached key (closes audit H3 — no more pre-change unfiltered
 *      rows served up to TTL); an unchanged config still HITS.
 *   2. A plugin `beforeQuery` REJECTION blocks a warm hit (an incident
 *      lockdown can't be bypassed by a cached query).
 *   3. A plugin `beforeQuery` REWRITE lands its rewritten SQL in the key, so
 *      it gets its own entry rather than colliding with the original.
 *   4. `afterQuery` (and the connection metrics beside it) are live-path-only:
 *      a cache hit does not execute, so it does not dispatch `afterQuery`.
 *
 * Harness mirrors `sql-cache-audit.test.ts` (mock connection + real
 * pipeline), but uses the REAL `buildCacheKey` behind a Map-backed cache so
 * the key material — RLS fingerprint included — actually drives hit/miss, and
 * a controllable `beforeQuery`/`afterQuery` hook module.
 */

import { describe, expect, it, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { buildCacheKey as realBuildCacheKey } from "@atlas/api/lib/cache/keys";
import type { CacheEntry } from "@atlas/api/lib/cache/types";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;

const whitelistedTables = new Set(["companies", "people"]);
void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => whitelistedTables,
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => whitelistedTables,
  _resetWhitelists: () => {},
}));

let queryFn: Mock<(sql: string, timeout: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>>;
const mockConn = {
  query: (...args: [string, number]) => queryFn(...args),
  close: async () => {},
};

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockConn,
    connections: {
      get: () => mockConn,
      getDefault: () => mockConn,
      getForOrg: () => mockConn,
    },
  }),
);

void mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: Record<string, unknown>, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

void mock.module("@atlas/api/lib/db/source-rate-limit", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Effect type is complex to express in mock
  withSourceSlot: (_sourceId: string, effect: any) => effect,
}));

void mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

// RLS injection is a passthrough here (resolved-config CHANGES drive the key
// fingerprint via `getConfig`, not via what the injector does), so the
// executed SQL stays byte-stable across config changes and the ONLY thing that
// moves the key is the RLS fingerprint.
void mock.module("@atlas/api/lib/rls", () => ({
  resolveRLSFilters: () => ({ groups: [], combineWith: "and" }),
  injectRLSConditions: (sql: string) => sql,
}));

// Real key material behind a Map-backed cache: the RLS fingerprint, rewritten
// SQL, org and claims all actually decide hit/miss. `capturedKeys` records
// every key built so the rewrite test can compare entries.
const store = new Map<string, CacheEntry>();
let capturedGetKeys: string[] = [];
let capturedSetKeys: string[] = [];
void mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({
    get: (key: string) => {
      capturedGetKeys.push(key);
      return store.get(key) ?? null;
    },
    set: (key: string, entry: CacheEntry) => {
      capturedSetKeys.push(key);
      store.set(key, entry);
    },
    stats: () => ({ hits: 0, misses: 0, entryCount: store.size, maxSize: 1000, ttl: 300000 }),
  }),
  buildCacheKey: realBuildCacheKey,
  cacheEnabled: () => true,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

// Controllable plugin hooks. `beforeQueryRewrite` (when set) rewrites the SQL;
// `beforeQueryReject` (when set) throws a rejection. `afterQueryCalls` counts
// live-path dispatches so the live-only carve-out is assertable.
let beforeQueryRewrite: ((sql: string) => string) | null = null;
let beforeQueryReject: string | null = null;
let afterQueryCalls: number = 0;
void mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async (event: string) => {
    if (event === "afterQuery") afterQueryCalls += 1;
  },
  dispatchMutableHook: async (_name: string, ctx: { sql: string }) => {
    if (beforeQueryReject) throw new Error(beforeQueryReject);
    return beforeQueryRewrite ? beforeQueryRewrite(ctx.sql) : ctx.sql;
  },
}));

// Controllable settings (row limit / timeout) — RLS settings stay unset so the
// SaaS overlay never fires; the resolved config comes wholly from `getConfig`.
let mockSettingValues: Record<string, string | undefined> = {};
void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => mockSettingValues[key] ?? undefined,
  getSettingAuto: (key: string) => mockSettingValues[key] ?? undefined,
  getSettingLive: async (key: string) => mockSettingValues[key] ?? undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// Controllable resolved RLS config. `deployMode` stays self-hosted so
// resolution reads `rls` straight off the config (no settings overlay).
let mockConfig: Record<string, unknown> = {};
void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => ({
    requestId: "test-cache-gov",
    user: { id: "u1", activeOrganizationId: "org-42", claims: { org_id: "org-42" } },
  }),
}));

const { executeSQL } = await import("@atlas/api/lib/tools/sql");

const SQL = "SELECT id FROM companies";
const exec = (sql: string = SQL) =>
  executeSQL.execute!(
    { sql, explanation: "test" },
    { toolCallId: "test", messages: [], abortSignal: undefined as never },
  ) as Promise<AnyResult>;

const RLS_A = {
  enabled: true,
  policies: [{ tables: ["*"], column: "tenant_id", claim: "org_id" }],
  combineWith: "and",
};
const RLS_A_TIGHTER = {
  enabled: true,
  policies: [
    { tables: ["*"], column: "tenant_id", claim: "org_id" },
    { tables: ["people"], column: "region", claim: "region" },
  ],
  combineWith: "and",
};

describe("executeSQL cache governance (ADR-0033)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    store.clear();
    capturedGetKeys = [];
    capturedSetKeys = [];
    beforeQueryRewrite = null;
    beforeQueryReject = null;
    afterQueryCalls = 0;
    mockConfig = {};
    mockSettingValues = { ATLAS_ROW_LIMIT: "1000", ATLAS_QUERY_TIMEOUT: "30000" };
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";
    queryFn = mock(() =>
      Promise.resolve({ columns: ["id"], rows: [{ id: 1 }] }),
    );
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origDatasource) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  // ── (1) Resolved RLS config in the key ──────────────────────────────────
  it("unchanged resolved RLS config still hits a warm entry", async () => {
    mockConfig = { deployMode: "self-hosted", rls: RLS_A };

    const first = await exec();
    expect(first.success).toBe(true);
    expect(first.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);

    const second = await exec();
    expect(second.success).toBe(true);
    expect(second.cached).toBe(true);
    // No new datasource round-trip — the warm entry served.
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("tightening the resolved RLS config MISSES the pre-change entry (closes audit H3)", async () => {
    mockConfig = { deployMode: "self-hosted", rls: RLS_A };
    const first = await exec();
    expect(first.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);

    // Admin tightens RLS. The pre-change entry is now unreachable by
    // construction — the fingerprint moved, so the key moved.
    mockConfig = { deployMode: "self-hosted", rls: RLS_A_TIGHTER };
    const afterChange = await exec();
    expect(afterChange.success).toBe(true);
    expect(afterChange.cached).toBe(false);
    // Re-executed under the new policy rather than serving stale rows.
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("disabling RLS also misses the pre-change (enabled) entry", async () => {
    mockConfig = { deployMode: "self-hosted", rls: RLS_A };
    await exec();
    expect(queryFn).toHaveBeenCalledTimes(1);

    mockConfig = { deployMode: "self-hosted", rls: { enabled: false, policies: [], combineWith: "and" } };
    const afterDisable = await exec();
    expect(afterDisable.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  // ── (1b) SaaS settings-overlay arm of the same criterion ────────────────
  // The criterion is "settings overlay OR env/config"; the tests above cover
  // the env/config arm. This one drives the SaaS hot-reload path: RLS resolved
  // from the settings overlay, then a settings change moves the fingerprint.
  it("a SaaS RLS settings-overlay change (hot-reload) misses the pre-change entry", async () => {
    mockConfig = { deployMode: "saas" };
    mockSettingValues.ATLAS_RLS_ENABLED = "true";
    mockSettingValues.ATLAS_RLS_COLUMN = "tenant_id";
    mockSettingValues.ATLAS_RLS_CLAIM = "org_id";

    const first = await exec();
    expect(first.success).toBe(true);
    expect(first.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);

    // Same overlay, unchanged → still hits.
    const same = await exec();
    expect(same.cached).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);

    // Admin re-points the RLS column via settings (a hot-reload). The resolved
    // overlay config changes → the fingerprint changes → the pre-change entry
    // is orphaned by construction.
    mockSettingValues.ATLAS_RLS_COLUMN = "account_id";
    const afterChange = await exec();
    expect(afterChange.success).toBe(true);
    expect(afterChange.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("misconfigured RLS (enabled via settings, column/claim missing) fails closed AND writes no cache entry", async () => {
    // The security invariant the sql.ts docblock claims: a misconfigured
    // request never writes an entry, so no hit can ever resolve under the
    // `{ __rlsMisconfigured }` fingerprint. Pin it end-to-end rather than by
    // hardcoding the sentinel shape (which would drift silently if renamed).
    mockConfig = { deployMode: "saas" };
    mockSettingValues.ATLAS_RLS_ENABLED = "true";
    mockSettingValues.ATLAS_RLS_CLAIM = "org_id"; // column intentionally absent

    const blocked = await exec();
    expect(blocked.success).toBe(false);
    expect(String(blocked.error)).toContain("not fully configured");
    // Fail-closed before the datasource, and nothing cached.
    expect(queryFn).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  // ── (2b) invalid plugin rewrite fails fast, above the cache check ───────
  it("a plugin rewrite to non-whitelisted SQL fails validation before the cache check (no execution, no entry)", async () => {
    beforeQueryRewrite = () => "SELECT id FROM not_whitelisted_table";
    const outcome = await exec(SQL);
    expect(outcome.success).toBe(false);
    expect(String(outcome.error)).toContain("Plugin-rewritten SQL failed validation");
    expect(queryFn).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  // ── (2) beforeQuery rejection blocks a warm hit ─────────────────────────
  it("a beforeQuery rejection blocks a warm cache hit (governance can't be bypassed by a cached query)", async () => {
    // Warm the cache with a passthrough hook.
    const warm = await exec();
    expect(warm.cached).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);

    // Now an incident lockdown plugin rejects everything. The SAME query must
    // NOT be served from cache — the rejection runs above the cache check.
    beforeQueryReject = "incident lockdown active";
    const blocked = await exec();
    expect(blocked.success).toBe(false);
    expect(String(blocked.error)).toContain("incident lockdown active");
    // The warm entry was never served (no additional execution either).
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  // ── (3) beforeQuery rewrite lands in the key ────────────────────────────
  it("a beforeQuery rewrite produces a different cache key than the original SQL", async () => {
    // Original SQL, passthrough hook → entry under key(original).
    await exec(SQL);
    expect(capturedSetKeys).toHaveLength(1);
    const keyOriginal = capturedSetKeys[0];

    // A plugin rewrites the SQL to a different (still valid) query. Its result
    // must land under a DIFFERENT key, not collide with the original's entry.
    beforeQueryRewrite = () => "SELECT id FROM companies WHERE id > 0";
    const rewritten = await exec(SQL);
    expect(rewritten.success).toBe(true);
    expect(rewritten.cached).toBe(false); // key(rewritten) is empty → miss
    expect(capturedSetKeys).toHaveLength(2);
    const keyRewritten = capturedSetKeys[1];

    expect(keyRewritten).not.toBe(keyOriginal);
    expect(store.size).toBe(2); // two distinct entries, no collision
    // …and the REWRITTEN SQL is what actually executed (not the original),
    // proving the rewrite reached the datasource, not just the key.
    const executedRewrite = queryFn.mock.calls.some(([sql]) => sql.includes("id > 0"));
    expect(executedRewrite).toBe(true);
  });

  // ── (4) afterQuery / metrics are live-path-only ─────────────────────────
  it("afterQuery dispatches on a live execution but NOT on a cache hit (live-only carve-out)", async () => {
    const first = await exec();
    expect(first.cached).toBe(false);
    // Live path executed → afterQuery observed the execution.
    expect(afterQueryCalls).toBe(1);

    const second = await exec();
    expect(second.cached).toBe(true);
    // A hit doesn't execute, so afterQuery must not fire — otherwise it would
    // fabricate a datasource round-trip that never happened (ADR-0033).
    expect(afterQueryCalls).toBe(1);
  });
});
