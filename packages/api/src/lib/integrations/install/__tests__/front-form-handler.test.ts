/**
 * Unit tests for `FrontFormInstallHandler` (#4400) — the Front Knowledge Base
 * connector install. Focus: field validation (API token), loud KB-enumeration
 * verification at install time, the PER-KB FAN-OUT (one collection per knowledge
 * base; base slug for a single KB, suffixed slugs for multi-KB), credential
 * routing (token → `knowledge_sync_credentials`, one row per KB collection,
 * NEVER into `workspace_plugins.config`), and the credential rollback on a
 * failed row write. Verification uses the REAL egress guard against an injected
 * fixture fetch; no test touches Front.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:front" }];
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

const { FrontFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/front-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = { api_token: "front-token" };

interface FixtureKB {
  id?: string;
  name?: string;
}

const ONE_KB: FixtureKB[] = [{ id: "kb_1", name: "Support" }];
const TWO_KBS: FixtureKB[] = [...ONE_KB, { id: "kb_2", name: "Internal" }];

/** A fixture knowledge-bases-endpoint fetch (or a fixed failure status). */
function kbFetch(opts: { bases?: FixtureKB[]; status?: number } = {}): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (url.pathname === "/knowledge_bases") {
      return new Response(
        JSON.stringify({ _results: opts.bases ?? ONE_KB, _pagination: { next: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function handler(fetchImpl?: typeof fetch) {
  let n = 0;
  return new FrontFormInstallHandler({
    idGenerator: () => `fixed-id-${++n}`,
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:front" }];
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
  it("requires the API token", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, { api_token: "" }), "api_token");
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a non-string description", async () => {
    const msg = await fieldErrorOf(
      handler(kbFetch()).validateConfig(WORKSPACE, { ...VALID, description: 42 }),
      "description",
    );
    expect(msg).toMatch(/string/i);
  });
});

describe("KB enumeration (install-time verification)", () => {
  it("blames the api_token field on a 401", async () => {
    const msg = await fieldErrorOf(
      handler(kbFetch({ status: 401 })).validateConfig(WORKSPACE, VALID),
      "api_token",
    );
    expect(msg).toMatch(/rejected the credentials/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("surfaces a 429 as a form-level error (the token may be fine)", async () => {
    const msg = await formErrorOf(handler(kbFetch({ status: 429 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/rate-limited/i);
  });

  it("surfaces a vendor 5xx as a form-level error, never blaming the token", async () => {
    const msg = await formErrorOf(handler(kbFetch({ status: 503 })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/vendor-side error/i);
  });

  it("rejects an account with no knowledge bases", async () => {
    const msg = await formErrorOf(handler(kbFetch({ bases: [] })).validateConfig(WORKSPACE, VALID));
    expect(msg).toMatch(/no knowledge bases/i);
  });
});

describe("per-KB fan-out", () => {
  it("single KB: one collection under the base slug, token in credentials not config", async () => {
    const rec = await handler(kbFetch()).validateConfig(WORKSPACE, VALID);
    expect(rec.installRecord).toMatchObject({ workspaceId: WORKSPACE, catalogId: "front" });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[3]).toBe("front");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toMatchObject({ knowledge_base_id: "kb_1", knowledge_base_name: "Support" });
    // The token NEVER lands in the install config…
    expect(config).not.toHaveProperty("api_token");
    // …it lands in knowledge_sync_credentials, keyed by the collection slug.
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(saveSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "front", "front-token"]);
  });

  it("respects a custom collection slug via __install_id__", async () => {
    await handler(kbFetch()).validateConfig(WORKSPACE, { ...VALID, __install_id__: "support-kb" });
    expect(insertCalls[0].params[3]).toBe("support-kb");
  });

  it("multi-KB: one collection per KB under suffixed slugs, one credential each", async () => {
    const rec = await handler(kbFetch({ bases: TWO_KBS })).validateConfig(WORKSPACE, VALID);
    expect(insertCalls.map((c) => c.params[3])).toEqual(["front-kb-1", "front-kb-2"]);
    const configs = insertCalls.map((c) => JSON.parse(c.params[4] as string));
    expect(configs.map((c) => c.knowledge_base_id)).toEqual(["kb_1", "kb_2"]);
    expect(saveSyncCredential.mock.calls.map((c) => c[1])).toEqual(["front-kb-1", "front-kb-2"]);
    // The returned record is the first KB's row.
    expect(rec.installRecord.id).toBe("fixed-id-1");
  });

  it("rejects a fan-out slug that would exceed the collection-slug bound BEFORE any write", async () => {
    const longBase = "z".repeat(124); // valid alone; overflows once "-kb-1" is appended
    const msg = await fieldErrorOf(
      handler(kbFetch({ bases: TWO_KBS })).validateConfig(WORKSPACE, {
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
      handler(kbFetch({ bases: TWO_KBS })).validateConfig(WORKSPACE, VALID),
      "__install_id__",
    );
    expect(msg).toMatch(/already used/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rolls back the failed KB's credential and leaves earlier KBs installed", async () => {
    INSERT_FAIL_ON_SLUG = "front-kb-2";
    await expect(
      handler(kbFetch({ bases: TWO_KBS })).validateConfig(WORKSPACE, VALID),
    ).rejects.toThrow(/simulated row-write failure/);
    // First KB fully installed…
    expect(insertCalls.map((c) => c.params[3])).toEqual(["front-kb-1"]);
    // …the failed KB's orphaned credential rolled back (and only that one).
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential.mock.calls[0]).toEqual([WORKSPACE, "front-kb-2"]);
  });
});

describe("catalog preconditions", () => {
  it("fails loudly when the catalog row is missing (seed has not run)", async () => {
    CATALOG_ROWS = [];
    await expect(handler(kbFetch()).validateConfig(WORKSPACE, VALID)).rejects.toThrow(
      /catalog row "front" not found/i,
    );
  });
});
