/**
 * Unit tests for `GitbookFormInstallHandler` (#4393) — the GitBook connector
 * install. Focus: field validation (space id / URL extraction, API token), loud
 * credential verification at install time, credential routing (token →
 * `knowledge_sync_credentials`, NEVER into `workspace_plugins.config`), and the
 * multi-instance `pillar='knowledge'` upsert shape. Verification uses the REAL
 * egress guard against an injected fixture fetch; no test touches GitBook.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:gitbook" }];
let INSERT_RETURNS_ID = true;
let CROSS_CATALOG_ROWS: { catalog_id: string }[] = [];
const insertCalls: { sql: string; params: unknown[] }[] = [];

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("FROM plugin_catalog")) return CATALOG_ROWS;
  if (sql.includes("catalog_id <> $3")) return CROSS_CATALOG_ROWS;
  if (sql.includes("INSERT INTO workspace_plugins")) {
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

const { GitbookFormInstallHandler, extractSpaceId } = await import(
  "@atlas/api/lib/integrations/install/gitbook-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = { space_id: "space-123", api_token: "gitbook-token" };

/** A fixture verify-fetch: the space lookup returns an object (or a status). */
function verifyFetch(opts: { spaceId?: string | null; status?: number } = {}): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (/\/v1\/spaces\/[^/]+$/.test(url.pathname)) {
      const id = opts.spaceId === undefined ? "space-123" : opts.spaceId;
      return new Response(JSON.stringify(id === null ? {} : { id, title: "Docs" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function handler(fetchImpl?: typeof fetch) {
  return new GitbookFormInstallHandler({
    idGenerator: () => "fixed-id",
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:gitbook" }];
  INSERT_RETURNS_ID = true;
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

describe("extractSpaceId", () => {
  it("returns a bare id unchanged", () => {
    expect(extractSpaceId("space-123")).toBe("space-123");
  });
  it("extracts the id from an app URL", () => {
    expect(extractSpaceId("https://app.gitbook.com/o/org1/s/AbC_123/guides/setup")).toBe("AbC_123");
  });
  it("returns empty for an unparseable URL", () => {
    expect(extractSpaceId("https://app.gitbook.com/o/org1/")).toBe("");
  });
});

describe("field validation", () => {
  it("requires the space id", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, space_id: "" }), "space_id");
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("requires the API token", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, api_token: "" }), "api_token");
    expect(msg).toMatch(/required/i);
  });

  it("rejects a token with embedded whitespace", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { ...VALID, api_token: "abc def" }),
      "api_token",
    );
    expect(msg).toMatch(/spaces/i);
  });

  it("accepts a space URL and stores the extracted id", async () => {
    const rec = await handler(verifyFetch()).validateConfig(WORKSPACE, {
      ...VALID,
      space_id: "https://app.gitbook.com/o/org1/s/space-123/guides",
    });
    expect(rec.credentialWritten).toBe(true);
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config.space_id).toBe("space-123");
  });
});

describe("credential verification", () => {
  it("blames the api_token field on a 401", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ status: 401 })).validateConfig(WORKSPACE, VALID),
      "api_token",
    );
    expect(msg).toMatch(/rejected the credentials/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it("blames the space_id field on a 404", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ status: 404 })).validateConfig(WORKSPACE, VALID),
      "space_id",
    );
    expect(msg).toMatch(/404/);
  });

  it("blames the space_id field when the space object has no id", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ spaceId: null })).validateConfig(WORKSPACE, VALID),
      "space_id",
    );
    expect(msg).toMatch(/not found or is not visible/i);
  });

  it("routes a rate-limit (429) verification failure to a form-level error, not a field", async () => {
    // Blaming a field on a 429 would send the admin re-entering a value that may
    // be fine — a 429 is a transient throttle, so it belongs at the form level.
    try {
      await handler(verifyFetch({ status: 429 })).validateConfig(WORKSPACE, VALID);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FormInstallValidationError);
      const e = err as InstanceType<typeof FormInstallValidationError>;
      expect(e.formErrors.length).toBeGreaterThan(0);
      expect(Object.keys(e.fieldErrors)).toHaveLength(0);
    }
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});

describe("successful install", () => {
  it("verifies, writes the credential, then upserts the knowledge collection (token never in config)", async () => {
    const rec = await handler(verifyFetch()).validateConfig(WORKSPACE, VALID);
    expect(rec.installRecord.id).toBe("fixed-id");
    expect(rec.credentialWritten).toBe(true);
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].sql).toContain("pillar");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toEqual({ space_id: "space-123" });
    expect(JSON.stringify(config)).not.toContain("gitbook-token");
  });

  it("rolls back the credential when the install-row upsert fails", async () => {
    INSERT_RETURNS_ID = false;
    await expect(handler(verifyFetch()).validateConfig(WORKSPACE, VALID)).rejects.toThrow();
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
  });
});
