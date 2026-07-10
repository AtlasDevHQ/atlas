/**
 * Unit tests for `IntercomFormInstallHandler` (#4399) — the Intercom connector
 * install. Focus: field validation (access token), loud credential verification
 * at install time (`GET /me`), credential routing (token →
 * `knowledge_sync_credentials`, NEVER into `workspace_plugins.config`), the
 * multi-instance `pillar='knowledge'` upsert shape, and rollback on a failed
 * install row. Verification uses the REAL egress guard against an injected
 * fixture fetch; no test touches Intercom.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:intercom" }];
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

const { IntercomFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/intercom-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = { access_token: "intercom-token" };

/** A fixture verify-fetch: /me returns an identity (or a status). */
function verifyFetch(opts: { status?: number; hollow?: boolean } = {}): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (url.pathname === "/me") {
      return new Response(JSON.stringify(opts.hollow ? {} : { type: "admin", id: "admin-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fixture: unexpected URL ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function handler(fetchImpl?: typeof fetch) {
  return new IntercomFormInstallHandler({
    idGenerator: () => "fixed-id",
    clientDeps: fetchImpl ? { fetchImpl } : {},
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:intercom" }];
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
  it("requires the access token", async () => {
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, { access_token: "" }), "access_token");
    expect(msg).toMatch(/required/i);
    expect(insertCalls).toHaveLength(0);
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });

  it("rejects a token with embedded whitespace", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { access_token: "abc def" }),
      "access_token",
    );
    expect(msg).toMatch(/spaces/i);
  });
});

describe("credential verification", () => {
  it("blames the access_token field on a 401", async () => {
    const msg = await fieldErrorOf(
      handler(verifyFetch({ status: 401 })).validateConfig(WORKSPACE, VALID),
      "access_token",
    );
    expect(msg).toMatch(/rejected the credentials/i);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it("routes a rate-limit (429) verification failure to a form-level error, not a field", async () => {
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

  it("routes a hollow /me (no identity) to a form-level error", async () => {
    try {
      await handler(verifyFetch({ hollow: true })).validateConfig(WORKSPACE, VALID);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FormInstallValidationError);
      const e = err as InstanceType<typeof FormInstallValidationError>;
      expect(e.formErrors.length).toBeGreaterThan(0);
    }
    expect(saveSyncCredential).not.toHaveBeenCalled();
  });
});

describe("successful install", () => {
  it("verifies, writes the credential, then upserts the knowledge collection (token never in config)", async () => {
    const rec = await handler(verifyFetch()).validateConfig(WORKSPACE, {
      ...VALID,
      description: "Support docs",
    });
    expect(rec.installRecord.id).toBe("fixed-id");
    expect(rec.credentialWritten).toBe(true);
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].sql).toContain("pillar");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toEqual({ description: "Support docs" });
    expect(JSON.stringify(config)).not.toContain("intercom-token");
  });

  it("rolls back the credential when the install-row upsert fails", async () => {
    INSERT_RETURNS_ID = false;
    await expect(handler(verifyFetch()).validateConfig(WORKSPACE, VALID)).rejects.toThrow();
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
  });
});
