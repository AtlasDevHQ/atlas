/**
 * Unit tests for `FreshdeskFormInstallHandler` (#4401) — the Freshdesk
 * Solutions connector install. Focus: field validation (subdomain, API key),
 * loud category-enumeration verification at install time, the PER-CATEGORY
 * FAN-OUT (one collection per category; base slug for a single category,
 * suffixed slugs for multi-category), credential routing (key →
 * `knowledge_sync_credentials`, one row per category collection, NEVER into
 * `workspace_plugins.config`), and the credential rollback on a failed row
 * write. Verification uses the REAL egress guard against an injected fixture
 * fetch; no test touches Freshdesk.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:freshdesk" }];
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

const { FreshdeskFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/freshdesk-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = { subdomain: "acme", api_key: "fd-key" };

interface FixtureCategory {
  id?: string | number;
  name?: string;
}

const ONE_CAT: FixtureCategory[] = [{ id: 1, name: "Support" }];
const TWO_CATS: FixtureCategory[] = [...ONE_CAT, { id: 2, name: "Internal" }];

/** A fixture categories-endpoint fetch (or a fixed failure status / SSRF redirect). */
function catFetch(
  opts: { categories?: FixtureCategory[]; status?: number; redirectToBlocked?: boolean } = {},
): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (url.pathname === "/api/v2/solutions/categories") {
      if (opts.redirectToBlocked) {
        // Redirect the guarded fetch at a link-local metadata IP; guardedFetch
        // re-validates the hop and raises EgressBlockedError before it leaves.
        return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      }
      return new Response(JSON.stringify(opts.categories ?? ONE_CAT), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function handler(fetchImpl?: typeof fetch) {
  let n = 0;
  return new FreshdeskFormInstallHandler({
    idGenerator: () => `fixed-id-${++n}`,
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:freshdesk" }];
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
  it("requires the subdomain", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { api_key: "fd-key" }),
      "subdomain",
    );
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("requires the API key", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { subdomain: "acme", api_key: "" }),
      "api_key",
    );
    expect(msg).toMatch(/required/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("reduces a pasted full URL to the subdomain label", async () => {
    await handler(catFetch()).validateConfig(WORKSPACE, {
      subdomain: "https://acme.freshdesk.com/a/solutions",
      api_key: "fd-key",
    });
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config.subdomain).toBe("acme");
  });

  it("rejects a non-string description", async () => {
    const msg = await fieldErrorOf(
      handler(catFetch()).validateConfig(WORKSPACE, { ...VALID, description: 42 }),
      "description",
    );
    expect(msg).toMatch(/string/i);
  });
});

describe("category enumeration (install-time verification)", () => {
  it("blames the api_key field on a 401", async () => {
    const msg = await fieldErrorOf(
      handler(catFetch({ status: 401 })).validateConfig(WORKSPACE, VALID),
      "api_key",
    );
    expect(msg).toMatch(/rejected the credentials/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("blames the subdomain field on a 404", async () => {
    const msg = await fieldErrorOf(
      handler(catFetch({ status: 404 })).validateConfig(WORKSPACE, VALID),
      "subdomain",
    );
    expect(msg).toMatch(/check the subdomain/i);
  });

  it("surfaces a 429 as a form-level error (the key may be fine)", async () => {
    const msg = await formErrorOf(handler(catFetch({ status: 429 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/rate-limited/i);
  });

  it("surfaces a vendor 5xx as a form-level error, never blaming the key", async () => {
    const msg = await formErrorOf(handler(catFetch({ status: 503 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/vendor-side error/i);
  });

  it("rejects an account with no Solutions categories", async () => {
    const msg = await formErrorOf(handler(catFetch({ categories: [] })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/no Solutions categories/i);
  });

  it("maps an SSRF egress block to the subdomain field and writes nothing", async () => {
    const msg = await fieldErrorOf(
      handler(catFetch({ redirectToBlocked: true })).validateConfig(WORKSPACE, VALID),
      "subdomain",
    );
    expect(msg).toMatch(/refusing to fetch host|private|link-local/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });
});

describe("per-category fan-out", () => {
  it("single category: one collection under the base slug, key in credentials not config", async () => {
    const rec = await handler(catFetch()).validateConfig(WORKSPACE, VALID);
    expect(rec.installRecord).toMatchObject({ workspaceId: WORKSPACE, catalogId: "freshdesk" });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[3]).toBe("freshdesk");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toMatchObject({ subdomain: "acme", category_id: "1", category_name: "Support" });
    // The key NEVER lands in the install config…
    expect(config).not.toHaveProperty("api_key");
    // …it lands in knowledge_sync_credentials, keyed by the collection slug.
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(saveSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "freshdesk", "fd-key"]);
  });

  it("respects a custom collection slug via __install_id__", async () => {
    await handler(catFetch()).validateConfig(WORKSPACE, { ...VALID, __install_id__: "support-kb" });
    expect(insertCalls[0].params[3]).toBe("support-kb");
  });

  it("multi-category: one collection per category under suffixed slugs, one credential each", async () => {
    const rec = await handler(catFetch({ categories: TWO_CATS })).validateConfig(WORKSPACE, VALID);
    expect(insertCalls.map((c) => c.params[3])).toEqual(["freshdesk-1", "freshdesk-2"]);
    const configs = insertCalls.map((c) => JSON.parse(c.params[4] as string));
    expect(configs.map((c) => c.category_id)).toEqual(["1", "2"]);
    expect(saveSyncCredential.mock.calls.map((c) => c[1])).toEqual(["freshdesk-1", "freshdesk-2"]);
    // The returned record is the first category's row.
    expect(rec.installRecord.id).toBe("fixed-id-1");
  });

  it("rejects a fan-out slug that would exceed the collection-slug bound BEFORE any write", async () => {
    const longBase = "z".repeat(127); // valid alone; overflows once "-1" is appended
    const msg = await fieldErrorOf(
      handler(catFetch({ categories: TWO_CATS })).validateConfig(WORKSPACE, {
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
      handler(catFetch({ categories: TWO_CATS })).validateConfig(WORKSPACE, VALID),
      "__install_id__",
    );
    expect(msg).toMatch(/already used/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rolls back the failed category's credential and leaves earlier categories installed", async () => {
    INSERT_FAIL_ON_SLUG = "freshdesk-2";
    await expect(
      handler(catFetch({ categories: TWO_CATS })).validateConfig(WORKSPACE, VALID),
    ).rejects.toThrow(/simulated row-write failure/);
    // First category fully installed…
    expect(insertCalls.map((c) => c.params[3])).toEqual(["freshdesk-1"]);
    // …the failed category's orphaned credential rolled back (and only that one).
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "freshdesk-2"]);
  });
});

describe("catalog preconditions", () => {
  it("fails loudly when the catalog row is missing (seed has not run)", async () => {
    CATALOG_ROWS = [];
    await expect(handler(catFetch()).validateConfig(WORKSPACE, VALID)).rejects.toThrow(
      /catalog row "freshdesk" not found/i,
    );
  });
});
