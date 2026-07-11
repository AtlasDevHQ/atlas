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

// Dispatcher stub mirroring the real applyAmendmentMutation: glossary types add
// the term to the glossary document; entity types push a dimension.
const stubApplyAmendmentMutation = (
  doc: Record<string, unknown>,
  result: { amendmentType: string; amendment: Record<string, unknown> },
): Record<string, unknown> => {
  if (result.amendmentType === "add_glossary_term" || result.amendmentType === "update_glossary_term") {
    const clone = structuredClone(doc);
    const terms = (clone.terms ?? {}) as Record<string, unknown>;
    const { term, ...value } = result.amendment;
    terms[String(term)] = value;
    clone.terms = terms;
    return clone;
  }
  return stubApplyAmendment(doc);
};

void mock.module("@atlas/api/lib/semantic/expert/apply", () => ({
  applyAmendment: stubApplyAmendment,
  resolveAmendmentBaseline: mock(() => Promise.reject(new Error("should not be called without a DB"))),
  applyAmendmentFromPayload: mock(() => Promise.resolve()),
  applyAmendmentMutation: stubApplyAmendmentMutation,
  isGlossaryAmendmentType: (t: string) =>
    t === "add_glossary_term" || t === "update_glossary_term",
  resolveGlossaryBaseline: mock(() => Promise.reject(new Error("should not be called without a DB"))),
  glossaryDiffPath: (g?: string) =>
    g && g !== "default" ? `semantic/groups/${g}/glossary.yml` : "semantic/glossary.yml",
  GLOSSARY_DOC_NAME: "glossary",
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

  // ── Glossary amendments, no-DB preview branch (#4518) ──────────────────────

  async function runGlossary(): Promise<ProposeResult> {
    return (await proposeAmendment.execute!(
      {
        entityName: "companies",
        amendmentType: "add_glossary_term",
        amendment: { term: "MRR", definition: "Monthly Recurring Revenue" },
        rationale: "Define MRR",
        confidence: 0.9,
      },
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK execute options are irrelevant here
      {} as any,
    )) as ProposeResult;
  }

  it("previews a first glossary term against an empty document, attributed to glossary.yml", async () => {
    // No flat-root glossary.yml → the branch seeds an empty {} and the diff
    // renders the created term.
    fileExists = false;

    const result = await runGlossary();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("queued");
    expect(result.diff).toContain("semantic/glossary.yml");
    expect(result.diff).not.toContain("semantic/entities/");
    expect(result.diff).toContain("MRR");
    expect(result.diff).toContain("Monthly Recurring Revenue");
  });

  it("returns a parse error when the flat-root glossary.yml is not a YAML mapping", async () => {
    fileExists = true;
    fileContents = "- not\n- a\n- mapping\n";

    const result = await runGlossary();

    expect(result.error).toContain("Glossary file glossary.yml could not be parsed as a YAML mapping");
    expect(result.status).toBeUndefined();
  });
});
