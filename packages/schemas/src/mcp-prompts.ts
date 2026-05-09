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
 */
export const PromptListEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.array(PromptArgumentSchema),
  source: PromptSourceSchema,
});
export type PromptListEntry = z.infer<typeof PromptListEntrySchema>;

/**
 * Canonical-prompts gate envelope. Modelled as a flat `ZodObject` (rather
 * than a `z.discriminatedUnion("exposed", ...)`) because the OpenAPI
 * extractor emits a richer schema for a flat object than for a `oneOf`
 * union, and downstream TS consumers narrow on the producer-side
 * discriminated union from `gating.ts` rather than on the wire shape.
 *
 * Kept as a raw `ZodObject` so consumers can `.extend({...})` it (the
 * web layer overlays a `.catch(null)` on the reason for forward-compat —
 * `.extend()` is unavailable on `ZodEffects`). The cross-field invariant
 * `exposed=true ⇔ reason=null` is bolted on via the
 * `RefinedCanonicalGateSchema` wrapper below — used by routes and web
 * for parse-time validation; the raw object is what surfaces in
 * OpenAPI.
 */
export const CanonicalGateSchema = z.object({
  exposed: z.boolean(),
  toggle: CanonicalToggleSchema,
  reason: CanonicalGateReasonSchema.nullable(),
});
export type CanonicalGateWire = z.infer<typeof CanonicalGateSchema>;

/**
 * Raw refinement function so a consumer that re-builds the schema with
 * `.catch(null)` (web parse path) can re-apply the same invariant. The
 * route layer uses `RefinedCanonicalGateSchema` directly; the web layer
 * applies `addCanonicalGateRefinement` to its tolerant variant.
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
 * Strict gate parser used by the route response schema — accepts only
 * the producer-side invariant `exposed=true ⇔ reason=null`. The web
 * client re-applies the same invariant on its `.catch(null)` variant
 * via `addCanonicalGateRefinement`.
 */
export const RefinedCanonicalGateSchema = addCanonicalGateRefinement(CanonicalGateSchema);

export const McpPromptsResponseSchema = z.object({
  prompts: z.array(PromptListEntrySchema),
  canonicalGate: RefinedCanonicalGateSchema,
});
export type McpPromptsResponse = z.infer<typeof McpPromptsResponseSchema>;
