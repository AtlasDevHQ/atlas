/**
 * Contract tests for the MCP-prompts wire schema (#2192).
 *
 * The same fixture must round-trip through every consumer's parse path:
 *
 *   1. Route layer — `McpPromptsResponseSchema` from
 *      `@useatlas/schemas/mcp-prompts` (used directly by
 *      `packages/api/src/api/routes/me-mcp-prompts.ts`).
 *   2. Web layer — `McpPromptsResponseSchema` re-exported via
 *      `packages/web/src/ui/lib/me-schemas.ts` (with `.catch(null)`
 *      tolerance on the gate reason for forward-compat).
 *   3. mcp prompts pipeline — types from `@useatlas/schemas/mcp-prompts`
 *      drive `PromptListEntry` / `CanonicalGateResult` in
 *      `packages/mcp/src/prompts/listing.ts`.
 *
 * If a future change drifts the canonical Zod against the wire shape
 * the listing pipeline produces, this file fails before the route /
 * web parse ever sees the bad shape.
 */
import { describe, expect, test } from "bun:test";
import {
  PromptArgumentSchema,
  PromptSourceSchema,
  PromptListEntrySchema,
  CanonicalGateSchema,
  CanonicalGateReasonSchema,
  CanonicalToggleSchema,
  McpPromptsResponseSchema,
  CANONICAL_GATE_REASONS,
  CANONICAL_TOGGLES,
  PROMPT_SOURCES,
} from "../mcp-prompts";

const sampleEntry = {
  name: "revenue-trend",
  description: "Show revenue trends over a time period",
  arguments: [
    { name: "period", description: "Time period to analyze", required: true },
  ],
  source: "builtin" as const,
};

const sampleResponse = {
  prompts: [
    sampleEntry,
    {
      name: "entity-orders-monthly-revenue",
      description: "[orders] Aggregate revenue by month",
      arguments: [],
      source: "semantic" as const,
    },
  ],
  canonicalGate: {
    exposed: false,
    toggle: "auto" as const,
    reason: "no-demo-signal" as const,
  },
};

describe("PROMPT_SOURCES", () => {
  test("matches PromptSourceSchema enum", () => {
    for (const value of PROMPT_SOURCES) {
      expect(PromptSourceSchema.parse(value)).toBe(value);
    }
  });

  test("rejects unknown source", () => {
    expect(() => PromptSourceSchema.parse("unknown")).toThrow();
  });
});

describe("CANONICAL_GATE_REASONS", () => {
  test("matches CanonicalGateReasonSchema enum", () => {
    for (const value of CANONICAL_GATE_REASONS) {
      expect(CanonicalGateReasonSchema.parse(value)).toBe(value);
    }
  });

  test("rejects unknown reason", () => {
    expect(() => CanonicalGateReasonSchema.parse("internal-db-down")).toThrow();
  });
});

describe("CANONICAL_TOGGLES", () => {
  test("matches CanonicalToggleSchema enum", () => {
    for (const value of CANONICAL_TOGGLES) {
      expect(CanonicalToggleSchema.parse(value)).toBe(value);
    }
  });
});

describe("PromptArgumentSchema", () => {
  test("requires non-empty name", () => {
    expect(() =>
      PromptArgumentSchema.parse({ name: "", description: "x", required: true }),
    ).toThrow();
  });

  test("accepts a fully populated arg", () => {
    expect(
      PromptArgumentSchema.parse(sampleEntry.arguments[0]),
    ).toEqual(sampleEntry.arguments[0]);
  });
});

describe("PromptListEntrySchema", () => {
  test("accepts every source bucket", () => {
    for (const source of PROMPT_SOURCES) {
      const entry = { ...sampleEntry, source };
      expect(PromptListEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  test("description is optional", () => {
    const { description: _drop, ...rest } = sampleEntry;
    expect(PromptListEntrySchema.parse(rest)).toMatchObject(rest);
  });

  test("rejects unknown source even if every other field is fine", () => {
    expect(() =>
      PromptListEntrySchema.parse({ ...sampleEntry, source: "rogue" }),
    ).toThrow();
  });
});

describe("CanonicalGateSchema", () => {
  test("accepts exposed=true with reason=null", () => {
    const gate = { exposed: true, toggle: "always" as const, reason: null };
    expect(CanonicalGateSchema.parse(gate)).toEqual(gate);
  });

  test("accepts exposed=false with each closed-gate reason", () => {
    for (const reason of CANONICAL_GATE_REASONS) {
      const gate = { exposed: false, toggle: "auto" as const, reason };
      expect(CanonicalGateSchema.parse(gate)).toEqual(gate);
    }
  });

  test("rejects unknown reason at the canonical (route) boundary", () => {
    expect(() =>
      CanonicalGateSchema.parse({
        exposed: false,
        toggle: "auto",
        reason: "future-signal",
      }),
    ).toThrow();
  });
});

describe("McpPromptsResponseSchema", () => {
  test("round-trips a representative response", () => {
    expect(McpPromptsResponseSchema.parse(sampleResponse)).toEqual(sampleResponse);
  });

  test("an empty prompt list is valid (closed gate, no semantic root, no library)", () => {
    const empty = {
      prompts: [],
      canonicalGate: {
        exposed: false,
        toggle: "never" as const,
        reason: "toggle-never" as const,
      },
    };
    expect(McpPromptsResponseSchema.parse(empty)).toEqual(empty);
  });
});
