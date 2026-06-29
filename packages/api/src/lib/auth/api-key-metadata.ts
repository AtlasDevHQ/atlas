/**
 * Workspace-scoped API-key metadata (#4046 / ADR-0027 §6).
 *
 * The unattended-CI credential is a Better Auth `apiKey()` key whose `metadata`
 * carries the workspace binding an interactive session gets from the org plugin:
 * the bound `orgId`, the minting member's `role` (a ceiling — see below), and the
 * member's RLS `claims`. With these in metadata, an `x-api-key`-authenticated
 * request resolves through the SAME actor path + gate chain as the device-flow
 * bearer (`atlas login`), against exactly the owning member's reach.
 *
 * An API key is **delegated human access, never an anonymous principal.** Better
 * Auth ties each key to its owning `userId` (`referenceId`), so the audit log
 * traces a leaked key to a real person + scope. This is the deliberate opposite
 * of the legacy `ATLAS_API_KEY` god-key (`simple-key.ts`), which mints a synthetic
 * `api-key-${hash}` identity on a separate auth path and is untouched here.
 *
 * Two halves, kept in one module so the writer (the mint route) and the reader
 * (the `validateManaged` enrichment seam) share one definition and can't drift:
 *  - `buildApiKeyMetadata` — construct the canonical metadata object at mint time.
 *  - `parseApiKeyMetadata` — narrow an untrusted metadata bag back into the typed
 *    shape, fail-closed (`null`) on any malformation.
 *
 * The stored `role` is a CEILING asserted at mint time, not authority on its own:
 * the enrichment seam re-resolves the LIVE member role at use time (so a key
 * down-privileges if the member was demoted) and caps it at this stored role. The
 * `claims` are the member's RLS claim values, surfaced into the resolved user's
 * `claims` bag so `resolveRLSFilters` (rls.ts) filters rows for RLS-enabled
 * workspaces rather than fail-closed-blocking a legitimate key (ADR-0027 §3).
 *
 * Pure: no DB, no Better Auth import — trivially unit-testable.
 */

import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";

/**
 * The reserved private claim that marks a resolved user as workspace-API-key
 * derived. Read by the execute-sql route to stamp `actor_kind = "api_key"`
 * (distinct from a human `atlas login`, ADR-0027 §6).
 *
 * Deliberately SEPARATE from `claims.origin`: an API key still transits the CLI,
 * so its `origin` stays `"cli"` (a valid `ApprovalRequestOrigin`, so approval
 * rules scoped to `cli` fire and the audit origin is correct). `origin` is the
 * *transport*; this marker is the *who*. `"api_key"` is NOT a valid origin and
 * must never be written into `claims.origin`.
 */
export const API_KEY_MARKER_CLAIM = "api_key" as const;

/**
 * Resolve the audit `actor.kind` for a request from its resolved user's claims:
 * `"api_key"` when the workspace-API-key auth path stamped
 * {@link API_KEY_MARKER_CLAIM} (`managed.ts` → `claims.api_key = true`), else
 * `"human"` (a device-flow `atlas login` bearer or any interactive session).
 *
 * This is the *who*, kept distinct from the `claims.origin` *transport* (see
 * {@link API_KEY_MARKER_CLAIM}). Shared by every CLI-reachable REST route
 * (execute-sql, metrics, explore, datasources) so an unattended CI key is
 * stamped consistently across the whole surface it can reach — flattening it to
 * `"human"` on any one route would be a lie in the audit trail (ADR-0027 §6).
 */
export function resolveActorKind(
  claims: Record<string, unknown> | null | undefined,
): "human" | "api_key" {
  return claims?.[API_KEY_MARKER_CLAIM] === true ? "api_key" : "human";
}

/**
 * The canonical workspace-API-key metadata shape, as resolved back from an
 * untrusted Better Auth metadata bag. `role` is optional because a malformed /
 * absent role is tolerated (the live member role is authoritative at use time);
 * `claims` is omitted when empty.
 */
export interface ApiKeyMetadata {
  readonly orgId: string;
  readonly role?: AtlasRole;
  readonly claims?: Record<string, unknown>;
}

/** Input to {@link buildApiKeyMetadata} — the minter's resolved binding. */
export interface BuildApiKeyMetadataInput {
  readonly orgId: string;
  readonly role: AtlasRole;
  readonly claims?: Record<string, unknown>;
}

/**
 * The on-the-wire metadata object stored on the Better Auth key. Carries the
 * `atlasWorkspaceKey` marker so {@link parseApiKeyMetadata} can tell a
 * workspace-scoped key from any other key a future surface might mint with the
 * same plugin.
 */
export interface StoredApiKeyMetadata {
  readonly atlasWorkspaceKey: true;
  readonly orgId: string;
  readonly role: AtlasRole;
  readonly claims?: Record<string, unknown>;
}

/** True when `value` is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Construct the canonical metadata object to store on a freshly-minted
 * workspace key. An empty claim bag is dropped so the stored metadata stays
 * minimal (and `parseApiKeyMetadata` round-trips it to `undefined`).
 */
export function buildApiKeyMetadata(input: BuildApiKeyMetadataInput): StoredApiKeyMetadata {
  const hasClaims = input.claims !== undefined && Object.keys(input.claims).length > 0;
  return {
    atlasWorkspaceKey: true,
    orgId: input.orgId,
    role: input.role,
    ...(hasClaims ? { claims: { ...input.claims } } : {}),
  };
}

/**
 * Narrow an untrusted Better Auth metadata bag into a typed {@link ApiKeyMetadata}.
 *
 * Returns `null` (fail-closed) when the bag is not a workspace-scoped key:
 *  - not a plain object,
 *  - missing the `atlasWorkspaceKey` marker (a key minted by some other surface),
 *  - missing a usable `orgId` (workspace isolation can't derive without it).
 *
 * A malformed `role` is tolerated (dropped to `undefined`) because the live
 * member role is re-resolved at use time; a non-object `claims` is dropped.
 */
export function parseApiKeyMetadata(raw: unknown): ApiKeyMetadata | null {
  if (!isPlainObject(raw)) return null;
  if (raw.atlasWorkspaceKey !== true) return null;

  const orgId = raw.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) return null;

  const role = typeof raw.role === "string" ? parseRole(raw.role) : undefined;
  const claims = isPlainObject(raw.claims) && Object.keys(raw.claims).length > 0 ? raw.claims : undefined;

  return {
    orgId,
    ...(role !== undefined ? { role } : {}),
    ...(claims !== undefined ? { claims } : {}),
  };
}
