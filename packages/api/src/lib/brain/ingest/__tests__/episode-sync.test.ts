/**
 * The brain episode sync engine (#4770) — the fork's attempt shape.
 *
 * What is worth testing here is precisely what the module does NOT own:
 * ADR-0036 reuses the ADR-0030 engine verbatim, so the tests assert that the
 * reused pieces are actually driving (cadence decides the mode, the shared
 * backoff sees the 429, the shared cap bounds the fetch, the shared
 * bookkeeping records the attempt) rather than re-testing them.
 *
 * The layering rule this suite lives under: `episode-sync.ts` never touches a
 * database handle directly — it reaches storage through
 * `connector-sync.ts`'s bookkeeping helpers and through `ingestEpisodes`, and
 * both of those modules (plus `knowledge-limits`) are `mock.module()`d here
 * with EVERY export stubbed (CLAUDE.md). The point is the control flow; the SQL
 * has its own real-Postgres suite in `episodes-pg.test.ts`.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import type { EpisodeIngestReport } from "@atlas/api/lib/brain/ingest/episodes";
import type {
  BrainEpisodeRecord,
  BrainSourceConnector,
  BrainSourceFetchParams,
} from "@atlas/api/lib/brain/ingest/types";

// ── Stubs ──────────────────────────────────────────────────────────────────
// Recorded per test; the mocks below close over these.

let syncStateRow: {
  highWaterMark: string | null;
  cursor: string | null;
  lastReconciledAt: string | null;
} = { highWaterMark: null, cursor: null, lastReconciledAt: null };
let stateWrites: Record<string, unknown>[] = [];
let ingested: { workspaceId: string; source: string; episodes: readonly BrainEpisodeRecord[] }[] = [];
let ingestThrows: Error | null = null;
let maxDocs = 1000;
let capsThrow: Error | null = null;

void mock.module("@atlas/api/lib/knowledge/connector-sync", () => ({
  // Reused engine surface, faithfully shaped.
  SYNC_OVERLAP_WINDOW_MS: 5 * 60 * 1000,
  RATE_LIMIT_MAX_ATTEMPTS: 3,
  RATE_LIMIT_DEFAULT_WAIT_MS: 2_000,
  RATE_LIMIT_MAX_WAIT_MS: 60_000,
  DEFAULT_SYNC_RECONCILE_INTERVAL_HOURS: 168,
  CONNECTOR_SYNC_STATE_SELECT_SQL: "select",
  CONNECTOR_SYNC_STATE_UPSERT_SQL: "upsert",
  getKnowledgeSyncReconcileIntervalMs: () => 168 * 3_600_000,
  readConnectorSyncState: async () => syncStateRow,
  upsertConnectorSyncState: async (
    _workspaceId: string,
    _installId: string,
    write: Record<string, unknown>,
  ) => {
    stateWrites.push(write);
  },
  // A FAITHFUL REIMPLEMENTATION of the engine's backoff, not the real function
  // (mock.module replaces the whole module). It is shaped this way so that
  // REMOVING the backoff wrapper from `episode-sync.ts` is caught — the attempt
  // count drops to 1 — which is the regression that matters here. It does NOT
  // pin the engine's constants: `RATE_LIMIT_MAX_ATTEMPTS` is a literal below,
  // so a change to the real one would not surface in this suite.
  withRateLimitBackoff: async <T>(
    fn: () => Promise<T>,
    opts?: { sleep?: (ms: number) => Promise<void>; maxAttempts?: number },
  ): Promise<T> => {
    const maxAttempts = opts?.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ConnectorRateLimitError) || attempt >= maxAttempts) throw err;
        await (opts?.sleep ?? (async () => {}))(1);
      }
    }
  },
  syncConnectorCollection: async () => {
    throw new Error("the brain arm must never call the document engine");
  },
}));

void mock.module("@atlas/api/lib/billing/knowledge-limits", () => ({
  resolveIngestCaps: async () => {
    if (capsThrow) throw capsThrow;
    return {
      maxDocs: { value: maxDocs, boundBy: "platform" },
      maxBundleBytes: { value: 1, boundBy: "platform" },
      maxDocBytes: { value: 1, boundBy: "platform" },
    };
  },
  capIsOperatorTunable: () => true,
  lowestTierAdmitting: () => null,
  // CLAUDE.md: mock ALL exports. A partial factory is what produces
  // "Export named 'X' not found" in an unrelated file the moment someone adds
  // an import — the failure lands nowhere near this file.
  resolveKnowledgeTierLimits: () => ({}),
  assertNotTierBound: () => {},
  minKnowledgeCap: (a: number) => a,
  assertIngestCapsFor: async () => {},
}));

void mock.module("@atlas/api/lib/brain/ingest/episodes", () => ({
  INSERT_EPISODES_SQL: "insert",
  ingestEpisodes: async (params: {
    workspaceId: string;
    source: string;
    episodes: readonly BrainEpisodeRecord[];
  }) => {
    if (ingestThrows) throw ingestThrows;
    ingested.push(params);
    return {
      inserted: params.episodes.length,
      duplicate: 0,
      refused: {
        blank_source_id: 0,
        blank_body: 0,
        unusable_grant: 0,
        invalid_occurred_at: 0,
      },
      batchDuplicate: 0,
    } satisfies EpisodeIngestReport;
  },
}));

const { syncBrainEpisodeSource } = await import("@atlas/api/lib/brain/ingest/episode-sync");

// ── Fixtures ───────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-01T12:00:00.000Z");

function episode(sourceId: string): BrainEpisodeRecord {
  return {
    sourceId,
    sourceActor: "U1",
    body: "evidence",
    occurredAt: new Date("2026-06-30T00:00:00.000Z"),
    visibleTo: ["org"],
  };
}

function connectorReturning(
  fetchEpisodes: (params: BrainSourceFetchParams) => Promise<{
    episodes: readonly BrainEpisodeRecord[];
    highWaterMark: string | null;
    cursor?: string | null;
    coverageIncomplete?: boolean;
    warnings?: readonly string[];
  }>,
): BrainSourceConnector {
  return { catalogId: "catalog:fixture", source: "fixture", createClient: () => ({ fetchEpisodes }) };
}

function run(connector: BrainSourceConnector) {
  return syncBrainEpisodeSource({
    connector,
    workspaceId: "ws-1",
    installId: "install-1",
    config: {},
    now: () => NOW,
    sleep: async () => {},
  });
}

beforeEach(() => {
  syncStateRow = { highWaterMark: null, cursor: null, lastReconciledAt: null };
  stateWrites = [];
  ingested = [];
  ingestThrows = null;
  capsThrow = null;
  maxDocs = 1000;
});

// ══════════════════════════════════════════════════════════════════
// The reused cadence decides the mode
// ══════════════════════════════════════════════════════════════════

describe("cadence (reused from the ADR-0030 engine)", () => {
  it("reconciles a source that has never synced", async () => {
    let seen: BrainSourceFetchParams | null = null;
    const outcome = await run(
      connectorReturning(async (params) => {
        seen = params;
        return { episodes: [], highWaterMark: null };
      }),
    );
    expect(seen!.mode).toBe("reconciliation");
    expect(outcome.mode).toBe("reconciliation");
  });

  it("runs incrementally once a mark exists and the reconcile clock is fresh", async () => {
    syncStateRow = {
      highWaterMark: "2026-07-01T11:00:00.000Z",
      cursor: "{}",
      lastReconciledAt: "2026-07-01T00:00:00.000Z",
    };
    let seen: BrainSourceFetchParams | null = null;
    await run(
      connectorReturning(async (params) => {
        seen = params;
        return { episodes: [], highWaterMark: null };
      }),
    );
    expect(seen!.mode).toBe("incremental");
    // The engine's overlap window rewinds the mark by 5 minutes.
    expect(seen!.since).toBe("2026-07-01T10:55:00.000Z");
    expect(seen!.cursor).toBe("{}");
  });

  it("reconciles again once the clock is due", async () => {
    syncStateRow = {
      highWaterMark: "2026-07-01T11:00:00.000Z",
      cursor: null,
      lastReconciledAt: "2026-01-01T00:00:00.000Z",
    };
    let seen: BrainSourceFetchParams | null = null;
    await run(
      connectorReturning(async (params) => {
        seen = params;
        return { episodes: [], highWaterMark: null };
      }),
    );
    expect(seen!.mode).toBe("reconciliation");
  });
});

// ══════════════════════════════════════════════════════════════════
// Caps and backoff come from the engine, not from the source
// ══════════════════════════════════════════════════════════════════

describe("caps and backoff", () => {
  it("hands the client the workspace's effective per-sync cap", async () => {
    maxDocs = 42;
    let seen: BrainSourceFetchParams | null = null;
    await run(
      connectorReturning(async (params) => {
        seen = params;
        return { episodes: [], highWaterMark: null };
      }),
    );
    expect(seen!.maxEpisodes).toBe(42);
  });

  it("refuses the whole batch when a client overshoots the cap it was given", async () => {
    // A partial store whose high-water mark claimed to cover the dropped
    // records would be worse than storing nothing — the gap would be
    // permanent and invisible.
    maxDocs = 2;
    const outcome = await run(
      connectorReturning(async () => ({
        episodes: [episode("a"), episode("b"), episode("c")],
        highWaterMark: "2026-06-30T00:00:00.000Z",
      })),
    );
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("over the 2-record per-sync limit");
    expect(ingested).toHaveLength(0);
  });

  it("retries through the shared 429 backoff, then reports exhaustion actionably", async () => {
    let attempts = 0;
    const outcome = await run(
      connectorReturning(async () => {
        attempts++;
        throw new ConnectorRateLimitError("throttled", 7);
      }),
    );
    expect(attempts).toBe(3);
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("rate limiting");
    expect(outcome.error).toContain("Retry-After 7s");
  });

  it("succeeds when the retry succeeds", async () => {
    let attempts = 0;
    const outcome = await run(
      connectorReturning(async () => {
        if (++attempts === 1) throw new ConnectorRateLimitError("throttled", null);
        return { episodes: [episode("a")], highWaterMark: "2026-06-30T00:00:00.000Z" };
      }),
    );
    expect(outcome.status).toBe("success");
    expect(outcome.episodes?.inserted).toBe(1);
  });

  it("reports a caps lookup failure as itself, not as a cap refusal", async () => {
    capsThrow = new Error("tier lookup timed out");
    const outcome = await run(connectorReturning(async () => ({ episodes: [], highWaterMark: null })));
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("tier lookup timed out");
  });
});

// ══════════════════════════════════════════════════════════════════
// Bookkeeping — the shared state row, with the fork's report shape
// ══════════════════════════════════════════════════════════════════

describe("bookkeeping", () => {
  it("advances the mark, cursor, and reconcile clock on a complete pass", async () => {
    const outcome = await run(
      connectorReturning(async () => ({
        episodes: [episode("a")],
        highWaterMark: "2026-06-30T00:00:00.000Z",
        cursor: '{"v":1}',
      })),
    );
    expect(outcome.status).toBe("success");
    const write = stateWrites[0]!;
    expect(write.highWaterMark).toBe("2026-06-30T00:00:00.000Z");
    expect(write.cursor).toBe('{"v":1}');
    expect(write.reconciledAt).toBe(NOW.toISOString());
  });

  it("holds the reconcile clock when coverage was incomplete", async () => {
    // A partially-covered pass must stay DUE, so the uncovered window gets a
    // wide re-crawl soon rather than in a week.
    await run(
      connectorReturning(async () => ({
        episodes: [episode("a")],
        highWaterMark: "2026-06-30T00:00:00.000Z",
        coverageIncomplete: true,
        warnings: ["C2 was not read this cycle"],
      })),
    );
    const write = stateWrites[0]!;
    expect(write.reconciledAt).toBeNull();
    const report = write.report as { coverageIncomplete: boolean; warnings: string[] };
    // Persisted so a coverage-incomplete "success" is never silently green.
    expect(report.coverageIncomplete).toBe(true);
    expect(report.warnings).toEqual(["C2 was not read this cycle"]);
  });

  it("passes NULLs on an error so the engine COALESCEs the old mark forward", async () => {
    ingestThrows = new Error("connection reset");
    const outcome = await run(
      connectorReturning(async () => ({
        episodes: [episode("a")],
        highWaterMark: "2026-06-30T00:00:00.000Z",
        cursor: '{"v":1}',
      })),
    );
    expect(outcome.status).toBe("error");
    const write = stateWrites[0]!;
    // A failed cycle must never skip the records it failed to ingest.
    expect(write.highWaterMark).toBeNull();
    expect(write.cursor).toBeNull();
    expect(write.reconciledAt).toBeNull();
  });

  it("drops an unparseable high-water mark instead of failing the sync on it", async () => {
    const outcome = await run(
      connectorReturning(async () => ({ episodes: [episode("a")], highWaterMark: "not-a-date" })),
    );
    expect(outcome.status).toBe("success");
    expect(stateWrites[0]!.highWaterMark).toBeNull();
  });

  it("records the REAL mode when the failure came after the mode was decided", async () => {
    const outcome = await syncBrainEpisodeSource({
      connector: {
        catalogId: "catalog:fixture",
        source: "fixture",
        createClient: () => {
          throw new Error("unreachable");
        },
      },
      workspaceId: "ws-1",
      installId: "install-1",
      config: {},
      now: () => NOW,
    });
    // `createClient` runs AFTER the mode decision, so this one is honest about
    // knowing the mode — the `unknown` arm is for failures before it.
    expect(outcome.mode).toBe("reconciliation");
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("unreachable");
  });
});

describe("never throws", () => {
  it("turns a client that rejects with a non-Error into an error outcome", async () => {
    const outcome = await run(
      connectorReturning(async () => {
        // A non-Error rejection: the outcome must still be a recorded error,
        // not an unhandled rejection out of a scheduler tick.
        throw "boom";
      }),
    );
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("boom");
  });

  it("stamps the source into every ingest call", async () => {
    await run(
      connectorReturning(async () => ({ episodes: [episode("a")], highWaterMark: null })),
    );
    expect(ingested[0]!.source).toBe("fixture");
    expect(ingested[0]!.workspaceId).toBe("ws-1");
  });
});
