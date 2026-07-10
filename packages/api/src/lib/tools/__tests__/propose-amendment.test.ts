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

// A real on-disk entity YAML so the tool reaches the test-query stage.
const entityYaml = [
  "name: companies",
  "description: Customer companies",
  "dimensions:",
  "  - name: id",
  "    type: number",
].join("\n");

void mock.module("fs", () => ({
  existsSync: () => true,
  readFileSync: () => entityYaml,
}));

const mockInsertSemanticAmendment: Mock<
  (args: Record<string, unknown>) => Promise<{ id: string; status: string }>
> = mock(() => Promise.resolve({ id: "prop-1", status: "queued" }));

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
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
