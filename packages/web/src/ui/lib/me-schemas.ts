/**
 * Per-user (`/api/v1/me/*`) wire schemas (#2065 — Settings → AI Agents).
 *
 * The OAuth-client shape is identical between the admin surface
 * (`/admin/oauth-clients`) and the per-user surface
 * (`/settings/ai-agents`). The schemas live here, not in
 * `admin-schemas.ts`, because they're shared by both pages and the per-user
 * surface is not admin-gated. `admin-schemas.ts` re-exports them so existing
 * import paths keep working.
 */
import { z } from "zod";

/**
 * One OAuth 2.1 client row from `/api/v1/admin/oauth-clients` or
 * `/api/v1/me/oauth-clients`. The hosted MCP install path issues these via
 * Dynamic Client Registration; both pages read them for inspection +
 * revocation. `lastUsedAt` is the most recent
 * `oauthAccessToken.createdAt` for the client and goes null when no token
 * has been issued yet (registered but never used).
 */
export const OAuthClientSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().nullable(),
  // Reject malformed values at the parse boundary so an adapter
  // regression at the API edge fails loudly here instead of rendering
  // as a broken row. WHATWG URL parsing accepts custom schemes
  // (`claude://`, `cursor://`) which DCR-registered native agents use.
  redirectUris: z.array(z.string().url()),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  // The DB column is nullable but the route normalizes via `Boolean(...)`
  // — the wire contract is always boolean, never null. Modeling as
  // `z.boolean()` saves consumers a `client.disabled === true` vs
  // `!!client.disabled` ambiguity.
  disabled: z.boolean(),
  type: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  // Counts come from a Postgres COUNT(*) routed through `parseInt(...)` in
  // the route. `int().nonnegative()` rejects NaN (parseInt of garbage),
  // negatives, and fractions — defense-in-depth for the route's coercion.
  tokenCount: z.number().int().nonnegative(),
  // tokenState (#2066) — derived in SQL from disabled flag + outstanding
  // non-expired access/refresh tokens. The Settings → AI Agents table
  // renders this as a status badge:
  //   - "active"             → green "Active"
  //   - "reconnect_required" → amber CTA prompting the user to re-run
  //                            the connect wizard
  //   - "revoked"            → dimmed row, deletion is the only sensible
  //                            next step
  // Legacy `tokenCount` stays as the informational "tokens issued"
  // signal; `tokenState` is the load-bearing health field.
  tokenState: z.enum(["active", "reconnect_required", "revoked"]),
  /**
   * Per-OAuth-client MCP rate limit override (#2071). `null` means the
   * client uses the workspace default (60 req/min); a numeric value is
   * the admin-set override. The admin page renders this as a "Rate"
   * column with a small badge: "60/min" (default, dimmed) or
   * "120/min · override" (bold) so admins can see at a glance which
   * clients have a custom budget.
   *
   * Bound: 1..3600 enforced at the DB CHECK constraint and the route
   * input schema. The wire shape stays open-int-or-null because the
   * admin page renders any positive integer; the validation belongs at
   * the write boundary, not on the read boundary.
   */
  rateLimitPerMinute: z.number().int().positive().nullable(),
  /**
   * Cross-workspace agent identity (#2073). `'single'` means the client
   * is bound to its origin workspace (legacy behavior); `'multi'` means
   * the user upgraded the client to access every workspace they're a
   * member of via per-request `X-Atlas-Workspace` resolution. The
   * Settings → AI Agents page renders a "Connected to all your
   * workspaces" badge for the multi state and surfaces per-workspace
   * revoke beneath the row.
   *
   * Strict enum (no `.catch` fallback) — this field controls the UI's
   * scope-toggle and per-workspace revoke gating. A server bug emitting
   * an unknown value should fail the parse loudly so we get an error
   * boundary surface, not silently render the agent as `'single'` and
   * have the user revoke the wrong way.
   */
  workspaceScope: z.enum(["single", "multi"]),
  /**
   * The granted workspace ids for `'multi'`-scope clients. Ordered by
   * `granted_at ASC` (origin workspace first). Empty for `'single'` —
   * the implicit grant is the OAuth client's `referenceId` and lives
   * outside the grant table.
   */
  grantedWorkspaceIds: z.array(z.string()),
});

export const ListOAuthClientsResponseSchema = z.object({
  clients: z.array(OAuthClientSchema),
});

export type OAuthClient = z.infer<typeof OAuthClientSchema>;

/**
 * Response for `/api/v1/me/oauth-clients` — same `clients` payload as the
 * admin variant, plus the resolved `deployMode` so the page can show the
 * "Connect new agent" CTA only for SaaS users (self-hosted operators
 * register via the admin surface or the CLI). `deployMode` is part of the
 * page's data fetch so the gate doesn't require a second admin-only roundtrip
 * (`useDeployMode` calls `/api/v1/admin/settings`, which 403s for non-admins).
 */
export const MeOAuthClientsResponseSchema = z.object({
  clients: z.array(OAuthClientSchema),
  deployMode: z.enum(["self-hosted", "saas"]),
});

export type MeOAuthClientsResponse = z.infer<typeof MeOAuthClientsResponseSchema>;

// Per-OAuth-client live MCP rate-limit usage (#2216) — schemas are
// sourced from `@useatlas/schemas/mcp-usage` so the route layer and
// this web client derive from one Zod definition. A wire-bound change
// is a one-place edit and drift surfaces as a TS error in every
// consumer rather than a runtime "version mismatch" banner. Mirrors
// the `mcp-prompts` precedent above.
import {
  McpUsageEntrySchema,
  MeMcpUsageResponseSchema,
  type McpUsageEntry,
  type MeMcpUsageResponse,
} from "@useatlas/schemas/mcp-usage";

export {
  McpUsageEntrySchema,
  MeMcpUsageResponseSchema,
  type McpUsageEntry,
  type MeMcpUsageResponse,
};

export const RevokeOAuthClientResponseSchema = z.object({
  success: z.boolean(),
  tokensRevoked: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// MCP prompts preview — Settings → AI Agents
//
// Schemas are sourced from `@useatlas/schemas/mcp-prompts` so the listing
// pipeline, the route layer, and this web client derive from one Zod
// definition. The local `Mcp*` aliases below stay so existing component
// imports keep working without a sweeping rename.
// ---------------------------------------------------------------------------

import {
  PromptArgumentSchema,
  PromptSourceSchema,
  PromptListEntrySchema,
  CanonicalGateSchema,
  CanonicalGateReasonSchema,
  type PromptListEntry,
  type PromptSource,
  type CanonicalGateWire,
} from "@useatlas/schemas/mcp-prompts";

export const McpPromptArgumentSchema = PromptArgumentSchema;
export const McpPromptSourceSchema = PromptSourceSchema;
export const McpPromptListEntrySchema = PromptListEntrySchema;

/**
 * Web-client copy of the canonical-gate schema with `.catch` on the
 * reason enum so a forward-compatible reason value during a multi-PR
 * rollout degrades to the "unknown reason" banner branch instead of
 * blanking the preview block. The canonical wire schema (used by the
 * route) is strict — the tolerance lives only at the read side and
 * fires `console.warn` so wire drift stays visible in dev tools rather
 * than silently masked.
 *
 * The cross-field invariant (`exposed=true ⇔ reason=null`) is
 * intentionally NOT re-applied here because `.catch` coerces a
 * malformed reason to `null`, and combining the two would re-reject
 * the very case `.catch` exists to absorb (`{exposed:false,
 * reason:"future-signal"}` → coerce to null → invariant rejects). The
 * route's strict schema is the boundary that catches drift.
 */
export const McpCanonicalGateSchema = CanonicalGateSchema.extend({
  reason: CanonicalGateReasonSchema.nullable().catch((ctx) => {
    console.warn(
      "[mcp-prompts] canonical gate reason failed to parse — coercing to null",
      ctx.issues,
    );
    return null;
  }),
});

export const McpPromptsResponseSchema = z.object({
  prompts: z.array(PromptListEntrySchema),
  canonicalGate: McpCanonicalGateSchema,
});

export type McpPromptListEntry = PromptListEntry;
export type McpPromptSource = PromptSource;
export type McpCanonicalGate = CanonicalGateWire;
export type McpPromptsResponse = z.infer<typeof McpPromptsResponseSchema>;
