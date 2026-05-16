/**
 * Shared MCP prompts listing logic — `listing.ts` (#2179).
 *
 * Pinned here separately from `registry.test.ts` because `listing.ts` has
 * two consumers — the MCP server's `prompts/list` handler AND the new
 * `/api/v1/me/mcp-prompts` HTTP endpoint — that must stay in lockstep on
 * both the prompt set and the canonical-gate envelope. This file pins
 * the public interface (return shape, source bucketing, gate reasons);
 * registry.test.ts continues to exercise the SDK-bound flow end-to-end.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let mockHasInternalDB = false;
let mockInternalQueryRows: Record<string, unknown>[] = [];
let mockInternalQueryError: Error | null = null;
let mockScannedEntities: Array<{
  filePath: string;
  sourceName: string;
  raw: Record<string, unknown>;
}> = [];
let mockSettings: Record<string, string | undefined> = {};

mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/tmp/atlas-test-semantic",
}));

mock.module("@atlas/api/lib/semantic/scanner", () => ({
  scanEntities: () => ({ entities: mockScannedEntities, warnings: [] }),
  getEntityDirs: () => ({ dirs: [], rootScanFailed: false }),
  readEntityYaml: () => null,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => {
    if (mockInternalQueryError) throw mockInternalQueryError;
    return mockInternalQueryRows;
  },
  internalExecute: async () => ({ rowCount: 1 }),
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string, _orgId?: string) => mockSettings[key],
}));

// Default canonical YAML — empty so source-merging tests don't accidentally
// pick up the 20 NovaMart prompts. Tests that need canonical content point
// `ATLAS_CANONICAL_QUESTIONS_PATH` at a fixture they create.
const emptyCanonicalDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "listing-canonical-empty-"),
);
fs.writeFileSync(
  path.join(emptyCanonicalDir, "questions.yml"),
  "questions: []\n",
);
process.env.ATLAS_CANONICAL_QUESTIONS_PATH = path.join(
  emptyCanonicalDir,
  "questions.yml",
);

const { listMcpPrompts } = await import("../../prompts/listing.js");

beforeEach(() => {
  mockHasInternalDB = false;
  mockInternalQueryRows = [];
  mockInternalQueryError = null;
  mockScannedEntities = [];
  mockSettings = {};
});

// ---------------------------------------------------------------------------
// Built-in source — always present, regardless of workspace context
// ---------------------------------------------------------------------------

describe("listMcpPrompts — built-ins", () => {
  it("returns the 5 built-in templates with source=builtin", async () => {
    const result = await listMcpPrompts({});
    const builtins = result.prompts.filter((p) => p.source === "builtin");
    expect(builtins).toHaveLength(5);
    const names = builtins.map((p) => p.name);
    expect(names).toContain("revenue-trend");
    expect(names).toContain("top-by-metric");
    expect(names).toContain("compare-periods");
    expect(names).toContain("breakdown");
    expect(names).toContain("anomaly-detection");
  });

  it("built-in entries carry argument metadata with required=true", async () => {
    const result = await listMcpPrompts({});
    const revenue = result.prompts.find((p) => p.name === "revenue-trend");
    expect(revenue).toBeDefined();
    expect(revenue?.arguments).toEqual([
      {
        name: "period",
        description: expect.stringContaining("Time period") as string,
        required: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Semantic source — query_patterns from entity YAMLs
// ---------------------------------------------------------------------------

describe("listMcpPrompts — semantic", () => {
  it("emits one entry per query_pattern with source=semantic", async () => {
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          query_patterns: [
            { name: "monthly-revenue", description: "Monthly revenue" },
            { name: "top-customers", description: "Top customers" },
          ],
        },
      },
    ];

    const result = await listMcpPrompts({});
    const semantic = result.prompts.filter((p) => p.source === "semantic");
    expect(semantic.map((p) => p.name)).toEqual([
      "entity-orders-monthly-revenue",
      "entity-orders-top-customers",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Library source — internal DB-backed
// ---------------------------------------------------------------------------

describe("listMcpPrompts — library", () => {
  it("loads library prompts when internal DB is available", async () => {
    mockHasInternalDB = true;
    mockInternalQueryRows = [
      {
        id: "lib-1",
        question: "How are users adopting the new feature?",
        description: "Adoption summary",
        collection_name: "Adoption",
      },
    ];

    const result = await listMcpPrompts({});
    const library = result.prompts.filter((p) => p.source === "library");
    expect(library).toHaveLength(1);
    expect(library[0]?.name).toBe("library-lib-1");
  });

  it("returns no library entries when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    const result = await listMcpPrompts({});
    expect(result.prompts.filter((p) => p.source === "library")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Canonical source — workspace-gated
// ---------------------------------------------------------------------------

describe("listMcpPrompts — canonical gate", () => {
  /**
   * Build a canonical fixture so the loader sees real prompts and the
   * inclusion decision is observable.
   */
  function fixtureWithCanonical(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-canonical-"));
    fs.writeFileSync(
      path.join(dir, "questions.yml"),
      [
        "questions:",
        '  - id: cq-001',
        '    mode: metric',
        '    metric_id: monthly_revenue',
        '    category: simple_metric',
        '    question: What was last month\'s revenue?',
      ].join("\n"),
    );
    return path.join(dir, "questions.yml");
  }

  it("includes canonical prompts when toggle=always", async () => {
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "always";

    const result = await listMcpPrompts({ workspaceId: "org-real" });

    expect(result.canonicalGate.exposed).toBe(true);
    expect(result.canonicalGate.reason).toBeNull();
    expect(
      result.prompts.filter((p) => p.source === "canonical").length,
    ).toBeGreaterThan(0);
  });

  it("hides canonical prompts when toggle=never with reason='toggle-never'", async () => {
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "never";

    const result = await listMcpPrompts({ workspaceId: "org-demo" });

    expect(result.canonicalGate.exposed).toBe(false);
    expect(result.canonicalGate.toggle).toBe("never");
    expect(result.canonicalGate.reason).toBe("toggle-never");
    expect(result.prompts.filter((p) => p.source === "canonical")).toEqual([]);
  });

  it("toggle=never wins over a positive demo signal (precedence)", async () => {
    // Pins the branch order in `evaluateCanonicalGate` — admin's explicit
    // opt-out must beat the auto-detected demo-industry signal. A
    // regression that reordered the toggle === "never" check below the
    // demo-signal probe would still expose canonicals here, and the UI
    // banner would show the wrong copy ("Atlas only surfaces canonical
    // eval prompts to demo workspaces") instead of "An admin disabled
    // the canonical NovaMart eval prompts."
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "never";
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";

    const result = await listMcpPrompts({ workspaceId: "org-demo" });

    expect(result.canonicalGate.exposed).toBe(false);
    expect(result.canonicalGate.reason).toBe("toggle-never");
  });

  it("surfaces reason='signal-unavailable' when the connections probe errors and no industry signal", async () => {
    // Distinguishes a real internal-DB outage from "this isn't a demo
    // workspace" — the UI banner copy + user-actionable advice differ
    // (retry / contact support vs flip toggle). A regression that
    // collapsed the error case back into `no-demo-signal` would leave
    // operators dogfooding the SaaS without an in-product outage signal.
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    mockHasInternalDB = true;
    mockInternalQueryError = new Error("connection refused");

    const result = await listMcpPrompts({ workspaceId: "org-real" });

    expect(result.canonicalGate.exposed).toBe(false);
    expect(result.canonicalGate.toggle).toBe("auto");
    expect(result.canonicalGate.reason).toBe("signal-unavailable");
  });

  it("DB error + industry signal still exposes (industry is enough on its own)", async () => {
    // Probe failure is recoverable when the industry signal independently
    // confirms demo status — the gate stays open. This pins that
    // `signal-unavailable` is reserved for the case where BOTH signals
    // fail to confirm demo status, not "any DB error."
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";
    mockHasInternalDB = true;
    mockInternalQueryError = new Error("connection refused");

    const result = await listMcpPrompts({ workspaceId: "org-demo" });

    expect(result.canonicalGate.exposed).toBe(true);
    expect(result.canonicalGate.reason).toBeNull();
  });

  it("hides canonical prompts on toggle=auto without demo signal (reason='no-demo-signal')", async () => {
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    // toggle defaults to auto; no industry, internal DB returns no demo connection
    mockHasInternalDB = true;
    mockInternalQueryRows = [{ active: false }];

    const result = await listMcpPrompts({ workspaceId: "org-real" });

    expect(result.canonicalGate.exposed).toBe(false);
    expect(result.canonicalGate.toggle).toBe("auto");
    expect(result.canonicalGate.reason).toBe("no-demo-signal");
  });

  it("exposes canonical prompts on toggle=auto when demo industry is set", async () => {
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = fixtureWithCanonical();
    mockSettings["ATLAS_DEMO_INDUSTRY"] = "ecommerce";

    const result = await listMcpPrompts({ workspaceId: "org-demo" });

    expect(result.canonicalGate.exposed).toBe(true);
    expect(result.canonicalGate.toggle).toBe("auto");
    expect(result.canonicalGate.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Combined ordering — built-in → canonical → semantic → library
// ---------------------------------------------------------------------------

describe("listMcpPrompts — ordering", () => {
  it("preserves built-in → canonical → semantic → library order", async () => {
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-order-"));
      fs.writeFileSync(
        path.join(dir, "questions.yml"),
        [
          "questions:",
          '  - id: cq-001',
          '    mode: metric',
          '    metric_id: monthly_revenue',
          '    question: What was last month\'s revenue?',
        ].join("\n"),
      );
      return path.join(dir, "questions.yml");
    })();
    mockSettings["ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS"] = "always";
    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          query_patterns: [{ name: "monthly", description: "Monthly" }],
        },
      },
    ];
    mockHasInternalDB = true;
    mockInternalQueryRows = [
      {
        id: "lib-1",
        question: "Adoption?",
        description: null,
        collection_name: "Adoption",
      },
    ];

    const result = await listMcpPrompts({ workspaceId: "org-1" });
    const sources = result.prompts.map((p) => p.source);
    const firstBuiltin = sources.indexOf("builtin");
    const firstCanonical = sources.indexOf("canonical");
    const firstSemantic = sources.indexOf("semantic");
    const firstLibrary = sources.indexOf("library");

    expect(firstBuiltin).toBeLessThan(firstCanonical);
    expect(firstCanonical).toBeLessThan(firstSemantic);
    expect(firstSemantic).toBeLessThan(firstLibrary);
  });
});

// ---------------------------------------------------------------------------
// Producer ↔ schema contract — every entry the listing pipeline emits must
// round-trip through `PromptListEntrySchema`. Without this, the four private
// constructors could drift from the discriminated union (e.g. a future
// refactor sneaks `arguments: undefined` into `semanticEntry`) and the
// regression would only surface at the route boundary at runtime.
// ---------------------------------------------------------------------------

describe("listMcpPrompts — producer ↔ schema contract", () => {
  it("every emitted entry round-trips through PromptListEntrySchema", async () => {
    const { PromptListEntrySchema } = await import(
      "@useatlas/schemas/mcp-prompts"
    );

    const canonicalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "listing-contract-canonical-"),
    );
    fs.writeFileSync(
      path.join(canonicalDir, "questions.yml"),
      [
        "questions:",
        '  - id: cq-001',
        '    mode: metric',
        '    metric_id: monthly_revenue',
        '    category: simple_metric',
        "    question: What was last month's revenue?",
      ].join("\n"),
    );
    process.env.ATLAS_CANONICAL_QUESTIONS_PATH = path.join(
      canonicalDir,
      "questions.yml",
    );

    mockScannedEntities = [
      {
        filePath: "/tmp/entities/orders.yml",
        sourceName: "default",
        raw: {
          table: "orders",
          query_patterns: [{ name: "monthly", description: "Monthly revenue" }],
        },
      },
    ];
    mockHasInternalDB = true;
    mockInternalQueryRows = [
      {
        id: "lib-1",
        question: "Adoption?",
        description: "Adoption summary",
        collection_name: "Adoption",
      },
    ];
    mockSettings = { ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS: "always" };

    const result = await listMcpPrompts({ workspaceId: "org-1" });
    const sources = new Set(result.prompts.map((p) => p.source));
    // All four constructors exercised — every arm of the discriminated
    // union round-trips through the schema below.
    expect(sources).toEqual(
      new Set(["builtin", "canonical", "semantic", "library"]),
    );

    for (const entry of result.prompts) {
      const parsed = PromptListEntrySchema.safeParse(entry);
      expect(parsed.success).toBe(true);
    }
  });
});
