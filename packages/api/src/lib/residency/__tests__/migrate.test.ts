/**
 * Tests for region migration executor.
 *
 * Covers: successful migration with 4 phases (export, transfer, cutover, cleanup),
 * failure handling, retry, cancel, stale detection, cleanup detection, and edge cases.
 */

import { describe, it, expect, beforeEach, mock, afterEach, afterAll } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockHasInternalDB = true;
let mockQueryResults: Record<string, unknown[]> = {};
// Per-SQL injection: when set, internalQuery rejects on the first call whose
// SQL contains the pattern. Used to exercise transient-failure paths on a
// specific statement without breaking unrelated queries.
// `times` limits how many matching calls reject (undefined = every match) —
// lets a test poison only the FIRST of several identical UPDATEs (#4459).
let mockInternalQueryRejectPattern: { pattern: string; error: Error; times?: number } | null = null;
let mockPoolQueryResult = { rows: [{ id: "org-1" }] };
let mockPoolQueryError: Error | null = null;
const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: (sql: string, params: unknown[]) => {
      capturedQueries.push({ sql, params });
      if (mockPoolQueryError) return Promise.reject(mockPoolQueryError);
      // For export queries, return empty results by default
      if (sql.includes("FROM conversations") || sql.includes("FROM messages") ||
          sql.includes("FROM semantic_entities") || sql.includes("FROM learned_patterns") ||
          sql.includes("FROM settings")) {
        return Promise.resolve({ rows: [] });
      }
      // ⚠️ THREE rows for the vocabulary, where every other section gets one.
      // Systemic accidental equality otherwise: with every manifest count equal
      // to 1, a section's `refused`, its `imported`, its `expected` and every
      // OTHER section's count are all the literal 1, so an assertion pinning one
      // of them pins all of them. Measured — rewriting the refusal disclosure's
      // payload from `refused` to the section TOTAL passed the whole suite,
      // which is precisely the count the disclosure exists to carry. Three makes
      // the numbers separable: expected 3 = imported 2 + refused 1.
      if (sql.includes("FROM brain_vocabulary_edge")) {
        return Promise.resolve({ rows: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] });
      }
      return Promise.resolve(mockPoolQueryResult);
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: (sql: string, params: unknown[]) => {
    capturedQueries.push({ sql, params });
    if (mockInternalQueryRejectPattern && sql.includes(mockInternalQueryRejectPattern.pattern)) {
      const reject = mockInternalQueryRejectPattern;
      if (reject.times === undefined) return Promise.reject(reject.error);
      if (reject.times > 0) {
        reject.times--;
        return Promise.reject(reject.error);
      }
    }
    // Match query to result based on SQL pattern
    for (const [key, value] of Object.entries(mockQueryResults)) {
      if (sql.includes(key)) return Promise.resolve(value);
    }
    return Promise.resolve([]);
  },
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

/**
 * Captured `log.warn` payloads.
 *
 * Its own sink rather than one array with the level in the payload: the LEVEL is
 * part of what the refusal disclosure claims, and a helper that merged the
 * levels would pass a mutation demoting `log.warn` to `log.debug` — this repo's
 * recorded "helper that merges what the test asserts" shape.
 */
const capturedWarns: Array<{ payload: Record<string, unknown>; message: string }> = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (payload: unknown, message?: unknown) =>
      capturedWarns.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === "string" ? message : String(payload),
      }),
    error: () => {},
    debug: () => {},
  }),
}));

const mockFlushCache = mock(async () => {});
const mockFlushCacheByOrg = mock(async (_orgId: string) => 0);
void mock.module("@atlas/api/lib/cache/index", () => ({
  flushCache: mockFlushCache,
  flushCacheByOrg: mockFlushCacheByOrg,
  getCache: () => null,
  cacheEnabled: () => false,
  buildCacheKey: () => "",
}));

// Mock config with target region apiUrl
const DEFAULT_MOCK_CONFIG = {
  residency: {
    regions: {
      "us-east": { label: "US East", databaseUrl: "postgres://us", apiUrl: "https://api-us.example.com" },
      "eu-west": { label: "EU West", databaseUrl: "postgres://eu", apiUrl: "https://api-eu.example.com" },
    },
    defaultRegion: "us-east",
  },
};

let mockConfig: Record<string, unknown> | null = { ...DEFAULT_MOCK_CONFIG };

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

// Mock fetch for transfer phase
let mockFetchResponse: { ok: boolean; status: number; body?: unknown } = { ok: true, status: 200, body: {} };
let mockFetchError: Error | null = null;
let capturedFetchCalls: Array<{ url: string; options: RequestInit }> = [];

/**
 * A target region that understood every section, derived from the bundle it
 * was actually sent (#4767).
 *
 * `transferBundleToTarget` reconciles the acknowledged per-section counts
 * against `manifest.counts` before cutover — a target that silently dropped a
 * section it didn't recognize must not be treated as success. So the default
 * mock has to answer like a CURRENT target; a test that wants the
 * older-target behaviour sets `mockFetchResponse.body` explicitly.
 */
interface SectionAck {
  imported: number;
  skipped: number;
  /** #5036's third vocabulary counter. Absent from every other section. */
  refused?: number;
}

function acknowledgeAll(options?: RequestInit): Record<string, SectionAck> {
  const raw = typeof options?.body === "string" ? options.body : "{}";
  const counts = (JSON.parse(raw) as { manifest?: { counts?: Record<string, number> } }).manifest?.counts ?? {};
  const ack: Record<string, SectionAck> = {};
  for (const [section, n] of Object.entries(counts)) {
    ack[section] = { imported: n, skipped: 0 };
  }
  return reshapeAck ? reshapeAck(ack) : ack;
}

/**
 * Rewrite the derived acknowledgement before the mock answers with it.
 *
 * A hook rather than a static `mockFetchResponse.body`, because what a test
 * needs to answer depends on the bundle the exporter actually built from the
 * mocked DB — which the test cannot know in advance. Hard-coding it would make
 * the reconciliation pass for the wrong reason the day a fixture's row count
 * changed, which is the failure mode this whole guard exists to catch.
 */
let reshapeAck: ((ack: Record<string, SectionAck>) => Record<string, SectionAck>) | null = null;

const _originalFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  capturedFetchCalls.push({ url: urlStr, options: options ?? {} });
  if (mockFetchError) return Promise.reject(mockFetchError);
  const body = mockFetchResponse.body ?? acknowledgeAll(options);
  return Promise.resolve({
    ok: mockFetchResponse.ok,
    status: mockFetchResponse.status,
    statusText: mockFetchResponse.ok ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as Response);
}) as typeof fetch;

// Restore the real fetch once after every test in this file has run.
// (Doing it in afterEach would clobber the mock between tests.)
afterAll(() => {
  globalThis.fetch = _originalFetch;
});

// ── Import after mocks ──────────────────────────────────────────────

const {
  executeRegionMigration,
  failStaleMigrations,
  getCleanupDueMigrations,
  resetMigrationForRetry,
  cancelMigration,
} = await import("../migrate");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  mockHasInternalDB = true;
  mockQueryResults = {};
  mockInternalQueryRejectPattern = null;
  mockPoolQueryResult = { rows: [{ id: "org-1" }] };
  mockPoolQueryError = null;
  capturedQueries.length = 0;
  // `body: undefined` ⇒ the mock derives a full acknowledgement from the
  // bundle it was sent (see acknowledgeAll). A test that needs a target which
  // dropped sections sets `body` explicitly.
  mockFetchResponse = { ok: true, status: 200, body: undefined };
  mockFetchError = null;
  reshapeAck = null;
  capturedWarns.length = 0;
  capturedFetchCalls = [];
  mockConfig = { ...DEFAULT_MOCK_CONFIG };
  process.env.ATLAS_INTERNAL_SECRET = "test-secret";
}

// ── Tests ───────────────────────────────────────────────────────────

describe("executeRegionMigration", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    delete process.env.ATLAS_INTERNAL_SECRET;
  });

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Internal database");
  });

  it("returns error when migration is not found", async () => {
    const result = await executeRegionMigration("mig-nonexistent");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("not found");
  });

  it("returns error when migration is not in pending status", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "completed" },
    ];
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("completed");
      expect(result.error).toContain("expected \"pending\"");
    }
  });

  it("executes migration successfully through all 4 phases", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);
    expect(result.migrationId).toBe("mig-1");

    // Verify status transitions: in_progress → completed
    const statusUpdates = capturedQueries.filter((q) => q.sql.includes("UPDATE region_migrations"));
    expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
    expect(statusUpdates[0].params[0]).toBe("in_progress");
    expect(statusUpdates[statusUpdates.length - 1].params[0]).toBe("completed");

    // Verify region update (cutover phase)
    const regionUpdate = capturedQueries.find((q) => q.sql.includes("UPDATE organization"));
    expect(regionUpdate).toBeDefined();
    expect(regionUpdate!.params).toContain("eu-west");
    expect(regionUpdate!.params).toContain("org-1");

    // Verify transfer was called to the target region's apiUrl
    expect(capturedFetchCalls.length).toBe(1);
    expect(capturedFetchCalls[0].url).toBe("https://api-eu.example.com/api/v1/internal/migrate/import");

    // Phase 3 purges EXACTLY the migrated workspace's cache (#4548), not the
    // whole region — a co-tenant on this process keeps its warm entries.
    expect(mockFlushCacheByOrg).toHaveBeenCalledWith("org-1");
    expect(mockFlushCache).not.toHaveBeenCalled();

    // ⚠️ THE NEGATIVE CONTROL for #5036's refusal disclosure, and it is the arm
    // that had none: dropping `&& refused > 0` from its guard was green. Every
    // clean migration would then announce that approved human review decisions
    // were not applied, with `refused: 0` — alarm fatigue that destroys the
    // value of the one line an operator has to act on within the grace period.
    expect(
      capturedWarns.filter((w) => w.message.includes("REFUSED curated alias edges")),
    ).toEqual([]);
  });

  it("includes internal token in transfer request", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    await executeRegionMigration("mig-1");

    expect(capturedFetchCalls.length).toBe(1);
    const headers = capturedFetchCalls[0].options.headers as Record<string, string>;
    expect(headers["X-Atlas-Internal-Token"]).toBe("test-secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes orgId in transfer request body", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    await executeRegionMigration("mig-1");

    const body = JSON.parse(capturedFetchCalls[0].options.body as string);
    expect(body.orgId).toBe("org-1");
    expect(body.manifest).toBeDefined();
    expect(body.conversations).toBeDefined();
  });

  it("fails when ATLAS_INTERNAL_SECRET is not set", async () => {
    delete process.env.ATLAS_INTERNAL_SECRET;
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("ATLAS_INTERNAL_SECRET");
  });

  it("fails when target region has no apiUrl configured", async () => {
    mockConfig = {
      residency: {
        regions: {
          "us-east": { label: "US East", databaseUrl: "postgres://us" },
          "eu-west": { label: "EU West", databaseUrl: "postgres://eu" },
        },
        defaultRegion: "us-east",
      },
    };
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("apiUrl");
    // mockConfig is auto-restored by resetMocks in beforeEach
  });

  it("fails BEFORE cutover when the target silently drops a bundle section (#4767)", async () => {
    // The failure this prevents: `z.object()` STRIPS unknown keys, so a target
    // region running an older build drops every section it has no schema for,
    // imports the rest, and answers 200. The source then cuts over and
    // schedules the destructive cleanup, which deletes the dropped pillar from
    // the source after the grace period — total data loss, no error logged.
    //
    // Regions deploy independently, so a window where one region has a section
    // and another doesn't is routine, not exceptional. Before #4767 the bundle
    // VERSION was the guard; the brain sections are deliberately optional on
    // the wire (so a pre-#4767 source can still migrate), which removed it.
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    // An old target: acknowledges the sections it knows, silently omits the
    // brain. The exporter's manifest says otherwise.
    mockFetchResponse = {
      ok: true,
      status: 200,
      body: { conversations: { imported: 1, skipped: 0 } },
    };

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      // Actionable: names the section, the shortfall, and that nothing was
      // deleted — an operator must not have to guess whether to panic.
      expect(result.error).toContain("dashboards");
      expect(result.error).toContain("0/1");
      expect(result.error).toContain("no source data");
      // ⚠️ BOTH skew directions, since #5036. The message used to say the target
      // "is most likely running an older build" — but a new target reporting a
      // counter an OLD SOURCE cannot sum produces this same shortfall, and that
      // wording sent the operator to upgrade the one build that was already
      // current. Regions deploy independently, which is this test's own premise.
      expect(result.error).toContain("older target");
      expect(result.error).toContain("older SOURCE");
    }

    // The cutover must NOT have run. `region_updated` is what flips the
    // workspace's home region; reaching it would mean the source already
    // considers itself migrated.
    const cutover = capturedQueries.find(
      (q) => q.sql.includes("UPDATE organization") || q.sql.includes("region_updated = TRUE"),
    );
    expect(cutover).toBeUndefined();
  });

  it("PROCEEDS with cutover when the target REFUSED a vocabulary edge (#5036)", async () => {
    // The regression this pins is the one #5036 created and had to fix in the
    // same change. The merge gained a third outcome — an arriving alias edge
    // that would close a cycle or take a second parent is refused, logged and
    // skipped — and this reconciliation summed only `imported + skipped`. Left
    // that way, the FIRST genuinely conflicting alias edge in a workspace fails
    // the whole cutover, with an error message blaming an old target build.
    //
    // A refusal is ACCOUNTING, not loss: the target looked at the row, decided,
    // and logged enough to re-author it. What this guard exists to catch is a
    // target that silently DROPPED a section, which is a different event.
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    let vocabularyExpected = -1;
    let dashboardsExpected = -1;
    reshapeAck = (ack) => {
      const vocabulary = ack.brainVocabularyEdges;
      vocabularyExpected = vocabulary?.imported ?? 0;
      // ⚠️ A MIXED answer, not the all-refused extreme, and the three numbers are
      // deliberately DISTINCT: expected 3 = imported 2 + refused 1. All-refused
      // made `refused` equal to the section total, so an implementation that
      // reported the total instead of the refusal count satisfied every
      // assertion here — measured, and it survived. Mixed also keeps the
      // `imported` term live for the one section that has three counters.
      if (vocabulary) ack.brainVocabularyEdges = { imported: 2, skipped: 0, refused: 1 };
      // ⚠️ A SECOND section answering entirely in `skipped`, because otherwise
      // the `skipped` TERM of the sum is dead in every fixture in this file —
      // the generator, the explicit body above, and this hook all set
      // `skipped: 0`, so deleting `+ (got?.skipped ?? 0)` passes the whole
      // suite. Three terms are only distinguishable when at least two of them
      // are nonzero, which is this repo's recorded accidental-equality shape.
      const dashboards = ack.dashboards;
      dashboardsExpected = dashboards?.imported ?? 0;
      if (dashboards) ack.dashboards = { imported: 0, skipped: dashboardsExpected };
      return ack;
    };

    const result = await executeRegionMigration("mig-1");

    // ⚠️ Guards the test against becoming vacuous: reconciliation `continue`s on
    // a section whose manifest count is 0, so a fixture that stopped exporting
    // any vocabulary edge would make this pass while testing nothing.
    // Exactly 3, not merely nonzero: the split above is only meaningful if the
    // section really carries three rows, and a fixture change that collapsed it
    // back to 1 would silently restore the accidental equality.
    expect(vocabularyExpected).toBe(3);
    expect(dashboardsExpected).toBeGreaterThan(0);
    expect(result.success).toBe(true);

    // The positive control the assertion above cannot give on its own: the
    // cutover actually RAN. `success` with no region flip would be the same
    // symptom as the abort this test rules out.
    const cutover = capturedQueries.find(
      (q) => q.sql.includes("UPDATE organization") || q.sql.includes("region_updated = TRUE"),
    );
    expect(cutover).toBeDefined();

    // ⚠️ AND THE SOURCE SIDE SAYS SO. Proceeding quietly is the defect, not the
    // feature: THIS region schedules the cleanup that deletes the source's own
    // `brain_vocabulary_edge` rows after the grace period, while the only other
    // record of the dropped decisions is a warn in the TARGET region's process.
    // Without this assertion the entire disclosure can be deleted and the suite
    // stays green — measured, which is why the assertion exists.
    const disclosure = capturedWarns.find((w) => w.message.includes("REFUSED curated alias edges"));
    expect(disclosure).toBeDefined();
    // `1`, which is NOT the section total (3) and NOT the imported count (2) —
    // the whole point of the mixed fixture above.
    expect(disclosure?.payload).toMatchObject({
      migrationId: "mig-1",
      section: "brainVocabularyEdges",
      refused: 1,
    });
    // Names the delete timer, because that is what makes it urgent rather than
    // merely informational.
    expect(disclosure?.message).toContain("grace period");
  });

  it("ABORTS on a NEGATIVE counter, which would otherwise mask an over-import (#5036)", async () => {
    // The fail-OPEN direction, and the one an arithmetic guard cannot see on its
    // own. `acknowledged` is `as`-cast from another region's JSON and only its
    // top level is shape-checked, so a counter can be negative — and a negative
    // one balances the sum: `{imported: expected + 2, refused: -2}` totals
    // exactly `expected`, reconciles CLEAN, and cuts over having imported two
    // rows more than the bundle carried. `refused > 0` is false too, so the
    // disclosure stays silent. Every other malformed counter (NaN, fractional)
    // fails closed and is benign; this one does not.
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    let vocabularyExpected = -1;
    reshapeAck = (ack) => {
      const vocabulary = ack.brainVocabularyEdges;
      vocabularyExpected = vocabulary?.imported ?? 0;
      // Sums to exactly `expected`, so a guard that only checks the arithmetic
      // passes this.
      if (vocabulary) {
        ack.brainVocabularyEdges = { imported: vocabularyExpected + 2, skipped: 0, refused: -2 };
      }
      return ack;
    };

    const result = await executeRegionMigration("mig-1");

    expect(vocabularyExpected).toBe(3);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("unusable 'refused' counter");
      expect(result.error).toContain("no source data has been deleted");
    }

    // No cutover — which is what stops the source cleanup running against a
    // target whose own accounting is incoherent.
    const cutover = capturedQueries.find(
      (q) => q.sql.includes("UPDATE organization") || q.sql.includes("region_updated = TRUE"),
    );
    expect(cutover).toBeUndefined();
  });

  it("still ABORTS when a section that cannot refuse reports `refused` (#5036)", async () => {
    // The regression the FIRST cut of #5036's reconciliation fix introduced, and
    // the reason `refused` is section-scoped rather than added for every section.
    //
    // `brainVocabularyEdges` is the only section whose import can refuse
    // anything. Summed blanketly, a target answering
    // `brainFacts: {imported: 0, skipped: 0, refused: N}` — through a bug, a
    // proxy, or a future section half-implemented in one region — reconciles
    // CLEAN, the migration cuts over, and the source cleanup then DELETES N
    // facts that were never imported. That is exactly the silently-dropped-a-
    // section event this whole block exists to prevent, re-opened by one key.
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    let dashboardsExpected = -1;
    reshapeAck = (ack) => {
      const dashboards = ack.dashboards;
      dashboardsExpected = dashboards?.imported ?? 0;
      // A section with no refusal semantics claiming its whole count as refused.
      if (dashboards) ack.dashboards = { imported: 0, skipped: 0, refused: dashboardsExpected };
      return ack;
    };

    const result = await executeRegionMigration("mig-1");

    // Vacuity guard, as above: a 0-count section short-circuits before the sum.
    expect(dashboardsExpected).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("dashboards");
      // ⚠️ The DIAGNOSIS has to reach the durable surface. This string lands in
      // `region_migrations.error_message` and is what the API and CLI render;
      // the warn below is an ephemeral log line. Without this the one channel an
      // operator is guaranteed to read carries only the version-skew GUESS.
      expect(result.error).toContain("refused=");
      expect(result.error).toContain("no refusal outcome in this build");
    }

    // The warn is the other half, and it had NO falsifier — deleting the whole
    // block was green when this test only pinned the abort.
    const unexpected = capturedWarns.find((w) => w.message.includes("cannot refuse any"));
    expect(unexpected).toBeDefined();
    expect(unexpected?.payload).toMatchObject({
      section: "dashboards",
      refused: dashboardsExpected,
    });

    // The cutover must NOT have run — that is what stops the source cleanup
    // deleting rows the target never imported.
    const cutover = capturedQueries.find(
      (q) => q.sql.includes("UPDATE organization") || q.sql.includes("region_updated = TRUE"),
    );
    expect(cutover).toBeUndefined();
  });

  it("fails when transfer HTTP call returns error", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockFetchResponse = { ok: false, status: 500, body: { message: "Import failed — DB error" } };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Import failed");

    // Verify status set to failed
    const failedUpdate = capturedQueries.filter(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params.includes("failed"),
    );
    expect(failedUpdate.length).toBeGreaterThanOrEqual(1);
  });

  it("fails when transfer throws network error", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockFetchError = new Error("ECONNREFUSED");

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Network error");
  });

  it("marks migration as failed when workspace not found during cutover", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-999", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    // Organization update returns no rows
    mockPoolQueryResult = { rows: [] };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("not found");
  });

  it("marks migration as failed when export throws", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockPoolQueryError = new Error("connection refused");

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("connection refused");
  });

  // Regression: the dedicated Phase 3 persist runs immediately after the org
  // region UPDATE and before the status='completed' write. If a refactor moves
  // it behind the cache flush (or a Phase 4 step) a future failure between
  // those points would leave the guard column in a stale state.
  it("persists region_updated=TRUE between the org cutover and status=completed", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);

    const orgUpdateIdx = capturedQueries.findIndex((q) => q.sql.includes("UPDATE organization"));
    const persistIdx = capturedQueries.findIndex((q) => q.sql.includes("region_updated = TRUE"));
    const completeIdx = capturedQueries.findIndex(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params[0] === "completed",
    );

    expect(orgUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    // Strict ordering: cutover → persist → completed.
    expect(persistIdx).toBeGreaterThan(orgUpdateIdx);
    expect(persistIdx).toBeLessThan(completeIdx);
    // The persist UPDATE targets the right migration row.
    expect(capturedQueries[persistIdx].params).toContain("mig-1");
  });

  // Regression: even if the dedicated Phase 3 persist fails (transient pool
  // blip), the failure-path catch must atomically stamp region_updated=true
  // alongside status='failed' from the in-memory flag — otherwise the guard
  // fails open and the workspace ends up reset-eligible despite having moved.
  it("stamps region_updated=true atomically with status=failed when the dedicated persist throws", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    // Targeted injection: the dedicated `region_updated = TRUE` UPDATE
    // throws; every other write keeps working. This is the exact transient-
    // failure profile that, before the catch-block atomic stamp was added,
    // would leave the row with status='failed' and region_updated=FALSE
    // even though `organization.region` had already been flipped.
    mockInternalQueryRejectPattern = {
      pattern: "SET region_updated = TRUE",
      error: new Error("transient pool drop"),
    };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);

    // The org cutover succeeded before the persist throw fired.
    const orgUpdate = capturedQueries.find((q) => q.sql.includes("UPDATE organization"));
    expect(orgUpdate).toBeDefined();
    expect(orgUpdate!.params).toContain("eu-west");

    // The catch block writes status='failed' AND region_updated=true in a
    // single UPDATE via updateMigrationStatus. Confirm both land in the
    // same statement — partial state would mean the guard fails open.
    const failedUpdate = capturedQueries.find(
      (q) =>
        q.sql.includes("UPDATE region_migrations")
        && q.sql.includes("region_updated")
        && q.params.includes("failed"),
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.params).toContain(true);
  });

  // Regression: when the failure happens before Phase 3, the catch stamps
  // region_updated=FALSE — a no-op against the default but truthful about
  // the executor's observation. A future retry then legitimately re-runs
  // Phase 1 because the guard sees region_updated=FALSE.
  it("stamps region_updated=false when failure occurs before Phase 3", async () => {
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    mockFetchResponse = { ok: false, status: 500, body: { message: "Import failed" } };

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(false);

    // Phase 3 never ran, so no org UPDATE.
    const orgUpdate = capturedQueries.find((q) => q.sql.includes("UPDATE organization"));
    expect(orgUpdate).toBeUndefined();

    // The failed-status UPDATE includes region_updated=FALSE — the catch
    // converges on the executor's observation in both directions.
    const failedUpdate = capturedQueries.find(
      (q) =>
        q.sql.includes("UPDATE region_migrations")
        && q.sql.includes("region_updated")
        && q.params.includes("failed"),
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.params).toContain(false);
    expect(failedUpdate!.params).not.toContain(true);
  });
});

describe("failStaleMigrations", () => {
  beforeEach(resetMocks);

  // #4459 — the reaper runs on a periodic fiber (region_migration_stale_reap
  // in effect/layers.ts). The sweep interval must not exceed the stale
  // threshold, so a workspace whose migration crashed is unlocked within a
  // bounded window of at most threshold + one interval (~6 min today) without
  // operator action.
  it("exports a reap cadence that bounds the unlock window (#4459)", async () => {
    const { STALE_MIGRATION_REAP_INTERVAL_MS, STALE_THRESHOLD_MS } =
      await import("../migrate");
    expect(STALE_MIGRATION_REAP_INTERVAL_MS).toBeGreaterThan(0);
    expect(STALE_MIGRATION_REAP_INTERVAL_MS).toBeLessThanOrEqual(
      STALE_THRESHOLD_MS,
    );
  });

  it("returns zero counts when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await failStaleMigrations();
    expect(result).toEqual({ found: 0, reaped: 0 });
  });

  it("returns zero counts when no stale migrations exist", async () => {
    const result = await failStaleMigrations();
    expect(result).toEqual({ found: 0, reaped: 0 });
  });

  it("fails stale migrations", async () => {
    mockQueryResults["status = 'in_progress'"] = [
      { id: "mig-stale", workspace_id: "org-1" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await failStaleMigrations();
    expect(result).toEqual({ found: 1, reaped: 1 });

    const failedUpdate = capturedQueries.find(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params.includes("failed"),
    );
    expect(failedUpdate).toBeDefined();
  });

  // #4459 — one poisoned row must not block reaping the rest: the loop logs
  // the per-row failure and continues, so one stuck migration can't keep
  // every OTHER crashed workspace write-locked.
  it("continues past a row whose UPDATE fails and reaps the rest", async () => {
    mockQueryResults["status = 'in_progress'"] = [
      { id: "mig-stale-1", workspace_id: "org-1" },
      { id: "mig-stale-2", workspace_id: "org-2" },
    ];
    mockInternalQueryRejectPattern = {
      pattern: "UPDATE region_migrations",
      error: new Error("permission denied"),
      times: 1,
    };

    const result = await failStaleMigrations();
    expect(result).toEqual({ found: 2, reaped: 1 });

    const attemptedUpdates = capturedQueries.filter(
      (q) => q.sql.includes("UPDATE region_migrations") && q.params.includes("failed"),
    );
    expect(attemptedUpdates).toHaveLength(2);
  });

  // #4459 — stale rows found but NONE reapable is a failure, not a quiet
  // zero: the periodic fiber's tick must reject so the span records ERROR
  // and the warn-log recovery path fires (the workspace is still locked).
  it("throws when stale rows are found but none can be marked failed", async () => {
    mockQueryResults["status = 'in_progress'"] = [
      { id: "mig-stale", workspace_id: "org-1" },
    ];
    mockInternalQueryRejectPattern = {
      pattern: "UPDATE region_migrations",
      error: new Error("permission denied"),
    };

    await expect(failStaleMigrations()).rejects.toThrow(/remain write-locked/);
  });

  // The stale SELECT has no catch — a failure there must propagate so the
  // fiber tick records span ERROR instead of a quiet healthy-looking zero.
  it("propagates a failure of the stale SELECT itself", async () => {
    mockInternalQueryRejectPattern = {
      pattern: "WHERE status = 'in_progress'",
      error: new Error("connection reset"),
    };

    await expect(failStaleMigrations()).rejects.toThrow("connection reset");
  });
});

describe("getCleanupDueMigrations", () => {
  beforeEach(resetMocks);

  it("returns empty when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await getCleanupDueMigrations();
    expect(result).toHaveLength(0);
  });

  it("returns empty when no completed migrations past grace period", async () => {
    const result = await getCleanupDueMigrations();
    expect(result).toHaveLength(0);
  });

  it("returns migrations eligible for cleanup", async () => {
    mockQueryResults["status = 'completed'"] = [
      { id: "mig-old", workspace_id: "org-1", source_region: "us-east", completed_at: "2026-03-01T00:00:00Z" },
    ];

    const result = await getCleanupDueMigrations();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mig-old");
    expect(result[0].workspaceId).toBe("org-1");
    expect(result[0].sourceRegion).toBe("us-east");
  });
});

describe("resetMigrationForRetry", () => {
  beforeEach(resetMocks);

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_db");
      expect(result.error).toContain("Internal database");
    }
  });

  it("returns error when migration not found", async () => {
    const result = await resetMigrationForRetry("mig-nonexistent", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns not_found when workspace does not match", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "failed", workspace_id: "org-other" }];
    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns error when migration is not failed", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending", workspace_id: "org-1" }];
    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_status");
      expect(result.error).toContain("pending");
    }
  });

  it("resets a failed migration to pending", async () => {
    mockQueryResults["SELECT id, status"] = [
      { id: "mig-1", status: "failed", workspace_id: "org-1", region_updated: false, target_region: "eu-west", source_region: "us-east" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await resetMigrationForRetry("mig-1", "org-1");
    expect(result.ok).toBe(true);

    const resetQuery = capturedQueries.find(
      (q) => q.sql.includes("status = 'pending'"),
    );
    expect(resetQuery).toBeDefined();
    // #4459 — the reset must restart the staleness clock: failStaleMigrations
    // anchors its threshold to requested_at, and the reaper now sweeps every
    // minute, so a retry that kept the ORIGINAL requested_at would re-enter
    // in_progress already stale and be killed within one sweep.
    expect(resetQuery!.sql).toContain("requested_at = NOW()");
  });

  // Once Phase 3 has flipped the workspace into the destination region,
  // re-running Phase 1 (export from source) would re-export a workspace that
  // already moved. The guard makes the unsafe reset impossible from code; the
  // operator is forced to follow the manual-intervention runbook.
  it("throws UnsafeRegionMigrationResetError when region_updated=true", async () => {
    mockQueryResults["SELECT id, status"] = [
      { id: "mig-1", status: "failed", workspace_id: "org-1", region_updated: true, target_region: "eu-west", source_region: "us-east" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];

    let thrown: unknown;
    try {
      await resetMigrationForRetry("mig-1", "org-1");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    const tagged = thrown as { _tag?: string; migrationId?: string; sourceRegion?: string; targetRegion?: string; message?: string };
    expect(tagged._tag).toBe("UnsafeRegionMigrationResetError");
    expect(tagged.migrationId).toBe("mig-1");
    expect(tagged.sourceRegion).toBe("us-east");
    expect(tagged.targetRegion).toBe("eu-west");
    // Message names both regions so operators can find the orphaned source bundle.
    expect(tagged.message).toContain("us-east");
    expect(tagged.message).toContain("eu-west");

    // Critically: no UPDATE was issued. The row must remain in `failed` so
    // operators see it in the audit trail and follow the runbook.
    const resetQuery = capturedQueries.find((q) => q.sql.includes("status = 'pending'"));
    expect(resetQuery).toBeUndefined();
  });
});

describe("cancelMigration", () => {
  beforeEach(resetMocks);

  it("returns error when internal DB is not available", async () => {
    mockHasInternalDB = false;
    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_db");
      expect(result.error).toContain("Internal database");
    }
  });

  it("returns error when migration not found", async () => {
    const result = await cancelMigration("mig-nonexistent", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns not_found when workspace does not match", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending", workspace_id: "org-other" }];
    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns error when migration is not pending", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "in_progress", workspace_id: "org-1" }];
    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_status");
      expect(result.error).toContain("in_progress");
    }
  });

  it("cancels a pending migration", async () => {
    mockQueryResults["SELECT id, status"] = [{ id: "mig-1", status: "pending", workspace_id: "org-1" }];
    mockQueryResults["UPDATE region_migrations"] = [];

    const result = await cancelMigration("mig-1", "org-1");
    expect(result.ok).toBe(true);

    const cancelQuery = capturedQueries.find(
      (q) => q.sql.includes("status = 'cancelled'") && q.sql.includes("Cancelled by admin"),
    );
    expect(cancelQuery).toBeDefined();
  });
});
