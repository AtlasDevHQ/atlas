export const AUTH_MODES = ["none", "simple-key", "managed", "byot"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const ATLAS_ROLES = ["viewer", "analyst", "admin"] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

export interface AtlasUser {
  id: string;
  mode: Exclude<AuthMode, "none">;
  label: string;
  /** Permission role for action approval. Defaults based on auth mode when not set. */
  role?: AtlasRole;
  /** Auth-source claims for RLS policy evaluation (JWT payload, session user, or env-derived). */
  claims?: Readonly<Record<string, unknown>>;
}
