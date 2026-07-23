/**
 * Unit tests for `HelpScoutFormInstallHandler` (#4398) — the Help Scout Docs
 * connector install. Focus: field validation (the single Docs API key), loud
 * site-enumeration verification at install time, the PER-SITE FAN-OUT (one
 * collection per Docs site; base slug for a single site, suffixed slugs for
 * multi-site), credential routing (key → `knowledge_sync_credentials`, one row
 * per site collection, NEVER into `workspace_plugins.config`), and the
 * credential rollback on a failed row write. Verification uses the REAL egress
 * guard against an injected fixture fetch; no test touches Help Scout.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:helpscout" }];
let INSERT_RETURNS_ID = true;
let INSERT_FAIL_ON_SLUG: string | null = null;
let CROSS_CATALOG_ROWS: { catalog_id: string }[] = [];
const insertCalls: { sql: string; params: unknown[] }[] = [];

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("FROM plugin_catalog")) return CATALOG_ROWS;
  if (sql.includes("catalog_id <> $3")) return CROSS_CATALOG_ROWS;
  if (sql.includes("INSERT INTO workspace_plugins")) {
    if (INSERT_FAIL_ON_SLUG !== null && params[3] === INSERT_FAIL_ON_SLUG) {
      throw new Error("simulated row-write failure");
    }
    insertCalls.push({ sql, params });
    return INSERT_RETURNS_ID ? [{ id: params[0] }] : [];
  }
  throw new Error(`unexpected SQL: ${sql.slice(0, 50)}`);
});

void mock.module("@atlas/api/lib/db/internal", () => buildInternalDbMockDefaults({ internalQuery }));

// The per-tier cap gates (#4235) run against the internal DB; this suite tests
// the handler's OWN fan-out logic (slug computation, credential order,
// rollback), so let the caps pass and keep the UPSERT observable through the
// same `internalQuery` mock. The cap gates themselves have dedicated tests.
// Mock every value export — a partial `mock.module()` breaks other importers.
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkKnowledgeCollectionLimit: () => Promise.resolve({ allowed: true }),
  checkKnowledgeCollectionFanOutLimit: () => Promise.resolve({ allowed: true }),
  checkKnowledgeCollectionLimitAndInstall: async (
    _org: string,
    _slug: string,
    insert: { sql: string; params: readonly unknown[] },
  ) => ({ allowed: true, rows: await internalQuery(insert.sql, [...insert.params]) }),
  checkChatIntegrationLimit: () => Promise.resolve({ allowed: true }),
  checkChatIntegrationLimitAndInstall: () => Promise.resolve({ allowed: true, rows: [] }),
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
  resolveAbuseCeilingPercent: () => Promise.resolve(null),
  resolveSpendPolicy: () => Promise.resolve("continue"),
  resolveUsageCeiling: () => Promise.resolve({ spendPolicy: "continue", ceilingPercent: null }),
  computeOverageDollars: () => 0,
  getTrialDaysRemaining: () => Promise.resolve(null),
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  KNOWLEDGE_COLLECTION_COUNT_SQL: "SELECT 1",
  KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL: "SELECT 1",
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const saveSyncCredential = mock(async (_w: string, _c: string, _s: string) => {});
const deleteSyncCredential = mock(async (_w: string, _c: string) => {});
const readSyncCredential = mock(async () => null);
void mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential,
  deleteSyncCredential,
  readSyncCredential,
}));

const { HelpScoutFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/helpscout-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = { api_key: "hs-docs-key" };

interface FixtureSite {
  id?: string | number;
  title?: string;
  subDomain?: string;
}

const ONE_SITE: FixtureSite[] = [{ id: "site-1", title: "Acme", subDomain: "acme" }];
const TWO_SITES: FixtureSite[] = [...ONE_SITE, { id: "site-2", title: "Beta", subDomain: "beta" }];

/** A fixture sites-endpoint fetch (or a fixed failure status). */
function sitesFetch(opts: { sites?: FixtureSite[]; status?: number } = {}): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (url.pathname.endsWith("/v1/sites")) {
      return new Response(
        JSON.stringify({ sites: { page: 1, pages: 1, items: opts.sites ?? ONE_SITE } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function handler(fetchImpl?: typeof fetch) {
  let n = 0;
  return new HelpScoutFormInstallHandler({
    idGenerator: () => `fixed-id-${++n}`,
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:helpscout" }];
  INSERT_RETURNS_ID = true;
  INSERT_FAIL_ON_SLUG = null;
  CROSS_CATALOG_ROWS = [];
  insertCalls.length = 0;
  internalQuery.mockClear();
  saveSyncCredential.mockClear();
  deleteSyncCredential.mockClear();
});
afterEach(() => internalQuery.mockClear());

async function fieldErrorOf(promise: Promise<unknown>, field: string): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.fieldErrors[field]?.[0];
    throw err;
  }
  return undefined;
}

async function formErrorOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.formErrors[0];
    throw err;
  }
  return undefined;
}

describe("field validation", () => {
  it("requires the API key", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, { api_key: "" }), "api_key");
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a key with whitespace", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { api_key: "has space" }),
      "api_key",
    );
    expect(msg).toMatch(/spaces/i);
  });
});

describe("site enumeration (install-time verification)", () => {
  it("blames the api_key field on a 401", async () => {
    const msg = await fieldErrorOf(
      handler(sitesFetch({ status: 401 })).validateConfig(WORKSPACE, VALID),
      "api_key",
    );
    expect(msg).toMatch(/rejected the credentials/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("surfaces a 429 as a form-level error (the key may be fine)", async () => {
    const msg = await formErrorOf(handler(sitesFetch({ status: 429 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/rate-limited/i);
  });

  it("surfaces a vendor 5xx as a form-level error, never blaming the key", async () => {
    const msg = await formErrorOf(handler(sitesFetch({ status: 503 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/vendor-side error/i);
  });

  it("rejects an account with no Docs sites", async () => {
    const msg = await formErrorOf(handler(sitesFetch({ sites: [] })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/no Docs sites/i);
  });
});

describe("per-site fan-out", () => {
  it("single site: one collection under the base slug, key → credentials only", async () => {
    const rec = await handler(sitesFetch()).validateConfig(WORKSPACE, VALID);
    expect(rec.installRecord).toMatchObject({ workspaceId: WORKSPACE, catalogId: "helpscout" });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[3]).toBe("helpscout");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toMatchObject({ site_id: "site-1", site_name: "Acme", subdomain: "acme" });
    // The key NEVER lands in the install config…
    expect(config).not.toHaveProperty("api_key");
    // …it lands in knowledge_sync_credentials, keyed by the collection slug.
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(saveSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "helpscout", "hs-docs-key"]);
  });

  it("respects a custom collection slug via __install_id__", async () => {
    await handler(sitesFetch()).validateConfig(WORKSPACE, { ...VALID, __install_id__: "support-kb" });
    expect(insertCalls[0].params[3]).toBe("support-kb");
  });

  it("multi-site: one collection per site under suffixed slugs, one credential each", async () => {
    const rec = await handler(sitesFetch({ sites: TWO_SITES })).validateConfig(WORKSPACE, VALID);
    expect(insertCalls.map((c) => c.params[3])).toEqual(["helpscout-acme", "helpscout-beta"]);
    const configs = insertCalls.map((c) => JSON.parse(c.params[4] as string));
    expect(configs.map((c) => c.site_id)).toEqual(["site-1", "site-2"]);
    expect(saveSyncCredential.mock.calls.map((c) => c[1])).toEqual(["helpscout-acme", "helpscout-beta"]);
    // The returned record is the first site's row.
    expect(rec.installRecord.id).toBe("fixed-id-1");
  });

  it("falls back to the site id suffix when a site has no subdomain", async () => {
    await handler(
      sitesFetch({ sites: [ONE_SITE[0], { id: "site-2", title: "Beta", subDomain: "" }] }),
    ).validateConfig(WORKSPACE, VALID);
    expect(insertCalls.map((c) => c.params[3])).toEqual(["helpscout-acme", "helpscout-site-2"]);
  });

  it("rejects a fan-out slug that would exceed the collection-slug bound BEFORE any write", async () => {
    const longBase = "z".repeat(125); // valid alone (≤128); overflows once "-acme" is appended
    const msg = await fieldErrorOf(
      handler(sitesFetch({ sites: TWO_SITES })).validateConfig(WORKSPACE, {
        ...VALID,
        __install_id__: longBase,
      }),
      "__install_id__",
    );
    expect(msg).toMatch(/exceeds 128 characters/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a fan-out slug taken by another knowledge catalog BEFORE any write", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    const msg = await fieldErrorOf(
      handler(sitesFetch({ sites: TWO_SITES })).validateConfig(WORKSPACE, VALID),
      "__install_id__",
    );
    expect(msg).toMatch(/already used/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rolls back the failed site's credential and leaves earlier sites installed", async () => {
    INSERT_FAIL_ON_SLUG = "helpscout-beta";
    await expect(
      handler(sitesFetch({ sites: TWO_SITES })).validateConfig(WORKSPACE, VALID),
    ).rejects.toThrow(/simulated row-write failure/);
    // First site fully installed…
    expect(insertCalls.map((c) => c.params[3])).toEqual(["helpscout-acme"]);
    // …the failed site's orphaned credential rolled back (and only that one).
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "helpscout-beta"]);
  });
});

describe("catalog preconditions", () => {
  it("fails loudly when the catalog row is missing (seed has not run)", async () => {
    CATALOG_ROWS = [];
    await expect(handler(sitesFetch()).validateConfig(WORKSPACE, VALID)).rejects.toThrow(
      /catalog row "helpscout" not found/i,
    );
  });
});
