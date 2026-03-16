/**
 * Auth types for Atlas.
 *
 * AuthMode determines how requests are authenticated.
 * AtlasRole determines the user's permission level for action approval.
 * AtlasUser represents a verified identity attached to a request.
 */

export { AUTH_MODES, ATLAS_ROLES } from "@useatlas/types/auth";
export type { AuthMode, AtlasRole, AtlasUser } from "@useatlas/types/auth";

import type { AuthMode, AtlasRole, AtlasUser } from "@useatlas/types/auth";

export type AuthResult =
  | { authenticated: true; mode: Exclude<AuthMode, "none">; user: AtlasUser }
  | { authenticated: true; mode: "none"; user: undefined }
  | { authenticated: false; mode: AuthMode; status: 401 | 500; error: string };

export interface CreateAtlasUserOptions {
  role?: AtlasRole;
  activeOrganizationId?: string;
  claims?: Record<string, unknown>;
}

/** Create a frozen AtlasUser with non-empty id/label validation. */
export function createAtlasUser(
  id: string,
  mode: Exclude<AuthMode, "none">,
  label: string,
  options?: CreateAtlasUserOptions,
): AtlasUser {
  if (!id) throw new Error("AtlasUser id must be non-empty");
  if (!label) throw new Error("AtlasUser label must be non-empty");
  const frozenClaims = options?.claims ? Object.freeze({ ...options.claims }) : undefined;
  return Object.freeze({
    id,
    mode,
    label,
    ...(options?.role !== undefined ? { role: options.role } : {}),
    ...(options?.activeOrganizationId !== undefined ? { activeOrganizationId: options.activeOrganizationId } : {}),
    ...(frozenClaims !== undefined ? { claims: frozenClaims } : {}),
  });
}
