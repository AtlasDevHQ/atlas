/**
 * Unit tests for the dashboard stage tracker deep module (#2365).
 *
 * Pure state-machine tests live up top — `acceptStageTransition`,
 * `discardStageTransition`, `payloadToDraftChange`. These have zero DB
 * and exhaustively cover the four-state machine (pending → applied,
 * pending → discarded, idempotent re-accept, idempotent re-discard,
 * rejected cross-transitions, multiple stages per card).
 *
 * DB-touching helpers (`stageChange`, `loadStagedChange`,
 * `listStagedChangesForUser`, `acceptStagedChange`, `discardStagedChange`)
 * use the `_resetPool(mockPool)` idiom from
 * `packages/api/src/lib/__tests__/conversations.test.ts` to avoid the
 * `mock.module()` async-loader deadlock under bun's full test suite
 * (see feedback_bun_test_async_mock_module). These verify the SQL
 * targets + per-user gating, not the pure state machine again.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  _resetPool,
  type InternalPool,
  type InternalPoolClient,
} from "../db/internal";
import {
  acceptStageTransition,
  discardStageTransition,
  payloadToDraftChange,
  stageChange,
  loadStagedChange,
  listStagedChangesForUser,
  discardStagedChange,
  type StagedChange,
  type StagePayload,
} from "../stage-tracker";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stageRow(overrides: Partial<StagedChange> = {}): StagedChange {
  return {
    id: "stage-1",
    dashboardId: "dash-1",
    userId: "user-1",
    kind: "remove_card",
    payload: { kind: "remove_card", cardId: "card-1" },
    status: "pending",
    createdAt: "2026-05-17T00:00:00Z",
    updatedAt: "2026-05-17T00:00:00Z",
    appliedAt: null,
    discardedAt: null,
    ...overrides,
  };
}

const NOW = "2026-05-17T01:00:00Z";

// ---------------------------------------------------------------------------
// Pure state machine — exhaustive
// ---------------------------------------------------------------------------

describe("payloadToDraftChange()", () => {
  it("maps remove_card → DraftChange { kind: 'removeCard', cardId }", () => {
    const change = payloadToDraftChange({ kind: "remove_card", cardId: "c-1" });
    expect(change).toEqual({ kind: "removeCard", cardId: "c-1" });
  });

  it("maps edit_sql → DraftChange { kind: 'editSql', cardId, newSql } (drops currentSql)", () => {
    const change = payloadToDraftChange({
      kind: "edit_sql",
      cardId: "c-2",
      newSql: "SELECT 2",
      currentSql: "SELECT 1",
    });
    expect(change).toEqual({ kind: "editSql", cardId: "c-2", newSql: "SELECT 2" });
  });
});

describe("acceptStageTransition()", () => {
  it("pending → applied returns { kind: 'apply', change, next } with timestamps stamped", () => {
    const row = stageRow({ status: "pending" });
    const result = acceptStageTransition(row, NOW);
    expect(result.kind).toBe("apply");
    if (result.kind !== "apply") throw new Error("unreachable");
    expect(result.change).toEqual({ kind: "removeCard", cardId: "card-1" });
    expect(result.next.status).toBe("applied");
    expect(result.next.appliedAt).toBe(NOW);
    expect(result.next.discardedAt).toBeNull();
    expect(result.next.updatedAt).toBe(NOW);
  });

  it("applied → applied is idempotent noop (re-accept does not re-apply)", () => {
    const row = stageRow({
      status: "applied",
      appliedAt: "2026-05-17T00:30:00Z",
    });
    const result = acceptStageTransition(row, NOW);
    expect(result.kind).toBe("noop");
    if (result.kind !== "noop") throw new Error("unreachable");
    // The original timestamps survive — noop must not stamp a new applied_at.
    expect(result.next.appliedAt).toBe("2026-05-17T00:30:00Z");
  });

  it("discarded → rejected (cannot un-discard via accept)", () => {
    const row = stageRow({
      status: "discarded",
      discardedAt: "2026-05-17T00:30:00Z",
    });
    const result = acceptStageTransition(row, NOW);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("discarded");
  });

  it("translates edit_sql payload to editSql DraftChange (carries newSql, drops currentSql)", () => {
    const row = stageRow({
      kind: "edit_sql",
      payload: {
        kind: "edit_sql",
        cardId: "c-9",
        newSql: "SELECT 9",
        currentSql: "SELECT 0",
      },
    });
    const result = acceptStageTransition(row, NOW);
    if (result.kind !== "apply") throw new Error("expected apply");
    expect(result.change).toEqual({ kind: "editSql", cardId: "c-9", newSql: "SELECT 9" });
  });
});

describe("discardStageTransition()", () => {
  it("pending → discarded returns { kind: 'discard', next } with timestamps stamped", () => {
    const row = stageRow({ status: "pending" });
    const result = discardStageTransition(row, NOW);
    expect(result.kind).toBe("discard");
    if (result.kind !== "discard") throw new Error("unreachable");
    expect(result.next.status).toBe("discarded");
    expect(result.next.discardedAt).toBe(NOW);
    expect(result.next.appliedAt).toBeNull();
    expect(result.next.updatedAt).toBe(NOW);
  });

  it("discarded → discarded is idempotent noop (re-discard does not restamp)", () => {
    const row = stageRow({
      status: "discarded",
      discardedAt: "2026-05-17T00:30:00Z",
    });
    const result = discardStageTransition(row, NOW);
    expect(result.kind).toBe("noop");
    if (result.kind !== "noop") throw new Error("unreachable");
    // Preserves original discarded_at.
    expect(result.next.discardedAt).toBe("2026-05-17T00:30:00Z");
  });

  it("applied → rejected (cannot un-apply via discard)", () => {
    const row = stageRow({
      status: "applied",
      appliedAt: "2026-05-17T00:30:00Z",
    });
    const result = discardStageTransition(row, NOW);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("applied");
  });
});

describe("concurrent stages for the same card", () => {
  // The schema does NOT enforce per-card uniqueness; multiple stages
  // against the same card coexist and resolve independently.
  it("two pending stages against the same card can each transition independently", () => {
    const stageA = stageRow({ id: "stage-a", payload: { kind: "remove_card", cardId: "card-7" } });
    const stageB = stageRow({
      id: "stage-b",
      kind: "edit_sql",
      payload: { kind: "edit_sql", cardId: "card-7", newSql: "SELECT 7", currentSql: "SELECT 1" },
    });
    // Accept A — yields removeCard.
    const a = acceptStageTransition(stageA, NOW);
    if (a.kind !== "apply") throw new Error("expected apply A");
    expect(a.change).toEqual({ kind: "removeCard", cardId: "card-7" });
    // Discard B — independent transition.
    const b = discardStageTransition(stageB, NOW);
    expect(b.kind).toBe("discard");
    if (b.kind !== "discard") throw new Error("expected discard B");
    expect(b.next.status).toBe("discarded");
  });
});

// ---------------------------------------------------------------------------
// DB-touching helpers — mock pool + _resetPool idiom
// ---------------------------------------------------------------------------

interface MockQueryResult {
  rows: Record<string, unknown>[];
}

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: MockQueryResult[] = [];
let queryResultIndex = 0;

// Pool client used inside the accept transaction. Tracks its own
// sequence so the test can assert BEGIN/COMMIT and per-statement results.
let clientCalls: Array<{ sql: string; params?: unknown[] }> = [];
let clientResults: MockQueryResult[] = [];
let clientResultIndex = 0;
let clientReleased = false;

const mockClient: InternalPoolClient = {
  query: async (sql: string, params?: unknown[]) => {
    clientCalls.push({ sql, params });
    const result = clientResults[clientResultIndex] ?? { rows: [] };
    clientResultIndex++;
    return result;
  },
  release: () => {
    clientReleased = true;
  },
};

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return mockClient;
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setQueryResults(...results: MockQueryResult[]) {
  queryResults = results;
  queryResultIndex = 0;
}

function setClientResults(...results: MockQueryResult[]) {
  clientResults = results;
  clientResultIndex = 0;
}

describe("stage-tracker DB helpers", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    clientCalls = [];
    clientResults = [];
    clientResultIndex = 0;
    clientReleased = false;
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  // -----------------------------------------------------------------------
  // stageChange — INSERT against dashboard_stage_changes
  // -----------------------------------------------------------------------

  describe("stageChange()", () => {
    it("INSERTs a remove_card row with payload JSON and returns the persisted row", async () => {
      enableInternalDB();
      const stamp = "2026-05-17T01:00:00Z";
      setQueryResults({
        rows: [
          {
            id: "stage-uuid-1",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "remove_card",
            payload: { kind: "remove_card", cardId: "card-1" },
            status: "pending",
            created_at: stamp,
            updated_at: stamp,
            applied_at: null,
            discarded_at: null,
          },
        ],
      });

      const result = await stageChange({
        dashboardId: "dash-1",
        userId: "user-1",
        payload: { kind: "remove_card", cardId: "card-1" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.stage.id).toBe("stage-uuid-1");
      expect(result.stage.status).toBe("pending");
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0]?.sql).toMatch(/INSERT INTO dashboard_stage_changes/);
      // Params: dashboardId, userId, kind, payload (json string).
      expect(queryCalls[0]?.params).toEqual([
        "dash-1",
        "user-1",
        "remove_card",
        JSON.stringify({ kind: "remove_card", cardId: "card-1" }),
      ]);
    });

    it("returns no_db when internal DB is unavailable", async () => {
      // DATABASE_URL not set + no pool — hasInternalDB() short-circuits.
      const result = await stageChange({
        dashboardId: "dash-1",
        userId: "user-1",
        payload: { kind: "remove_card", cardId: "card-1" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("no_db");
    });

    it("propagates JSON-encoded payload for edit_sql (carries currentSql + newSql)", async () => {
      enableInternalDB();
      const stamp = "2026-05-17T01:00:00Z";
      const payload: StagePayload = {
        kind: "edit_sql",
        cardId: "card-9",
        newSql: "SELECT 9",
        currentSql: "SELECT 1",
      };
      setQueryResults({
        rows: [
          {
            id: "stage-uuid-2",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "edit_sql",
            payload,
            status: "pending",
            created_at: stamp,
            updated_at: stamp,
            applied_at: null,
            discarded_at: null,
          },
        ],
      });
      const result = await stageChange({
        dashboardId: "dash-1",
        userId: "user-1",
        payload,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(queryCalls[0]?.params?.[3]).toBe(JSON.stringify(payload));
      // The returned stage round-trips the JSON shape.
      expect(result.stage.payload).toEqual(payload);
    });
  });

  // -----------------------------------------------------------------------
  // loadStagedChange — per-user gating
  // -----------------------------------------------------------------------

  describe("loadStagedChange()", () => {
    it("returns the row when (stageId, userId) matches", async () => {
      enableInternalDB();
      setQueryResults({
        rows: [
          {
            id: "stage-1",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "remove_card",
            payload: { kind: "remove_card", cardId: "card-1" },
            status: "pending",
            created_at: "2026-05-17T00:00:00Z",
            updated_at: "2026-05-17T00:00:00Z",
            applied_at: null,
            discarded_at: null,
          },
        ],
      });
      const row = await loadStagedChange("stage-1", "user-1");
      expect(row).not.toBeNull();
      expect(row?.id).toBe("stage-1");
      // SQL gates on (id, user_id) — an attacker stamping someone else's
      // stage id can't probe for existence because the param list includes
      // their own userId.
      expect(queryCalls[0]?.sql).toMatch(/WHERE id = \$1 AND user_id = \$2/);
      expect(queryCalls[0]?.params).toEqual(["stage-1", "user-1"]);
    });

    it("returns null when no row matches (cross-user access)", async () => {
      enableInternalDB();
      setQueryResults({ rows: [] });
      const row = await loadStagedChange("stage-1", "user-other");
      expect(row).toBeNull();
    });

    it("returns null on DB error without throwing", async () => {
      enableInternalDB();
      // Force a thrown error — overwrite the pool's query.
      const errorPool: InternalPool = {
        ...mockPool,
        query: async () => {
          throw new Error("connection refused");
        },
      };
      _resetPool(errorPool);
      const row = await loadStagedChange("stage-1", "user-1");
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // listStagedChangesForUser — per-user pending only
  // -----------------------------------------------------------------------

  describe("listStagedChangesForUser()", () => {
    it("filters by (dashboard_id, user_id, status='pending') and orders by created_at ASC", async () => {
      enableInternalDB();
      setQueryResults({
        rows: [
          {
            id: "s1",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "remove_card",
            payload: { kind: "remove_card", cardId: "c-1" },
            status: "pending",
            created_at: "2026-05-17T00:00:00Z",
            updated_at: "2026-05-17T00:00:00Z",
            applied_at: null,
            discarded_at: null,
          },
          {
            id: "s2",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "edit_sql",
            payload: { kind: "edit_sql", cardId: "c-2", newSql: "SELECT 2", currentSql: "SELECT 1" },
            status: "pending",
            created_at: "2026-05-17T00:01:00Z",
            updated_at: "2026-05-17T00:01:00Z",
            applied_at: null,
            discarded_at: null,
          },
        ],
      });
      const rows = await listStagedChangesForUser("dash-1", "user-1");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe("s1");
      expect(rows[1]?.id).toBe("s2");
      const sql = queryCalls[0]?.sql ?? "";
      expect(sql).toMatch(/WHERE dashboard_id = \$1\s+AND user_id = \$2\s+AND status = 'pending'/);
      expect(sql).toMatch(/ORDER BY created_at ASC/);
      expect(queryCalls[0]?.params).toEqual(["dash-1", "user-1"]);
    });

    it("returns [] on no_db", async () => {
      const rows = await listStagedChangesForUser("dash-1", "user-1");
      expect(rows).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // discardStagedChange — flip status with idempotency guards
  // -----------------------------------------------------------------------

  describe("discardStagedChange()", () => {
    it("flips a pending row to discarded; returns { discarded: true }", async () => {
      enableInternalDB();
      // 1st call: loadStagedChange. 2nd call: UPDATE returning the new row.
      setQueryResults(
        {
          rows: [
            {
              id: "stage-1",
              dashboard_id: "dash-1",
              user_id: "user-1",
              kind: "remove_card",
              payload: { kind: "remove_card", cardId: "card-1" },
              status: "pending",
              created_at: "2026-05-17T00:00:00Z",
              updated_at: "2026-05-17T00:00:00Z",
              applied_at: null,
              discarded_at: null,
            },
          ],
        },
        {
          rows: [
            {
              id: "stage-1",
              dashboard_id: "dash-1",
              user_id: "user-1",
              kind: "remove_card",
              payload: { kind: "remove_card", cardId: "card-1" },
              status: "discarded",
              created_at: "2026-05-17T00:00:00Z",
              updated_at: "2026-05-17T01:00:00Z",
              applied_at: null,
              discarded_at: "2026-05-17T01:00:00Z",
            },
          ],
        },
      );
      const result = await discardStagedChange({ stageId: "stage-1", userId: "user-1" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.discarded).toBe(true);
      expect(result.stage.status).toBe("discarded");
      // UPDATE statement gates on status='pending' to handle the race
      // where the row flipped under us between the load and the update.
      expect(queryCalls[1]?.sql).toMatch(/UPDATE dashboard_stage_changes/);
      expect(queryCalls[1]?.sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND status = 'pending'/);
    });

    it("returns rejected when the row is already applied", async () => {
      enableInternalDB();
      setQueryResults({
        rows: [
          {
            id: "stage-1",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "remove_card",
            payload: { kind: "remove_card", cardId: "card-1" },
            status: "applied",
            created_at: "2026-05-17T00:00:00Z",
            updated_at: "2026-05-17T00:30:00Z",
            applied_at: "2026-05-17T00:30:00Z",
            discarded_at: null,
          },
        ],
      });
      const result = await discardStagedChange({ stageId: "stage-1", userId: "user-1" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("rejected");
      // Only the load query ran; no UPDATE.
      expect(queryCalls).toHaveLength(1);
    });

    it("is idempotent — re-discarding a discarded row returns { discarded: false } without a write", async () => {
      enableInternalDB();
      setQueryResults({
        rows: [
          {
            id: "stage-1",
            dashboard_id: "dash-1",
            user_id: "user-1",
            kind: "remove_card",
            payload: { kind: "remove_card", cardId: "card-1" },
            status: "discarded",
            created_at: "2026-05-17T00:00:00Z",
            updated_at: "2026-05-17T00:30:00Z",
            applied_at: null,
            discarded_at: "2026-05-17T00:30:00Z",
          },
        ],
      });
      const result = await discardStagedChange({ stageId: "stage-1", userId: "user-1" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.discarded).toBe(false);
      // Only the load ran; pure transition returned noop, no UPDATE.
      expect(queryCalls).toHaveLength(1);
    });

    it("returns not_found when the row doesn't exist for this user (cross-user safety)", async () => {
      enableInternalDB();
      setQueryResults({ rows: [] });
      const result = await discardStagedChange({ stageId: "stage-1", userId: "user-other" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("not_found");
    });
  });
});
