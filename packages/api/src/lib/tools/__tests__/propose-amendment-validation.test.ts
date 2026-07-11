/**
 * proposeAmendment validation seam (#4513): validation happens where the
 * Amendment is created. A proposal that fails validation NEVER becomes a
 * pending Amendment — the tool result tells the model why, and nothing is
 * inserted. Evidence runs where the change lives: the test query executes
 * against the amendment's own connection group, not the default datasource.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { UserQueryOutcome, RunUserQueryOpts } from "@atlas/api/lib/tools/sql";

const ordersEntity: Record<string, unknown> = {
  name: "orders",
  table: "orders",
  description: "Orders",
  dimensions: [{ name: "status", sql: "status", type: "string" }],
};

// --- DB seam: track whether anything is ever inserted ---
const mockInsert: Mock<(args: Record<string, unknown>) => Promise<{ outcome: string; id?: string; autoApprove?: boolean }>> =
  mock(() => Promise.resolve({ outcome: "inserted", id: "prop-1", autoApprove: false }));
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsert,
}));

void mock.module("@atlas/api/lib/semantic/expert/decide", () => ({
  decideAmendment: mock(async (p: { id: string }) => ({ kind: "approved", id: p.id })),
}));

// --- Baseline resolver: returns the amendment's own group + a table-ful doc ---
let targetGroupId: string | null = "eu_prod";
const mockResolveBaseline: Mock<
  (orgId: string | null, name: string, group: string | undefined) => Promise<{
    row: Record<string, unknown>;
    targetGroupId: string | null;
    parsed: Record<string, unknown>;
  }>
> = mock(async () => ({
  row: { id: "orders-row", connection_group_id: targetGroupId },
  targetGroupId,
  parsed: structuredClone(ordersEntity),
}));

// Real applyAmendment would keep `table`; stub keeps the doc shape valid. When
// `corruptPostApply` is set, the stub drops `table` to exercise the propose-time
// gate-3 (post-apply EntityShape) failure path.
let corruptPostApply = false;
function stubApply(entity: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(entity);
  const dims = (clone.dimensions ?? []) as Record<string, unknown>[];
  dims.push({ name: "added", sql: "added", type: "string" });
  clone.dimensions = dims;
  if (corruptPostApply) delete clone.table;
  return clone;
}
void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentFromPayload: mock(() => Promise.resolve()),
  resolveAmendmentBaseline: mockResolveBaseline,
  applyAmendment: stubApply,
  // #4518: propose dispatches via applyAmendmentMutation; these validation
  // cases are entity amendments, so the dispatcher resolves to the entity stub.
  applyAmendmentMutation: stubApply,
  isGlossaryAmendmentType: (t: string) =>
    t === "add_glossary_term" || t === "update_glossary_term",
  resolveGlossaryBaseline: mock(() => Promise.resolve({ row: null, targetGroupId: null, parsed: {} })),
  glossaryDiffPath: (g?: string) =>
    g && g !== "default" ? `semantic/groups/${g}/glossary.yml` : "semantic/glossary.yml",
  GLOSSARY_DOC_NAME: "glossary",
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => ({ requestId: "req-1", user: { activeOrganizationId: "org-1" } }),
}));

void mock.module("@atlas/api/lib/semantic/files", () => ({ getSemanticRoot: () => "/semantic" }));

// The amendment's group resolves to this connection — the assertion target.
const mockResolveGroupConn: Mock<
  (orgId: string | undefined, groupId: string | null | undefined) => Promise<string>
> = mock(async (_org, groupId) => (groupId === "eu_prod" ? "eu_prod_primary" : "default"));
void mock.module("@atlas/api/lib/group-reach/lookup", () => ({
  resolveGroupPrimaryConnectionId: mockResolveGroupConn,
  loadVisibleGroups: mock(async () => []),
}));

const okOutcome: UserQueryOutcome = {
  kind: "ok", columns: ["status"], rows: [{ status: "active" }], rowCount: 1,
  executionMs: 3, truncated: false, maskingApplied: false,
};
const mockPipeline: Mock<(opts: RunUserQueryOpts) => Promise<UserQueryOutcome>> = mock(() => Promise.resolve(okOutcome));
let sqlValid = true;
let sqlError = "Forbidden SQL operation detected";
const mockValidateSQL: Mock<(sql: string, c?: string, w?: string) => Promise<{ valid: boolean; error?: string }>> =
  mock(async () => (sqlValid ? { valid: true } : { valid: false, error: sqlError }));
void mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mockPipeline,
  validateSQL: mockValidateSQL,
}));

const { proposeAmendment } = await import("@atlas/api/lib/tools/propose-amendment");

type Result = { proposalId?: string; status?: string; diff?: string; error?: string };
type ProposeInput = Parameters<NonNullable<typeof proposeAmendment.execute>>[0];
async function run(args: Record<string, unknown>): Promise<Result> {
  return (await proposeAmendment.execute!(
    { rationale: "r", confidence: 0.9, ...args } as ProposeInput,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- execute options irrelevant
    {} as any,
  )) as Result;
}

beforeEach(() => {
  targetGroupId = "eu_prod";
  sqlValid = true;
  corruptPostApply = false;
  mockInsert.mockClear();
  mockPipeline.mockClear();
  mockValidateSQL.mockClear();
  mockResolveGroupConn.mockClear();
});

describe("propose-time payload gate (#4513 AC1)", () => {
  it("rejects an update_dimension that smuggles sql — no insert, reason returned", async () => {
    const result = await run({
      entityName: "orders",
      amendmentType: "update_dimension",
      amendment: { name: "status", sql: "lower(status)" },
    });
    expect(result.error).toMatch(/sql/i);
    expect(result.status).toBeUndefined();
    // Nothing reached the queue.
    expect(mockInsert).not.toHaveBeenCalled();
    // The gate fires before baseline resolution — no DB read either.
    expect(mockResolveBaseline).not.toHaveBeenCalled();
  });

  it("rejects a payload missing a required field before any insert", async () => {
    const result = await run({
      entityName: "orders",
      amendmentType: "add_measure",
      amendment: { name: "revenue" }, // no sql
    });
    expect(result.error).toMatch(/sql/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("propose-time embedded-SQL gate (#4513 AC1)", () => {
  it("blocks unparseable/forbidden embedded SQL — no insert, reason names the field", async () => {
    sqlValid = false;
    const result = await run({
      entityName: "orders",
      amendmentType: "add_measure",
      amendment: { name: "m", sql: "pg_read_file('/etc/passwd')" },
    });
    expect(result.error).toMatch(/Forbidden/);
    expect(result.error).toMatch(/sql/i);
    expect(mockInsert).not.toHaveBeenCalled();
    // Embedded SQL was validated as a wrapped expression against the group conn.
    expect(mockValidateSQL).toHaveBeenCalledTimes(1);
    expect(mockValidateSQL.mock.calls[0][0]).toBe("SELECT pg_read_file('/etc/passwd')");
  });

  it("blocks a forbidden query-pattern SQL (validated un-wrapped) — no insert", async () => {
    sqlValid = false;
    const result = await run({
      entityName: "orders",
      amendmentType: "add_query_pattern",
      amendment: { name: "p", sql: "SELECT * FROM orders; DROP TABLE orders" },
    });
    expect(result.error).toMatch(/sql/i);
    expect(mockInsert).not.toHaveBeenCalled();
    // A query pattern is a full statement — passed through as-is, never wrapped.
    expect(mockValidateSQL).toHaveBeenCalledTimes(1);
    expect(mockValidateSQL.mock.calls[0][0]).toBe("SELECT * FROM orders; DROP TABLE orders");
  });
});

describe("propose-time post-apply EntityShape gate (#4513 AC1, gate 3)", () => {
  it("blocks an amendment whose applied document would not parse as an entity — no insert", async () => {
    corruptPostApply = true;
    const result = await run({
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "region", sql: "region", type: "string" },
    });
    expect(result.error).toMatch(/corrupt entity/i);
    expect(result.status).toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("test query runs against the amendment's group connection (#4513 AC4)", () => {
  it("routes the test query to the resolved non-default group connection", async () => {
    const result = await run({
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "region", sql: "region", type: "string" },
      testQuery: "SELECT region FROM orders",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("queued");
    // The group ("eu_prod") was resolved to its primary connection...
    expect(mockResolveGroupConn).toHaveBeenCalledTimes(1);
    expect(mockResolveGroupConn.mock.calls[0][1]).toBe("eu_prod");
    // ...and the test query executed against THAT connection, not "default".
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockPipeline.mock.calls[0][0].connectionId).toBe("eu_prod_primary");
  });

  it("stays on the default connection for a default-scope (NULL group) amendment", async () => {
    targetGroupId = null;
    await run({
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "region", sql: "region", type: "string" },
      testQuery: "SELECT region FROM orders",
    });
    // NULL group short-circuits to "default" without a group-reach lookup.
    expect(mockResolveGroupConn).not.toHaveBeenCalled();
    expect(mockPipeline.mock.calls[0][0].connectionId).toBe("default");
  });
});
