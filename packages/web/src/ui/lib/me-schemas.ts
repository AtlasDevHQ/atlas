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

export const RevokeOAuthClientResponseSchema = z.object({
  success: z.boolean(),
  tokensRevoked: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// MCP prompts preview (#2179) — Settings → AI Agents
// ---------------------------------------------------------------------------

/**
 * Mirrors the API route's `PromptListEntrySchema`. The Settings → AI
 * Agents preview block buckets by `source` to show "Built-in (5) ·
 * Canonical (20) · Semantic (12) · Library (3)"; reading `source` off
 * each entry avoids name-prefix pattern-matching at the UI layer.
 */
export const McpPromptArgumentSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  required: z.boolean(),
});

export const McpPromptSourceSchema = z.enum([
  "builtin",
  "canonical",
  "semantic",
  "library",
]);

export const McpPromptListEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: z.array(McpPromptArgumentSchema),
  source: McpPromptSourceSchema,
});

/**
 * Canonical-prompts gate envelope. `exposed=false` means the canonical
 * eval prompts are hidden; `reason` tells the UI which banner to render:
 *   - "toggle-never"     — admin opted out at Admin → Settings → MCP
 *   - "no-demo-signal"   — toggle=auto, this isn't a demo workspace
 */
export const McpCanonicalGateSchema = z.object({
  exposed: z.boolean(),
  toggle: z.enum(["always", "never", "auto"]),
  reason: z.enum(["toggle-never", "no-demo-signal"]).nullable(),
});

export const McpPromptsResponseSchema = z.object({
  prompts: z.array(McpPromptListEntrySchema),
  canonicalGate: McpCanonicalGateSchema,
});

export type McpPromptListEntry = z.infer<typeof McpPromptListEntrySchema>;
export type McpPromptSource = z.infer<typeof McpPromptSourceSchema>;
export type McpCanonicalGate = z.infer<typeof McpCanonicalGateSchema>;
export type McpPromptsResponse = z.infer<typeof McpPromptsResponseSchema>;
