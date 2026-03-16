/**
 * Auth types shared across API, frontend, and SDK.
 *
 * AuthMode determines how requests are authenticated.
 * AtlasRole determines the user's permission level for action approval.
 * AtlasUser represents a verified identity attached to a request.
 */

export const AUTH_MODES = ["none", "simple-key", "managed", "byot"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const ATLAS_ROLES = ["member", "admin", "owner"] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

export interface AtlasUser {
  id: string;
  mode: Exclude<AuthMode, "none">;
  label: string;
  /** Permission role for action approval. Defaults based on auth mode when not set. */
  role?: AtlasRole;
  /** Active organization ID from session. All data is scoped to this org. */
  activeOrganizationId?: string;
  /** Auth-source claims for RLS policy evaluation (JWT payload, session user, or env-derived). */
  claims?: Readonly<Record<string, unknown>>;
}
