/**
 * L2 BYOT catalog cache tests (#2274).
 *
 * Mocks `db/internal` to assert wire shape without standing up Postgres.
 * Per CLAUDE.md, every named export is mirrored in the mock so the
 * partial-mock SyntaxError trap doesn't fire elsewhere.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

interface RecordedCall {
  sql: string;
  params: unknown[];
}

const recorded: RecordedCall[] = [];
let nextRows: unknown[] = [];
let nextError: Error | null = null;
let hasInternalDBValue = true;

const mockInternalQuery = mock(async (sql: string, params: unknown[]) => {
  recorded.push({ sql, params });
  if (nextError) throw nextError;
  return nextRows;
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBValue,
  internalQuery: mockInternalQuery,
  // The catalog-store doesn't touch the rest of internal.ts, but the
  // partial-mock guard requires every export the module surfaces.
  // Empty stubs are enough — the byot-catalog-store doesn't reach into
  // them, and bun:test's mock.module errors loudly if a consumer in this
  // test suite ever does.
  encryptSecret: () => "",
  decryptSecret: () => "",
  encryptUrl: () => "",
  decryptUrl: () => "",
  getInternalDB: () => null,
  getEncryptionKey: () => null,
  getEncryptionKeyVersions: () => ({ active: 1, keys: new Map() }),
}));

const { loadFromDB, storeToDB, deleteFromDB, isFresh } = await import("../byot-catalog-store");

function reset() {
  recorded.length = 0;
  nextRows = [];
  nextError = null;
  hasInternalDBValue = true;
  mockInternalQuery.mockClear();
}

describe("byot-catalog-store", () => {
  beforeEach(() => reset());
  afterEach(() => reset());

  describe("loadFromDB", () => {
    test("returns null when no internal DB is configured", async () => {
      hasInternalDBValue = false;
      const result = await loadFromDB("org_a", "anthropic");
      expect(result).toBeNull();
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    test("returns null on miss", async () => {
      nextRows = [];
      const result = await loadFromDB("org_a", "anthropic");
      expect(result).toBeNull();
      expect(recorded[0].params).toEqual(["org_a", "anthropic", ""]);
    });

    test("returns parsed payload on hit", async () => {
      nextRows = [
        {
          payload: { models: [{ id: "claude-opus-4-6", provider: "anthropic" }] },
          fetched_at: "2026-05-11T00:00:00.000Z",
        },
      ];
      const result = await loadFromDB("org_a", "anthropic");
      expect(result).not.toBeNull();
      expect(result!.fetchedAt).toBe("2026-05-11T00:00:00.000Z");
      expect(result!.models).toHaveLength(1);
    });

    test("uses region in the WHERE clause for bedrock", async () => {
      nextRows = [];
      await loadFromDB("org_a", "bedrock", "us-east-1");
      expect(recorded[0].params).toEqual(["org_a", "bedrock", "us-east-1"]);
    });

    test("returns null on DB error (best-effort, never throws)", async () => {
      nextError = new Error("ECONNREFUSED");
      const result = await loadFromDB("org_a", "anthropic");
      expect(result).toBeNull();
    });

    test("returns null on malformed payload", async () => {
      nextRows = [{ payload: { not_models: "wrong shape" }, fetched_at: "2026-05-11T00:00:00.000Z" }];
      const result = await loadFromDB("org_a", "anthropic");
      expect(result).toBeNull();
    });
  });

  describe("storeToDB", () => {
    test("no-op when no internal DB", async () => {
      hasInternalDBValue = false;
      await storeToDB("org_a", "anthropic", "", {
        models: [],
        fetchedAt: "2026-05-11T00:00:00.000Z",
      });
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });

    test("upserts on (org_id, provider, region) tuple", async () => {
      await storeToDB("org_a", "openai", "", {
        models: [{ id: "gpt-4o" } as never],
        fetchedAt: "2026-05-11T00:00:00.000Z",
      });
      expect(recorded[0].sql).toMatch(/INSERT INTO workspace_model_catalog/);
      expect(recorded[0].sql).toMatch(/ON CONFLICT \(org_id, provider, region\)/);
      expect(recorded[0].params[1]).toBe("openai");
      expect(recorded[0].params[2]).toBe("");
      // payload[3] is the JSON-stringified bag.
      expect(JSON.parse(recorded[0].params[3] as string).models[0].id).toBe("gpt-4o");
    });

    test("bedrock region rides on the upsert key", async () => {
      await storeToDB("org_a", "bedrock", "ap-northeast-1", {
        models: [{ id: "anthropic.claude-opus-4-v1:0" } as never],
        fetchedAt: "2026-05-11T00:00:00.000Z",
      });
      expect(recorded[0].params[2]).toBe("ap-northeast-1");
    });

    test("swallows DB errors so the in-memory cache return path is preserved", async () => {
      nextError = new Error("constraint violation");
      // Must NOT throw — the L2 store is best-effort by contract.
      await storeToDB("org_a", "anthropic", "", {
        models: [],
        fetchedAt: "2026-05-11T00:00:00.000Z",
      });
    });
  });

  describe("deleteFromDB", () => {
    test("flushes every region for an org+provider in one shot", async () => {
      await deleteFromDB("org_a", "bedrock");
      expect(recorded[0].sql).toMatch(/DELETE FROM workspace_model_catalog/);
      expect(recorded[0].params).toEqual(["org_a", "bedrock"]);
    });

    test("no-op when no internal DB", async () => {
      hasInternalDBValue = false;
      await deleteFromDB("org_a", "anthropic");
      expect(mockInternalQuery).not.toHaveBeenCalled();
    });
  });

  describe("isFresh", () => {
    test("returns true for a recent fetchedAt", () => {
      const persisted = {
        models: [],
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      expect(isFresh(persisted, 5 * 60_000)).toBe(true);
    });

    test("returns false past the TTL window", () => {
      const persisted = {
        models: [],
        fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      };
      expect(isFresh(persisted, 5 * 60_000)).toBe(false);
    });

    test("returns false for an unparseable timestamp", () => {
      const persisted = { models: [], fetchedAt: "yesterday" };
      expect(isFresh(persisted, 60_000)).toBe(false);
    });
  });
});
