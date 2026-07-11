/**
 * Insert-enforced rejection memory + pending dedup for semantic amendments
 * (#4507).
 *
 * `insertSemanticAmendment` is the single choke point every path (chat tool,
 * scheduler, CLI) shares. Before queuing, it checks the amendment's canonical
 * group-scoped identity against the org's existing rejected/pending rows:
 *   - a rejected identity → refused permanently (`outcome: "rejected"`), NO INSERT;
 *   - an identical pending identity → converges (`outcome: "already_pending"`), NO INSERT;
 *   - no conflict → a new row is queued, keyed on the identity (`pattern_sql`).
 *
 * These assert the SQL the guard runs and that the INSERT only fires on the
 * clean path — using a captured-SQL stub pool (same harness as
 * semantic-amendment-saas-scoping.test.ts).
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

// `hasInternalDB()`/`getInternalDB()` read DATABASE_URL at call time; set it
// before importing the module under test so the query path runs.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import { insertSemanticAmendment, _resetPool, _resetCircuitBreaker } from "../internal";

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[] = [];

/** Rows the conflict SELECT returns for the current test. */
let conflictRows: Array<{
  id: string;
  status: string;
  connection_group_id: string | null;
  amendment_payload: Record<string, unknown> | string | null;
}> = [];

function makeStubPool() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes("INSERT INTO learned_patterns")) {
        return { rows: [{ id: "new-row-id" }] };
      }
      // The conflict SELECT (status IN ('rejected','pending')).
      return { rows: conflictRows };
    },
    async end() {},
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    on() {},
  };
}

const baseAmendment = {
  orgId: "org-a",
  description: "[add_dimension] orders: adds region",
  sourceEntity: "orders",
  confidence: 0.9,
  connectionGroupId: null as string | null,
  amendmentPayload: {
    amendmentType: "add_dimension",
    amendment: { name: "region", type: "string" },
  } as Record<string, unknown>,
};

function insertSql(): Captured | undefined {
  return captured.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
}

beforeEach(() => {
  captured = [];
  conflictRows = [];
  _resetCircuitBreaker();
  _resetPool(makeStubPool() as unknown as Parameters<typeof _resetPool>[0], null);
});

afterAll(() => {
  _resetPool(null, null);
  _resetCircuitBreaker();
  mock.restore();
});

describe("insertSemanticAmendment — clean path (#4507)", () => {
  it("queues a new row keyed on the canonical identity when no conflict exists", async () => {
    const result = await insertSemanticAmendment(baseAmendment);

    // The `inserted` arm reports auto-approve ELIGIBILITY (#4506) — every row
    // lands `pending`; the decide seam is the only writer of `approved`.
    expect(result).toEqual({ outcome: "inserted", id: "new-row-id", autoApprove: false });

    // The identity is the storage key — no timestamp uniquifier.
    const ins = insertSql();
    expect(ins).toBeDefined();
    expect(ins!.params[1]).toBe("default:orders:add_dimension:region");
  });

  it("scopes the conflict lookup to the amendment's own org (IS NOT DISTINCT FROM)", async () => {
    await insertSemanticAmendment(baseAmendment);

    const lookup = captured.find((c) => c.sql.includes("status IN ('rejected', 'pending')"));
    expect(lookup).toBeDefined();
    expect(lookup!.sql).toContain("org_id IS NOT DISTINCT FROM $2");
    expect(lookup!.params).toEqual(["orders", "org-a"]);
  });
});

describe("insertSemanticAmendment — permanent rejection memory (#4507)", () => {
  it("refuses the insert when the identity was previously rejected", async () => {
    conflictRows = [
      {
        id: "rejected-1",
        status: "rejected",
        connection_group_id: null,
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
    ];

    const result = await insertSemanticAmendment(baseAmendment);

    expect(result).toEqual({ outcome: "rejected", id: "rejected-1" });
    expect(insertSql()).toBeUndefined(); // NO INSERT ran
  });

  it("does NOT suppress a different amendment on the same entity (identity is per-target)", async () => {
    // A rejected add_dimension:region must not block add_dimension:status.
    conflictRows = [
      {
        id: "rejected-1",
        status: "rejected",
        connection_group_id: null,
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
    ];

    const result = await insertSemanticAmendment({
      ...baseAmendment,
      amendmentPayload: { amendmentType: "add_dimension", amendment: { name: "status" } },
    });

    expect(result.outcome).toBe("inserted");
    expect(insertSql()).toBeDefined();
  });

  it("does NOT suppress the same identity in a different Connection group", async () => {
    // Rejected in the default group; a proposal in group `eu` must still queue.
    conflictRows = [
      {
        id: "rejected-1",
        status: "rejected",
        connection_group_id: null,
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
    ];

    const result = await insertSemanticAmendment({ ...baseAmendment, connectionGroupId: "eu" });

    expect(result.outcome).toBe("inserted");
  });
});

describe("insertSemanticAmendment — pending dedup (#4507)", () => {
  it("converges on the existing pending row instead of queuing a duplicate", async () => {
    conflictRows = [
      {
        id: "pending-1",
        status: "pending",
        connection_group_id: null,
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
    ];

    const result = await insertSemanticAmendment(baseAmendment);

    expect(result).toEqual({ outcome: "already_pending", id: "pending-1" });
    expect(insertSql()).toBeUndefined(); // NO duplicate INSERT
  });

  it("prefers rejected over pending when both share the identity", async () => {
    conflictRows = [
      {
        id: "pending-1",
        status: "pending",
        connection_group_id: null,
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
      {
        id: "rejected-1",
        status: "rejected",
        connection_group_id: null,
        amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
      },
    ];

    const result = await insertSemanticAmendment(baseAmendment);

    expect(result).toEqual({ outcome: "rejected", id: "rejected-1" });
  });
});
