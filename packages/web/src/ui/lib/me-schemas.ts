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
