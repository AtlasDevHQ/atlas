/**
 * Tests for region migration executor.
 *
 * Covers: successful migration with 4 phases (export, transfer, cutover, cleanup),
 * failure handling, retry, cancel, stale detection, cleanup detection, and edge cases.
 */

import { describe, it, expect, beforeEach, mock, afterEach, afterAll } from "bun:test";
// A plain const, so a static import cannot bind ahead of the `mock.module` calls
// below the way a logger or DB import would. From `lib/brain/vocabulary`, not
// `@useatlas/types` — see the constant's docstring for why a VALUE export in the
// published package broke every scaffold build.
import { VOCABULARY_REFUSAL_DETAIL_CAP } from "@atlas/api/lib/brain/vocabulary";

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

/**
 * Captured `log.info` payloads — `logMigrationEvent`'s channel (#5112).
 *
 * A SECOND array rather than one sink with the level in the payload, for
 * `capturedWarns`' reason exactly: the refusal disclosure is a `warn` and the
 * audit events are `info`, and a merged sink would pass a mutation that swapped
 * them. Two arrays make "which channel said this" part of what the assertions
 * can see.
 */
const capturedInfos: Array<{ payload: Record<string, unknown>; message: string }> = [];
/**
 * Captured `log.error` payloads — its own sink, for `capturedWarns`' reason.
 *
 * Needed since #5297's review: the fix that stopped driver text reaching the durable
 * `error_message` has TWO halves, and the second is that the raw text still goes
 * somewhere. A sink that merged levels would let "log it at debug" pass.
 */
const capturedErrors: Array<{ payload: Record<string, unknown>; message: string }> = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: (payload: unknown, message?: unknown) =>
      capturedInfos.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === "string" ? message : String(payload),
      }),
    warn: (payload: unknown, message?: unknown) =>
      capturedWarns.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === "string" ? message : String(payload),
      }),
    error: (payload: unknown, message?: unknown) =>
      capturedErrors.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === "string" ? message : String(payload),
      }),
    debug: () => {},
  }),
}));

/** Find one `logMigrationEvent` emission by its `event` name. */
function migrationEvent(event: string): Record<string, unknown> | undefined {
  return capturedInfos.find((i) => i.payload.event === event)?.payload;
}

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
  /**
   * #5112's refusal payloads. `unknown` deliberately, and not
   * `VocabularyRefusalDetail[]`: half the cases here answer with something a
   * well-behaved region would never send, which is the input the screening exists
   * for. A typed field would make those cases uncompilable and quietly narrow the
   * suite to the happy path.
   */
  refusalDetails?: unknown;
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
  screenRefusalDetails,
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
  capturedInfos.length = 0;
  capturedErrors.length = 0;
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

  // ── #5112 — the refusal record, durable at the SOURCE ───────────────
  //
  // #5036 gave the source a COUNT and left the recovery payload in the TARGET
  // region's log. This region schedules the cleanup that DELETEs its own
  // `brain_vocabulary_edge` rows after the grace period, so the party owning the
  // irreversible act held the number and another region's log retention held the
  // record. These cases pin the four places that changed: the durable write, the
  // two audit events, and the executor's own result.

  /**
   * One refusal payload as a well-behaved target sends it.
   *
   * `existingTarget` non-null, so the field is live: an implementation that wrote
   * `null` for every arm would satisfy a fixture whose value was already null,
   * which is this repo's recorded accidental-equality shape.
   */
  const refusalDetail = (fromNorm: string) => ({
    slotPosition: "predicate",
    fromNorm,
    toNorm: "priced at",
    approvedBy: "source-admin",
    approvedAt: "2026-06-01T00:00:00Z",
    refusal: "already-aliased",
    existingTarget: "cost",
    reason: `"${fromNorm}" is already aliased to "cost"`,
  });

  /**
   * Answer with a mixed vocabulary section: 2 imported, 1 refused out of 3
   * exported, plus `refusalDetails`.
   *
   * The three numbers stay DISTINCT for the reason the #5036 case above records —
   * with `expected`, `imported` and `refused` all equal, an implementation that
   * reported any one of them satisfies assertions about all of them.
   */
  /**
   * The exported vocabulary count the last `ackWithRefusals` actually saw.
   *
   * ⚠️ A PREMISE GUARD, and its absence was a real hole. The #5036 case above
   * captures the same number and asserts `toBe(3)` specifically so a fixture that
   * stopped exporting alias edges cannot make a test vacuous — `reshapeAck`'s
   * `if (ack.brainVocabularyEdges)` would go false, the write would record `0`/`null`,
   * and every `refused: 0` case here would still pass while proving nothing.
   * `expectVocabularyExported()` is what closes that.
   */
  let vocabularyExportedCount = -1;

  function ackWithRefusals(details: unknown, refused = 1): void {
    vocabularyExportedCount = -1;
    mockQueryResults["SELECT id, workspace_id"] = [
      { id: "mig-1", workspace_id: "org-1", source_region: "us-east", target_region: "eu-west", status: "pending" },
    ];
    mockQueryResults["UPDATE region_migrations"] = [];
    reshapeAck = (ack) => {
      const vocabulary = ack.brainVocabularyEdges;
      vocabularyExportedCount = vocabulary?.imported ?? 0;
      if (vocabulary) {
        ack.brainVocabularyEdges = {
          imported: 3 - refused,
          skipped: 0,
          refused,
          refusalDetails: details,
        };
      }
      return ack;
    };
  }

  /**
   * Assert the fixture really exported three alias edges.
   *
   * Exactly 3, not merely non-zero: `imported: 3 - refused` and every "distinct
   * numbers" claim in this group depend on the section carrying three rows, so a
   * fixture change that collapsed it to one would silently restore the accidental
   * equality the numbers are chosen to avoid.
   */
  function expectVocabularyExported(): void {
    expect(vocabularyExportedCount).toBe(3);
  }

  /** The `UPDATE region_migrations SET vocabulary_edges_refused = …` write. */
  function refusalRecordWrite(): { sql: string; params: unknown[] } | undefined {
    return capturedQueries.find((q) => q.sql.includes("vocabulary_edges_refused"));
  }

  it("⭐ RECORDS the refused count AND payloads on the source's own migration row", async () => {
    ackWithRefusals([refusalDetail("price")]);

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);
    expectVocabularyExported();

    const write = refusalRecordWrite();
    expect(write).toBeDefined();
    // `region_migrations`, not some other table — the platform-classified row is
    // the entire reason this survives the cleanup.
    expect(write?.sql).toContain("UPDATE region_migrations");
    expect(write?.params[0]).toBe("mig-1");
    // 1, which is neither the section total (3) nor the imported count (2).
    expect(write?.params[1]).toBe(1);
    // The payload goes in as JSON text bound to a `::jsonb` parameter. Parsed and
    // compared field-by-field: a length assertion would pass an implementation
    // that wrote the wrong arm of `VocabularyMergeRefusal`.
    expect(JSON.parse(String(write?.params[2]))).toEqual([refusalDetail("price")]);
  });

  it("⭐ KEEPS the refusal record when the migration fails AFTER the write", async () => {
    // The other half of the "PERSISTED BEFORE CUTOVER, not in Phase 4" decision, and
    // the half nothing tested. The comment's stated reason for the position is that
    // "the record exists even for a migration that never completes" — so a mutation
    // moving the write down past the cutover would satisfy every other case here
    // (the abort case only checks that cutover did NOT happen) while re-opening the
    // documented window: the target has committed a partial import, and the source
    // holds no record of it.
    ackWithRefusals([refusalDetail("price")]);
    // The cutover's `UPDATE organization ... RETURNING id` answering no rows is how
    // this file already makes Phase 3 throw.
    mockPoolQueryResult = { rows: [] };

    const result = await executeRegionMigration("mig-1");
    expectVocabularyExported();

    // Failed — after the record was written.
    expect(result.success).toBe(false);
    const write = refusalRecordWrite();
    expect(write).toBeDefined();
    expect(write?.params[1]).toBe(1);
    // The PAYLOAD too, not just the count: a write that landed the count and lost the
    // array would satisfy a presence check and leave nothing to re-author from.
    expect(JSON.parse(String(write?.params[2]))).toEqual([refusalDetail("price")]);
  });

  it("⭐ ABORTS BEFORE CUTOVER when the refusal record cannot be written", async () => {
    // The polarity that makes this feature worth having. Continuing past a failed
    // write would cut over and schedule the destructive cleanup while the only
    // durable record of a dropped human decision is a log line in another region —
    // the exact state #5112 removes, re-entered through the error path.
    ackWithRefusals([refusalDetail("price")]);
    // A driver message carrying the three kinds of infrastructure detail that must
    // never reach a workspace admin: an internal host and port, a row fragment, and an
    // internal column spelling. `errorMessage`'s scrub covers NONE of them — it
    // rewrites credential URIs only — so the guard has to be that the throw site does
    // not interpolate driver text at all.
    const DRIVER_LEAK =
      "connect ECONNREFUSED 10.0.3.7:5432 - DETAIL: Key (workspace_id)=(org-1) already exists, " +
      'column "vocabulary_refusals_internal" does not exist';
    mockInternalQueryRejectPattern = {
      pattern: "vocabulary_edges_refused",
      error: new Error(DRIVER_LEAK),
    };

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("refused alias edge");
      expect(result.error).toContain("BEFORE cutover");
      // ⭐ `result.error` IS `region_migrations.error_message`, which
      // `admin-residency.ts` returns verbatim to a workspace admin. The whole string
      // and each distinctive fragment, both directions — asserting only the whole
      // string passes a message that appended the detail, and asserting only the
      // fragments passes one that echoed a DIFFERENT driver error.
      expect(result.error).not.toContain(DRIVER_LEAK);
      for (const fragment of [
        "ECONNREFUSED",
        "10.0.3.7",
        "Key (workspace_id)=",
        "vocabulary_refusals_internal",
      ]) {
        expect(result.error, `the durable error message leaked ${fragment}`).not.toContain(fragment);
      }
      // And it says where the detail went, so the operator is not left guessing.
      expect(result.error).toContain("recorded server-side");
    }
    // ⚠️ THE OTHER HALF: the raw text is not discarded, it is logged. Without this the
    // fix could be "drop the message entirely", which trades a leak for a blind spot.
    // `capturedErrors` is its own sink, so the LEVEL is part of the claim.
    expect(
      capturedErrors.some((e) => String(e.payload.err).includes("ECONNREFUSED")),
      "the driver error was neither returned nor logged — it was swallowed",
    ).toBe(true);
    // ⚠️ THE LOAD-BEARING HALF: nothing was cut over, so nothing will be deleted.
    // Without this, an implementation that threw AFTER the cutover would satisfy
    // every assertion above while having scheduled the delete anyway.
    const cutover = capturedQueries.find(
      (q) => q.sql.includes("UPDATE organization") || q.sql.includes("region_updated = TRUE"),
    );
    expect(cutover).toBeUndefined();
  });

  it("⭐ SCRUBS a credential URI out of the durable error message", async () => {
    // The half `errorMessage` genuinely covers, and it was unfalsified until this case:
    // removing `errorMessage(err)` from the durable field left all 60 tests green,
    // because no fixture drove a credential-bearing error down that path. The scrub was
    // decoration.
    //
    // `error_message` is returned VERBATIM to a workspace admin by
    // `admin-residency.ts`'s `failed` arm, and `error-scrub.ts`'s own header names this
    // exact hazard: "pg / better-auth error text sometimes echoes the connection
    // string, so the DB password lands in the audit row verbatim".
    ackWithRefusals(undefined, 0);
    mockPoolQueryError = new Error(
      "connection terminated: postgres://atlas:hunter2@db.internal:5432/atlas",
    );

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      // The PASSWORD is gone and the scrubbed form is present — both, because asserting
      // only the absence passes a message that dropped the whole string, and asserting
      // only the presence passes one that appended the raw copy beside it.
      expect(result.error).not.toContain("hunter2");
      expect(result.error).toContain("postgres://***@db.internal:5432/atlas");
    }
    // And the raw text still reaches an operator, which is the same two-halves split the
    // abort case above pins.
    expect(capturedErrors.some((e) => String(e.payload.err).includes("hunter2"))).toBe(true);
  });

  it("does NOT abort when the record write fails and nothing was refused", async () => {
    // The other input class at the same guard. A migration that is going to lose
    // nothing must not fail on the bookkeeping FOR the loss — the two branches of
    // `evidence.refused > 0` are what make that a decision rather than an
    // accident, and a single-input test cannot tell them apart.
    ackWithRefusals(undefined, 0);
    mockInternalQueryRejectPattern = {
      pattern: "vocabulary_edges_refused",
      error: new Error("column does not exist"),
    };

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(true);
    if (result.success) expect(result.vocabularyEdgesRefused).toBe(0);
    const cutover = capturedQueries.find(
      (q) => q.sql.includes("UPDATE organization") || q.sql.includes("region_updated = TRUE"),
    );
    expect(cutover).toBeDefined();
    // ⚠️ AND THE CATCH SAID SO. Continuing is right; continuing SILENTLY is a
    // swallowed error, and the `log.warn` on that arm is the only signal it emits.
    // Without this, deleting the warn leaves a catch that says nothing and the test
    // stays green — which is the exact shape CLAUDE.md's error-handling rule forbids.
    expect(
      capturedWarns.some((w) =>
        w.message.includes("Could not record the vocabulary-refusal bookkeeping"),
      ),
      "the record-write catch continued without emitting anything",
    ).toBe(true);
  });

  it("records `null` rather than an empty array when there is nothing to recover", async () => {
    // So "migrations with recoverable payloads" is `IS NOT NULL` and does not have
    // to also know that `'[]'::jsonb` means the same thing.
    ackWithRefusals(undefined, 0);

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);

    const write = refusalRecordWrite();
    // `0`, not null — the target ANSWERED and refused nothing. NULL on the column
    // is reserved for "this build never asked", which is what a pre-0204 row is.
    expect(write?.params[1]).toBe(0);
    expect(write?.params[2]).toBeNull();
  });

  it("⭐ routes the count through BOTH migration audit events", async () => {
    // The disclosure was a bare `log.warn` sitting beside an audit channel built
    // for exactly this. `cleanup_scheduled` fires for the 7-day timer the
    // disclosure names, so the deadline and what expires with it are now one
    // record; `completed` carries it so the question "did this migration lose any
    // curated decisions" is answerable from the terminal event alone.
    ackWithRefusals([refusalDetail("price")]);

    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);

    expectVocabularyExported();

    const scheduled = migrationEvent("region_migration_cleanup_scheduled");
    expect(scheduled).toBeDefined();
    expect(scheduled).toMatchObject({
      vocabularyEdgesRefused: 1,
      vocabularyRefusalDetailsRecorded: 1,
      gracePeriodDays: expect.any(Number) as unknown as number,
    });

    const completed = migrationEvent("region_migration_completed");
    expect(completed).toBeDefined();
    expect(completed).toMatchObject({ vocabularyEdgesRefused: 1 });
  });

  it("⭐ surfaces the count on MigrationResult, distinct from imported and total", async () => {
    // AC-4's server half: the operator who pressed the button gets the number
    // without grepping a log stream. `1` is neither the section total (3) nor the
    // imported count (2), so an implementation returning either fails.
    ackWithRefusals([refusalDetail("price")]);

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(true);
    if (result.success) expect(result.vocabularyEdgesRefused).toBe(1);
  });

  it("carries the count on the success arm even when nothing was refused", async () => {
    // `0` is a claim, and it is the claim the CLI renders. An implementation that
    // only populated the field on the non-zero path would leave it `undefined`
    // here and the CLI would print nothing at all.
    ackWithRefusals(undefined, 0);
    const result = await executeRegionMigration("mig-1");
    expect(result.success).toBe(true);
    if (result.success) expect(result.vocabularyEdgesRefused).toBe(0);
  });

  it("keeps the count when a target predating #5112 sends NO payloads", async () => {
    // The cross-version case. A target between #5036 and #5112 answers with
    // `refused` and no `refusalDetails` at all — which must not abort, because
    // #5036's remedy (this region still holds its own rows for the grace period)
    // is intact. `refused` still has to survive.
    ackWithRefusals(undefined, 1);

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(true);
    if (result.success) expect(result.vocabularyEdgesRefused).toBe(1);
    const write = refusalRecordWrite();
    expect(write?.params[1]).toBe(1);
    expect(write?.params[2]).toBeNull();
    // And the disclosure says the payload count is SHORT of the refusal count,
    // which is the operator's signal that part of this has no record here.
    const disclosure = capturedWarns.find((w) => w.message.includes("REFUSED curated alias edges"));
    expect(disclosure?.payload).toMatchObject({ refused: 1, detailsRecorded: 0, malformedDetails: 0 });
  });

  it("⭐ SCREENS malformed refusal entries on the way to the durable row", async () => {
    // The integration half of the screening: what survives is what gets written and
    // what the disclosure counts. Every ARM of the screen, and the cap, are covered
    // by `screenRefusalDetails`' own describe below — the reconciliation here bounds
    // `refused` to the three edges the fixture exports, so those cases are simply
    // not expressible from this side.
    //
    // ⚠️ TWO distinct numbers do the work here — 1 kept, 2 dropped — so a screen that
    // kept everything (3/0) or nothing (0/3) fails. The `refused: 3` is NOT a third
    // independent number: with three edges exported it is simultaneously the section
    // total and the refusal count, so `params[1] === 3` cannot tell "reported the
    // refusal count" from "reported the section total". The siblings are what separate
    // those — the case above has refused 1 against a total of 3, and the payload cases
    // have 1 refused against 0 details. An earlier version of this comment claimed
    // three distinct numbers and was wrong about which ones were load-bearing.
    ackWithRefusals(
      [
        refusalDetail("price"),
        "not an object",
        { ...refusalDetail("margin"), fromNorm: undefined },
      ],
      3,
    );

    const result = await executeRegionMigration("mig-1");

    // Screening DROPS; it does not abort. The count still reconciles and this
    // region still holds its own rows, so failing a cutover over an unreadable
    // log-grade field would make the improvement a new way to fail.
    expect(result.success).toBe(true);

    const write = refusalRecordWrite();
    expect(write?.params[1]).toBe(3);
    expect(JSON.parse(String(write?.params[2]))).toEqual([refusalDetail("price")]);

    const disclosure = capturedWarns.find((w) => w.message.includes("REFUSED curated alias edges"));
    expect(disclosure?.payload).toMatchObject({
      refused: 3,
      detailsRecorded: 1,
      malformedDetails: 2,
    });
  });

  it("counts a non-array `refusalDetails` as malformed rather than throwing", async () => {
    ackWithRefusals({ nope: true }, 1);

    const result = await executeRegionMigration("mig-1");

    expect(result.success).toBe(true);
    const write = refusalRecordWrite();
    expect(write?.params[2]).toBeNull();
    const disclosure = capturedWarns.find((w) => w.message.includes("REFUSED curated alias edges"));
    expect(disclosure?.payload).toMatchObject({ detailsRecorded: 0, malformedDetails: 1 });
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

describe("screenRefusalDetails (#5112)", () => {
  /**
   * One well-formed entry. `existingTarget` is a STRING here, so the field is
   * live: an implementation that hardcoded `null` would satisfy a fixture whose
   * value was already null.
   */
  const good = (fromNorm: string) => ({
    slotPosition: "predicate",
    fromNorm,
    toNorm: "priced at",
    approvedBy: "source-admin",
    approvedAt: "2026-06-01T00:00:00Z",
    refusal: "already-aliased",
    existingTarget: "cost",
    reason: `"${fromNorm}" is already aliased to "cost"`,
  });

  it("passes a well-formed entry through unchanged", () => {
    const { details, malformed } = screenRefusalDetails([good("price")]);
    // Field-by-field, not by length: a screen that dropped `existingTarget` or
    // `reason` on the way through would still return one entry.
    expect(details).toEqual([good("price")]);
    expect(malformed).toBe(0);
  });

  it("⭐ STRIPS keys the type does not declare", () => {
    // The property that makes this a SCREEN rather than a cast, and the one every
    // other fixture in this file agreed with by construction — they all carry exactly
    // the eight declared keys, so `push(entry as VocabularyRefusalDetail)` satisfies
    // them all. That mutation puts a foreign region's arbitrary extra keys — unbounded
    // size, unvalidated content — into this region's `jsonb` column under a name that
    // claims a shape, which is the whole thesis of the function.
    //
    // `toEqual` fails on EXTRA properties (unlike `toMatchObject`), which is what makes
    // this assertion able to go red.
    const raw = {
      ...good("price"),
      attacker: "<script>alert(1)</script>",
      nested: { deep: [1, 2, 3] },
    };
    const { details, malformed } = screenRefusalDetails([raw]);
    expect(details).toEqual([good("price")]);
    expect(malformed).toBe(0);
    // Named explicitly, because the `toEqual` above is the kind of assertion whose
    // strictness a future reader might soften without realising what it was for.
    expect(Object.keys(details[0])).not.toContain("attacker");
  });

  it("treats `undefined` and `null` as NOTHING TO SCREEN, not as malformed", () => {
    // A target predating #5112 omits the key entirely. That is a build, not a bug,
    // and reporting it as malformed would tell an operator a region is broken.
    expect(screenRefusalDetails(undefined)).toEqual({ details: [], malformed: 0 });
    expect(screenRefusalDetails(null)).toEqual({ details: [], malformed: 0 });
  });

  it("counts a non-array as ONE malformed thing", () => {
    // Not an array at all — an object, a string, a number. One malformed
    // "collection", because there are no entries to count individually.
    for (const raw of [{ nope: true }, "refusals", 7, true]) {
      expect(screenRefusalDetails(raw)).toEqual({ details: [], malformed: 1 });
    }
  });

  it("⭐ drops each malformed ENTRY KIND and keeps the good ones beside them", () => {
    // ⚠️ Four bad entries, each a different SHAPE, with a good entry either side so
    // a screen that bailed on the first bad one cannot pass. FOUR bad, TWO good —
    // distinct counts, so neither "kept everything" nor "kept nothing" satisfies
    // this.
    //
    // ⚠️ These four are not four independently falsifiable ARMS, and the comment
    // that first said they were was wrong. Measured: deleting `Array.isArray(entry)`
    // from the screen kills nothing, because an array carries none of the required
    // string fields and the field check rejects it regardless. The array and `null`
    // cases are here as SHAPES a foreign region might really send, not as proof that
    // each clause is load-bearing — only `null` and the missing-string case are.
    const { details, malformed } = screenRefusalDetails([
      good("price"),
      // Not an object at all.
      "not an object",
      // An array — `typeof "object"`, but with no fields. Rejected by the field
      // check even without the explicit `Array.isArray` clause.
      [good("margin")],
      // `null` — also `typeof "object"`, and the one that THROWS without the
      // explicit null check rather than merely failing it.
      null,
      // A required string missing.
      { ...good("margin"), toNorm: undefined },
      good("cost"),
    ]);

    expect(details).toEqual([good("price"), good("cost")]);
    expect(malformed).toBe(4);
  });

  it("⭐ requires `approvedBy` and `existingTarget` to be PRESENT, null included", () => {
    // `null` is a VALUE on both — an auto-approved edge, and a refusal arm with no
    // conflicting edge. So `null` passes and MISSING is malformed: reading a missing
    // key as `null` would invent "auto-approved" for an entry that never said, and
    // invent "there is no conflicting edge" for one that simply omitted it.
    //
    // Two assertions in one test because they are one rule, and the pair is what
    // makes it falsifiable: a screen that accepted `undefined` passes the first
    // half's `null` case on its own.
    const nulls = { ...good("price"), approvedBy: null, existingTarget: null };
    expect(screenRefusalDetails([nulls])).toEqual({ details: [nulls], malformed: 0 });

    const { approvedBy: _a, ...missingApprovedBy } = good("price");
    const { existingTarget: _e, ...missingExistingTarget } = good("margin");
    expect(screenRefusalDetails([missingApprovedBy, missingExistingTarget])).toEqual({
      details: [],
      malformed: 2,
    });
  });

  it("rejects a non-string, non-null value on the nullable fields", () => {
    // `0` and `false` are the ones a truthiness check lets through.
    const { details, malformed } = screenRefusalDetails([
      { ...good("price"), approvedBy: 0 },
      { ...good("margin"), existingTarget: false },
    ]);
    expect(details).toEqual([]);
    expect(malformed).toBe(2);
  });

  it("⭐ CAPS what it returns, and the excess is BOUNDED rather than malformed", () => {
    // The producer's cap is a promise about a well-behaved region; this one is a
    // property of what this region will store in its own `jsonb` column, and a
    // target that ignores the cap is exactly the target whose payload should not
    // size a row here.
    //
    // Counting the excess malformed would report a target bug for behaviour this
    // build defines — so `malformed` must be 0 even though entries were discarded.
    const over = VOCABULARY_REFUSAL_DETAIL_CAP + 7;
    const { details, malformed } = screenRefusalDetails(
      Array.from({ length: over }, (_, i) => good(`norm-${i}`)),
    );
    expect(details).toHaveLength(VOCABULARY_REFUSAL_DETAIL_CAP);
    expect(malformed).toBe(0);
    // The FIRST cap entries, not an arbitrary slice — the arriving order is the
    // source's export order (`slot_position, from_norm ASC`), so a truncated list
    // that started in the middle would be harder to reconcile against the source.
    expect(details[0]).toEqual(good("norm-0"));
    expect(details[VOCABULARY_REFUSAL_DETAIL_CAP - 1]).toEqual(
      good(`norm-${VOCABULARY_REFUSAL_DETAIL_CAP - 1}`),
    );
  });

  it("counts malformed entries only within the cap it examines", () => {
    // A pathological target sending cap+N entries where the bad ones are past the
    // cap. Nothing beyond the cap is read, so nothing beyond it can be reported —
    // which keeps `malformed` a statement about what this region looked at.
    const raw: unknown[] = Array.from({ length: VOCABULARY_REFUSAL_DETAIL_CAP }, (_, i) =>
      good(`norm-${i}`),
    );
    raw.push("garbage", "more garbage");
    const { details, malformed } = screenRefusalDetails(raw);
    expect(details).toHaveLength(VOCABULARY_REFUSAL_DETAIL_CAP);
    expect(malformed).toBe(0);
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
