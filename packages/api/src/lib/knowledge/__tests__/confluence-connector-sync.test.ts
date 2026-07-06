/**
 * REAL Confluence connector through the REAL engine (`syncConnectorCollection`)
 * — the vendor↔spine integration the fixture-connector suite
 * (`connector-sync.test.ts`) and the direct vendor-client suite
 * (`confluence/__tests__/client.test.ts`) each leave unpinned. Only the edges
 * are doubled: the vendor HTTP (injected `fetchImpl`), the internal DB
 * (in-memory store + sync-state table), and the credential read.
 *
 * Pins the cross-module seams:
 *   - PATH STABILITY across modes — the hierarchy path an incremental cycle
 *     derives is byte-identical to reconciliation's (a mode-dependent path
 *     would make the next reconciliation archive the doc the incremental just
 *     drafted);
 *   - the vendor's high-water mark flows through `validVendorTimestamp` into
 *     sync-state, and the engine's `since` (mark − overlap) flows back into
 *     the vendor's modified-at filter;
 *   - a reconciliation after a vendor-side delete archives exactly the absent
 *     path (`archivedAbsent: 1`).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const ORG = "org-1";
const COLLECTION = "confluence-eng";
const BASE = "https://acme.atlassian.net/wiki";
const SPACE_ID = "100";

mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
  DEFAULT_INGEST_MAX_DOCS: 1000,
  DEFAULT_INGEST_MAX_DOC_BYTES: 1_000_000,
  DEFAULT_INGEST_MAX_BUNDLE_BYTES: 25_000_000,
  getIngestMaxDocs: () => 100,
  getIngestMaxDocBytes: () => 100_000,
  getIngestMaxBundleBytes: () => 200_000,
  positiveIntSetting: (_key: string, raw: string | undefined, fallback: number) => {
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  },
}));

// The connector factory reads the encrypted token — doubled at the seam
// (mock-all-exports; the SQL constant is re-exported verbatim for any reader).
mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "-- doubled in this suite",
  saveSyncCredential: async () => {},
  readSyncCredential: async () => "secret-token",
  deleteSyncCredential: async () => {},
}));

// ── In-memory knowledge store + fake transactional client (the
//    connector-sync.test.ts double, trimmed to what this suite exercises) ────
interface StoredDoc {
  id: string;
  status: string;
  body: string;
  type: string | null;
  title: string | null;
  description: string | null;
  resource: string | null;
  tags: unknown;
  timestamp: string | null;
}
let store: Map<string, StoredDoc>;
let nextId = 1;

function fakeTxClient() {
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM workspace_plugins")) return { rows: [{ status: "published" }] };
      if (sql.includes("SELECT id, status, body")) {
        const existing = store.get(params[2] as string);
        return { rows: existing ? [existing as unknown as Record<string, unknown>] : [] };
      }
      if (sql.includes("INSERT INTO knowledge_documents")) {
        const id = `doc-${nextId++}`;
        store.set(params[2] as string, {
          id,
          status: "draft",
          body: params[9] as string,
          type: params[3] as string,
          title: params[4] as string,
          description: params[5] as string | null,
          resource: params[8] as string | null,
          tags: JSON.parse(params[6] as string),
          timestamp: params[7] as string | null,
        });
        return { rows: [{ id }] };
      }
      if (sql.includes("SET status = 'archived'")) {
        const present = new Set(params[2] as string[]);
        const archived: Record<string, unknown>[] = [];
        for (const [path, doc] of store) {
          if (doc.status !== "archived" && !present.has(path)) {
            doc.status = "archived";
            archived.push({ id: doc.id });
          }
        }
        return { rows: archived };
      }
      if (sql.includes("UPDATE knowledge_documents")) {
        for (const doc of store.values()) {
          if (doc.id === params[0]) {
            doc.status = "draft";
            doc.body = params[7] as string;
          }
        }
        return { rows: [] };
      }
      if (sql.includes("knowledge_links")) return { rows: [] };
      throw new Error(`unexpected tx SQL: ${sql.slice(0, 60)}`);
    },
    release() {},
  };
}

// ── In-memory sync-state table (COALESCE-forward upsert semantics) ──────────
interface StateRow {
  status: string;
  error: string | null;
  report: unknown;
  high_water_mark: string | null;
  sync_cursor: string | null;
  last_reconciled_at: string | null;
}
let syncState: Map<string, StateRow>;
const stateKey = (ws: string, coll: string) => `${ws}\0${coll}`;

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("INSERT INTO knowledge_sync_state")) {
    const key = stateKey(params[0] as string, params[1] as string);
    const prev = syncState.get(key);
    syncState.set(key, {
      status: params[2] as string,
      error: params[3] as string | null,
      report: params[4] === null ? null : JSON.parse(params[4] as string),
      high_water_mark: (params[5] as string | null) ?? prev?.high_water_mark ?? null,
      sync_cursor: (params[6] as string | null) ?? prev?.sync_cursor ?? null,
      last_reconciled_at: (params[7] as string | null) ?? prev?.last_reconciled_at ?? null,
    });
    return [];
  }
  if (sql.includes("SELECT high_water_mark")) {
    const row = syncState.get(stateKey(params[0] as string, params[1] as string));
    return row
      ? [
          {
            high_water_mark: row.high_water_mark,
            sync_cursor: row.sync_cursor,
            last_reconciled_at: row.last_reconciled_at,
          },
        ]
      : [];
  }
  throw new Error(`unexpected internalQuery SQL: ${sql.slice(0, 60)}`);
});

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery }),
  hasInternalDB: () => true,
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

mock.module("@atlas/api/lib/knowledge/mirror-invalidation", () => ({
  invalidateKnowledgeMirror: async () => {},
}));

const { syncConnectorCollection } = await import("@atlas/api/lib/knowledge/connector-sync");
const { createConfluenceConnector } = await import(
  "@atlas/api/lib/knowledge/confluence/connector"
);

// ── The Confluence fixture space (mutable between runs) ─────────────────────

interface FixturePage {
  id: string;
  title: string;
  parentId: string | null;
  modifiedAt: string;
  body: string;
}

let spacePages: FixturePage[];
let vendorCalls: string[];

function pageObject(p: FixturePage, withBody: boolean): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    parentId: p.parentId,
    version: { createdAt: p.modifiedAt, number: 1 },
    _links: { webui: `/spaces/ENG/pages/${p.id}`, base: BASE },
    ...(withBody ? { body: { storage: { value: p.body } } } : {}),
  };
}

const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
  const raw = typeof input === "string" ? input : input.toString();
  vendorCalls.push(raw);
  const url = new URL(raw);
  const json = (obj: unknown) =>
    new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

  if (url.pathname.endsWith("/api/v2/spaces")) {
    return json({ results: [{ id: SPACE_ID, key: "ENG" }] });
  }
  const single = url.pathname.match(/\/api\/v2\/pages\/([^/]+)$/);
  if (single) {
    const p = spacePages.find((x) => x.id === single[1]);
    if (!p) return new Response("{}", { status: 404 });
    return json(pageObject(p, true));
  }
  if (url.pathname.endsWith("/pages")) {
    const withBody = url.searchParams.get("body-format") === "storage";
    return json({ results: spacePages.map((p) => pageObject(p, withBody)), _links: { base: BASE } });
  }
  throw new Error(`fixture: unexpected URL ${raw}`);
}) as unknown as typeof globalThis.fetch;

const connector = createConfluenceConnector({ clientDeps: { fetchImpl } });

const NOW = new Date("2026-07-06T12:00:00.000Z");

function runSync() {
  return syncConnectorCollection({
    connector,
    workspaceId: ORG,
    collectionSlug: COLLECTION,
    config: { base_url: BASE, email: "bot@acme.com", space_key: "ENG" },
    now: () => NOW,
  });
}

const state = () => syncState.get(stateKey(ORG, COLLECTION));

const ROOT_PATH = "confluence-eng/engineering.md";
const CHILD_PATH = "confluence-eng/engineering/oncall.md";

beforeEach(() => {
  store = new Map();
  syncState = new Map();
  nextId = 1;
  vendorCalls = [];
  spacePages = [
    { id: "1", title: "Engineering", parentId: null, modifiedAt: "2026-07-01T00:00:00.000Z", body: "<p>Root prose here, enough to ingest.</p>" },
    { id: "2", title: "Oncall", parentId: "1", modifiedAt: "2026-07-02T00:00:00.000Z", body: "<p>Oncall prose here, first version.</p>" },
  ];
});

describe("real Confluence connector through the real engine", () => {
  it("reconcile-seed → incremental-with-change → reconcile-with-delete keeps paths stable and archives exactly the absent doc", async () => {
    // ── 1. First sync: no state → reconciliation crawl seeds the tree ───────
    const first = await runSync();
    expect(first).toMatchObject({
      status: "success",
      mode: "reconciliation",
      documents: { created: 2, total: 2 },
      archivedAbsent: 0,
      coverageIncomplete: false,
      // The vendor's newest version.createdAt survived validVendorTimestamp.
      highWaterMark: "2026-07-02T00:00:00.000Z",
    });
    expect([...store.keys()].toSorted()).toEqual([ROOT_PATH, CHILD_PATH]);
    expect(store.get(CHILD_PATH)?.status).toBe("draft");
    expect(state()).toMatchObject({
      status: "success",
      high_water_mark: "2026-07-02T00:00:00.000Z",
      last_reconciled_at: NOW.toISOString(),
    });

    // ── 2. Second sync: mark + fresh reconcile clock → incremental ──────────
    spacePages[1] = {
      ...spacePages[1],
      modifiedAt: "2026-07-06T09:00:00.000Z",
      body: "<p>Oncall prose here, second version.</p>",
    };
    vendorCalls = [];
    const second = await runSync();
    expect(second).toMatchObject({
      status: "success",
      mode: "incremental",
      documents: { updated: 1, total: 1 },
      archivedAbsent: null,
      highWaterMark: "2026-07-06T09:00:00.000Z",
    });
    // PATH STABILITY across modes: the incremental upsert hit the exact path
    // reconciliation derived — no new key, the body changed in place. (A
    // mode-dependent path would leave this store with three keys and the next
    // reconciliation would archive the incremental's draft.)
    expect([...store.keys()].toSorted()).toEqual([ROOT_PATH, CHILD_PATH]);
    expect(store.get(CHILD_PATH)?.body).toContain("second version");
    // The engine's `since` (mark − overlap) reached the vendor filter: only
    // the changed page's body was fetched, not the unchanged root's.
    expect(vendorCalls.filter((c) => /\/api\/v2\/pages\/2(\?|$)/.test(c))).toHaveLength(1);
    expect(vendorCalls.some((c) => /\/api\/v2\/pages\/1(\?|$)/.test(c))).toBe(false);
    expect(state()?.high_water_mark).toBe("2026-07-06T09:00:00.000Z");

    // ── 3. Third sync: vendor-side delete + due clock → reconciliation ──────
    spacePages = [spacePages[0]];
    const row = state();
    if (!row) throw new Error("sync state row missing after two syncs");
    row.last_reconciled_at = "2026-06-01T00:00:00.000Z"; // cadence due again
    const third = await runSync();
    expect(third).toMatchObject({
      status: "success",
      mode: "reconciliation",
      archivedAbsent: 1,
    });
    expect(store.get(CHILD_PATH)?.status).toBe("archived");
    expect(store.get(ROOT_PATH)?.status).toBe("draft");
    expect(state()?.last_reconciled_at).toBe(NOW.toISOString());
  });

  it("a malformed vendor page flags the crawl coverage-incomplete end-to-end: upserts land, nothing archives, the clock holds", async () => {
    // Seed two docs with a clean crawl, then break one page at the vendor
    // (drops `version`): the Confluence client warn-skips it and flags
    // coverage, and the ENGINE must respond by deferring deletions.
    await runSync();
    expect(store.size).toBe(2);

    spacePages[1] = { ...spacePages[1], modifiedAt: "" }; // normalizePage skips it
    const row = state();
    if (!row) throw new Error("sync state row missing after seed sync");
    row.last_reconciled_at = "2026-06-01T00:00:00.000Z"; // cadence due again
    const outcome = await runSync();
    expect(outcome).toMatchObject({
      status: "success",
      mode: "reconciliation",
      coverageIncomplete: true,
      archivedAbsent: null,
    });
    // The skipped page's document survived the partial crawl...
    expect(store.get(CHILD_PATH)?.status).toBe("draft");
    // ...and the reconcile clock held, so the next cycle re-crawls.
    expect(state()?.last_reconciled_at).toBe("2026-06-01T00:00:00.000Z");
    expect(state()?.report).toMatchObject({ coverageIncomplete: true });
  });
});
