/**
 * Knowledge Sync Connector engine tests (#4376, ADR-0030) — the tracer bullet:
 * a FIXTURE VENDOR (an in-memory page store behind the `ConnectorVendorClient`
 * interface, its documents produced by the real `@atlas/okf-bundle` collect
 * machinery) driven end-to-end through the shared engine and the sync cycle
 * walk, against an in-memory internal DB.
 *
 * Pins the engine contract per the issue's acceptance criteria:
 *   - first sync / stale collections run a RECONCILIATION crawl (full set,
 *     subtractive archiving, full-set cap validation with real numbers);
 *   - steady-state cycles run INCREMENTALLY off the persisted high-water mark
 *     minus the overlap window, and deletions are untouchable there;
 *   - 429/`Retry-After` gets bounded engine backoff, never per-vendor code;
 *   - one collection's failure never blocks the cycle's remaining collections;
 *   - bookkeeping advances only on success (error attempts pass nulls);
 *   - NO publish path exists (structural pin on both engine modules).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { collectPages } from "@atlas/okf-bundle";
import type {
  ConnectorChanges,
  ConnectorDocument,
  KnowledgeSyncConnector,
} from "@atlas/api/lib/knowledge/connectors";

const ORG = "org-1";
const COLLECTION = "fixture-docs";
const FIXTURE_CATALOG_ID = "catalog:fixture-vendor";

// ── Mutable caps (mock-all-exports for ingest-limits) ───────────────────────
let MAX_DOCS = 100;
const MAX_DOC_BYTES = 100_000;
const MAX_BUNDLE_BYTES = 200_000;

mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
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

// ── In-memory knowledge store + fake transactional client ───────────────────
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
/** `atlas_source` values the ingest INSERT/UPDATE stamped. */
let writtenSources: unknown[] = [];

function fakeTxClient() {
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (txThrowOn && sql.includes(txThrowOn)) throw new Error("tx infra failure");
      if (sql.includes("FROM workspace_plugins")) {
        return { rows: [{ status: installStatusInTx }] };
      }
      if (sql.includes("SELECT id, status, body")) {
        const existing = store.get(params[2] as string);
        return { rows: existing ? [existing as unknown as Record<string, unknown>] : [] };
      }
      if (sql.includes("INSERT INTO knowledge_documents")) {
        const id = `doc-${nextId++}`;
        writtenSources.push(params[10]);
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
        writtenSources.push(params[8]);
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

// ── In-memory sync-state table (upsert semantics incl. COALESCE-forward) ────
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
let INSTALL_ROWS: Array<{
  workspace_id: string;
  install_id: string;
  catalog_id: string;
  config: unknown;
}> = [];
let installsQueryParams: unknown[] | null = null;

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (internalQueryThrowOn && sql.includes(internalQueryThrowOn)) throw new Error("internal DB unavailable");
  if (sql.includes("INSERT INTO knowledge_sync_state")) {
    const key = stateKey(params[0] as string, params[1] as string);
    const prev = syncState.get(key);
    syncState.set(key, {
      status: params[2] as string,
      error: params[3] as string | null,
      report: params[4] === null ? null : JSON.parse(params[4] as string),
      // COALESCE(EXCLUDED.x, existing.x) — the semantics the real-Postgres
      // test (knowledge-lifecycle-pg) executes against the live schema.
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
  if (sql.includes("SELECT workspace_id, install_id")) {
    installsQueryParams = params;
    return INSTALL_ROWS;
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

let invalidations: string[] = [];
mock.module("@atlas/api/lib/knowledge/mirror-invalidation", () => ({
  invalidateKnowledgeMirror: async (orgId: string) => {
    invalidations.push(orgId);
  },
}));

const {
  syncConnectorCollection,
  withRateLimitBackoff,
  getKnowledgeSyncReconcileIntervalMs,
  DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS,
  SYNC_OVERLAP_WINDOW_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_DEFAULT_WAIT_MS,
} = await import("@atlas/api/lib/knowledge/connector-sync");
const {
  registerKnowledgeSyncConnector,
  _resetKnowledgeSyncConnectors,
  ConnectorRateLimitError,
} = await import("@atlas/api/lib/knowledge/connectors");
const { runKnowledgeSyncCycle } = await import("@atlas/api/lib/knowledge/sync");

// ── The fixture vendor ───────────────────────────────────────────────────────
// An in-memory page store behind the vendor-client interface. Its documents
// are produced by the REAL `@atlas/okf-bundle` collect machinery (doc-source
// seam → deterministic paths → OKF render), proving a connector consumes
// collected documents at the ingest seam with no tar round-trip.

interface FixturePage {
  path: string;
  body: string;
  title?: string;
  /** ISO-8601 vendor modification time — what the change feed filters on. */
  lastModified: string;
}

let vendorPages: FixturePage[];
/** Rate-limit injections remaining: each fetch throws until it hits zero. */
let rateLimits = 0;
let retryAfterSeconds: number | null = null;
let fetchCalls: Array<{ kind: "changes" | "all"; since?: string | null; cursor?: string | null }>;
/** Overrides the vendor-reported high-water mark (e.g. garbage timestamps). */
let vendorMarkOverride: string | null | undefined;
/** The cursor the fixture vendor returns from each fetch (persisted on success). */
let vendorCursor: string | null = null;
/** When true, the fixture vendor flags its enumeration as knowingly partial. */
let vendorCoverageIncomplete = false;
/** The install status the in-transaction re-check sees — flip to simulate an
 *  uninstall landing mid-sync (#4229). */
let installStatusInTx = "published";
/** When set, the internal-DB mock throws on any query whose SQL contains this
 *  substring — exercises the "sync never throws" isolation against DB failures. */
let internalQueryThrowOn: string | null = null;
/** When set, the fake transactional client throws on any query whose SQL
 *  contains this substring — simulates a mid-ingest infra failure. */
let txThrowOn: string | null = null;

async function collectFixtureDocs(pages: FixturePage[]): Promise<ConnectorDocument[]> {
  const result = await collectPages(
    {
      getPages: () =>
        pages.map((p) => ({
          path: p.path,
          title: p.title,
          loadBody: async () => p.body,
        })),
    },
    { prefix: "fixture" },
  );
  return result.docs.map((d) => ({ path: d.path, content: d.content }));
}

function vendorMark(pages: FixturePage[]): string | null {
  if (vendorMarkOverride !== undefined) return vendorMarkOverride;
  if (pages.length === 0) return null;
  return pages.map((p) => p.lastModified).toSorted().at(-1) ?? null;
}

function maybeRateLimit(): void {
  if (rateLimits > 0) {
    rateLimits--;
    throw new ConnectorRateLimitError("fixture vendor throttled", retryAfterSeconds);
  }
}

const fixtureConnector: KnowledgeSyncConnector = {
  catalogId: FIXTURE_CATALOG_ID,
  vendor: "fixture",
  createClient: () => ({
    async fetchChanges({ since, cursor }): Promise<ConnectorChanges> {
      maybeRateLimit();
      fetchCalls.push({ kind: "changes", since, cursor });
      const changed = vendorPages.filter((p) => since === null || p.lastModified >= since);
      return {
        documents: await collectFixtureDocs(changed),
        highWaterMark: vendorMark(vendorPages),
        cursor: vendorCursor,
        coverageIncomplete: vendorCoverageIncomplete,
      };
    },
    async fetchAll(): Promise<ConnectorChanges> {
      maybeRateLimit();
      fetchCalls.push({ kind: "all" });
      return {
        documents: await collectFixtureDocs(vendorPages),
        highWaterMark: vendorMark(vendorPages),
        cursor: vendorCursor,
        coverageIncomplete: vendorCoverageIncomplete,
      };
    },
  }),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A markdown body with real prose — the collect machinery's contentless
 *  check (deliberately left ON: the fixture exercises the REAL core) skips
 *  heading-only bodies. */
const md = (title: string) => `# ${title}\n\n${title} prose for the fixture vendor.\n`;

const NOW = new Date("2026-07-06T12:00:00.000Z");
let sleeps: number[];
const testSleep = async (ms: number) => {
  sleeps.push(ms);
};

function runSync(over: Partial<Parameters<typeof syncConnectorCollection>[0]> = {}) {
  return syncConnectorCollection({
    connector: fixtureConnector,
    workspaceId: ORG,
    collectionSlug: COLLECTION,
    config: {},
    now: () => NOW,
    sleep: testSleep,
    ...over,
  });
}

/** Seed the collection's sync-state row as if a prior sync succeeded. */
function seedState(over: Partial<StateRow> = {}) {
  syncState.set(stateKey(ORG, COLLECTION), {
    status: "success",
    error: null,
    report: null,
    high_water_mark: "2026-07-05T00:00:00.000Z",
    sync_cursor: null,
    // Recent enough that the weekly cadence is NOT due.
    last_reconciled_at: "2026-07-04T00:00:00.000Z",
    ...over,
  });
}

const state = () => syncState.get(stateKey(ORG, COLLECTION));

beforeEach(() => {
  MAX_DOCS = 100;
  store = new Map();
  syncState = new Map();
  nextId = 1;
  writtenSources = [];
  invalidations = [];
  fetchCalls = [];
  sleeps = [];
  vendorPages = [];
  rateLimits = 0;
  retryAfterSeconds = null;
  vendorMarkOverride = undefined;
  vendorCursor = null;
  vendorCoverageIncomplete = false;
  installStatusInTx = "published";
  internalQueryThrowOn = null;
  txThrowOn = null;
  INSTALL_ROWS = [];
  installsQueryParams = null;
  _resetKnowledgeSyncConnectors();
});

// ── Reconciliation (the correctness anchor) ─────────────────────────────────

describe("reconciliation crawls", () => {
  it("a collection with no sync state runs a FULL crawl: drafts seeded, mark + reconciled-at persisted", async () => {
    vendorPages = [
      { path: "runbooks/oncall.md", body: md("Oncall"), lastModified: "2026-07-01T00:00:00.000Z" },
      { path: "runbooks/deploy.md", body: md("Deploy"), lastModified: "2026-07-02T00:00:00.000Z" },
    ];
    const outcome = await runSync();

    expect(outcome).toMatchObject({
      status: "success",
      mode: "reconciliation",
      documents: { created: 2, total: 2 },
      archivedAbsent: 0,
      highWaterMark: "2026-07-02T00:00:00.000Z",
    });
    expect(fetchCalls).toEqual([{ kind: "all" }]);
    // The collect machinery derived the paths; every write landed draft with
    // the vendor-stamped connector source.
    expect(store.get("fixture/runbooks/oncall.md")?.status).toBe("draft");
    expect(writtenSources).toEqual(["connector:fixture", "connector:fixture"]);
    expect(state()).toMatchObject({
      status: "success",
      high_water_mark: "2026-07-02T00:00:00.000Z",
      last_reconciled_at: NOW.toISOString(),
    });
    expect(invalidations).toEqual([ORG]);
  });

  it("archives vendor-deleted paths ONLY here; an unchanged published doc is left alone", async () => {
    // First reconciliation seeds the tree; a reviewer then publishes both docs.
    vendorPages = [
      { path: "keep.md", body: md("Keep"), lastModified: "2026-07-01T00:00:00.000Z" },
      { path: "gone.md", body: md("Gone"), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    const first = await runSync();
    expect(first).toMatchObject({ status: "success", mode: "reconciliation" });
    const keep = store.get("fixture/keep.md");
    const gone = store.get("fixture/gone.md");
    if (!keep || !gone) throw new Error("first sync did not seed the store");
    keep.status = "published";
    gone.status = "published";
    // `gone.md` is deleted at the vendor; the weekly cadence comes due again.
    vendorPages = [vendorPages[0]];
    seedState({ last_reconciled_at: "2026-06-01T00:00:00.000Z" });

    const outcome = await runSync();
    expect(outcome.mode).toBe("reconciliation");
    expect(outcome.status).toBe("success");
    expect(outcome.archivedAbsent).toBe(1);
    expect(store.get("fixture/gone.md")?.status).toBe("archived");
    // The unchanged published doc was left alone (no needless demotion).
    expect(store.get("fixture/keep.md")?.status).toBe("published");
  });

  it("an EMPTY reconciliation is an error and archives NOTHING — one bad vendor response must not wipe a collection", async () => {
    vendorPages = [];
    store.set("fixture/precious.md", {
      id: "doc-p",
      status: "published",
      body: "# P",
      type: "Document",
      title: "P",
      description: null,
      resource: null,
      tags: [],
      timestamp: null,
    });
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/returned no documents/i);
    expect(store.get("fixture/precious.md")?.status).toBe("published");
    expect(state()).toMatchObject({ status: "error", last_reconciled_at: null });
  });

  it("a reconciliation where every document is rejected is a distinct all-rejected error, still archiving nothing", async () => {
    // One oversized page → zero eligible docs but a non-empty rejection list:
    // the no_documents guard must fire with the all-rejected wording (not the
    // empty-vendor wording) and, crucially, still refuse to archive.
    store.set("fixture/precious.md", {
      id: "doc-p",
      status: "published",
      body: "# P",
      type: "Document",
      title: "P",
      description: null,
      resource: null,
      tags: [],
      timestamp: null,
    });
    vendorPages = [
      { path: "huge.md", body: md("Huge") + "x".repeat(MAX_DOC_BYTES), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/every document the vendor returned was rejected/i);
    expect(outcome.rejected).toHaveLength(1);
    expect(store.get("fixture/precious.md")?.status).toBe("published");
    expect(state()).toMatchObject({ status: "error", last_reconciled_at: null });
  });

  it("a coverage-incomplete reconciliation upserts but archives NOTHING and holds the reconcile clock", async () => {
    // First a clean reconciliation seeds two docs; a reviewer publishes one.
    vendorPages = [
      { path: "keep.md", body: md("Keep"), lastModified: "2026-07-01T00:00:00.000Z" },
      { path: "missed.md", body: md("Missed"), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    await runSync();
    const missed = store.get("fixture/missed.md");
    if (!missed) throw new Error("first sync did not seed the store");
    missed.status = "published";
    // The vendor's next crawl KNOWS it skipped pages (depth cap, malformed
    // entries): `missed.md` is absent from the partial set, and the weekly
    // cadence is due again.
    vendorPages = [
      { path: "keep.md", body: md("Keep v2"), lastModified: "2026-07-06T00:00:00.000Z" },
    ];
    vendorCoverageIncomplete = true;
    seedState({ last_reconciled_at: "2026-06-01T00:00:00.000Z" });

    const outcome = await runSync();
    expect(outcome).toMatchObject({
      status: "success",
      mode: "reconciliation",
      coverageIncomplete: true,
      // archiveAbsent was skipped entirely — null, not 0.
      archivedAbsent: null,
    });
    // The upsert still landed; the absent doc survived the partial crawl.
    expect(store.get("fixture/keep.md")?.body).toContain("Keep v2");
    expect(store.get("fixture/missed.md")?.status).toBe("published");
    // The reconcile clock did NOT advance (the next cycle stays due), the mark
    // did, and the report records the deferred deletions for the admin surface.
    expect(state()).toMatchObject({
      status: "success",
      last_reconciled_at: "2026-06-01T00:00:00.000Z",
      high_water_mark: "2026-07-06T00:00:00.000Z",
    });
    expect(state()?.report).toMatchObject({ coverageIncomplete: true });
  });

  it("validates the ingest caps over the FULL set with real numbers", async () => {
    MAX_DOCS = 1;
    vendorPages = [
      { path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" },
      { path: "b.md", body: md("B"), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/2 documents, over the 1-document limit/);
    expect(outcome.error).toMatch(/ATLAS_KNOWLEDGE_INGEST_MAX_DOCS/);
    expect(store.size).toBe(0);
    // The failed attempt didn't stamp a reconciliation success.
    expect(state()).toMatchObject({ status: "error", high_water_mark: null, last_reconciled_at: null });
  });
});

// ── Incremental cycles ───────────────────────────────────────────────────────

describe("incremental cycles", () => {
  it("fetches since (high-water mark − overlap window) and upserts only the changes as drafts", async () => {
    seedState({ high_water_mark: "2026-07-05T00:00:00.000Z" });
    vendorPages = [
      { path: "old.md", body: md("Old"), lastModified: "2026-07-01T00:00:00.000Z" },
      { path: "new.md", body: md("New"), lastModified: "2026-07-06T09:00:00.000Z" },
    ];
    const outcome = await runSync();

    expect(outcome).toMatchObject({
      status: "success",
      mode: "incremental",
      documents: { created: 1, total: 1 },
      archivedAbsent: null,
      highWaterMark: "2026-07-06T09:00:00.000Z",
    });
    const expectedSince = new Date(
      Date.parse("2026-07-05T00:00:00.000Z") - SYNC_OVERLAP_WINDOW_MS,
    ).toISOString();
    expect(fetchCalls).toEqual([{ kind: "changes", since: expectedSince, cursor: null }]);
    expect(store.has("fixture/new.md")).toBe(true);
    expect(store.has("fixture/old.md")).toBe(false);
    expect(state()).toMatchObject({
      high_water_mark: "2026-07-06T09:00:00.000Z",
      last_reconciled_at: "2026-07-04T00:00:00.000Z", // untouched by incremental
    });
  });

  it("a vendor-deleted path is NOT archived on an incremental cycle", async () => {
    seedState();
    store.set("fixture/gone.md", {
      id: "doc-gone",
      status: "published",
      body: "# Gone",
      type: "Document",
      title: "Gone",
      description: null,
      resource: null,
      tags: [],
      timestamp: null,
    });
    vendorPages = [
      { path: "changed.md", body: md("Changed"), lastModified: "2026-07-06T00:00:00.000Z" },
    ];
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(outcome.mode).toBe("incremental");
    expect(store.get("fixture/gone.md")?.status).toBe("published");
  });

  it("a quiet cycle (no changes) still advances the high-water mark without touching the store", async () => {
    seedState({ high_water_mark: "2026-07-06T11:00:00.000Z" });
    vendorPages = [
      // Older than since — filtered out by the vendor.
      { path: "old.md", body: md("Old"), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    vendorMarkOverride = "2026-07-06T11:30:00.000Z";
    const outcome = await runSync();
    expect(outcome).toMatchObject({
      status: "success",
      mode: "incremental",
      documents: { total: 0 },
      highWaterMark: "2026-07-06T11:30:00.000Z",
    });
    expect(store.size).toBe(0);
    expect(invalidations).toEqual([]);
    expect(state()?.high_water_mark).toBe("2026-07-06T11:30:00.000Z");
  });

  it("an unparseable vendor high-water mark is not persisted (the next cycle reconciles instead)", async () => {
    seedState();
    vendorPages = [
      { path: "new.md", body: md("New"), lastModified: "2026-07-06T09:00:00.000Z" },
    ];
    vendorMarkOverride = "not-a-timestamp";
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(outcome.highWaterMark).toBeNull();
    // COALESCE kept the previous mark rather than poisoning the row.
    expect(state()?.high_water_mark).toBe("2026-07-05T00:00:00.000Z");
  });

  it("threads the persisted cursor into fetchChanges and persists the vendor's returned cursor", async () => {
    // Cursor-shaped vendors (ADR-0030): the last cursor is threaded back in, and
    // the new one is persisted on success — the round-trip the COALESCE upsert
    // is there to support.
    seedState({ high_water_mark: "2026-07-05T00:00:00.000Z", sync_cursor: "cursor-1" });
    vendorPages = [{ path: "new.md", body: md("New"), lastModified: "2026-07-06T09:00:00.000Z" }];
    vendorCursor = "cursor-2";
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(outcome.mode).toBe("incremental");
    expect(fetchCalls[0]).toMatchObject({ kind: "changes", cursor: "cursor-1" });
    expect(state()?.sync_cursor).toBe("cursor-2");
  });
});

// ── Rate limiting (engine property) ─────────────────────────────────────────

describe("429 / Retry-After backoff", () => {
  it("waits the vendor's Retry-After (bounded) and retries to success", async () => {
    vendorPages = [
      { path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    rateLimits = 2; // two 429s, third attempt succeeds
    retryAfterSeconds = 1;
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(sleeps).toEqual([1000, 1000]);
    expect(store.size).toBe(1);
  });

  it("caps an hour-scale Retry-After so one vendor can't wedge the cycle walk", async () => {
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    rateLimits = 1;
    retryAfterSeconds = 3600;
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(sleeps).toEqual([RATE_LIMIT_MAX_WAIT_MS]);
  });

  it("backs off the default wait when the vendor sends no Retry-After", async () => {
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    rateLimits = 1;
    retryAfterSeconds = null;
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(sleeps).toEqual([RATE_LIMIT_DEFAULT_WAIT_MS]);
  });

  it("exhausted backoff is a bounded error outcome — not a throw, not an unbounded wait", async () => {
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    rateLimits = 100;
    retryAfterSeconds = 2;
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/rate limiting/i);
    expect(sleeps).toHaveLength(RATE_LIMIT_MAX_ATTEMPTS - 1);
    expect(state()).toMatchObject({ status: "error" });
  });

  it("withRateLimitBackoff does not retry non-rate-limit errors", async () => {
    let calls = 0;
    await expect(
      withRateLimitBackoff(
        async () => {
          calls++;
          throw new Error("vendor exploded");
        },
        { sleep: testSleep },
      ),
    ).rejects.toThrow("vendor exploded");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

// ── Failure isolation + bookkeeping-on-error ─────────────────────────────────

describe("failure handling", () => {
  it("a createClient failure is an actionable error outcome, never a throw", async () => {
    const broken: KnowledgeSyncConnector = {
      catalogId: "catalog:broken-vendor",
      vendor: "broken",
      createClient: () => {
        throw new Error("The connector credential could not be decrypted — re-enter it.");
      },
    };
    const outcome = await runSync({ connector: broken });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/could not be decrypted/);
  });

  it("an error attempt never regresses the high-water mark or reconciliation clock", async () => {
    seedState({
      high_water_mark: "2026-07-05T00:00:00.000Z",
      last_reconciled_at: "2026-07-04T00:00:00.000Z",
    });
    const failing: KnowledgeSyncConnector = {
      catalogId: FIXTURE_CATALOG_ID,
      vendor: "fixture",
      createClient: () => ({
        fetchChanges: async () => {
          throw new Error("vendor 500");
        },
        fetchAll: async () => {
          throw new Error("vendor 500");
        },
      }),
    };
    const outcome = await runSync({ connector: failing });
    expect(outcome.status).toBe("error");
    expect(state()).toMatchObject({
      status: "error",
      high_water_mark: "2026-07-05T00:00:00.000Z",
      last_reconciled_at: "2026-07-04T00:00:00.000Z",
    });
  });

  it("an ingest-transaction infra failure after a successful fetch is an error outcome, never a throw", async () => {
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    txThrowOn = "INSERT INTO knowledge_documents";
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Ingest failed after a successful vendor fetch/);
    expect(state()).toMatchObject({ status: "error" });
  });

  it("an internal-DB failure reading sync state is an isolated error outcome, never a throw", async () => {
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    internalQueryThrowOn = "SELECT high_water_mark";
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Sync failed unexpectedly/);
    // The failure happened BEFORE the mode decision — the synthesized attempt
    // says so honestly rather than labeling it "incremental".
    expect(outcome.mode).toBe("unknown");
    // The error is still persisted (the state WRITE succeeds; only the READ threw).
    expect(state()).toMatchObject({ status: "error" });
  });

  it("a sync-state WRITE failure is swallowed — the committed sync still returns success", async () => {
    // recordConnectorSyncState must not fail a sync that already committed.
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    internalQueryThrowOn = "INSERT INTO knowledge_sync_state";
    const outcome = await runSync();
    expect(outcome.status).toBe("success");
    expect(store.get("fixture/a.md")?.status).toBe("draft");
    // The write threw before landing a row, but the sync did not throw.
    expect(state()).toBeUndefined();
  });

  it("an uninstall landing mid-sync (install re-check archived) is an error outcome with no writes", async () => {
    vendorPages = [{ path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" }];
    installStatusInTx = "archived";
    const outcome = await runSync();
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/uninstalled while the sync was running/);
    expect(store.size).toBe(0);
  });
});

// ── The cycle walk dispatches on catalog id ──────────────────────────────────

describe("runKnowledgeSyncCycle dispatch", () => {
  it("dispatches connector installs to the engine and isolates a failing collection", async () => {
    registerKnowledgeSyncConnector(fixtureConnector);
    vendorPages = [
      { path: "a.md", body: md("A"), lastModified: "2026-07-01T00:00:00.000Z" },
    ];
    INSTALL_ROWS = [
      // An install whose catalog id has no registered connector (a registry
      // mutation racing the cycle) — the walk must COUNT it as a failure via the
      // undefined-connector branch, never silently skip it.
      { workspace_id: ORG, install_id: "broken-docs", catalog_id: "catalog:unregistered", config: {} },
      { workspace_id: ORG, install_id: COLLECTION, catalog_id: FIXTURE_CATALOG_ID, config: {} },
    ];
    const result = await runKnowledgeSyncCycle();
    expect(result).toEqual({ inspected: 2, succeeded: 1, failed: 1, queryFailed: false });
    // The installs query asked for bundle-sync PLUS every registered connector.
    expect(installsQueryParams).toEqual([["catalog:bundle-sync", FIXTURE_CATALOG_ID]]);
    // The registered connector's install synced end-to-end on the walk.
    expect(store.get("fixture/a.md")?.status).toBe("draft");
    expect(state()).toMatchObject({ status: "success" });
  });
});

// ── Registry contract ────────────────────────────────────────────────────────

describe("connector registry", () => {
  it("rejects duplicate catalog ids and malformed vendor slugs", () => {
    registerKnowledgeSyncConnector(fixtureConnector);
    expect(() => registerKnowledgeSyncConnector(fixtureConnector)).toThrow(/already registered/);
    expect(() =>
      registerKnowledgeSyncConnector({
        catalogId: "catalog:bad",
        vendor: "Not A Slug!",
        createClient: () => ({
          fetchChanges: async () => ({ documents: [], highWaterMark: null }),
          fetchAll: async () => ({ documents: [], highWaterMark: null }),
        }),
      }),
    ).toThrow(/vendor slug/);
  });
});

// ── Reconciliation-cadence knob ──────────────────────────────────────────────

describe("getKnowledgeSyncReconcileIntervalMs", () => {
  const KEY = "ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS";
  function withEnv(value: string | undefined, fn: () => void) {
    const prev = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  it("defaults to weekly and honors overrides, falling back on garbage", () => {
    withEnv(undefined, () =>
      expect(getKnowledgeSyncReconcileIntervalMs()).toBe(
        DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS * 3_600_000,
      ),
    );
    withEnv("24", () => expect(getKnowledgeSyncReconcileIntervalMs()).toBe(24 * 3_600_000));
    withEnv("0.5", () => expect(getKnowledgeSyncReconcileIntervalMs()).toBe(30 * 60 * 1000));
    for (const garbage of ["0", "-3", "nonsense"]) {
      withEnv(garbage, () =>
        expect(getKnowledgeSyncReconcileIntervalMs()).toBe(
          DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS * 3_600_000,
        ),
      );
    }
  });
});

// ── AC: no publish path exists on the connector engine (structural pin) ─────

describe("review gate — no publish path on connector sync (ADR-0028 §4)", () => {
  it("the engine modules never reference the content-mode publish machinery", async () => {
    for (const rel of ["../connector-sync.ts", "../connectors.ts"]) {
      const source = await Bun.file(new URL(rel, import.meta.url).pathname).text();
      expect(source).not.toContain("runPublishPhases");
      expect(source).not.toMatch(/from\s+"@atlas\/api\/lib\/content-mode/);
      expect(source).not.toMatch(/SET\s+status\s*=\s*'published'/i);
      // The engine never asks the ingest seam to publish.
      expect(source).not.toMatch(/publish:\s*true/);
    }
  });
});
