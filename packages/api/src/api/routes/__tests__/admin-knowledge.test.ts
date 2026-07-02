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

const CURRENT_ORG = "org-1";

// Mutable per-test caps so cap-branch tests don't need giant fixtures.
let MAX_DOCS = 100;
let MAX_DOC_BYTES = 100_000;
let MAX_BUNDLE_BYTES = 200_000;

// The collection loadCollection() resolves (null → 404).
let COLLECTION: { install_id: string; status: string; config: Record<string, unknown> } | null = {
  install_id: "runbooks",
  status: "published",
  config: {},
};

// In-memory knowledge store shared by the fake transactional client.
let store: Map<string, { id: string; status: string; body: string }>;
let publishRan = false;
let archivedDocRows = 0;
let nextId = 1;

function fakeTxClient() {
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
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
      if (sql.includes("UPDATE workspace_plugins")) return { rows: [] };
      if (sql.includes("DELETE FROM knowledge_links")) return { rows: [] };
      if (sql.includes("INSERT INTO knowledge_links")) return { rows: [] };
      throw new Error(`unexpected tx SQL: ${sql.slice(0, 60)}`);
    },
    release() {},
  };
}

// Documents returned by the GET /{slug}/documents SELECT (mutable per test).
let DOCUMENTS: Array<Record<string, unknown>> = [];

const internalQuery = mock(async (sql: string, _params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("SELECT install_id, status, config")) return COLLECTION ? [COLLECTION] : [];
  if (sql.includes("ORDER BY installed_at")) return COLLECTION ? [{ install_id: COLLECTION.install_id, config: COLLECTION.config, installed_at: "2026-07-02T00:00:00.000Z" }] : [];
  if (sql.includes("GROUP BY collection_id")) return [{ collection_id: "runbooks", status: "published", n: 3 }];
  if (sql.includes("FROM knowledge_documents") && sql.includes("ORDER BY path")) return DOCUMENTS;
  throw new Error(`unexpected internalQuery SQL: ${sql.slice(0, 60)}`);
});

// Full internal-DB mock via the sanctioned helper (mock-all-exports discipline),
// with `getInternalDB` overridden to hand back the in-memory transactional fake.
mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery }),
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: () => {},
  ADMIN_ACTIONS: { knowledge: { ingest: "knowledge.ingest", uninstall: "knowledge.uninstall" } },
}));

mock.module("@atlas/api/lib/content-mode", () => ({
  CONTENT_MODE_TABLES: [],
  makeService: () => ({
    runPublishPhases: () =>
      Effect.sync(() => {
        publishRan = true;
        return [];
      }),
  }),
}));

mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
  getIngestMaxDocs: () => MAX_DOCS,
  getIngestMaxDocBytes: () => MAX_DOC_BYTES,
  getIngestMaxBundleBytes: () => MAX_BUNDLE_BYTES,
}));

mock.module("../admin-router", () => ({
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
  MAX_DOCS = 100;
  MAX_DOC_BYTES = 100_000;
  MAX_BUNDLE_BYTES = 200_000;
  COLLECTION = { install_id: "runbooks", status: "published", config: {} };
  store = new Map();
  publishRan = false;
  archivedDocRows = 0;
  nextId = 1;
  DOCUMENTS = [];
  internalQuery.mockClear();
});
afterEach(() => internalQuery.mockClear());

describe("POST /{collectionSlug}/ingest — guards", () => {
  it("404s when the collection does not exist", async () => {
    COLLECTION = null;
    const res = await ingest("/nope/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(404);
  });

  it("404s when the collection is archived", async () => {
    COLLECTION = { install_id: "runbooks", status: "archived", config: {} };
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A") }));
    expect(res.status).toBe(404);
  });

  it("400s on an empty bundle", async () => {
    const res = await ingest("/runbooks/ingest", new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_bundle");
  });

  it("400s when the raw bundle exceeds the size cap", async () => {
    MAX_BUNDLE_BYTES = 10;
    const res = await ingest("/runbooks/ingest", zipSync({ "a.md": strToU8("# A longer body") }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bundle_too_large");
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

  it("400s with per-file reasons when every file is rejected", async () => {
    const res = await ingest("/runbooks/ingest", zipSync({ "../evil.md": strToU8("# bad") }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; rejected: { path: string }[] };
    expect(body.error).toBe("no_documents");
    expect(body.rejected.length).toBeGreaterThan(0);
  });
});

describe("POST /{collectionSlug}/ingest — happy path", () => {
  it("ingests documents at draft and reports counts + rejects", async () => {
    const res = await ingest(
      "/runbooks/ingest",
      zipSync({ "a.md": strToU8("# A"), "b.md": strToU8("# B"), "index.md": strToU8("# nav") }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: { created: number; total: number }; published: boolean };
    expect(body.documents.created).toBe(2); // index.md is reserved → skipped
    expect(body.published).toBe(false);
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
});

describe("GET / — list collections", () => {
  it("lists collections with per-status document counts", async () => {
    const res = await adminKnowledge.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections: { slug: string; documents: { published: number } }[] };
    expect(body.collections[0]).toMatchObject({ slug: "runbooks", documents: { published: 3 } });
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
    COLLECTION = { install_id: "runbooks", status: "archived", config: {} };
    const res = await adminKnowledge.request("/runbooks/documents");
    expect(res.status).toBe(404);
  });
});
