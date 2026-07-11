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

// insertSemanticAmendment returns a discriminated union (#4507, #4506):
// { outcome: "inserted"; id; autoApproveEligible } | { outcome: "already_pending" | "rejected"; id }.
const mockInsertSemanticAmendment: Mock<
  (args: Record<string, unknown>) => Promise<{ outcome: string; id?: string; autoApproveEligible?: boolean }>
> = mock(() => Promise.resolve({ outcome: "inserted", id: "prop-1", autoApproveEligible: false }));

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

// The single decide seam (#4506): auto-approve routes through it, never a direct
// apply. The seam owns claim-then-apply + compensation, so this tool only sees
// the outcome. Default resolves `approved`; failure-path tests override.
type DecideResult =
  | { outcome: "approved"; id: string }
  | { outcome: "rejected"; id: string }
  | { outcome: "already_reviewed" }
  | { outcome: "apply_failed"; id: string; reason: string; revertedToPending: boolean };
const mockDecideAmendment: Mock<(args: Record<string, unknown>) => Promise<DecideResult>> = mock(
  (args: Record<string, unknown>) => Promise.resolve({ outcome: "approved", id: String(args.id) }),
);
void mock.module("@atlas/api/lib/semantic/expert/decide", () => ({
  decideAmendment: mockDecideAmendment,
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
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-1", autoApproveEligible: false });
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
    mockApplyAmendmentFromPayload.mockClear();
    mockApplyAmendmentFromPayload.mockResolvedValue(undefined);
    mockDecideAmendment.mockClear();
    mockDecideAmendment.mockImplementation((args: Record<string, unknown>) =>
      Promise.resolve({ outcome: "approved", id: String(args.id) }),
    );
  });

  it("does NOT decide when the insert is not auto-approve-eligible", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-pending", autoApproveEligible: false });
    const result = await run();
    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.status).toBe("queued");
  });

  it("routes an eligible insert through the decide seam and reports auto_approved", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-approved", autoApproveEligible: true });
    const result = await run();

    // The invariant: an eligible insert triggers exactly one decide, asking the
    // seam to APPROVE the freshly-inserted row under the auto origin. The seam
    // (not this tool) owns claim-then-apply + the group/payload threading.
    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(mockDecideAmendment.mock.calls[0][0]).toMatchObject({
      id: "prop-approved",
      decision: "approved",
      reviewedBy: "auto-approve",
    });
    // The tool never applies YAML directly anymore.
    expect(mockApplyAmendmentFromPayload).not.toHaveBeenCalled();
    expect(result.status).toBe("auto_approved");
    // Pin the wire contract the web relies on (#4499): an auto_approved result
    // still carries the row id — `extractProposals` drops results without a
    // `proposalId`, so losing it would silently hide the applied card.
    expect(result.proposalId).toBe("prop-approved");
  });

  it("reports queued (never throws) when the decide seam returns apply_failed", async () => {
    // The seam claimed the row, failed to apply, and already reverted it to
    // pending — the tool just tells the model the truth (queued), never an
    // `auto_approved` lie or a thrown error that hides the row.
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-approved", autoApproveEligible: true });
    mockDecideAmendment.mockResolvedValue({
      outcome: "apply_failed",
      id: "prop-approved",
      reason: "entity not found for org",
      revertedToPending: true,
    });

    const result = await run();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
    expect(result.error).toBeUndefined();
  });

  it("reports queued (never a tool error) when the decide seam THROWS a cross-group ambiguity", async () => {
    // decideAmendment throws only for an AmbiguousEntityError whose revert
    // succeeded — the row is back in the pending queue. The tool must report
    // queued (the proposal exists, awaiting review), not surface a whole-tool
    // error that hides the created row.
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "prop-amb", autoApproveEligible: true });
    mockDecideAmendment.mockRejectedValue(new Error("orders exists in 2 groups"));

    const result = await run();

    expect(result.status).toBe("queued");
    expect(result.error).toBeUndefined();
    expect(result.proposalId).toBe("prop-amb");
  });

  it("invariant: the tool never returns auto_approved without a successful decide", async () => {
    // Sweep eligibility; auto_approved requires an `approved` decide outcome.
    for (const eligible of [false, true] as const) {
      mockInsertSemanticAmendment.mockResolvedValue({
        outcome: "inserted",
        id: `prop-${eligible}`,
        autoApproveEligible: eligible,
      });
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
