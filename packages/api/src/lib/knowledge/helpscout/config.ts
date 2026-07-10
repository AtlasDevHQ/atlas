/**
 * Help Scout Docs connector identity + stored-config contract (#4398, PRD
 * #4395). The simplest install in the support tier: a single Docs API key over
 * HTTP Basic auth, no OAuth, no customer-supplied host.
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), and the admin-knowledge
 * surface (recognizes the catalog id) share ONE definition — a field rename
 * can't drift the three apart silently. The Docs API key is NOT part of this
 * config; it lives encrypted in `knowledge_sync_credentials` and is read via
 * `readSyncCredential`.
 *
 * Help Scout is a MULTI-SITE vendor: one install enumerates the account's Docs
 * Sites (Help Scout's multi-brand unit) and creates one collection per Site
 * (the PRD's "one collection per Site"). Each collection's config is therefore
 * SITE-scoped: it pins the numeric/opaque `site_id` the client filters
 * enumeration by. Unlike Zendesk, the Docs API host is a FIXED vendor constant
 * (`docsapi.helpscout.net`) — the Site is a query-param filter, never a host —
 * so there is no customer-supplied URL to validate; every request still routes
 * through the SSRF egress guard at fetch time (the AC's "host through the
 * egress guard").
 */

/** The built-in Help Scout Docs Knowledge Base catalog slug + row id. */
export const HELPSCOUT_SLUG = "helpscout";
export const HELPSCOUT_CATALOG_ID = "catalog:helpscout";
/** Vendor slug stamped into `atlas_source` as `connector:helpscout`. */
export const HELPSCOUT_VENDOR = "helpscout";

/**
 * The Help Scout Docs REST base — a fixed vendor host, never customer-supplied
 * (distinct from the Mailbox API's `api.helpscout.net`). The Site is a
 * query-param filter on top of this host, not a per-site subdomain.
 */
export const HELPSCOUT_DOCS_API_BASE = "https://docsapi.helpscout.net";

/**
 * The non-secret config persisted on each per-site `workspace_plugins` row.
 * The Docs API key is NOT here — it lands encrypted in
 * `knowledge_sync_credentials`, one row per site collection.
 */
export interface HelpScoutCollectionConfig {
  /** The Docs Site id this collection mirrors (the enumeration filter). */
  readonly site_id: string;
  /** Human site title, for the admin surface + provenance. */
  readonly site_name: string;
  /** The site's `*.helpscoutdocs.com` subdomain, when it has one (admin/provenance). */
  readonly subdomain?: string;
  readonly description?: string;
}

export type ParsedHelpScoutConfig =
  | { readonly ok: true; readonly siteId: string; readonly siteName: string; readonly subdomain: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * `site_id` means someone edited the row out of band; re-installing repairs it.
 */
export function parseHelpScoutConfig(
  config: Record<string, unknown> | null,
): ParsedHelpScoutConfig {
  const siteId = typeof config?.site_id === "string" ? config.site_id.trim() : "";
  if (siteId === "") {
    return { ok: false, error: "Collection has no Help Scout site configured — re-install it." };
  }
  const siteName = typeof config?.site_name === "string" ? config.site_name.trim() : "";
  const subdomain = typeof config?.subdomain === "string" && config.subdomain.trim() !== ""
    ? config.subdomain.trim()
    : null;
  return { ok: true, siteId, siteName, subdomain };
}
