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
import { z } from "zod";
import {
  PromptArgumentSchema,
  PromptSourceSchema,
  PromptListEntrySchema,
  CanonicalGateSchema,
  CanonicalGateReasonSchema,
  CanonicalToggleSchema,
  RefinedCanonicalGateSchema,
  addCanonicalGateRefinement,
  McpPromptsResponseSchema,
  CANONICAL_GATE_REASONS,
  CANONICAL_TOGGLES,
  PROMPT_SOURCES,
  type CanonicalGateWire,
  type PromptListEntry,
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
      arguments: [] as [],
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
  test("accepts a builtin entry with non-empty arguments", () => {
    expect(PromptListEntrySchema.parse(sampleEntry)).toEqual(sampleEntry);
  });

  test("accepts canonical/semantic/library entries with empty arguments", () => {
    for (const source of ["canonical", "semantic", "library"] as const) {
      // Cast through unknown — the discriminated union infers
      // `arguments: []` (empty tuple) on the non-builtin arm, so the
      // spread-then-override-with-`[]` literal needs the explicit shape
      // to satisfy the empty-tuple type.
      const entry = { ...sampleEntry, source, arguments: [] as [] };
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

  // Discriminated union enforces "only source: builtin ever has args" at
  // the parse boundary — canonical / semantic / library entries with
  // non-empty args must fail at runtime (and at the type level — see
  // the @ts-expect-error sites below).
  test.each(["canonical", "semantic", "library"] as const)(
    "rejects %s entries that smuggle in non-empty arguments",
    (source) => {
      const illegal = { ...sampleEntry, source };
      expect(() => PromptListEntrySchema.parse(illegal)).toThrow();
    },
  );

  test("type-level: canonical entries with non-empty args are unrepresentable", () => {
    // Compile-time witnesses for the discriminated-union shape — if a
    // future regression flattens the union, these `@ts-expect-error`s
    // become unused and `tsgo --noEmit` fails the build.

    // @ts-expect-error — canonical arm forbids non-empty arguments.
    const _illegalCanonical: PromptListEntry = {
      source: "canonical",
      name: "x",
      description: "y",
      arguments: [{ name: "a", description: "b", required: true }],
    };
    void _illegalCanonical;

    // @ts-expect-error — semantic arm forbids non-empty arguments.
    const _illegalSemantic: PromptListEntry = {
      source: "semantic",
      name: "x",
      description: "y",
      arguments: [{ name: "a", description: "b", required: true }],
    };
    void _illegalSemantic;

    // @ts-expect-error — library arm forbids non-empty arguments.
    const _illegalLibrary: PromptListEntry = {
      source: "library",
      name: "x",
      description: "y",
      arguments: [{ name: "a", description: "b", required: true }],
    };
    void _illegalLibrary;

    // Sanity — the legal builtin shape still satisfies the union.
    const _legalBuiltin: PromptListEntry = {
      source: "builtin",
      name: "x",
      description: "y",
      arguments: [{ name: "a", description: "b", required: true }],
    };
    void _legalBuiltin;
    expect(true).toBe(true);
  });
});

describe("CanonicalGateSchema (raw object — used by .extend)", () => {
  test("accepts exposed=true with reason=null", () => {
    const gate = { exposed: true, toggle: "always" as const, reason: null };
    expect(CanonicalGateSchema.parse(gate)).toEqual(gate);
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

describe("RefinedCanonicalGateSchema (route response parser)", () => {
  test("accepts exposed=true with reason=null", () => {
    const gate = { exposed: true, toggle: "always" as const, reason: null };
    expect(RefinedCanonicalGateSchema.parse(gate)).toEqual(gate);
  });

  test("accepts exposed=false with each closed-gate reason", () => {
    for (const reason of CANONICAL_GATE_REASONS) {
      const gate = { exposed: false, toggle: "auto" as const, reason };
      expect(RefinedCanonicalGateSchema.parse(gate)).toEqual(gate);
    }
  });

  test("rejects representable-but-illegal {exposed:true, reason:set}", () => {
    expect(() =>
      RefinedCanonicalGateSchema.parse({
        exposed: true,
        toggle: "always",
        reason: "toggle-never",
      }),
    ).toThrow(/reason must be null when exposed=true/);
  });

  test("rejects representable-but-illegal {exposed:false, reason:null}", () => {
    expect(() =>
      RefinedCanonicalGateSchema.parse({
        exposed: false,
        toggle: "auto",
        reason: null,
      }),
    ).toThrow(/reason must be set when exposed=false/);
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

// Every shape `evaluateCanonicalGate` (in `packages/mcp/src/prompts/gating.ts`)
// can produce, captured as a fixture so a future producer branch that adds
// a 6th case has to either match an existing tuple or extend this array
// (and the route's strict schema gets exercised against it).
const PRODUCER_OUTCOMES: CanonicalGateWire[] = [
  // toggle=always
  { exposed: true, toggle: "always", reason: null },
  // toggle=never
  { exposed: false, toggle: "never", reason: "toggle-never" },
  // toggle=auto + probe-active OR industry signal
  { exposed: true, toggle: "auto", reason: null },
  // toggle=auto + probe-errored + no industry
  { exposed: false, toggle: "auto", reason: "signal-unavailable" },
  // toggle=auto + probe-inactive + no industry
  { exposed: false, toggle: "auto", reason: "no-demo-signal" },
];

describe("Producer→route round-trip", () => {
  test.each(PRODUCER_OUTCOMES)(
    "RefinedCanonicalGateSchema accepts producer outcome %p",
    (outcome) => {
      expect(RefinedCanonicalGateSchema.parse(outcome)).toEqual(outcome);
    },
  );
});

describe("addCanonicalGateRefinement (programmatic application)", () => {
  // A schema overlay representative of what an SDK consumer might build:
  // start from the canonical wire shape, layer a `.catch` on the reason
  // (mirrors the web pattern), then apply the refinement on top. Confirms
  // the refinement composes through `.extend` without a TypeScript bend.
  const tolerantThenRefined = addCanonicalGateRefinement(
    CanonicalGateSchema.extend({
      reason: CanonicalGateReasonSchema.nullable().catch(null),
    }),
  );

  test("known-good values pass", () => {
    const gate = { exposed: true, toggle: "always" as const, reason: null };
    expect(tolerantThenRefined.parse(gate)).toEqual(gate);
  });

  test("invariant still rejects exposed=true with reason=set", () => {
    expect(() =>
      tolerantThenRefined.parse({
        exposed: true,
        toggle: "always",
        reason: "toggle-never",
      }),
    ).toThrow(/reason must be null/);
  });

  test("a forward-compat reason is coerced to null then re-rejected by the invariant", () => {
    // The `.catch` coerces `"future"` → `null`, then the refinement runs
    // with `{exposed:false, reason:null}` which is illegal. This is the
    // documented reason the web layer does NOT compose `.catch` with the
    // refinement — the test pins that interaction so the doc stays
    // honest.
    expect(() =>
      tolerantThenRefined.parse({
        exposed: false,
        toggle: "auto",
        reason: "future",
      }),
    ).toThrow(/reason must be set/);
  });

  test("addCanonicalGateRefinement returns the same schema type (zod superRefine returns this)", () => {
    // Compile-time witness — if a future Zod bump makes superRefine
    // return ZodEffects, the type assertion below fails compile.
    const refined = addCanonicalGateRefinement(CanonicalGateSchema);
    const _typeCheck: typeof CanonicalGateSchema = refined;
    void _typeCheck;
    expect(refined).toBeInstanceOf(z.ZodObject);
  });
});
