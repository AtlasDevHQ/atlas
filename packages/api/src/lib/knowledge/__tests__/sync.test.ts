/**
 * Unit tests for the knowledge bundle sync engine (#4211).
 *
 * Exercises the fetch-hardening branches (SSRF block, redirect-to-internal,
 * size caps, timeout, non-200), the ingest-computed diff wiring (source
 * `bundle-sync`, archive-absent semantics, rejected files kept out of the
 * absent set), the empty-bundle safety stop, and the sync-state bookkeeping —
 * all against an in-memory fake internal DB and an injected `fetchImpl`
 * (`guardedFetch` itself runs REAL, so the SSRF policy under test is the real
 * one). The AC "no publish-on-sync path exists" is pinned twice: behaviorally
 * (no SQL ever writes status='published') and structurally (the module never
 * references the content-mode publish machinery).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const ORG = "org-1";
const COLLECTION = "docs";
const ENDPOINT = "https://kb.example.com/bundle.zip";

// ── Mutable caps (mock-all-exports for ingest-limits) ───────────────────────
let MAX_DOCS = 100;
let MAX_DOC_BYTES = 100_000;
let MAX_BUNDLE_BYTES = 200_000;
// When set, the bundle-bytes getter THROWS — simulates a defect escaping
// runSyncAttempt (a settings-backend regression) for the never-throws pin.
let LIMITS_THROW = false;

mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
  DEFAULT_INGEST_MAX_DOCS: 1000,
  DEFAULT_INGEST_MAX_DOC_BYTES: 1_000_000,
  DEFAULT_INGEST_MAX_BUNDLE_BYTES: 25_000_000,
  getIngestMaxDocs: () => MAX_DOCS,
  getIngestMaxDocBytes: () => MAX_DOC_BYTES,
  getIngestMaxBundleBytes: () => {
    if (LIMITS_THROW) throw new Error("settings backend exploded");
    return MAX_BUNDLE_BYTES;
  },
  positiveIntSetting: (_key: string, raw: string | undefined, fallback: number) => {
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  },
}));

// ── Credential store ─────────────────────────────────────────────────────────
let CREDENTIAL: string | null = null;
let CREDENTIAL_THROWS = false;
const readSyncCredential = mock(async () => {
  if (CREDENTIAL_THROWS) throw new Error("decrypt boom");
  return CREDENTIAL;
});
mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  readSyncCredential,
  saveSyncCredential: async () => {},
  deleteSyncCredential: async () => {},
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
const txSql: { sql: string; params: unknown[] }[] = [];
// Transaction control statements (BEGIN/COMMIT/ROLLBACK), captured separately.
const txControl: string[] = [];
// When set, the fake client throws on the ingest INSERT — exercises the
// transaction-failure path (ROLLBACK + error outcome + error state row).
let TX_INSERT_THROWS = false;
// When set, the state upsert throws — exercises recordSyncState resilience.
let STATE_WRITE_THROWS = false;
let INSTALL_ROWS: Array<{ workspace_id: string; install_id: string; config: unknown }> = [];
const stateWrites: { params: unknown[] }[] = [];
// What the in-transaction install re-check (FOR UPDATE) sees. `null` = the row
// is gone; "archived" = an uninstall landed mid-sync (the race under test).
let TX_INSTALL_STATUS: string | null = "published";

function fakeTxClient() {
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        txControl.push(sql);
        return { rows: [] };
      }
      txSql.push({ sql, params });
      if (sql.includes("FROM workspace_plugins")) {
        return { rows: TX_INSTALL_STATUS === null ? [] : [{ status: TX_INSTALL_STATUS }] };
      }
      if (sql.includes("SELECT id, status, body")) {
        const existing = store.get(params[2] as string);
        return { rows: existing ? [existing as unknown as Record<string, unknown>] : [] };
      }
      if (sql.includes("INSERT INTO knowledge_documents")) {
        if (TX_INSERT_THROWS) throw new Error("duplicate key value violates unique constraint");
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

let HAS_INTERNAL_DB = true;
const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("INSERT INTO knowledge_sync_state")) {
    if (STATE_WRITE_THROWS) throw new Error("state table unavailable");
    stateWrites.push({ params });
    return [];
  }
  if (sql.includes("FROM workspace_plugins")) return INSTALL_ROWS;
  throw new Error(`unexpected internalQuery SQL: ${sql.slice(0, 60)}`);
});

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery }),
  hasInternalDB: () => HAS_INTERNAL_DB,
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

// Partial mock, justified: `sync.ts` lazy-imports EXACTLY ONE symbol from
// `semantic/sync` (`invalidateOrgModeRoots`, the post-sync mirror bust) and
// nothing else in this file imports the module. Mocking it (a) lets the tests
// assert the invalidation contract and (b) stops the previous behavior of
// running the REAL module's fire-and-forget explore import as an untracked
// side effect of every successful sync.
const invalidateCalls: string[] = [];
mock.module("@atlas/api/lib/semantic/sync", () => ({
  invalidateOrgModeRoots: (orgId: string) => {
    invalidateCalls.push(orgId);
  },
}));

const { syncCollection, runKnowledgeSyncCycle } = await import("@atlas/api/lib/knowledge/sync");

// ── Helpers ──────────────────────────────────────────────────────────────────

function zipBundle(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content);
  return zipSync(entries);
}

/** A minimal Response-alike accepted by guardedFetch + the body reader. */
function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
}): Response {
  const bytes = opts.bytes ?? new Uint8Array(0);
  return {
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: new Headers(opts.headers ?? {}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Response;
}

function fetchReturning(response: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { endpoint_url: ENDPOINT, auth_scheme: "none", ...overrides };
}

function seedDoc(path: string, status: string, body: string): void {
  store.set(path, {
    id: `seed-${path}`,
    status,
    body,
    type: "Document",
    title: path,
    description: null,
    resource: null,
    tags: [],
    timestamp: null,
  });
}

beforeEach(() => {
  MAX_DOCS = 100;
  MAX_DOC_BYTES = 100_000;
  MAX_BUNDLE_BYTES = 200_000;
  LIMITS_THROW = false;
  TX_INSERT_THROWS = false;
  STATE_WRITE_THROWS = false;
  CREDENTIAL = null;
  CREDENTIAL_THROWS = false;
  HAS_INTERNAL_DB = true;
  store = new Map();
  nextId = 1;
  txSql.length = 0;
  txControl.length = 0;
  stateWrites.length = 0;
  INSTALL_ROWS = [];
  TX_INSTALL_STATUS = "published";
  invalidateCalls.length = 0;
  internalQuery.mockClear();
  readSyncCredential.mockClear();
});

// ── The diff + archive semantics ─────────────────────────────────────────────

describe("syncCollection — ingest-computed diff", () => {
  it("creates new docs as draft, demotes changed published docs, archives absent paths — and never publishes", async () => {
    seedDoc("changed.md", "published", "old body");
    seedDoc("gone.md", "published", "was here");

    const bundle = zipBundle({
      "changed.md": "# changed\nnew body",
      "new.md": "# new\nhello",
    });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));

    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("success");
    expect(outcome.format).toBe("zip");
    expect(outcome.documents).toEqual({
      created: 1,
      updated: 0,
      demoted: 1,
      resurrected: 0,
      unchanged: 0,
      total: 2,
    });
    expect(outcome.archivedAbsent).toBe(1);
    expect(store.get("gone.md")?.status).toBe("archived");
    expect(store.get("changed.md")?.status).toBe("draft");
    expect(store.get("new.md")?.status).toBe("draft");

    // The review gate holds: nothing on the sync path ever writes 'published'
    // — neither as a SQL literal nor as a bound parameter.
    for (const { sql, params } of txSql) {
      expect(sql).not.toMatch(/status\s*=\s*'published'/);
      expect(params).not.toContain("published");
    }
    // Docs land with the bundle-sync provenance source.
    const insert = txSql.find((q) => q.sql.includes("INSERT INTO knowledge_documents"));
    expect(insert?.params[10]).toBe("bundle-sync");

    // Sync state recorded as success.
    expect(stateWrites).toHaveLength(1);
    expect(stateWrites[0].params[2]).toBe("success");
  });

  it("keeps rejected files OUT of the absent set — a broken file must not archive its reviewed doc", async () => {
    MAX_DOC_BYTES = 10; // force an oversize rejection
    seedDoc("big.md", "published", "reviewed body");

    const bundle = zipBundle({
      "big.md": "# way over the ten byte per-doc cap",
      "ok.md": "# ok",
    });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));

    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("success");
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].path).toBe("big.md");
    // Present-but-rejected → NOT archived.
    expect(store.get("big.md")?.status).toBe("published");
    expect(outcome.archivedAbsent).toBe(0);
  });

  it("refuses a doc-less bundle outright — a bad endpoint response must not archive the collection", async () => {
    seedDoc("keep.md", "published", "body");
    const bundle = zipBundle({ "asset.png": "not markdown" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));

    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Nothing was changed/);
    expect(store.get("keep.md")?.status).toBe("published");
    expect(txSql).toHaveLength(0); // no transaction was opened
    expect(stateWrites[0].params[2]).toBe("error");
  });

  it("enforces the document-count cap", async () => {
    MAX_DOCS = 1;
    const bundle = zipBundle({ "a.md": "# a", "b.md": "# b" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/document limit/);
  });

  it("rejects a non-archive response (HTML error page) with an actionable error and no writes", async () => {
    seedDoc("keep.md", "published", "body");
    const { impl } = fetchReturning(
      fakeResponse({ bytes: strToU8("<html>404 not found</html>") }),
    );
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Unrecognized bundle format/);
    expect(txSql).toHaveLength(0);
    expect(store.get("keep.md")?.status).toBe("published");
    expect(stateWrites[0].params[2]).toBe("error");
  });

  it("rolls back and records an error state when the ingest transaction fails", async () => {
    TX_INSERT_THROWS = true;
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Ingest failed after a successful fetch/);
    expect(txControl).toContain("ROLLBACK");
    expect(txControl).not.toContain("COMMIT");
    expect(stateWrites[0].params[2]).toBe("error");
  });

  it("still reports success when the state bookkeeping write itself fails (never fail a committed sync)", async () => {
    STATE_WRITE_THROWS = true;
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("success");
  });

  it("records an error state even when the attempt throws unexpectedly (never a stale success)", async () => {
    LIMITS_THROW = true;
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Sync failed unexpectedly: settings backend exploded/);
    // The defect still landed a state row — the admin surface can't keep
    // showing a stale "success".
    expect(stateWrites).toHaveLength(1);
    expect(stateWrites[0].params[2]).toBe("error");
  });
});

// ── Uninstall × in-flight sync race ─────────────────────────────────────────

describe("syncCollection — uninstall × in-flight sync race", () => {
  it("aborts the transaction with no writes when the install was archived mid-sync", async () => {
    seedDoc("was-archived.md", "archived", "old body");
    // The pre-fetch check saw a live install; the uninstall lands during the
    // fetch window, so the in-transaction FOR UPDATE re-check sees 'archived'.
    TX_INSTALL_STATUS = "archived";

    const bundle = zipBundle({ "was-archived.md": "# back\nnew body", "new.md": "# new" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));

    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/uninstalled while the sync was running/);
    expect(txControl).toContain("ROLLBACK");
    expect(txControl).not.toContain("COMMIT");
    // The race guard fired BEFORE any document write: nothing resurrected,
    // nothing inserted.
    expect(txSql.some((q) => q.sql.includes("INSERT INTO knowledge_documents"))).toBe(false);
    expect(txSql.some((q) => q.sql.includes("UPDATE knowledge_documents"))).toBe(false);
    expect(store.get("was-archived.md")?.status).toBe("archived");
    expect(store.has("new.md")).toBe(false);
    // No mirror churn for an aborted sync.
    expect(invalidateCalls).toHaveLength(0);
  });

  it("aborts identically when the install row is gone entirely", async () => {
    TX_INSTALL_STATUS = null;
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/uninstalled while the sync was running/);
    expect(store.size).toBe(0);
  });
});

// ── Mirror invalidation contract (#4208) ────────────────────────────────────

describe("syncCollection — knowledge mirror invalidation", () => {
  it("busts the org's mode roots after a sync that changed documents", async () => {
    const bundle = zipBundle({ "new.md": "# new\nhello" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("success");
    expect(invalidateCalls).toEqual([ORG]);
  });

  it("skips the mirror bust for an all-unchanged sync (no churn)", async () => {
    // Seed a doc IDENTICAL to what the bundle parses to: no frontmatter, so the
    // whole content is the body, title = first heading, type stamped Document.
    store.set("same.md", {
      id: "seed-same",
      status: "published",
      body: "# same\nbody",
      type: "Document",
      title: "same",
      description: null,
      resource: null,
      tags: [],
      timestamp: null,
    });
    const bundle = zipBundle({ "same.md": "# same\nbody" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("success");
    expect(outcome.documents?.unchanged).toBe(1);
    expect(outcome.archivedAbsent).toBe(0);
    expect(invalidateCalls).toHaveLength(0);
  });

  it("does not bust the mirror on a failed sync", async () => {
    TX_INSERT_THROWS = true;
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(invalidateCalls).toHaveLength(0);
  });
});

// ── Fetch hardening ──────────────────────────────────────────────────────────

describe("syncCollection — fetch hardening", () => {
  it("blocks a private-address endpoint (SSRF) without ever fetching", async () => {
    const { impl, calls } = fetchReturning(fakeResponse({}));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ endpoint_url: "https://169.254.169.254/latest/meta-data" }),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Refusing to fetch/);
    expect(calls).toHaveLength(0);
    expect(stateWrites[0].params[2]).toBe("error");
  });

  it("blocks a redirect to an internal host (TOCTOU) — the hop is re-validated", async () => {
    const redirect = fakeResponse({
      status: 302,
      headers: { location: "https://127.0.0.1/internal.tar.gz" },
    });
    const { impl, calls } = fetchReturning(redirect);
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/Refusing to fetch/);
    expect(calls).toHaveLength(1); // first hop only; the internal hop never left
  });

  it("surfaces a non-2xx endpoint response with the host, never the full URL", async () => {
    const { impl } = fetchReturning(fakeResponse({ status: 403 }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ endpoint_url: `${ENDPOINT}?token=SECRET` }),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("403");
    expect(outcome.error).not.toContain("SECRET");
  });

  it("rejects on a too-large declared Content-Length before reading the body", async () => {
    const { impl } = fetchReturning(
      fakeResponse({ headers: { "content-length": String(MAX_BUNDLE_BYTES + 1) } }),
    );
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/byte limit/);
  });

  it("aborts a streamed body that exceeds the cap (lying/chunked endpoint)", async () => {
    MAX_BUNDLE_BYTES = 1000;
    const { impl } = fetchReturning(fakeResponse({ bytes: new Uint8Array(5000) }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/download aborted/);
  });

  it("rebuilds transport errors around the host — folding the cause, never leaking the URL", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 93.184.216.34:443") });
    }) as unknown as typeof globalThis.fetch;
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ endpoint_url: `${ENDPOINT}?token=SECRET` }),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain('"kb.example.com"');
    expect(outcome.error).toContain("fetch failed");
    // The narrowed cause (where undici hides the useful part) is folded in…
    expect(outcome.error).toContain("ECONNREFUSED");
    // …and the credentialed URL never reaches the state row.
    expect(outcome.error).not.toContain("SECRET");
    expect(stateWrites[0].params[3]).not.toContain("SECRET");
  });

  it("maps a fetch timeout to the time-budget error", async () => {
    const impl = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof globalThis.fetch;
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig(),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/time budget/);
  });

  it("errors on an unconfigured endpoint", async () => {
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: {},
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/endpoint_url/);
  });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe("syncCollection — endpoint auth", () => {
  it("sends Bearer for the bearer scheme", async () => {
    CREDENTIAL = "tok-123";
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl, calls } = fetchReturning(fakeResponse({ bytes: bundle }));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ auth_scheme: "bearer" }),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("success");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
  });

  it("sends base64 Basic for the basic scheme", async () => {
    CREDENTIAL = "user:pass";
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl, calls } = fetchReturning(fakeResponse({ bytes: bundle }));
    await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ auth_scheme: "basic" }),
      fetchImpl: impl,
    });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("fails loud when the scheme needs a secret but none is stored — never fetches unauthenticated", async () => {
    CREDENTIAL = null;
    const { impl, calls } = fetchReturning(fakeResponse({}));
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ auth_scheme: "bearer" }),
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/no stored secret/);
    expect(calls).toHaveLength(0);
  });

  it("fails loud on an undecryptable secret", async () => {
    CREDENTIAL_THROWS = true;
    const outcome = await syncCollection({
      workspaceId: ORG,
      collectionSlug: COLLECTION,
      config: baseConfig({ auth_scheme: "bearer" }),
    });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/could not be decrypted/);
  });
});

// ── Cycle ────────────────────────────────────────────────────────────────────

describe("runKnowledgeSyncCycle", () => {
  it("walks every enabled install, isolating per-collection failures", async () => {
    INSTALL_ROWS = [
      { workspace_id: ORG, install_id: "good", config: baseConfig() },
      { workspace_id: ORG, install_id: "bad", config: { endpoint_url: "" } },
    ];
    const bundle = zipBundle({ "a.md": "# a" });
    const { impl } = fetchReturning(fakeResponse({ bytes: bundle }));

    const result = await runKnowledgeSyncCycle({ fetchImpl: impl });
    expect(result).toEqual({ inspected: 2, succeeded: 1, failed: 1, queryFailed: false });
    // Both attempts recorded state (success + error).
    expect(stateWrites).toHaveLength(2);
  });

  it("no-ops without an internal DB", async () => {
    HAS_INTERNAL_DB = false;
    const result = await runKnowledgeSyncCycle();
    expect(result).toEqual({ inspected: 0, succeeded: 0, failed: 0, queryFailed: false });
  });
});

// ── AC: no publish-on-sync path exists (structural pin) ─────────────────────

describe("review gate — no publish path on sync (ADR-0028 §4)", () => {
  it("the sync module never references the content-mode publish machinery", async () => {
    const source = await Bun.file(
      new URL("../sync.ts", import.meta.url).pathname,
    ).text();
    expect(source).not.toContain("runPublishPhases");
    // No import of the content-mode registry (the only door to promotion).
    expect(source).not.toMatch(/from\s+"@atlas\/api\/lib\/content-mode/);
    // The only status literal the sync path may write is 'archived'.
    expect(source).not.toMatch(/SET\s+status\s*=\s*'published'/i);
  });
});
