/**
 * Unit tests for `OkfUploadFormInstallHandler` (#4207) — the collection install.
 *
 * Focus: slug resolution/validation, the multi-instance `pillar='knowledge'`
 * upsert shape (install_id = slug, status='published'), and the config
 * (description) handling. The internal DB is a SQL-string-dispatching mock;
 * the live INSERT is pinned against real Postgres in the `-pg` test.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:okf-upload" }];
let INSERT_RETURNS_ID = true;
// Rows returned by the cross-catalog slug guard (#4211) — non-empty = conflict.
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

const { OkfUploadFormInstallHandler, resolveCollectionSlug, OKF_UPLOAD_SLUG } = await import(
  "@atlas/api/lib/integrations/install/okf-upload-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/email-form-handler"
);

const WORKSPACE = "org-1" as WorkspaceId;

function handler() {
  return new OkfUploadFormInstallHandler({ idGenerator: () => "fixed-id" });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:okf-upload" }];
  INSERT_RETURNS_ID = true;
  CROSS_CATALOG_ROWS = [];
  insertCalls.length = 0;
  internalQuery.mockClear();
});
afterEach(() => internalQuery.mockClear());

describe("OkfUploadFormInstallHandler.validateConfig", () => {
  it("defaults the collection slug to the catalog slug when omitted", async () => {
    const { installRecord, credentialWritten } = await handler().validateConfig(WORKSPACE, {});
    expect(credentialWritten).toBe(false);
    expect(installRecord).toEqual({ id: "fixed-id", workspaceId: WORKSPACE, catalogId: OKF_UPLOAD_SLUG });
    // install_id ($4) = the default slug; pillar 'knowledge'; status 'published'.
    expect(insertCalls[0].params[3]).toBe(OKF_UPLOAD_SLUG);
    expect(insertCalls[0].sql).toContain("'knowledge'");
    expect(insertCalls[0].sql).toContain("'published'");
  });

  it("uses a custom collection slug from the reserved field and stores the description", async () => {
    await handler().validateConfig(WORKSPACE, {
      __install_id__: "eu-runbooks",
      description: "  EU runbooks  ",
    });
    expect(insertCalls[0].params[3]).toBe("eu-runbooks");
    expect(JSON.parse(insertCalls[0].params[4] as string)).toEqual({ description: "EU runbooks" });
  });

  it("rejects an invalid slug with a field-level validation error", async () => {
    await expect(
      handler().validateConfig(WORKSPACE, { __install_id__: "bad/slug" }),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects a non-string description", async () => {
    await expect(
      handler().validateConfig(WORKSPACE, { description: 42 }),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
  });

  it("throws when the catalog row is missing (seed misconfig → 500, not silent)", async () => {
    CATALOG_ROWS = [];
    await expect(handler().validateConfig(WORKSPACE, {})).rejects.toThrow(/not found or disabled/);
  });

  it("fails loud when the upsert returns no id (Postgres invariant break)", async () => {
    INSERT_RETURNS_ID = false;
    await expect(handler().validateConfig(WORKSPACE, {})).rejects.toThrow(/returned no id/);
  });

  it("rejects a slug already used by another knowledge catalog (bundle-sync) — trees must not merge (#4211)", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    await expect(
      handler().validateConfig(WORKSPACE, { __install_id__: "runbooks" }),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(insertCalls).toHaveLength(0);
  });
});

describe("resolveCollectionSlug", () => {
  it("defaults on omitted / blank", () => {
    expect(resolveCollectionSlug(undefined, "d")).toBe("d");
    expect(resolveCollectionSlug("  ", "d")).toBe("d");
  });
  it("trims and accepts a valid slug", () => {
    expect(resolveCollectionSlug("  eu-runbooks_1.2 ", "d")).toBe("eu-runbooks_1.2");
  });
  it("rejects slashes, spaces, and over-long slugs", () => {
    expect(() => resolveCollectionSlug("a/b", "d")).toThrow(FormInstallValidationError);
    expect(() => resolveCollectionSlug("a b", "d")).toThrow(FormInstallValidationError);
    expect(() => resolveCollectionSlug("x".repeat(200), "d")).toThrow(FormInstallValidationError);
  });
});
