/**
 * Confluence Data Center / Server connector identity + stored-config contract
 * (#4394, PRD #4375). The self-managed sibling of the Cloud connector
 * (`config.ts`): same collection model (one per space), same shared
 * storage-XHTML→markdown converter, but a different client layer — Confluence
 * Server/DC REST **v1** with a Personal Access Token (Bearer auth) instead of
 * Cloud REST v2 with Basic auth.
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config), the
 * connector (reads it back in `createClient`), and the admin-knowledge surface
 * (recognizes the catalog id) share ONE definition — a field rename can't drift
 * the three apart silently. The PAT is NOT part of this config; it lives
 * encrypted in `knowledge_sync_credentials` and is read via `readSyncCredential`.
 *
 * Deliberately a SEPARATE catalog row from Cloud (`confluence`), not a
 * `deployment: cloud | datacenter` discriminator threaded through the shared
 * config: the two clients speak different REST versions + auth schemes, so a
 * distinct row keeps the pairing test clean, the provenance vendor slug
 * unambiguous (`connector:confluence-datacenter`), and the install form free of
 * a Cloud-only email field.
 */

/** The built-in Confluence Data Center Knowledge Base catalog slug + row id. */
export const CONFLUENCE_DC_SLUG = "confluence-datacenter";
export const CONFLUENCE_DC_CATALOG_ID = "catalog:confluence-datacenter";
/** Vendor slug stamped into `atlas_source` as `connector:confluence-datacenter`. */
export const CONFLUENCE_DC_VENDOR = "confluence-datacenter";

/** The non-secret config persisted on the `workspace_plugins` row. */
export interface ConfluenceDcCollectionConfig {
  /** Server/DC base URL, e.g. `https://confluence.acme.com` (context path incl.). */
  readonly base_url: string;
  /** The Confluence space key this collection mirrors (one space per install). */
  readonly space_key: string;
  readonly description?: string;
}

export type ParsedConfluenceDcConfig =
  | { readonly ok: true; readonly baseUrl: string; readonly spaceKey: string }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * field means someone edited the row out of band; re-installing repairs it.
 */
export function parseConfluenceDcConfig(
  config: Record<string, unknown> | null,
): ParsedConfluenceDcConfig {
  const baseUrl = typeof config?.base_url === "string" ? config.base_url.trim() : "";
  const spaceKey = typeof config?.space_key === "string" ? config.space_key.trim() : "";
  if (baseUrl === "") {
    return { ok: false, error: "Collection has no Confluence base URL configured — re-install it." };
  }
  if (spaceKey === "") {
    return { ok: false, error: "Collection has no Confluence space key configured — re-install it." };
  }
  return { ok: true, baseUrl, spaceKey };
}
