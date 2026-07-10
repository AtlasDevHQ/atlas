/**
 * Intercom connector identity + stored-config contract (#4399, PRD #4395).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config), the
 * connector (reads it back in `createClient`), and the admin-knowledge surface
 * (recognizes the catalog id) share ONE definition — a field rename can't drift
 * the three apart silently. The access token is NOT part of this config; it
 * lives encrypted in `knowledge_sync_credentials` and is read via
 * `readSyncCredential`.
 *
 * Intercom's REST API is a fixed vendor host (`api.intercom.io`) and has no
 * multi-brand concept — ONE workspace maps to ONE collection — so, unlike
 * Zendesk (per-brand host) or Confluence (customer base URL), there is no scope
 * field to persist: the only config is an optional human description. Every
 * request still goes through the SSRF egress guard at fetch time (defence in
 * depth; the AC's "host through the egress guard").
 */

/** The built-in Intercom Knowledge Base catalog slug + row id. */
export const INTERCOM_SLUG = "intercom";
export const INTERCOM_CATALOG_ID = "catalog:intercom";
/** Vendor slug stamped into `atlas_source` as `connector:intercom`. */
export const INTERCOM_VENDOR = "intercom";

/**
 * The Intercom REST base — a fixed vendor host, never customer-supplied.
 *
 * NOTE: Intercom serves EU/AU data-residency workspaces from regional hosts
 * (`api.eu.intercom.io`, `api.au.intercom.io`). This slice targets the default
 * US host only; a token for an EU/AU workspace will 401/403 against it. Regional
 * host selection is deliberately out of scope here (a future config field), not
 * an oversight.
 */
export const INTERCOM_API_BASE = "https://api.intercom.io";

/**
 * The non-secret config persisted on the `workspace_plugins` row. Intercom has
 * no per-collection scope (one workspace = one collection), so the only field
 * is the optional description.
 */
export interface IntercomCollectionConfig {
  readonly description?: string;
}
