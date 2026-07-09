/**
 * Route-level tests for `admin-knowledge` (#4207).
 *
 * Exercises the ingest route's guard branches (missing collection, empty /
 * oversized / unrecognized bundle, doc-cap, all-rejected) and the happy-path
 * ingest + uninstall against an in-memory fake internal DB. The full SQL
 * behavior (upsert-by-path, demote, archive) is pinned by the `-pg` test; here
 * `../admin-router` is a passthrough so the assertions are about THIS router.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { zipSync, strToU8 } from "fflate";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
// Type-only import — erased at compile time, so it coexists with the
// mock.module() of the same path below.
import type { KnowledgeSyncOutcome } from "@atlas/api/lib/knowledge/sync";

const CURRENT_ORG = "org-1";

// Mutable per-test caps so cap-branch tests don't need giant fixtures.
let MAX_DOCS = 100;
let MAX_DOC_BYTES = 100_000;
let MAX_BUNDLE_BYTES = 200_000;

// The collection loadCollection() resolves (null → 404).
let COLLECTION: {
  install_id: string;
  catalog_id: string;
  status: string;
  config: Record<string, unknown>;
} | null = {
  install_id: "runbooks",
  catalog_id: "catalog:okf-upload",
  status: "published",
  config: {},
};

// Sync-state rows returned by the list route's knowledge_sync_state read.
let SYNC_STATES: Array<Record<string, unknown>> = [];

// In-memory knowledge store shared by the fake transactional client.
let store: Map<string, { id: string; status: string; body: string }>;
let publishRan = false;
let archivedDocRows = 0;
let nextId = 1;

// Transaction SQL captured per test (uninstall cleanup assertions).
const txSql: string[] = [];

// What the seam's in-transaction install re-check sees. `null` = row gone.
let TX_INSTALL_STATUS: string | null = "published";

function fakeTxClient() {
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      txSql.push(sql);
      if (sql.includes("SELECT id, status, body") && sql.includes("knowledge_documents")) {
        const existing = store.get(params[2] as string);
        return { rows: existing ? [existing] : [] };
      }
      if (sql.includes("INSERT INTO knowledge_documents")) {
        const id = `doc-${nextId++}`;
        store.set(params[2] as string, { id, status: "draft", body: params[9] as string });
        return { rows: [{ id }] };
      }
      if (sql.includes("UPDATE knowledge_documents") && sql.includes("collection_id")) {
        // uninstall archive: RETURNING id for the count
        const rows = Array.from({ length: archivedDocRows }, (_, i) => ({ id: `a-${i}` }));
        return { rows };
      }
      if (sql.includes("UPDATE knowledge_documents")) return { rows: [] };
      if (sql.includes("SELECT status") && sql.includes("FROM workspace_plugins")) {
        // The ingestBundle seam's uninstall × in-flight-ingest re-check
        // (FOR UPDATE) — mutable so the race disposition is testable.
        return { rows: TX_INSTALL_STATUS === null ? [] : [{ status: TX_INSTALL_STATUS }] };
      }
      if (sql.includes("UPDATE workspace_plugins")) return { rows: [] };
      if (sql.includes("DELETE FROM knowledge_links")) return { rows: [] };
      if (sql.includes("INSERT INTO knowledge_links")) return { rows: [] };
      if (sql.includes("DELETE FROM knowledge_sync_credentials")) return { rows: [] };
      if (sql.includes("DELETE FROM knowledge_sync_state")) return { rows: [] };
      throw new Error(`unexpected tx SQL: ${sql.slice(0, 60)}`);
    },
    release() {},
  };
}

// Documents returned by the GET /{slug}/documents SELECT (mutable per test).
let DOCUMENTS: Array<Record<string, unknown>> = [];

const internalQuery = mock(async (sql: string, _params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("SELECT install_id, catalog_id, status, config")) return COLLECTION ? [COLLECTION] : [];
  if (sql.includes("ORDER BY installed_at")) return COLLECTION ? [{ install_id: COLLECTION.install_id, catalog_id: COLLECTION.catalog_id, config: COLLECTION.config, installed_at: "2026-07-02T00:00:00.000Z" }] : [];
  if (sql.includes("GROUP BY collection_id")) return [{ collection_id: "runbooks", status: "published", n: 3 }];
  if (sql.includes("FROM knowledge_sync_state")) return SYNC_STATES;
  if (sql.includes("FROM knowledge_documents") && sql.includes("ORDER BY path")) return DOCUMENTS;
  throw new Error(`unexpected internalQuery SQL: ${sql.slice(0, 60)}`);
});

// Full internal-DB mock via the sanctioned helper (mock-all-exports discipline),
// with `getInternalDB` overridden to hand back the in-memory transactional fake.
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery }),
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
}));

void mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: () => {},
  ADMIN_ACTIONS: {
    knowledge: { ingest: "knowledge.ingest", sync: "knowledge.sync", uninstall: "knowledge.uninstall" },
  },
}));

// The sync engine is pinned in lib/knowledge/__tests__/sync.test.ts — here it
// is a spy so the route tests assert dispatch + gating only. Typed to the REAL
// `KnowledgeSyncOutcome` (type-only import above) so a contract reshape in
// sync.ts is a compile error here, not a green test against a stale shape.
const syncCollection = mock(
  async (params: { collectionSlug: string }): Promise<KnowledgeSyncOutcome> => ({
    collection: params.collectionSlug,
    status: "success",
    syncedAt: "2026-07-02T01:00:00.000Z",
    error: null,
    format: "zip",
    documents: { created: 1, updated: 0, demoted: 0, resurrected: 0, unchanged: 0, total: 1 },
    archivedAbsent: 0,
    linksWritten: 0,
    rejected: [],
  }),
);
void mock.module("@atlas/api/lib/knowledge/sync", () => ({
  syncCollection,
  runKnowledgeSyncCycle: async () => ({ inspected: 0, succeeded: 0, failed: 0, queryFailed: false }),
  getKnowledgeSyncFetchTimeoutMs: () => 60_000,
  DEFAULT_SYNC_FETCH_TIMEOUT_SECONDS: 60,
  SYNC_STATE_UPSERT_SQL: "",
  SYNC_CYCLE_INSTALLS_SQL: "",
}));

// Partial mock, justified: the router lazy-imports EXACTLY ONE symbol from
// `semantic/sync` (`invalidateOrgModeRoots`) and nothing else in this file
// imports the module. Captures calls so the tests can assert the mirror
// invalidation contract (#4208) on the ingest and uninstall paths.
const invalidateCalls: string[] = [];
void mock.module("@atlas/api/lib/semantic/sync", () => ({
  // The ingestBundle/uninstall seams bust only the knowledge subtree; a
  // publish busts the full roots. Both feed the same counter — these tests
  // assert THAT invalidation happened; scope is pinned in
  // ingest-bundle.test.ts / mode-semantic-root.test.ts.
  invalidateOrgKnowledgeSubtree: (orgId: string) => {
    invalidateCalls.push(orgId);
  },
  invalidateOrgModeRoots: (orgId: string) => {
    invalidateCalls.push(orgId);
  },
}));

// Only the catalog-id constant is consumed by the router; mock the handler
// module so its (heavier) install-pipeline import graph stays out of this test.
void mock.module("@atlas/api/lib/integrations/install/bundle-sync-form-handler", () => ({
  BUNDLE_SYNC_SLUG: "bundle-sync",
  BUNDLE_SYNC_CATALOG_ID: "catalog:bundle-sync",
  BUNDLE_SYNC_AUTH_SCHEMES: ["none", "bearer", "basic"],
  BUNDLE_SYNC_INSTALL_UPSERT_SQL: "",
  BundleSyncFormInstallHandler: class {},
  parseBundleSyncConfig: () => ({ ok: true, endpointUrl: "https://kb.example.com/bundle.zip", authScheme: "none" }),
}));

// Notion connector dispatch (#4378). Stub the heavier notion client stack out
// (only the catalog-id constant is consumed), and spy the registry +
// connector engine so the route tests assert dispatch + the fail-closed
// `connector_unavailable` branch only. `NOTION_CONNECTOR` is read live by the
// registry mock so a test can null it to simulate a missing registration.
let NOTION_CONNECTOR: unknown = {
  catalogId: "catalog:notion-knowledge",
  vendor: "notion",
  createClient: () => ({}),
};
void mock.module("@atlas/api/lib/knowledge/notion/connector", () => ({
  NOTION_KNOWLEDGE_CATALOG_ID: "catalog:notion-knowledge",
  NOTION_KNOWLEDGE_SLUG: "notion-knowledge",
  NOTION_VENDOR: "notion",
  notionKnowledgeConnector: NOTION_CONNECTOR,
  registerNotionKnowledgeConnector: () => {},
}));
const getKnowledgeSyncConnector = mock((_id: string) => NOTION_CONNECTOR);
class ConnectorRateLimitError extends Error {}
void mock.module("@atlas/api/lib/knowledge/connectors", () => ({
  getKnowledgeSyncConnector,
  registerKnowledgeSyncConnector: () => {},
  listKnowledgeSyncConnectorCatalogIds: () => ["catalog:notion-knowledge"],
  _resetKnowledgeSyncConnectors: () => {},
  ConnectorRateLimitError,
  toIsoInstant: (value: unknown) => (typeof value === "string" ? value : null),
}));
const syncConnectorCollection = mock(async (params: { collectionSlug: string }) => ({
  collection: params.collectionSlug,
  status: "success" as const,
  mode: "reconciliation" as const,
  syncedAt: "2026-07-02T02:00:00.000Z",
  error: null,
  documents: { created: 3, updated: 0, demoted: 0, resurrected: 0, unchanged: 0, total: 3 },
  archivedAbsent: 1,
  rejected: [],
  highWaterMark: "2026-07-01T00:00:00.000Z",
}));
// Partial mock, justified: the router reaches exactly one symbol from
// connector-sync (`syncConnectorCollection`); the isolated per-file runner
// prevents cross-file leaks, and any other export reached later would fail
// loudly as `undefined is not a function`.
void mock.module("@atlas/api/lib/knowledge/connector-sync", () => ({
  syncConnectorCollection,
}));

// Partial mock, justified: this file's import graph reaches only the exports
// stubbed below; the isolated per-file runner prevents cross-file leaks, and an
// unmocked export reached later fails loudly as `undefined is not a function`.
void mock.module("@atlas/api/lib/content-mode", () => ({
  CONTENT_MODE_TABLES: [],
  makeService: () => ({
    runPublishPhases: () =>
      Effect.sync(() => {
        publishRan = true;
        return [];
      }),
  }),
}));

// Full mock of every ingest-limits export (mock-all-exports): `mirror.ts` —
// reachable through this file's import graph — consumes `positiveIntSetting`,
// so a getters-only partial mock would break at a distance on the next
// import-graph change. Shape mirrors connector-sync.test.ts.
void mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
  DEFAULT_INGEST_MAX_DOCS: 1000,
  DEFAULT_INGEST_MAX_DOC_BYTES: 1_000_000,
  DEFAULT_INGEST_MAX_BUNDLE_BYTES: 25_000_000,
  getIngestMaxDocs: () => MAX_DOCS,
  getIngestMaxDocBytes: () => MAX_DOC_BYTES,
  getIngestMaxBundleBytes: () => MAX_BUNDLE_BYTES,
  positiveIntSetting: (_key: string, raw: string | undefined, fallback: number) => {
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  },
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  requireOrgContext: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
    await next();
  },
}));

const { adminKnowledge } = await import("../admin-knowledge");

function ingest(path: string, body: Uint8Array) {
  return adminKnowledge.request(path, {
    method: "POST",
    body,
    headers: { "content-type": "application/octet-stream" },
  });
}

beforeEach(() => {
  TX_INSTALL_STATUS = "published";
  MAX_DOCS = 100;
  MAX_DOC_BYTES = 100_000;
  MAX_BUNDLE_BYTES = 200_000;
  COLLECTION = { install_id: "runbooks", catalog_id: "catalog:okf-upload", status: "published", config: {} };
  store = new Map();
  publishRan = false;
  archivedDocRows = 0;
  nextId = 1;
  DOCUMENTS = [];
  SYNC_STATES = [];
  txSql.length = 0;
  invalidateCalls.length = 0;
  internalQuery.mockClear();
  syncCollection.mockClear();
  syncConnectorCollection.mockClear();
  getKnowledgeSyncConnector.mockClear();
  NOTION_CONNECTOR = { catalogId: "catalog:notion-knowledge", vendor: "notion", createClient: () => ({}) };
});
afterEach(() => internalQuery.mockClear());

/** Switch the resolved collection to a Notion connector install (#4378). */
function useNotionCollection(): void {
  COLLECTION = {
    install_id: "runbooks",
    catalog_id: "catalog:notion-knowledge",
    status: "published",
    config: {},
  };
}

/** Switch the resolved collection to a bundle-sync install (#4211). */
function useSyncedCollection(): void {
  COLLECTION = {
    install_id: "runbooks",
    catalog_id: "catalog:bundle-sync",
    status: "published",
    config: { endpoint_url: "https://kb.example.com/bundle.zip", auth_scheme: "none" },
  };
}

describe("POST /{collectionSlug}/ingest — guards", () => {
  it("404s when the collection does not exist", async () => {
    COLLECTION = null;
    const res = await ingest("/nope/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(404);
  });

  it("404s when the collection is archived", async () => {
    COLLECTION = { install_id: "runbooks", catalog_id: "catalog:okf-upload", status: "archived", config: {} };
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(404);
  });

  it("400s on an empty bundle", async () => {
    const res = await ingest("/runbooks/ingest", new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_bundle");
  });

  it("400s via the STREAMING cap when an over-cap body arrives with no Content-Length", async () => {
    // Requests constructed by the test client carry no Content-Length header,
    // so this flows past the advisory pre-check into `readBodyWithCap` — the
    // "upload aborted" wording uniquely identifies the streaming branch, so
    // this test fails loudly if the runtime ever starts stamping the header
    // and the streaming branch silently loses its route-level exercise.
    MAX_BUNDLE_BYTES = 10;
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A longer body") }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bundle_too_large");
    expect(body.message).toContain("upload aborted");
  });

  it("400s on the advisory Content-Length pre-check before reading any body byte", async () => {
    MAX_BUNDLE_BYTES = 10;
    const res = await adminKnowledge.request("/runbooks/ingest", {
      method: "POST",
      body: zipSync({ "a.md": strToU8("# A") }),
      headers: { "content-type": "application/octet-stream", "content-length": "99999" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bundle_too_large");
    // The pre-check message names the declared byte count — distinct from the
    // streaming branch's "upload aborted".
    expect(body.message).toContain("99999 bytes");
  });

  it("400s on an unrecognized format", async () => {
    const res = await ingest("/runbooks/ingest", strToU8("just some text, not an archive"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_bundle");
  });

  it("400s when the doc count exceeds the cap", async () => {
    MAX_DOCS = 1;
    const res = await ingest(
      "/runbooks/ingest",
      zipSync({ "a.md": strToU8("# A"), "b.md": strToU8("# B") }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("too_many_documents");
  });

  it("404s (not a bundle error) when the collection was uninstalled mid-upload — the seam's race guard", async () => {
    // The pre-check sees a live collection; the uninstall lands while the
    // body streams/parses, and the seam's in-transaction FOR UPDATE re-check
    // aborts before any write.
    TX_INSTALL_STATUS = "archived";
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
    expect(store.size).toBe(0);
  });

  it("400s with per-file reasons when every file is rejected", async () => {
    const res = await ingest("/runbooks/ingest", zipSync({ "../evil.md": strToU8("# bad") }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; rejected: { path: string }[] };
    expect(body.error).toBe("no_documents");
    expect(body.rejected.length).toBeGreaterThan(0);
  });
});

describe("POST /{collectionSlug}/ingest — happy path", () => {
  it("ingests documents at draft and reports counts + rejects + skipped assets", async () => {
    const res = await ingest(
      "/runbooks/ingest",
      zipSync({
        "a.md": strToU8("# A"),
        "b.md": strToU8("# B"),
        "index.md": strToU8("# nav"),
        "logo.png": strToU8("not markdown"),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: { created: number; total: number };
      published: boolean;
      skippedNonMarkdown: number;
    };
    expect(body.documents.created).toBe(2); // index.md is reserved → skipped
    expect(body.published).toBe(false);
    // The asset drop is counted, not silent.
    expect(body.skippedNonMarkdown).toBe(1);
    expect(publishRan).toBe(false);
    expect(store.get("a.md")?.status).toBe("draft");
  });

  it("ingests the good docs AND surfaces per-file rejections in a 200 (never silently skipped)", async () => {
    // One good doc + one traversal entry → 200, created:1, rejected:1 (AC #2).
    const res = await ingest(
      "/runbooks/ingest",
      zipSync({ "good.md": strToU8("# Good"), "../evil.md": strToU8("# bad") }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: { created: number };
      rejected: { path: string; reason: string }[];
    };
    expect(body.documents.created).toBe(1);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].reason).toContain("unsafe path");
  });

  it("runs the atomic publish when ?publish=true (upload & publish)", async () => {
    const res = await ingest("/runbooks/ingest?publish=true", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { published: boolean }).published).toBe(true);
    expect(publishRan).toBe(true);
  });

  it("400s an upload into a bundle-sync collection — synced trees are endpoint-owned (#4211)", async () => {
    useSyncedCollection();
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("synced_collection");
    // Definitely no publish backdoor through the guard.
    expect(publishRan).toBe(false);
  });
});

describe("POST /{collectionSlug}/sync — manual Sync now (#4211)", () => {
  it("runs the sync for a bundle-sync collection and returns the outcome", async () => {
    useSyncedCollection();
    const res = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collection: string; status: string; documents: { created: number } };
    expect(body.collection).toBe("runbooks");
    expect(body.status).toBe("success");
    expect(body.documents.created).toBe(1);
    expect(syncCollection).toHaveBeenCalledTimes(1);
    expect(syncCollection.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: CURRENT_ORG,
      collectionSlug: "runbooks",
      config: { endpoint_url: "https://kb.example.com/bundle.zip" },
    });
  });

  it("returns a failed attempt as 200 with status error (recorded, actionable)", async () => {
    useSyncedCollection();
    syncCollection.mockImplementationOnce(async (params: { collectionSlug: string }) => ({
      collection: params.collectionSlug,
      status: "error" as const,
      syncedAt: "2026-07-02T01:00:00.000Z",
      error: 'Bundle endpoint "kb.example.com" responded HTTP 403 — check the URL and auth configuration.',
      format: null,
      documents: null,
      archivedAbsent: null,
      linksWritten: null,
      rejected: [],
    }));
    const res = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toContain("403");
  });

  it("400s for an upload collection (nothing to sync)", async () => {
    const res = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_synced_collection");
    expect(syncCollection).not.toHaveBeenCalled();
  });

  it("404s when the collection does not exist", async () => {
    COLLECTION = null;
    const res = await adminKnowledge.request("/nope/sync", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("404s when the collection is archived — 'Sync now' must never touch an uninstalled tree", async () => {
    COLLECTION = {
      install_id: "runbooks",
      catalog_id: "catalog:bundle-sync",
      status: "archived",
      config: { endpoint_url: "https://kb.example.com/bundle.zip", auth_scheme: "none" },
    };
    const res = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(res.status).toBe(404);
    expect(syncCollection).not.toHaveBeenCalled();
  });
});

describe("POST /{collectionSlug}/sync — connector collections (#4378)", () => {
  it("dispatches a Notion collection to the connector engine, not the bundle engine", async () => {
    useNotionCollection();
    const res = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(syncConnectorCollection).toHaveBeenCalledTimes(1);
    expect(syncCollection).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      collection: string;
      status: string;
      format: string | null;
      linksWritten: number | null;
      archivedAbsent: number | null;
      documents: { total: number };
    };
    // The connector outcome maps to the shared wire shape — no bundle `format`
    // or `linksWritten`, but the ingest counts + archivedAbsent carry through.
    expect(body).toMatchObject({
      collection: "runbooks",
      status: "success",
      format: null,
      linksWritten: null,
      archivedAbsent: 1,
    });
    expect(body.documents.total).toBe(3);
  });

  it("500s connector_unavailable when the catalog has no registered connector", async () => {
    useNotionCollection();
    NOTION_CONNECTOR = undefined; // getKnowledgeSyncConnector → undefined
    const res = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("connector_unavailable");
    expect(body.requestId).toBeDefined();
    expect(syncConnectorCollection).not.toHaveBeenCalled();
  });

  it("lists a Notion collection as source 'notion' with sync bookkeeping", async () => {
    useNotionCollection();
    SYNC_STATES = [
      { collection_id: "runbooks", last_sync_at: "2026-07-02T02:00:00.000Z", status: "success", error: null },
    ];
    const res = await adminKnowledge.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collections: Array<{ slug: string; source: string; endpointUrl: string | null; sync: unknown }>;
    };
    const notion = body.collections.find((c) => c.slug === "runbooks");
    expect(notion?.source).toBe("notion");
    expect(notion?.endpointUrl).toBeNull(); // connector has a token, not an endpoint
    expect(notion?.sync).not.toBeNull();
  });

  // Confluence rides the SAME generic connector dispatch as Notion; these two
  // cases just pin that its distinct catalog id classifies as source 'confluence'.
  it("dispatches a Confluence collection to the connector engine and lists it as source 'confluence' (#4377)", async () => {
    COLLECTION = {
      install_id: "runbooks",
      catalog_id: "catalog:confluence",
      status: "published",
      config: { base_url: "https://acme.atlassian.net/wiki", email: "b@a.com", space_key: "ENG" },
    };
    SYNC_STATES = [
      { collection_id: "runbooks", last_sync_at: "2026-07-02T02:00:00.000Z", status: "success", error: null },
    ];
    const syncRes = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(syncRes.status).toBe(200);
    expect(syncConnectorCollection).toHaveBeenCalledTimes(1);
    expect(syncCollection).not.toHaveBeenCalled();

    const listRes = await adminKnowledge.request("/", { method: "GET" });
    const body = (await listRes.json()) as {
      collections: Array<{ slug: string; source: string; endpointUrl: string | null; sync: unknown }>;
    };
    const conf = body.collections.find((c) => c.slug === "runbooks");
    expect(conf?.source).toBe("confluence");
    expect(conf?.endpointUrl).toBeNull();
    expect(conf?.sync).not.toBeNull();
  });

  it("dispatches a Confluence Data Center collection to the connector engine and lists it as source 'confluence-datacenter' (#4394)", async () => {
    COLLECTION = {
      install_id: "runbooks",
      catalog_id: "catalog:confluence-datacenter",
      status: "published",
      config: { base_url: "https://confluence.acme.com", space_key: "ENG" },
    };
    SYNC_STATES = [
      { collection_id: "runbooks", last_sync_at: "2026-07-02T02:00:00.000Z", status: "success", error: null },
    ];
    const syncRes = await adminKnowledge.request("/runbooks/sync", { method: "POST" });
    expect(syncRes.status).toBe(200);
    expect(syncConnectorCollection).toHaveBeenCalledTimes(1);
    expect(syncCollection).not.toHaveBeenCalled();

    const listRes = await adminKnowledge.request("/", { method: "GET" });
    const body = (await listRes.json()) as {
      collections: Array<{ slug: string; source: string; endpointUrl: string | null; sync: unknown }>;
    };
    const conf = body.collections.find((c) => c.slug === "runbooks");
    // A future edit dropping this from isSyncedSource would silently strip the
    // collection's sync bookkeeping / "Sync now" — the wire enum wouldn't catch it.
    expect(conf?.source).toBe("confluence-datacenter");
    expect(conf?.endpointUrl).toBeNull();
    expect(conf?.sync).not.toBeNull();
  });
});

describe("knowledge mirror invalidation (#4208)", () => {
  it("busts the org's mode roots after a successful ingest", async () => {
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(200);
    expect(invalidateCalls).toEqual([CURRENT_ORG]);
  });

  it("does not bust the mirror when the ingest is rejected", async () => {
    const res = await ingest("/runbooks/ingest", new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(invalidateCalls).toHaveLength(0);
  });

  it("busts the org's mode roots after an uninstall", async () => {
    const res = await adminKnowledge.request("/runbooks", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(invalidateCalls).toEqual([CURRENT_ORG]);
  });
});

describe("DELETE /{collectionSlug} — uninstall archives", () => {
  it("archives the collection's documents and reports the count", async () => {
    archivedDocRows = 4;
    const res = await adminKnowledge.request("/runbooks", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: boolean; collection: string; archivedDocuments: number };
    expect(body).toEqual({ archived: true, collection: "runbooks", archivedDocuments: 4 });
  });

  it("404s when the collection does not exist", async () => {
    COLLECTION = null;
    const res = await adminKnowledge.request("/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("hard-deletes the sync credential + state when uninstalling a synced collection (#4211)", async () => {
    useSyncedCollection();
    const res = await adminKnowledge.request("/runbooks", { method: "DELETE" });
    expect(res.status).toBe(200);
    // Secrets never outlive their install — both cleanup DELETEs must run in
    // the uninstall transaction (removing them silently would strand a secret).
    expect(txSql.some((q) => q.includes("DELETE FROM knowledge_sync_credentials"))).toBe(true);
    expect(txSql.some((q) => q.includes("DELETE FROM knowledge_sync_state"))).toBe(true);
  });
});

describe("GET / — list collections", () => {
  it("lists upload collections with per-status counts and no sync surface", async () => {
    const res = await adminKnowledge.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collections: { slug: string; source: string; endpointUrl: string | null; sync: unknown; documents: { published: number } }[];
    };
    expect(body.collections[0]).toMatchObject({
      slug: "runbooks",
      source: "upload",
      endpointUrl: null,
      sync: null,
      documents: { published: 3 },
    });
  });

  it("surfaces source, endpoint, and last-sync status for bundle-sync collections (#4211)", async () => {
    useSyncedCollection();
    SYNC_STATES = [
      {
        collection_id: "runbooks",
        last_sync_at: "2026-07-02T01:00:00.000Z",
        status: "error",
        error: "Bundle endpoint responded HTTP 403",
      },
    ];
    const res = await adminKnowledge.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections: Array<Record<string, unknown>> };
    expect(body.collections[0]).toMatchObject({
      slug: "runbooks",
      source: "bundle-sync",
      endpointUrl: "https://kb.example.com/bundle.zip",
      sync: {
        lastSyncAt: "2026-07-02T01:00:00.000Z",
        status: "error",
        error: "Bundle endpoint responded HTTP 403",
      },
    });
  });

  it("returns sync: null for a synced collection that has never synced", async () => {
    useSyncedCollection();
    const res = await adminKnowledge.request("/");
    const body = (await res.json()) as { collections: Array<{ sync: unknown; source: string }> };
    expect(body.collections[0]).toMatchObject({ source: "bundle-sync", sync: null });
  });
});

describe("GET /{slug}/documents — list documents", () => {
  it("lists a collection's documents with status, coercing tags + timestamps", async () => {
    DOCUMENTS = [
      {
        id: "d1",
        path: "index.md",
        title: "Home",
        description: null,
        type: "guide",
        tags: ["a", 5, "b"], // non-string members dropped
        status: "published",
        updated_at: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "d2",
        path: "runbook.md",
        title: null,
        description: "How to",
        type: null,
        tags: null, // malformed → []
        status: "draft",
        updated_at: null,
      },
    ];
    const res = await adminKnowledge.request("/runbooks/documents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection: string;
      documents: Array<{ id: string; path: string; tags: string[]; status: string }>;
    };
    expect(body.collection).toBe("runbooks");
    expect(body.documents).toHaveLength(2);
    expect(body.documents[0]).toMatchObject({ id: "d1", path: "index.md", status: "published", tags: ["a", "b"] });
    expect(body.documents[1]).toMatchObject({ id: "d2", status: "draft", tags: [] });
  });

  it("404s when the collection does not exist", async () => {
    COLLECTION = null;
    const res = await adminKnowledge.request("/nope/documents");
    expect(res.status).toBe(404);
  });

  it("404s when the collection is archived", async () => {
    COLLECTION = { install_id: "runbooks", catalog_id: "catalog:okf-upload", status: "archived", config: {} };
    const res = await adminKnowledge.request("/runbooks/documents");
    expect(res.status).toBe(404);
  });
});
