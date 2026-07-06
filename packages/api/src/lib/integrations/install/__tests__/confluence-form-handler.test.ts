/**
 * Unit tests for `ConfluenceFormInstallHandler` (#4377) — the Confluence
 * connector install. Focus: field validation (base URL + SSRF gate, email,
 * space key, API token), loud credential verification at install time, the
 * credential routing (token → `knowledge_sync_credentials`, NEVER into
 * `workspace_plugins.config`), and the multi-instance `pillar='knowledge'`
 * upsert shape. The SSRF check + verification use the REAL egress guard against
 * an injected fixture fetch; no test touches Atlassian.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:confluence" }];
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

mock.module("@atlas/api/lib/db/internal", () => buildInternalDbMockDefaults({ internalQuery }));
mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const saveSyncCredential = mock(async (_w: string, _c: string, _s: string) => {});
const deleteSyncCredential = mock(async (_w: string, _c: string) => {});
const readSyncCredential = mock(async () => null);
mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential,
  deleteSyncCredential,
  readSyncCredential,
}));

const { ConfluenceFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/confluence-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = {
  base_url: "https://acme.atlassian.net/wiki",
  email: "bot@acme.com",
  space_key: "ENG",
  api_token: "atlassian-token",
};

/** A fixture verify-fetch: the space lookup returns `spaceResults` (or a status). */
function verifyFetch(opts: { spaceResults?: unknown[]; status?: number } = {}) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (url.pathname.endsWith("/api/v2/spaces")) {
      return new Response(JSON.stringify({ results: opts.spaceResults ?? [{ id: "100", key: "ENG" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
}

function handler(fetchImpl?: typeof fetch) {
  return new ConfluenceFormInstallHandler({
    idGenerator: () => "fixed-id",
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:confluence" }];
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

describe("field validation", () => {
  it("requires the base URL", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, base_url: "" }), "base_url");
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a non-https base URL", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { ...VALID, base_url: "http://acme.atlassian.net/wiki" }),
      "base_url",
    );
    expect(msg).toMatch(/https/i);
  });

  it("blocks an SSRF base URL as a field error, not a 500", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { ...VALID, base_url: "https://169.254.169.254/wiki" }),
      "base_url",
    );
    expect(msg).toMatch(/private|internal|Refusing/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("requires the email, space key, and API token", async () => {
    expect(await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, email: "" }), "email")).toMatch(/required/i);
    expect(await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, space_key: "" }), "space_key")).toMatch(/required/i);
    expect(await fieldErrorOf(handler().validateConfig(WORKSPACE, { ...VALID, api_token: "" }), "api_token")).toMatch(/token is required/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects credentials embedded in the base URL (the token belongs in the encrypted field)", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { ...VALID, base_url: "https://user:pass@acme.atlassian.net/wiki" }),
      "base_url",
    );
    expect(msg).toMatch(/Remove the credentials from the URL/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a malformed base URL", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { ...VALID, base_url: "not a url" }),
      "base_url",
    );
    expect(msg).toMatch(/well-formed/i);
  });

  it("rejects a slug already taken by another knowledge catalog, before any write", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    await expect(
      handler(verifyFetch() as unknown as typeof fetch).validateConfig(WORKSPACE, VALID),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});

describe("credential verification + persistence", () => {
  it("installs on valid config: verifies, stores the token, persists config WITHOUT the token", async () => {
    const result = await handler(verifyFetch() as unknown as typeof fetch).validateConfig(WORKSPACE, VALID);

    expect(result.installRecord).toMatchObject({ id: "fixed-id", catalogId: "confluence" });
    expect(result.credentialWritten).toBe(true);
    // The token was routed to the credential store.
    expect(saveSyncCredential).toHaveBeenCalledWith(WORKSPACE, "confluence", "atlassian-token");
    // The persisted config carries base_url/email/space_key — NEVER the token.
    expect(insertCalls).toHaveLength(1);
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toMatchObject({ base_url: VALID.base_url, email: VALID.email, space_key: "ENG" });
    expect(config).not.toHaveProperty("api_token");
  });

  it("fails the install loudly on a bad token (401), persisting nothing", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ status: 401 }) as unknown as typeof fetch).validateConfig(WORKSPACE, VALID),
      "api_token",
    );
    expect(msg).toMatch(/rejected the credentials \(401\)/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it("fails the install when the space key is not visible to the token", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ spaceResults: [] }) as unknown as typeof fetch).validateConfig(WORKSPACE, VALID),
      "api_token",
    );
    expect(msg).toMatch(/space "ENG" was not found or is not visible/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it("rolls back the just-written credential when the install-row upsert returns no id", async () => {
    INSERT_RETURNS_ID = false;
    await expect(
      handler(verifyFetch() as unknown as typeof fetch).validateConfig(WORKSPACE, VALID),
    ).rejects.toThrow(/returned no id/i);
    // The credential was written, then rolled back so no secret outlives the
    // failed install (its install row never landed).
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential).toHaveBeenCalledWith(WORKSPACE, "confluence");
  });
});
