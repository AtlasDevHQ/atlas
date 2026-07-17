/**
 * Tests for tool-side seeding (#4558, ADR-0034 Decision 1) — the shared
 * `seedDraftCards` batch used by `createDashboard` and the bound `addCard`.
 *
 * Pinned behavior (the acceptance criteria, at the module seam):
 *   - Each card runs through `runUserQueryPipeline` (the full validation / RLS /
 *     audit / masking guard) with its SQL, connection, and the shared resolved
 *     parameter values — never a privileged side-channel.
 *   - A card that returns rows is cached and reported `rows` (with rowCount);
 *     zero rows → `empty`.
 *   - A card whose pipeline outcome is non-ok is reported `error` and the batch
 *     still resolves for every other card (fail-soft — never throws).
 *   - A card still running when the wall-clock budget elapses is reported
 *     `unseeded` and its cache is never written.
 *   - A successful execution whose cache write fails is reported `unseeded`
 *     (staged, to be filled by the canvas-mount render) — never silently "rows".
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { UserQueryOutcome } from "@atlas/api/lib/tools/sql";
import type { SaveDraftCardCacheResult } from "@atlas/api/lib/dashboard-draft-cache";

// ---- mock the two collaborators (sync factories — bun deadlocks on async) ----

/** Per-call queue of pipeline behaviors, keyed by the card's SQL. */
const pipelineBySql = new Map<string, () => Promise<UserQueryOutcome>>();
const pipelineCalls: { sql: string; connectionId?: string; parameters?: Record<string, unknown> }[] =
  [];

const runUserQueryPipelineMock = mock(
  (opts: { sql: string; connectionId?: string; parameters?: Record<string, unknown> }) => {
    pipelineCalls.push({
      sql: opts.sql,
      connectionId: opts.connectionId,
      parameters: opts.parameters,
    });
    const behavior = pipelineBySql.get(opts.sql);
    if (!behavior) {
      return Promise.resolve<UserQueryOutcome>({
        kind: "query_failed",
        message: "no behavior registered for this sql",
      });
    }
    return behavior();
  },
);

void mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: runUserQueryPipelineMock,
}));

const saveCalls: { cardId: string; columns: string[]; rows: unknown[] }[] = [];
let saveResult: SaveDraftCardCacheResult = { ok: true, cachedAt: "2026-07-17T00:00:00.000Z" };

const saveDraftCardCacheMock = mock(
  (
    _userId: string,
    _dashboardId: string,
    cardId: string,
    result: { columns: string[]; rows: Record<string, unknown>[] },
  ) => {
    saveCalls.push({ cardId, columns: result.columns, rows: result.rows });
    return Promise.resolve(saveResult);
  },
);

void mock.module("@atlas/api/lib/dashboard-draft-cache", () => ({
  saveDraftCardCache: saveDraftCardCacheMock,
}));

const { seedDraftCards, SEED_WALL_CLOCK_BUDGET_MS } = await import(
  "@atlas/api/lib/dashboard-seeding"
);

// ---- helpers ------------------------------------------------------------

function okOutcome(rows: Record<string, unknown>[]): UserQueryOutcome {
  return {
    kind: "ok",
    columns: rows.length > 0 ? Object.keys(rows[0]) : ["n"],
    rows,
    rowCount: rows.length,
    executionMs: 1,
    truncated: false,
    maskingApplied: false,
  };
}

function registerOk(sql: string, rows: Record<string, unknown>[]) {
  pipelineBySql.set(sql, () => Promise.resolve(okOutcome(rows)));
}

const BASE = { userId: "user-1", dashboardId: "dash-1", parameters: {} };

beforeEach(() => {
  pipelineBySql.clear();
  pipelineCalls.length = 0;
  saveCalls.length = 0;
  saveResult = { ok: true, cachedAt: "2026-07-17T00:00:00.000Z" };
  runUserQueryPipelineMock.mockClear();
  saveDraftCardCacheMock.mockClear();
});

describe("seedDraftCards", () => {
  it("returns [] and runs nothing for an empty batch", async () => {
    const outcomes = await seedDraftCards({ ...BASE, cards: [] });
    expect(outcomes).toEqual([]);
    expect(pipelineCalls).toHaveLength(0);
    expect(saveCalls).toHaveLength(0);
  });

  it("caches a card that returns rows and reports rows + rowCount", async () => {
    registerOk("SELECT a", [{ a: 1 }, { a: 2 }]);
    const outcomes = await seedDraftCards({
      ...BASE,
      cards: [{ cardId: "c1", title: "A", sql: "SELECT a", connectionId: null }],
    });
    expect(outcomes).toEqual([{ cardId: "c1", title: "A", status: "rows", rowCount: 2 }]);
    expect(saveCalls).toEqual([{ cardId: "c1", columns: ["a"], rows: [{ a: 1 }, { a: 2 }] }]);
  });

  it("reports empty (and still caches) when the query returns zero rows", async () => {
    registerOk("SELECT none", []);
    const outcomes = await seedDraftCards({
      ...BASE,
      cards: [{ cardId: "c1", title: "Empty", sql: "SELECT none", connectionId: null }],
    });
    expect(outcomes).toEqual([{ cardId: "c1", title: "Empty", status: "empty" }]);
    // Even an empty result is cached — an honest "0 rows" tile, not "never run".
    expect(saveCalls).toHaveLength(1);
  });

  it("runs each card through the full pipeline with its connection + shared params", async () => {
    registerOk("SELECT a", [{ a: 1 }]);
    registerOk("SELECT b", [{ b: 1 }]);
    await seedDraftCards({
      userId: "user-1",
      dashboardId: "dash-1",
      parameters: { date_from: "2026-01-01", date_to: "2026-02-01" },
      cards: [
        { cardId: "c1", title: "A", sql: "SELECT a", connectionId: "conn-x" },
        { cardId: "c2", title: "B", sql: "SELECT b", connectionId: null },
      ],
    });
    const byId = new Map(pipelineCalls.map((c) => [c.sql, c]));
    expect(byId.get("SELECT a")?.connectionId).toBe("conn-x");
    // A null connection is passed as "no connectionId" (pipeline defaults it).
    expect(byId.get("SELECT b")?.connectionId).toBeUndefined();
    expect(byId.get("SELECT a")?.parameters).toEqual({
      date_from: "2026-01-01",
      date_to: "2026-02-01",
    });
  });

  it("is fail-soft: a non-ok pipeline outcome is reported error, siblings still seed", async () => {
    registerOk("SELECT good", [{ a: 1 }]);
    pipelineBySql.set("SELECT bad", () =>
      Promise.resolve<UserQueryOutcome>({
        kind: "query_failed",
        message: 'column "missing" does not exist',
      }),
    );
    const outcomes = await seedDraftCards({
      ...BASE,
      cards: [
        { cardId: "c1", title: "Good", sql: "SELECT good", connectionId: null },
        { cardId: "c2", title: "Bad", sql: "SELECT bad", connectionId: null },
      ],
    });
    expect(outcomes[0]).toEqual({ cardId: "c1", title: "Good", status: "rows", rowCount: 1 });
    expect(outcomes[1]).toEqual({
      cardId: "c2",
      title: "Bad",
      status: "error",
      message: 'column "missing" does not exist',
    });
    // The failing card was NOT cached; the good one was.
    expect(saveCalls.map((s) => s.cardId)).toEqual(["c1"]);
  });

  it("never throws when the pipeline rejects — reports error", async () => {
    pipelineBySql.set("SELECT boom", () => Promise.reject(new Error("kaboom")));
    const outcomes = await seedDraftCards({
      ...BASE,
      cards: [{ cardId: "c1", title: "Boom", sql: "SELECT boom", connectionId: null }],
    });
    expect(outcomes[0].status).toBe("error");
    expect(saveCalls).toHaveLength(0);
  });

  it("leaves a card unseeded (not failed) when the wall-clock budget elapses", async () => {
    registerOk("SELECT fast", [{ a: 1 }]);
    // Slow card resolves well after the tiny budget → the deadline wins.
    pipelineBySql.set(
      "SELECT slow",
      () => new Promise((resolve) => setTimeout(() => resolve(okOutcome([{ a: 1 }])), 200)),
    );
    const outcomes = await seedDraftCards({
      ...BASE,
      budgetMs: 10,
      cards: [
        { cardId: "c1", title: "Fast", sql: "SELECT fast", connectionId: null },
        { cardId: "c2", title: "Slow", sql: "SELECT slow", connectionId: null },
      ],
    });
    expect(outcomes[0]).toEqual({ cardId: "c1", title: "Fast", status: "rows", rowCount: 1 });
    expect(outcomes[1]).toEqual({ cardId: "c2", title: "Slow", status: "unseeded" });
    // The timed-out card is never cached.
    expect(saveCalls.map((s) => s.cardId)).toEqual(["c1"]);
  });

  it("reports unseeded (never a false rows) when the cache write fails", async () => {
    registerOk("SELECT a", [{ a: 1 }]);
    saveResult = { ok: false, reason: "no_draft" };
    const outcomes = await seedDraftCards({
      ...BASE,
      cards: [{ cardId: "c1", title: "A", sql: "SELECT a", connectionId: null }],
    });
    expect(outcomes[0]).toEqual({ cardId: "c1", title: "A", status: "unseeded" });
  });

  it("exposes a sane default wall-clock budget", () => {
    expect(SEED_WALL_CLOCK_BUDGET_MS).toBeGreaterThan(0);
    expect(SEED_WALL_CLOCK_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});
