/**
 * GitBook connector identity + stored-config contract (#4393, ADR-0030).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config), the
 * connector (reads it back in `createClient`), and the admin-knowledge surface
 * (recognizes the catalog id) share ONE definition — a field rename can't drift
 * the three apart silently. The API token is NOT part of this config; it lives
 * encrypted in `knowledge_sync_credentials` and is read via `readSyncCredential`.
 *
 * GitBook Cloud's API is a fixed vendor host (`api.gitbook.com`), so — unlike
 * Confluence — there is no customer-supplied base URL to persist; the collection
 * is pinned to ONE space by its id. Every request still goes through the SSRF
 * egress guard at fetch time (defence in depth; the AC's "API host through the
 * egress guard").
 */

/** The built-in GitBook Knowledge Base catalog slug + row id. */
export const GITBOOK_SLUG = "gitbook";
export const GITBOOK_CATALOG_ID = "catalog:gitbook";
/** Vendor slug stamped into `atlas_source` as `connector:gitbook`. */
export const GITBOOK_VENDOR = "gitbook";

/** The GitBook Cloud REST base — a fixed vendor host, never customer-supplied. */
export const GITBOOK_API_BASE = "https://api.gitbook.com";

/** The non-secret config persisted on the `workspace_plugins` row. */
export interface GitbookCollectionConfig {
  /** The GitBook space id this collection mirrors (one space per install). */
  readonly space_id: string;
  readonly description?: string;
}

export type ParsedGitbookConfig =
  | { readonly ok: true; readonly spaceId: string }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * field means someone edited the row out of band; re-installing repairs it.
 */
export function parseGitbookConfig(
  config: Record<string, unknown> | null,
): ParsedGitbookConfig {
  const spaceId = typeof config?.space_id === "string" ? config.space_id.trim() : "";
  if (spaceId === "") {
    return { ok: false, error: "Collection has no GitBook space id configured — re-install it." };
  }
  return { ok: true, spaceId };
}
