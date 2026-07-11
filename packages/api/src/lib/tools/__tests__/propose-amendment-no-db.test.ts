/**
 * proposeAmendment without an internal DB (#4488): self-hosted preview reads the
 * baseline from the flat disk root, and the DB-backed insert + auto-approve
 * apply seam never runs. Covers the disk-read branch left uncovered when the
 * DB-path tests swapped the `fs` mock for the `resolveAmendmentBaseline` stub —
 * the found/parsed preview plus both error returns (missing file, malformed).
 */

import { describe, it, expect, mock } from "bun:test";

const entityYaml = [
  "name: companies",
  "table: companies",
  "description: Customer companies",
  "dimensions:",
  "  - name: id",
  "    type: number",
].join("\n");

// Toggled per test so one file can exercise found / missing / malformed.
let fileExists = true;
let fileContents = entityYaml;

void mock.module("fs", () => ({
  existsSync: () => fileExists,
  readFileSync: () => fileContents,
}));

// No internal DB → the insert + decide seam is skipped entirely; the resolver
// is never called (stubbed only to satisfy mock-all-exports for the module graph).
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  insertSemanticAmendment: mock(() => Promise.resolve({ id: "unused", autoApprove: false })),
}));

const stubApplyAmendment = (entity: Record<string, unknown>): Record<string, unknown> => {
  const clone = structuredClone(entity);
  const dims = (clone.dimensions ?? []) as Record<string, unknown>[];
  dims.push({ name: "region", type: "string" });
  clone.dimensions = dims;
  return clone;
};

void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendment: stubApplyAmendment,
  resolveAmendmentBaseline: mock(() => Promise.reject(new Error("should not be called without a DB"))),
  applyAmendmentFromPayload: mock(() => Promise.resolve()),
  // #4518: propose dispatches via applyAmendmentMutation; this is an entity
  // amendment, so the dispatcher resolves to the entity stub.
  applyAmendmentMutation: stubApplyAmendment,
  isGlossaryAmendmentType: (t: string) =>
    t === "add_glossary_term" || t === "update_glossary_term",
  resolveGlossaryBaseline: mock(() => Promise.reject(new Error("should not be called without a DB"))),
  glossaryDiffPath: (g?: string) =>
    g && g !== "default" ? `semantic/groups/${g}/glossary.yml` : "semantic/glossary.yml",
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

void mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/semantic",
}));

void mock.module("@atlas/api/lib/tools/sql", () => ({
  runUserQueryPipeline: mock(() =>
    Promise.resolve({ kind: "ok", columns: [], rows: [], rowCount: 0, executionMs: 0, truncated: false }),
  ),
}));

const { proposeAmendment } = await import("@atlas/api/lib/tools/propose-amendment");

type ProposeResult = { proposalId?: string; status?: string; diff?: string; error?: string };

async function run(): Promise<ProposeResult> {
  return (await proposeAmendment.execute!(
    {
      entityName: "companies",
      amendmentType: "add_dimension",
      amendment: { name: "region", type: "string" },
      rationale: "Add region",
      confidence: 0.9,
    },
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK execute options are irrelevant here
    {} as any,
  )) as ProposeResult;
}

describe("proposeAmendment no-internal-DB disk fallback (#4488)", () => {
  it("previews from the flat-root file and reports queued with a local id", async () => {
    fileExists = true;
    fileContents = entityYaml;

    const result = await run();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("queued");
    expect(result.proposalId).toMatch(/^local-/);
    expect(result.diff).toContain("name: region");
  });

  it("returns 'Entity file not found' when the flat-root file is absent", async () => {
    fileExists = false;

    const result = await run();

    expect(result.error).toContain("Entity file not found");
    expect(result.status).toBeUndefined();
  });

  it("returns a parse error when the flat-root file is not a YAML mapping", async () => {
    fileExists = true;
    fileContents = "- just\n- a\n- list\n";

    const result = await run();

    expect(result.error).toContain("could not be parsed as a YAML mapping");
  });
});
