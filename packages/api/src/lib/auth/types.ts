/**
 * Auth types for Atlas.
 *
 * AuthMode determines how requests are authenticated.
 * AtlasRole determines the user's permission level for action approval.
 * AtlasUser represents a verified identity attached to a request.
 * AuthResult is the return type from all auth validators.
 */

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

export type AuthResult =
  | { authenticated: true; mode: Exclude<AuthMode, "none">; user: AtlasUser }
  | { authenticated: true; mode: "none"; user: undefined }
  | { authenticated: false; mode: AuthMode; status: 401 | 500; error: string };

/** Create a frozen AtlasUser with non-empty id/label validation. */
export function createAtlasUser(
  id: string,
  mode: Exclude<AuthMode, "none">,
  label: string,
  role?: AtlasRole,
  claims?: Record<string, unknown>,
): AtlasUser {
  if (!id) throw new Error("AtlasUser id must be non-empty");
  if (!label) throw new Error("AtlasUser label must be non-empty");
  const frozenClaims = claims ? Object.freeze({ ...claims }) : undefined;
  return Object.freeze({
    id,
    mode,
    label,
    ...(role ? { role } : {}),
    ...(frozenClaims ? { claims: frozenClaims } : {}),
  });
}
