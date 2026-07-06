/**
 * Confluence connector identity + stored-config contract (#4377, PRD #4375).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config), the
 * connector (reads it back in `createClient`), and the admin-knowledge surface
 * (recognizes the catalog id) share ONE definition — a field rename can't drift
 * the three apart silently. The API token is NOT part of this config; it lives
 * encrypted in `knowledge_sync_credentials` and is read via `readSyncCredential`.
 */

/** The built-in Confluence Knowledge Base catalog slug + row id. */
export const CONFLUENCE_SLUG = "confluence";
export const CONFLUENCE_CATALOG_ID = "catalog:confluence";
/** Vendor slug stamped into `atlas_source` as `connector:confluence`. */
export const CONFLUENCE_VENDOR = "confluence";

/** The non-secret config persisted on the `workspace_plugins` row. */
export interface ConfluenceCollectionConfig {
  /** Site wiki base URL, e.g. `https://acme.atlassian.net/wiki`. */
  readonly base_url: string;
  /** Atlassian account email — the Basic-auth username paired with the token. */
  readonly email: string;
  /** The Confluence space key this collection mirrors (one space per install). */
  readonly space_key: string;
  readonly description?: string;
}

export type ParsedConfluenceConfig =
  | { readonly ok: true; readonly baseUrl: string; readonly email: string; readonly spaceKey: string }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * field means someone edited the row out of band; re-installing repairs it.
 */
export function parseConfluenceConfig(
  config: Record<string, unknown> | null,
): ParsedConfluenceConfig {
  const baseUrl = typeof config?.base_url === "string" ? config.base_url.trim() : "";
  const email = typeof config?.email === "string" ? config.email.trim() : "";
  const spaceKey = typeof config?.space_key === "string" ? config.space_key.trim() : "";
  if (baseUrl === "") {
    return { ok: false, error: "Collection has no Confluence site URL configured — re-install it." };
  }
  if (email === "") {
    return { ok: false, error: "Collection has no Atlassian email configured — re-install it." };
  }
  if (spaceKey === "") {
    return { ok: false, error: "Collection has no Confluence space key configured — re-install it." };
  }
  return { ok: true, baseUrl, email, spaceKey };
}
