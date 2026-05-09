/**
 * MCP-prompts wire-format schemas — single source of truth for the
 * `/api/v1/me/mcp-prompts` response shape, used by the listing pipeline,
 * the route layer, and the web client.
 *
 * The Zod schemas are authoritative; TS shapes are `z.infer<>` of the
 * schemas, so a new `CanonicalGateReason` / `PromptSource` / `CanonicalToggle`
 * value is a one-place change and drift surfaces as a TS error in every
 * consumer.
 *
 * Why these schemas live in `@useatlas/schemas` and not in `@atlas/mcp`:
 * the mcp package depends on `@atlas/api`, so a Zod entry point exported
 * from there would transitively pull `@atlas/api` into any web caller —
 * a violation of the "frontend never imports from `@atlas/api`" rule
 * documented in CLAUDE.md. `@useatlas/schemas` sits below `@atlas/*` (an
 * ESLint `no-restricted-imports` rule scoped to `packages/schemas/**`
 * fails the lint on an upward import) so the dependency direction stays
 * `types → schemas → api/web/mcp`.
 */
import { z } from "zod";
import type { CanonicalToggle } from "@useatlas/types/mcp";

// ---------------------------------------------------------------------------
// Enum tuples — exported for callers that need the values at runtime
// (test fixtures, exhaustive maps in UI code). The schemas package can
// safely export const tuples; the scaffold-CI caveat is on
// `@useatlas/types`, not on `@useatlas/schemas`.
// ---------------------------------------------------------------------------

/**
 * Where each entry in `prompts/list` came from. Used by the Settings →
 * AI Agents preview block to bucket and count without round-tripping a
 * name-prefix heuristic.
 */
export const PROMPT_SOURCES = [
  "builtin",
  "canonical",
  "semantic",
  "library",
] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];
export const PromptSourceSchema = z.enum(PROMPT_SOURCES);

/**
 * Closed gate reasons surfaced via `/api/v1/me/mcp-prompts` so the
 * Settings → AI Agents preview block can render the right banner copy.
 *
 *   - `toggle-never`        — admin opted out at Admin → Settings → MCP.
 *   - `no-demo-signal`      — toggle=auto, the workspace has no
 *                             `__demo__` connection AND no
 *                             `ATLAS_DEMO_INDUSTRY` setting.
 *   - `signal-unavailable`  — toggle=auto, the connections probe
 *                             failed AND no industry signal could
 *                             confirm demo status either way (operator-
 *                             facing outage signal, distinct from the
 *                             confirmed-not-demo case).
 */
export const CANONICAL_GATE_REASONS = [
  "toggle-never",
  "no-demo-signal",
  "signal-unavailable",
] as const;
export type CanonicalGateReason = (typeof CANONICAL_GATE_REASONS)[number];
export const CanonicalGateReasonSchema = z.enum(CANONICAL_GATE_REASONS);

/**
 * Tri-state setting from `@useatlas/types/mcp`. The matching const tuple
 * lives here (not in `@useatlas/types`) because adding a value export to
 * the published `@useatlas/types` package breaks scaffold-CI smoke
 * tests. Schemas is private/workspace-internal and free of that
 * constraint.
 *
 * Bidirectional drift guard:
 *   - `satisfies` checks the array is a subset of the type.
 *   - `_TogglesArrayCovers` checks the type is a subset of the array.
 * Together they fail at compile-time if a value is added to one side
 * but not the other.
 */
export const CANONICAL_TOGGLES = ["always", "never", "auto"] as const satisfies
  readonly CanonicalToggle[];
type _TogglesArrayCovers =
  CanonicalToggle extends (typeof CANONICAL_TOGGLES)[number] ? true : never;
const _togglesArrayCovers: _TogglesArrayCovers = true;
void _togglesArrayCovers;
export const CanonicalToggleSchema = z.enum(CANONICAL_TOGGLES);

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

export const PromptArgumentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  required: z.boolean(),
});
export type PromptArgumentSpec = z.infer<typeof PromptArgumentSchema>;

/**
 * Workspace-shaped prompt list entry. `source` lets the preview block
 * bucket by origin without a name-prefix heuristic; the SDK
 * `prompts/list` shape strips the field at the surface.
 *
 * Modeled as a `z.discriminatedUnion("source", …)` so the invariant
 * "only `source: \"builtin\"` ever has args" — enforced today by the
 * private constructors in `packages/mcp/src/prompts/listing.ts` — is
 * lifted to a compile-time fact: the canonical / semantic / library
 * arms type `arguments` as `[]`, so a future contributor can't smuggle
 * a non-empty arg list past the type checker (and runtime
 * `safeParse` rejects the same shape with the same parse error every
 * other arm catches). Consumers narrow on `entry.source` to get the
 * right shape instead of defensively iterating `entry.arguments` on
 * every entry.
 *
 * The wire shape is unchanged from the pre-discriminated flat object —
 * same fields, same JSON, just typed tighter — so the OpenAPI
 * extraction and the route's `c.json` payload stay byte-identical.
 */
const PromptListEntryBuiltinSchema = z.object({
  source: z.literal("builtin"),
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.array(PromptArgumentSchema),
});

const PromptListEntryHardcodedEmptyArgsSchema = z.object({
  source: z.enum(["canonical", "semantic", "library"]),
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.tuple([]),
});

export const PromptListEntrySchema = z.discriminatedUnion("source", [
  PromptListEntryBuiltinSchema,
  PromptListEntryHardcodedEmptyArgsSchema,
]);
export type PromptListEntry = z.infer<typeof PromptListEntrySchema>;

/**
 * Canonical-prompts gate envelope. Modelled as a flat `ZodObject`
 * (rather than `z.discriminatedUnion("exposed", ...)`) because the
 * OpenAPI extractor emits a richer flat-object schema than a `oneOf`
 * union, and downstream TS consumers narrow on the producer-side
 * discriminated union from `gating.ts` rather than on the wire shape.
 *
 * Kept as a raw `ZodObject` so callers can `.extend({...})` it — the
 * web layer overlays a `.catch(null)` on the reason for forward-compat,
 * and `.extend()` is unavailable on `ZodEffects` (the type
 * `superRefine` returns).
 *
 * The cross-field invariant `exposed=true ⇔ reason=null` is enforced
 * by `RefinedCanonicalGateSchema` (parse-time only — the OpenAPI
 * extractor reads through the refinement to this inner object so the
 * spec stays a flat object with `null` permitted on `reason`; the
 * runtime `parse()` rejects the illegal pair).
 */
export const CanonicalGateSchema = z.object({
  exposed: z.boolean(),
  toggle: CanonicalToggleSchema,
  reason: CanonicalGateReasonSchema.nullable(),
});
export type CanonicalGateWire = z.infer<typeof CanonicalGateSchema>;

/**
 * Re-usable cross-field refinement. Today's only caller is
 * `RefinedCanonicalGateSchema` below (the strict route boundary). The
 * web layer (`packages/web/src/ui/lib/me-schemas.ts`) deliberately
 * does NOT apply this refinement on top of its `.catch(null)` variant:
 * the catch coerces a malformed reason to `null`, and combining both
 * would re-reject the very `{exposed:false, reason:"future-signal"}`
 * case the catch exists to absorb. The route's strict path is the
 * boundary that validates the invariant.
 *
 * Kept exported anyway — a future caller (e.g. an SDK consumer
 * round-tripping a serialized response) may want strict semantics
 * without re-implementing the predicate.
 */
export function addCanonicalGateRefinement<T extends z.ZodType<CanonicalGateWire>>(schema: T): T {
  return schema.superRefine((gate, ctx) => {
    if (gate.exposed && gate.reason !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason must be null when exposed=true",
      });
    }
    if (!gate.exposed && gate.reason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason must be set when exposed=false",
      });
    }
  });
}

/**
 * Strict gate parser used by the route response schema — rejects
 * `{exposed:true, reason:set}` and `{exposed:false, reason:null}` at
 * `parse()` time. The OpenAPI spec sees the inner `CanonicalGateSchema`
 * (the extractor doesn't render Zod refinements as JSON-schema
 * constraints), so the cross-field check is runtime-only.
 */
export const RefinedCanonicalGateSchema = addCanonicalGateRefinement(CanonicalGateSchema);

export const McpPromptsResponseSchema = z.object({
  prompts: z.array(PromptListEntrySchema),
  canonicalGate: RefinedCanonicalGateSchema,
});
export type McpPromptsResponse = z.infer<typeof McpPromptsResponseSchema>;
