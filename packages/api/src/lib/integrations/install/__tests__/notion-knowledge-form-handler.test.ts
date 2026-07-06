/**
 * Unit tests for `NotionKnowledgeFormInstallHandler` (#4378) — the Notion
 * synced-collection install.
 *
 * Focus: token validation, loud install-time token verification (one
 * `GET /users/me` against an injected fixture fetch — no test calls Notion),
 * the credential routing (token → `knowledge_sync_credentials` via the store,
 * NEVER into `workspace_plugins.config`), the orphaned-credential rollback on
 * an install-row failure, the multi-instance `pillar='knowledge'` upsert
 * shape, and the cross-catalog slug guard. The internal DB is a
 * SQL-string-dispatching mock; the live INSERT is pinned against real Postgres
 * in the shared install `-pg` smoke.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:notion-knowledge" }];
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
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT INTO knowledge_sync_credentials …",
  saveSyncCredential,
  deleteSyncCredential,
  readSyncCredential,
}));

const { NotionKnowledgeFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/notion-knowledge-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;

const verifyCalls: { url: string; headers: Record<string, string> }[] = [];

/** A fixture verify-fetch: `GET /users/me` returns the bot user (or a status). */
function verifyFetch(opts: { status?: number; code?: string; reject?: Error } = {}) {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    verifyCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (opts.reject) throw opts.reject;
    if (!url.endsWith("/users/me")) throw new Error(`fixture: unexpected URL ${url}`);
    if (opts.status !== undefined && opts.status !== 200) {
      return new Response(
        JSON.stringify({
          object: "error",
          status: opts.status,
          code: opts.code ?? "unauthorized",
          message: "API token is invalid.",
        }),
        { status: opts.status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ object: "user", id: "bot-user" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function handler(fetchImpl: typeof fetch = verifyFetch()) {
  return new NotionKnowledgeFormInstallHandler({
    idGenerator: () => "fixed-id",
    clientOptions: { fetchImpl },
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:notion-knowledge" }];
  INSERT_RETURNS_ID = true;
  CROSS_CATALOG_ROWS = [];
  insertCalls.length = 0;
  verifyCalls.length = 0;
  internalQuery.mockClear();
  saveSyncCredential.mockClear();
  deleteSyncCredential.mockClear();
});

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

describe("NotionKnowledgeFormInstallHandler — token validation", () => {
  it("requires a token", async () => {
    const err = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { __install_id__: "notion" }),
      "integration_token",
    );
    expect(err).toMatch(/token is required/i);
  });

  it("rejects a token with embedded whitespace", async () => {
    const err = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { __install_id__: "notion", integration_token: "ntn_ a b" }),
      "integration_token",
    );
    expect(err).toMatch(/must not contain spaces/i);
  });

  it("rejects a pathologically long token", async () => {
    const err = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, {
        __install_id__: "notion",
        integration_token: "n".repeat(600),
      }),
      "integration_token",
    );
    expect(err).toMatch(/characters or fewer/i);
  });
});

describe("NotionKnowledgeFormInstallHandler — token verification", () => {
  it("verifies the token with one GET /users/me before persisting", async () => {
    await handler().validateConfig(WORKSPACE, {
      __install_id__: "runbooks",
      integration_token: "ntn_secret-token",
    });

    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0].url).toContain("/users/me");
    expect(verifyCalls[0].headers.Authorization).toBe("Bearer ntn_secret-token");
  });

  it("fails the install loudly on a bad token (401), persisting nothing", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ status: 401 })).validateConfig(WORKSPACE, {
        __install_id__: "runbooks",
        integration_token: "ntn_revoked",
      }),
      "integration_token",
    );
    expect(msg).toMatch(/rejected the integration token/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it("maps a transport failure to a form-level error (not the token field), persisting nothing", async () => {
    const promise = handler(
      verifyFetch({ reject: new Error("getaddrinfo ENOTFOUND api.notion.com") }),
    ).validateConfig(WORKSPACE, {
      __install_id__: "runbooks",
      integration_token: "ntn_fine",
    });
    const msg = await formErrorOf(promise);
    // Transport is not a credential rejection — never blame the token field.
    expect(msg).toMatch(/could not be reached/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});

describe("NotionKnowledgeFormInstallHandler — install", () => {
  it("routes the token to the credential store and NEVER into config", async () => {
    const result = await handler().validateConfig(WORKSPACE, {
      __install_id__: "runbooks",
      integration_token: "ntn_secret-token",
      description: "Product runbooks",
    });

    expect(saveSyncCredential).toHaveBeenCalledWith(WORKSPACE, "runbooks", "ntn_secret-token");
    expect(result.credentialWritten).toBe(true);
    expect(result.installRecord).toEqual({
      id: "fixed-id",
      workspaceId: WORKSPACE,
      catalogId: "notion-knowledge",
    });

    // The persisted config carries the description but NOT the token.
    expect(insertCalls).toHaveLength(1);
    const configJson = insertCalls[0].params[4] as string;
    expect(JSON.parse(configJson)).toEqual({ description: "Product runbooks" });
    expect(configJson).not.toContain("ntn_secret-token");
    // Upsert is the knowledge-pillar, published-container shape.
    expect(insertCalls[0].sql).toContain("'knowledge'");
    expect(insertCalls[0].sql).toContain("'published'");
  });

  it("fails loudly when the catalog row is missing (seed not run)", async () => {
    CATALOG_ROWS = [];
    await expect(
      handler().validateConfig(WORKSPACE, {
        __install_id__: "notion",
        integration_token: "ntn_x",
      }),
    ).rejects.toThrow(/not found or disabled/);
    // Never persisted a credential for an install that can't complete.
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a slug already taken by another knowledge catalog", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:okf-upload" }];
    await expect(
      handler().validateConfig(WORKSPACE, {
        __install_id__: "runbooks",
        integration_token: "ntn_x",
      }),
    ).rejects.toBeDefined();
    expect(insertCalls).toHaveLength(0);
  });

  it("aborts (no install row) when the credential write fails — never a half-install", async () => {
    saveSyncCredential.mockImplementationOnce(async () => {
      throw new Error("encryption keyset unavailable");
    });
    await expect(
      handler().validateConfig(WORKSPACE, {
        __install_id__: "runbooks",
        integration_token: "ntn_x",
      }),
    ).rejects.toThrow(/encryption keyset unavailable/);
    // Credential-first write order: a failed credential means NO workspace_plugins
    // row (no installable card whose scheduled sync then 401s).
    expect(insertCalls).toHaveLength(0);
  });

  it("rolls back the just-written credential when the install-row upsert returns no id", async () => {
    INSERT_RETURNS_ID = false;
    await expect(
      handler().validateConfig(WORKSPACE, {
        __install_id__: "runbooks",
        integration_token: "ntn_x",
      }),
    ).rejects.toThrow(/returned no id/i);
    // The credential was written, then rolled back so no secret outlives the
    // failed install (its install row never landed, so uninstall can't reach it).
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential).toHaveBeenCalledWith(WORKSPACE, "runbooks");
  });
});
