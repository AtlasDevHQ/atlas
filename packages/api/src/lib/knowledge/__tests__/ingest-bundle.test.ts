/**
 * Unit tests for `ingestBundle` — the shared orchestration seam from raw bundle
 * bytes to committed rows (milestone #81 arch review, candidate 1). The upload
 * route and the sync engine are disposition adapters over THIS interface, so
 * upload/sync parity is structural; these tests pin the seam's own contract:
 * typed failure outcomes, the single transaction (ingest + archive-absent +
 * publish), the publish×source guard (ADR-0028 §4), and churn-gated mirror
 * invalidation.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { zipSync, strToU8 } from "fflate";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

let MAX_DOCS = 100;
let MAX_DOC_BYTES = 100_000;
let MAX_BUNDLE_BYTES = 200_000;

// In-memory knowledge store shared by the fake transactional client. Rows keep
// every mirrored field so `docChanged` sees a faithful read-back (the
// all-unchanged test depends on it).
let store: Map<string, Record<string, unknown>>;
let publishRan = false;
let txActive = false;
let lastTxVerb: string | null = null;
let publishRanInTx = false;
let archiveRanInTx = false;
let archivedPathsParam: unknown = null;
let nextId = 1;

// What the seam's in-transaction install re-check sees. `null` = row gone.
let TX_INSTALL_STATUS: string | null = "published";

function fakeTxClient() {
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      if (sql === "BEGIN") {
        txActive = true;
        return { rows: [] };
      }
      if (sql.includes("SELECT status") && sql.includes("FROM workspace_plugins")) {
        return { rows: TX_INSTALL_STATUS === null ? [] : [{ status: TX_INSTALL_STATUS }] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        txActive = false;
        lastTxVerb = sql;
        return { rows: [] };
      }
      if (sql.includes("SELECT id, status, body") && sql.includes("knowledge_documents")) {
        const existing = store.get(params[2] as string);
        return { rows: existing ? [existing] : [] };
      }
      if (sql.includes("INSERT INTO knowledge_documents")) {
        const id = `doc-${nextId++}`;
        store.set(params[2] as string, {
          id,
          status: "draft",
          type: params[3],
          title: params[4],
          description: params[5],
          tags: JSON.parse(params[6] as string),
          timestamp: params[7],
          resource: params[8],
          body: params[9],
        });
        return { rows: [{ id }] };
      }
      if (sql.includes("UPDATE knowledge_documents") && sql.includes("path <> ALL")) {
        archiveRanInTx = txActive;
        archivedPathsParam = params[2];
        // Pretend one absent doc got archived.
        return { rows: [{ id: "archived-1" }] };
      }
      if (sql.includes("UPDATE knowledge_documents")) return { rows: [] };
      if (sql.includes("DELETE FROM knowledge_links")) return { rows: [] };
      if (sql.includes("INSERT INTO knowledge_links")) return { rows: [] };
      throw new Error(`unexpected tx SQL: ${sql.slice(0, 60)}`);
    },
    release() {},
  };
}

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async (sql: string) => {
      throw new Error(`unexpected internalQuery outside the transaction: ${sql.slice(0, 60)}`);
    },
  }),
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

// Partial mock, justified: this file's import graph reaches only the exports
// stubbed below; the isolated per-file runner prevents cross-file leaks, and an
// unmocked export reached later fails loudly as `undefined is not a function`.
mock.module("@atlas/api/lib/content-mode", () => ({
  CONTENT_MODE_TABLES: [],
  makeService: () => ({
    runPublishPhases: () =>
      Effect.sync(() => {
        publishRan = true;
        publishRanInTx = txActive;
        return [];
      }),
  }),
}));

mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
  getIngestMaxDocs: () => MAX_DOCS,
  getIngestMaxDocBytes: () => MAX_DOC_BYTES,
  getIngestMaxBundleBytes: () => MAX_BUNDLE_BYTES,
}));

// The mirror-invalidation seam lazy-imports semantic/sync; only the
// invalidation entrypoint is reachable from this module's graph.
let invalidations: Array<{ orgId: string; scope: string }> = [];
mock.module("@atlas/api/lib/knowledge/mirror-invalidation", () => ({
  invalidateKnowledgeMirror: async (orgId: string, opts?: { scope?: string }) => {
    invalidations.push({ orgId, scope: opts?.scope ?? "knowledge" });
  },
}));

const { ingestBundle } = await import("@atlas/api/lib/knowledge/ingest-bundle");

const WS = "org-1";
const COLL = "runbooks";

function run(
  bytes: Uint8Array,
  over: Partial<Parameters<typeof ingestBundle>[0]> = {},
) {
  return ingestBundle({
    workspaceId: WS,
    collectionId: COLL,
    source: "upload",
    bytes,
    ...over,
  });
}

beforeEach(() => {
  TX_INSTALL_STATUS = "published";
  MAX_DOCS = 100;
  MAX_DOC_BYTES = 100_000;
  MAX_BUNDLE_BYTES = 200_000;
  store = new Map();
  publishRan = false;
  txActive = false;
  lastTxVerb = null;
  publishRanInTx = false;
  archiveRanInTx = false;
  archivedPathsParam = null;
  nextId = 1;
  invalidations = [];
});

describe("typed failure outcomes (no writes)", () => {
  it("empty bytes → empty_bundle", async () => {
    const outcome = await run(new Uint8Array(0));
    expect(outcome.kind).toBe("empty_bundle");
    expect(store.size).toBe(0);
  });

  it("over the size cap → bundle_too_large with the observed size", async () => {
    MAX_BUNDLE_BYTES = 10;
    const bytes = zipSync({ "a.md": strToU8("# A longer body") });
    const outcome = await run(bytes);
    expect(outcome).toMatchObject({ kind: "bundle_too_large", bytes: bytes.length, maxBundleBytes: 10 });
  });

  it("unrecognized format → invalid_bundle with the format error message", async () => {
    const outcome = await run(strToU8("just some text, not an archive"));
    expect(outcome.kind).toBe("invalid_bundle");
    if (outcome.kind === "invalid_bundle") expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("doc cap exceeded → too_many_documents", async () => {
    MAX_DOCS = 1;
    const outcome = await run(zipSync({ "a.md": strToU8("# A"), "b.md": strToU8("# B") }));
    expect(outcome).toMatchObject({ kind: "too_many_documents", count: 2, maxDocs: 1 });
  });

  it("every file rejected → no_documents with per-file reasons", async () => {
    const outcome = await run(zipSync({ "../evil.md": strToU8("# bad") }));
    expect(outcome.kind).toBe("no_documents");
    if (outcome.kind === "no_documents") expect(outcome.rejected.length).toBeGreaterThan(0);
  });

  it("failure outcomes never invalidate the mirror", async () => {
    await run(new Uint8Array(0));
    await run(strToU8("garbage"));
    expect(invalidations).toEqual([]);
  });
});

describe("the committed write", () => {
  it("ingests documents at draft and reports counts + format", async () => {
    const outcome = await run(zipSync({ "a.md": strToU8("# A"), "b.md": strToU8("# B") }));
    expect(outcome).toMatchObject({
      kind: "ok",
      format: "zip",
      published: false,
      archivedAbsent: null,
      report: { created: 2, documents: 2 },
    });
    expect(store.get("a.md")?.status).toBe("draft");
    expect(publishRan).toBe(false);
    // Plain ingest touches only the knowledge subtree — never a full-root bust.
    expect(invalidations).toEqual([{ orgId: WS, scope: "knowledge" }]);
  });

  it("archiveAbsent archives inside the SAME transaction, excepting present + rejected paths", async () => {
    const outcome = await run(
      zipSync({ "good.md": strToU8("# Good"), "../evil.md": strToU8("# bad") }),
      { source: "bundle-sync", archiveAbsent: true },
    );
    expect(outcome).toMatchObject({ kind: "ok", archivedAbsent: 1 });
    expect(archiveRanInTx).toBe(true);
    // Present set = parsed docs + per-file rejections (a present-but-broken
    // file must not archive its previously-reviewed document).
    expect(archivedPathsParam).toEqual(["good.md", "../evil.md"]);
  });

  it("publish runs the content-mode phases inside the SAME transaction", async () => {
    const outcome = await run(zipSync({ "a.md": strToU8("# A") }), { publish: true });
    expect(outcome).toMatchObject({ kind: "ok", published: true });
    expect(publishRan).toBe(true);
    expect(publishRanInTx).toBe(true);
    // Publish is workspace-wide (entities/prompts promote too) → full-root bust.
    expect(invalidations).toEqual([{ orgId: WS, scope: "full" }]);
  });

  it("rejects publish for a non-upload source — ADR-0028 §4 as a property of the seam", async () => {
    await expect(
      run(zipSync({ "a.md": strToU8("# A") }), { source: "bundle-sync", publish: true }),
    ).rejects.toThrow(/ADR-0028/);
    expect(publishRan).toBe(false);
    expect(store.size).toBe(0);
  });

  it("aborts with install_gone (ROLLBACK, no writes, no invalidation) when the install vanished mid-ingest", async () => {
    TX_INSTALL_STATUS = "archived";
    const outcome = await run(zipSync({ "a.md": strToU8("# A") }));
    expect(outcome.kind).toBe("install_gone");
    expect(store.size).toBe(0);
    expect(invalidations).toEqual([]);
    expect(lastTxVerb).toBe("ROLLBACK"); // the abort rolled back — never committed
  });

  it("an all-unchanged ingest skips mirror invalidation (no churn, no publish)", async () => {
    const bytes = zipSync({ "a.md": strToU8("# A") });
    const first = await run(bytes);
    expect(first.kind).toBe("ok");
    invalidations = [];
    const second = await run(bytes);
    expect(second).toMatchObject({ kind: "ok", report: { unchanged: 1 } });
    expect(invalidations).toEqual([]);
  });
});
