/**
 * MCP-prompts wire-format schemas (#2192).
 *
 * Single source of truth for the `/api/v1/me/mcp-prompts` response shape.
 * Three surfaces previously kept parallel definitions in lockstep by hand:
 *
 *   1. `packages/mcp/src/prompts/listing.ts`        — TS interfaces
 *   2. `packages/api/src/api/routes/me-mcp-prompts.ts` — route Zod
 *   3. `packages/web/src/ui/lib/me-schemas.ts`         — web parse Zod
 *
 * They are now derived from this module: the Zod schemas are authoritative,
 * the TS shapes are `z.infer<>` of the schemas. Adding a future
 * `CanonicalGateReason` value or `PromptSource` value is a one-place change
 * here — drift surfaces as a TS error in every consumer.
 *
 * Why `@useatlas/schemas` and not `@atlas/mcp` (the issue's option B): the
 * mcp package depends on `@atlas/api`, so if `@atlas/web` imported its
 * Zod entry point the frontend would transitively pull `@atlas/api` —
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
 * tests; see the caveat at
 * `packages/web/src/app/admin/settings/mcp/page.tsx:34-42`. Schemas is
 * private/workspace-internal and free of that constraint.
 */
export const CANONICAL_TOGGLES = ["always", "never", "auto"] as const satisfies
  readonly CanonicalToggle[];
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
 * Canonical-prompts gate envelope. The TS-side discriminated-union
 * invariant (`exposed=true ⇒ reason=null`) is enforced at the producer
 * in `@atlas/mcp/prompts/gating.ts`; the wire schema validates only
 * field presence/shape so the OpenAPI extractor keeps a flat object.
 *
 * Web parse uses `.catch(null)` on the reason so a forward-compatible
 * value during a multi-PR rollout degrades to the "unknown reason"
 * banner branch instead of failing the entire response. That tolerance
 * is applied at the consumer site, not here, so the route's strict
 * schema still rejects a malformed value at the API boundary.
 */
export const CanonicalGateSchema = z.object({
  exposed: z.boolean(),
  toggle: CanonicalToggleSchema,
  reason: CanonicalGateReasonSchema.nullable(),
});
export type CanonicalGateWire = z.infer<typeof CanonicalGateSchema>;

export const McpPromptsResponseSchema = z.object({
  prompts: z.array(PromptListEntrySchema),
  canonicalGate: CanonicalGateSchema,
});
export type McpPromptsResponse = z.infer<typeof McpPromptsResponseSchema>;
