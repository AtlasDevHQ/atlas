/**
 * Unit tests for `ZendeskFormInstallHandler` (#4396) — the Zendesk Guide
 * connector install. Focus: field validation (subdomain label extraction,
 * email, API token), loud brand-enumeration verification at install time, the
 * PER-BRAND FAN-OUT (one collection per help-center-enabled brand; base slug
 * for a single brand, suffixed slugs for multi-brand), credential routing
 * (token → `knowledge_sync_credentials`, one row per brand collection, NEVER
 * into `workspace_plugins.config`), and the credential rollback on a failed
 * row write. Verification uses the REAL egress guard against an injected
 * fixture fetch; no test touches Zendesk.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:zendesk" }];
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

const { ZendeskFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/zendesk-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = { subdomain: "acme", email: "ops@acme.test", api_token: "zd-token" };

interface FixtureBrand {
  id?: number;
  name?: string;
  subdomain?: string;
  has_help_center?: boolean;
  active?: boolean;
}

const ONE_BRAND: FixtureBrand[] = [
  { id: 10, name: "Acme", subdomain: "acme", has_help_center: true, active: true },
];
const TWO_BRANDS: FixtureBrand[] = [
  ...ONE_BRAND,
  { id: 11, name: "Beta", subdomain: "acme-beta", has_help_center: true, active: true },
];

/** A fixture brands-endpoint fetch (or a fixed failure status). */
function brandsFetch(opts: { brands?: FixtureBrand[]; status?: number } = {}): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (url.pathname.endsWith("/api/v2/brands.json")) {
      return new Response(
        JSON.stringify({ brands: opts.brands ?? ONE_BRAND, meta: { has_more: false }, links: { next: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function handler(fetchImpl?: typeof fetch) {
  let n = 0;
  return new ZendeskFormInstallHandler({
    idGenerator: () => `fixed-id-${++n}`,
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:zendesk" }];
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
      handler().validateConfig(WORKSPACE, { ...VALID, subdomain: "" }),
      "subdomain",
    );
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("reduces a pasted URL / host to the bare label", async () => {
    for (const paste of ["https://acme.zendesk.com/hc/en-us", "acme.zendesk.com", "ACME"]) {
      insertCalls.length = 0;
      const rec = await handler(brandsFetch()).validateConfig(WORKSPACE, { ...VALID, subdomain: paste });
      expect(rec.credentialWritten).toBe(true);
      const config = JSON.parse(insertCalls[0].params[4] as string);
      expect(config.subdomain).toBe("acme");
    }
  });

  it("rejects a subdomain that is not a host label", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { ...VALID, subdomain: "acme_corp!" }),
      "subdomain",
    );
    expect(msg).toMatch(/bare Zendesk subdomain/i);
  });

  it("requires a plausible email and an API token", async () => {
    expect(
      await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, email: "nope" }), "email"),
    ).toMatch(/valid/i);
    expect(
      await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, api_token: "" }), "api_token"),
    ).toMatch(/required/i);
  });
});

describe("brand enumeration (install-time verification)", () => {
  it("blames the api_token field on a 401", async () => {
    const msg = await fieldErrorOf(
      handler(brandsFetch({ status: 401 })).validateConfig(WORKSPACE, VALID),
      "api_token",
    );
    expect(msg).toMatch(/rejected the credentials/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("surfaces a 429 as a form-level error (the token may be fine)", async () => {
    const msg = await formErrorOf(handler(brandsFetch({ status: 429 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/rate-limited/i);
  });

  it("blames the subdomain field on a 404 (wrong subdomain)", async () => {
    const msg = await fieldErrorOf(
      handler(brandsFetch({ status: 404 })).validateConfig(WORKSPACE, VALID),
      "subdomain",
    );
    expect(msg).toMatch(/404/);
  });

  it("surfaces a vendor 5xx as a form-level error, never blaming the token", async () => {
    const msg = await formErrorOf(handler(brandsFetch({ status: 503 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/vendor-side error/i);
  });

  it("rejects an account with no help-center-enabled brand", async () => {
    const msg = await formErrorOf(
      handler(
        brandsFetch({ brands: [{ id: 1, name: "X", subdomain: "x", has_help_center: false, active: true }] }),
      ).validateConfig(WORKSPACE, VALID),
    );
    expect(msg).toMatch(/no active brand with a Help Center/i);
  });
});

describe("per-brand fan-out", () => {
  it("single brand: one collection under the base slug", async () => {
    const rec = await handler(brandsFetch()).validateConfig(WORKSPACE, VALID);
    expect(rec.installRecord).toMatchObject({ workspaceId: WORKSPACE, catalogId: "zendesk" });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[3]).toBe("zendesk");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toMatchObject({
      subdomain: "acme",
      email: "ops@acme.test",
      brand_id: "10",
      brand_subdomain: "acme",
      brand_name: "Acme",
    });
    // The token NEVER lands in the install config…
    expect(config).not.toHaveProperty("api_token");
    // …it lands in knowledge_sync_credentials, keyed by the collection slug.
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(saveSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "zendesk", "zd-token"]);
  });

  it("respects a custom collection slug via __install_id__", async () => {
    await handler(brandsFetch()).validateConfig(WORKSPACE, { ...VALID, __install_id__: "support-kb" });
    expect(insertCalls[0].params[3]).toBe("support-kb");
  });

  it("multi-brand: one collection per brand under suffixed slugs, one credential each", async () => {
    const rec = await handler(brandsFetch({ brands: TWO_BRANDS })).validateConfig(WORKSPACE, VALID);
    expect(insertCalls.map((c) => c.params[3])).toEqual(["zendesk-acme", "zendesk-acme-beta"]);
    const configs = insertCalls.map((c) => JSON.parse(c.params[4] as string));
    expect(configs.map((c) => c.brand_subdomain)).toEqual(["acme", "acme-beta"]);
    expect(saveSyncCredential.mock.calls.map((c) => c[1])).toEqual(["zendesk-acme", "zendesk-acme-beta"]);
    // The returned record is the first brand's row.
    expect(rec.installRecord.id).toBe("fixed-id-1");
  });

  it("skips inactive and non-help-center brands in the fan-out", async () => {
    await handler(
      brandsFetch({
        brands: [
          ...TWO_BRANDS,
          { id: 12, name: "Dead", subdomain: "acme-dead", has_help_center: true, active: false },
          { id: 13, name: "NoHC", subdomain: "acme-nohc", has_help_center: false, active: true },
        ],
      }),
    ).validateConfig(WORKSPACE, VALID);
    expect(insertCalls.map((c) => c.params[3])).toEqual(["zendesk-acme", "zendesk-acme-beta"]);
  });

  it("rejects a fan-out slug that would exceed the collection-slug bound BEFORE any write", async () => {
    const longBase = "z".repeat(120); // valid alone; overflows once "-acme-beta" is appended
    const msg = await fieldErrorOf(
      handler(brandsFetch({ brands: TWO_BRANDS })).validateConfig(WORKSPACE, {
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
      handler(brandsFetch({ brands: TWO_BRANDS })).validateConfig(WORKSPACE, VALID),
      "__install_id__",
    );
    expect(msg).toMatch(/already used/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rolls back the failed brand's credential and leaves earlier brands installed", async () => {
    INSERT_FAIL_ON_SLUG = "zendesk-acme-beta";
    await expect(
      handler(brandsFetch({ brands: TWO_BRANDS })).validateConfig(WORKSPACE, VALID),
    ).rejects.toThrow(/simulated row-write failure/);
    // First brand fully installed…
    expect(insertCalls.map((c) => c.params[3])).toEqual(["zendesk-acme"]);
    // …the failed brand's orphaned credential rolled back (and only that one).
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "zendesk-acme-beta"]);
  });
});

describe("catalog preconditions", () => {
  it("fails loudly when the catalog row is missing (seed has not run)", async () => {
    CATALOG_ROWS = [];
    await expect(handler(brandsFetch()).validateConfig(WORKSPACE, VALID)).rejects.toThrow(
      /catalog row "zendesk" not found/i,
    );
  });
});
