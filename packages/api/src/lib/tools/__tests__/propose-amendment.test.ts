/**
 * proposeAmendment — the LLM-authored test query must run through the shared
 * user-query pipeline (validation → approval → RLS → auto-LIMIT → audit +
 * masking), never a raw `db.query` (#4485, mirroring the #3338 fix in
 * validate-proposal.ts). The rows persisted into learned_patterns.amendment_payload
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
  description: "Customer companies",
  dimensions: [{ name: "id", type: "number" }],
};

const mockInsertSemanticAmendment: Mock<
  (args: Record<string, unknown>) => Promise<{ id: string; status: string }>
> = mock(() => Promise.resolve({ id: "prop-1", status: "queued" }));

const mockRevertAmendmentToPending: Mock<(id: string) => Promise<boolean>> = mock(() =>
  Promise.resolve(true),
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
  revertAmendmentToPending: mockRevertAmendmentToPending,
}));

// The auto-approve apply seam (#4486). When insertSemanticAmendment resolves a
// proposal to `approved` at insert time, the tool must apply it in the same
// flow (mirroring the scheduler) — never leave it approved-but-unapplied.
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
    mockInsertSemanticAmendment.mockResolvedValue({ id: "prop-1", status: "queued" });
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

describe("proposeAmendment auto-approve applies in the same flow (#4486)", () => {
  beforeEach(() => {
    mockRunUserQueryPipeline.mockClear();
    mockRunUserQueryPipeline.mockResolvedValue(okOutcome);
    mockInsertSemanticAmendment.mockClear();
    mockApplyAmendmentFromPayload.mockClear();
    mockApplyAmendmentFromPayload.mockResolvedValue(undefined);
    mockRevertAmendmentToPending.mockClear();
    mockRevertAmendmentToPending.mockResolvedValue(true);
  });

  it("does NOT apply when the insert lands pending (auto-approve disabled)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ id: "prop-pending", status: "pending" });
    const result = await run();
    expect(mockApplyAmendmentFromPayload).not.toHaveBeenCalled();
    expect(mockRevertAmendmentToPending).not.toHaveBeenCalled();
    expect(result.status).toBe("queued");
  });

  it("applies the amendment in the same flow when the insert auto-approves", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ id: "prop-approved", status: "approved" });
    const result = await run();

    // The invariant: an `approved` insert triggers exactly one apply.
    expect(mockApplyAmendmentFromPayload).toHaveBeenCalledTimes(1);
    const applyArgs = mockApplyAmendmentFromPayload.mock.calls[0][0] as {
      sourceEntity: string;
      connectionGroupId: string | null;
      label: string;
      rawPayload: { amendment: Record<string, unknown> };
    };
    expect(applyArgs.sourceEntity).toBe("companies");
    expect(applyArgs.connectionGroupId).toBeNull();
    expect(applyArgs.label).toBe("prop-approved");
    // The inner amendment object is carried through so the YAML mutation applies.
    expect(applyArgs.rawPayload.amendment).toMatchObject({ name: "region" });

    // Apply succeeded → the row legitimately stays approved; no revert.
    expect(mockRevertAmendmentToPending).not.toHaveBeenCalled();
    expect(result.status).toBe("auto_approved");
  });

  it("reverts the row to pending and reports queued when the auto-approve apply fails", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ id: "prop-approved", status: "approved" });
    mockApplyAmendmentFromPayload.mockRejectedValue(new Error("entity not found for org"));

    const result = await run();

    // Apply was attempted, then the row was reverted so it never lingers as
    // approved-but-unapplied (invariant restored + surfaced, not swallowed).
    expect(mockApplyAmendmentFromPayload).toHaveBeenCalledTimes(1);
    expect(mockRevertAmendmentToPending).toHaveBeenCalledTimes(1);
    expect(mockRevertAmendmentToPending.mock.calls[0][0]).toBe("prop-approved");
    // The model is told the truth: the proposal is queued, not auto-applied.
    expect(result.status).toBe("queued");
    // The apply failure never surfaces as a tool-level error that hides the row.
    expect(result.error).toBeUndefined();
  });

  it("still reports queued (never throws) when both the apply AND the revert fail", async () => {
    // Worst case: apply fails and the revert-to-pending also fails, so the row
    // genuinely stays `approved`-but-unapplied. This must still be surfaced via
    // logs and reported honestly to the model (queued), never swallowed into a
    // tool-level error or an `auto_approved` lie.
    mockInsertSemanticAmendment.mockResolvedValue({ id: "prop-approved", status: "approved" });
    mockApplyAmendmentFromPayload.mockRejectedValue(new Error("apply exploded"));
    mockRevertAmendmentToPending.mockRejectedValue(new Error("revert exploded"));

    const result = await run();

    expect(mockApplyAmendmentFromPayload).toHaveBeenCalledTimes(1);
    expect(mockRevertAmendmentToPending).toHaveBeenCalledTimes(1);
    // The double failure never surfaces as a thrown error or auto_approved.
    expect(result.status).toBe("queued");
    expect(result.error).toBeUndefined();
  });

  it("invariant: the tool never returns auto_approved without having applied", async () => {
    // Sweep both insert outcomes; assert apply-count tracks approved+success.
    for (const status of ["pending", "approved"] as const) {
      mockInsertSemanticAmendment.mockResolvedValue({ id: `prop-${status}`, status });
      mockApplyAmendmentFromPayload.mockClear();
      const result = await run();
      if (result.status === "auto_approved") {
        // The only way to report auto_approved is a successful apply call.
        expect(mockApplyAmendmentFromPayload).toHaveBeenCalledTimes(1);
      } else {
        expect(result.status).toBe("queued");
      }
    }
  });
});
