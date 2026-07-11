/**
 * proposeAmendment — the LLM-authored test query must run through the shared
 * user-query pipeline (validation → approval → RLS → auto-LIMIT → audit +
 * masking), never a raw `db.query` (#4485, the same discipline the #3338 fix
 * established). The rows persisted into learned_patterns.amendment_payload
 * must be the pipeline's masked, capped output — never raw tenant data.
 */

import { describe, expect, it, beforeEach, mock, type Mock } from "bun:test";
import type { UserQueryOutcome, RunUserQueryOpts } from "@atlas/api/lib/tools/sql";
import type { AmendmentPayload } from "@useatlas/types";

// --- Mocks (registered before importing the module under test) ---

// Parsed entity baseline the DB-backed resolver returns (#4488). With an
// internal DB present the tool resolves the baseline through
// `resolveAmendmentBaseline`, NOT the flat disk root — so the test stubs that
// resolver rather than `fs`.
const companiesEntity: Record<string, unknown> = {
  name: "companies",
  // Real entities always carry `table` — the post-apply EntityShape gate (#4513)
  // requires it, so the fixture must too.
  table: "companies",
  description: "Customer companies",
  dimensions: [{ name: "id", type: "number" }],
};

// insertSemanticAmendment now returns a discriminated union (#4507):
// { outcome: "inserted" | "already_pending" | "rejected", ... }.
const mockInsertSemanticAmendment: Mock<
  (args: Record<string, unknown>) => Promise<{ outcome: string; id?: string; autoApprove?: boolean }>
> = mock(() => Promise.resolve({ outcome: "inserted", id: "prop-1", autoApprove: false }));

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
}));

// The decide seam (#4506). When insertSemanticAmendment reports auto-approve
// eligibility, the tool must route the approval through `decideAmendment`
// (claim → apply → stamp) — never stamp or apply anything itself.
type DecideOutcome = { kind: "approved" | "rejected" | "not_pending"; id: string };
const mockDecideAmendment: Mock<
  (params: { id: string; orgId: string | null; decision: string; reviewedBy: string; requestId: string }) => Promise<DecideOutcome>
> = mock(async (params) => ({ kind: "approved", id: params.id }));

void mock.module("@atlas/api/lib/semantic/expert/decide", () => ({
  decideAmendment: mockDecideAmendment,
}));

// Kept total for mock-all-exports; the tool itself no longer calls the apply
// helper directly (the seam does).
const mockApplyAmendmentFromPayload: Mock<(args: Record<string, unknown>) => Promise<void>> = mock(
  () => Promise.resolve(),
);

// The baseline resolver (#4488): the tool reads the current entity through the
// SAME org/group-aware DB read the apply path uses. Returns the default-scope
// (NULL group) companies row here.
const mockResolveAmendmentBaseline: Mock<
  (
    orgId: string | null,
    entityName: string,
    group: string | undefined,
  ) => Promise<{ row: Record<string, unknown>; targetGroupId: string | null; parsed: Record<string, unknown> }>
> = mock(() =>
  Promise.resolve({
    row: { id: "companies-row", connection_group_id: null },
    targetGroupId: null,
    parsed: structuredClone(companiesEntity),
  }),
);

// The authoritative mutation (#4488): the tool applies the amendment through
// the shared `applyAmendment`, not a divergent local copy. Stubbed to a minimal
// add_dimension so the tool has a non-trivial "after" to diff/serialize.
function stubApplyAmendment(entity: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(entity);
  const dims = (clone.dimensions ?? []) as Record<string, unknown>[];
  dims.push({ name: "region", type: "string", description: "Region" });
  clone.dimensions = dims;
  return clone;
}

void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendmentFromPayload: mockApplyAmendmentFromPayload,
  resolveAmendmentBaseline: mockResolveAmendmentBaseline,
  applyAmendment: stubApplyAmendment,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

void mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/semantic",
}));

// The masked, auto-LIMITed pipeline output. `maskingApplied` + a bounded row
// set stand in for the production masking/row-cap seam.
const okOutcome: UserQueryOutcome = {
  kind: "ok",
  columns: ["email"],
  rows: [
    { email: "a***@example.com" },
    { email: "b***@example.com" },
    { email: "c***@example.com" },
    { email: "d***@example.com" },
    { email: "e***@example.com" },
    { email: "f***@example.com" },
    { email: "g***@example.com" },
  ],
  rowCount: 7,
  executionMs: 5,
  truncated: false,
  maskingApplied: true,
};

const mockRunUserQueryPipeline: Mock<(opts: RunUserQueryOpts) => Promise<UserQueryOutcome>> =
  mock(() => Promise.resolve(okOutcome));

// The module under test imports exactly one value binding from this module —
// `runUserQueryPipeline` (propose-amendment.ts) — and no unmocked transitive
// dep in this test's graph reads any other `sql` export, so a single-binding
// stub is complete for this file's import surface.
void mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mockRunUserQueryPipeline,
}));

const { proposeAmendment } = await import("@atlas/api/lib/tools/propose-amendment");

type ProposeResult = {
  proposalId?: string;
  status?: string;
  diff?: string;
  error?: string;
  testResult?: AmendmentPayload["testResult"];
};

async function run(testQuery?: string): Promise<ProposeResult> {
  return (await proposeAmendment.execute!(
    {
      entityName: "companies",
      amendmentType: "add_dimension",
      amendment: { name: "region", type: "string", description: "Region" },
      rationale: "Adds region",
      confidence: 0.9,
      ...(testQuery !== undefined && { testQuery }),
    },
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK execute options are irrelevant to this tool
    {} as any,
  )) as ProposeResult;
}

describe("proposeAmendment test query routing (#4485)", () => {
  beforeEach(() => {
    mockRunUserQueryPipeline.mockClear();
    mockRunUserQueryPipeline.mockResolvedValue(okOutcome);
    mockInsertSemanticAmendment.mockClear();
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-1", autoApprove: false });
  });

  it("routes the test query through runUserQueryPipeline with an explicit connectionId", async () => {
    const result = await run("SELECT email FROM companies");
    expect(mockRunUserQueryPipeline).toHaveBeenCalledTimes(1);
    const opts = mockRunUserQueryPipeline.mock.calls[0][0];
    expect(opts.sql).toBe("SELECT email FROM companies");
    expect(opts.connectionId).toBe("default");
    expect(result.testResult?.success).toBe(true);
    expect(result.testResult?.rowCount).toBe(7);
  });

  it("persists only the pipeline's masked output, capped at 5 rows", async () => {
    await run("SELECT email FROM companies");
    expect(mockInsertSemanticAmendment).toHaveBeenCalledTimes(1);
    const persisted = mockInsertSemanticAmendment.mock.calls[0][0] as {
      amendmentPayload: { testResult?: { sampleRows: Record<string, unknown>[] } };
    };
    const sampleRows = persisted.amendmentPayload.testResult?.sampleRows ?? [];
    // Capped at 5 even though the pipeline returned 7.
    expect(sampleRows).toHaveLength(5);
    // Masked values only — no raw PII reaches the persisted payload.
    expect(sampleRows.every((r) => String(r.email).includes("***"))).toBe(true);
  });

  it("fails closed when the pipeline would block the query — no rows captured or persisted", async () => {
    // A query the pipeline blocks at validation must yield an error result with
    // zero rows — the tool path cannot execute what the pipeline refuses.
    mockRunUserQueryPipeline.mockResolvedValue({
      kind: "validation_failed",
      message: 'Table "secrets" is not in the allowed list.',
    });
    const result = await run("SELECT * FROM secrets");
    expect(result.testResult?.success).toBe(false);
    expect(result.testResult?.sampleRows).toEqual([]);
    expect(result.testResult?.error).toContain("allowed list");

    // The blocked query's (absent) rows are never persisted.
    const persisted = mockInsertSemanticAmendment.mock.calls[0][0] as {
      amendmentPayload: { testResult?: { sampleRows: Record<string, unknown>[]; success: boolean } };
    };
    expect(persisted.amendmentPayload.testResult?.success).toBe(false);
    expect(persisted.amendmentPayload.testResult?.sampleRows).toEqual([]);
  });

  it("never touches the query pipeline when no test query is supplied", async () => {
    const result = await run(); // no testQuery
    expect(mockRunUserQueryPipeline).not.toHaveBeenCalled();
    expect(result.testResult).toBeUndefined();
    const persisted = mockInsertSemanticAmendment.mock.calls[0][0] as {
      amendmentPayload: { testResult?: unknown };
    };
    expect(persisted.amendmentPayload.testResult).toBeUndefined();
  });

  it("surfaces an RLS block as a failed test query (fail-closed, not raw rows)", async () => {
    mockRunUserQueryPipeline.mockResolvedValue({
      kind: "rls_failed",
      message: 'RLS policy requires claim "tenant_id" but it is missing. Query blocked.',
    });
    const result = await run("SELECT email FROM companies");
    expect(result.testResult?.success).toBe(false);
    expect(result.testResult?.error).toContain("RLS");
    expect(result.testResult?.sampleRows).toEqual([]);
  });
});

describe("proposeAmendment auto-approve routes through the decide seam (#4486, #4506)", () => {
  beforeEach(() => {
    mockRunUserQueryPipeline.mockClear();
    mockRunUserQueryPipeline.mockResolvedValue(okOutcome);
    mockInsertSemanticAmendment.mockClear();
    mockDecideAmendment.mockClear();
    mockDecideAmendment.mockImplementation(async (params) => ({ kind: "approved", id: params.id }));
  });

  it("does NOT invoke the seam when the insert is not eligible (auto-approve disabled)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-pending", autoApprove: false });
    const result = await run();
    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.status).toBe("queued");
  });

  it("routes an eligible insert through the seam with the inserted row's id", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-approved", autoApprove: true });
    const result = await run();

    // The invariant: eligibility triggers exactly one seam decision — the
    // seam applies from the STORED payload (claim → apply → stamp), so the
    // tool passes only the identity, never a payload copy that could diverge.
    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    const [params] = mockDecideAmendment.mock.calls[0];
    expect(params).toMatchObject({
      id: "prop-approved",
      orgId: null,
      decision: "approved",
      reviewedBy: "auto-approve",
    });

    expect(result.status).toBe("auto_approved");
    // Pin the wire contract the web relies on (#4499): an auto_approved result
    // still carries the row id — `extractProposals` drops results without a
    // `proposalId`, so losing it would silently hide the applied card.
    expect(result.proposalId).toBe("prop-approved");
  });

  it("reports queued when the seam's apply fails (row already compensated to pending)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-approved", autoApprove: true });
    mockDecideAmendment.mockImplementation(async () => {
      throw new Error("entity not found for org");
    });

    const result = await run();

    // The seam threw AFTER compensating the row back to pending — the model
    // is told the truth: queued, not auto-applied, and never a tool error
    // that hides the row.
    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
    expect(result.error).toBeUndefined();
  });

  it("reports queued when a concurrent decision beat the tool to its own insert", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-approved", autoApprove: true });
    mockDecideAmendment.mockImplementation(async (params) => ({ kind: "not_pending", id: params.id }));

    const result = await run();

    expect(result.status).toBe("queued");
    expect(result.error).toBeUndefined();
  });

  it("invariant: the tool never returns auto_approved without a seam-approved outcome", async () => {
    // Sweep both eligibility outcomes; auto_approved requires the seam's
    // approved outcome (which itself requires a successful apply + stamp).
    for (const autoApprove of [false, true]) {
      mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: `prop-${autoApprove}`, autoApprove });
      mockDecideAmendment.mockClear();
      const result = await run();
      if (result.status === "auto_approved") {
        expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
      } else {
        expect(result.status).toBe("queued");
      }
    }
  });
});

describe("proposeAmendment permanent rejection memory + pending dedup (#4507)", () => {
  beforeEach(() => {
    mockRunUserQueryPipeline.mockClear();
    mockRunUserQueryPipeline.mockResolvedValue(okOutcome);
    mockInsertSemanticAmendment.mockClear();
    mockApplyAmendmentFromPayload.mockClear();
    mockApplyAmendmentFromPayload.mockResolvedValue(undefined);
  });

  it("reports rejected (with a reason the model can see) and applies nothing when the identity was previously rejected", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "rejected", id: "rej-1" });

    const result = await run();

    expect(result.status).toBe("rejected");
    // The tool result says WHY (acceptance criterion 1) — the model must learn
    // not to re-propose it.
    expect(String((result as { reason?: string }).reason)).toMatch(/previously rejected/i);
    // A refused insert never applies and never claims a queued proposal id.
    expect(mockApplyAmendmentFromPayload).not.toHaveBeenCalled();
    expect(result.proposalId).toBeUndefined();
    // The diff is still surfaced so the model sees what it tried to change.
    expect(result.diff).toBeDefined();
  });

  it("converges on the existing pending row instead of re-applying or duplicating", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "already_pending", id: "pend-1" });

    const result = await run();

    expect(result.status).toBe("already_pending");
    // Points the model at the existing proposal, not a new one.
    expect(result.proposalId).toBe("pend-1");
    // An already-pending identity is not auto-approved/applied.
    expect(mockApplyAmendmentFromPayload).not.toHaveBeenCalled();
  });
});
