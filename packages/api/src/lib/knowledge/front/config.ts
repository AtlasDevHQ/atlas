/**
 * Front Knowledge Base connector identity + stored-config contract (#4400,
 * PRD #4395).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), and the admin-knowledge
 * surface (recognizes the catalog id) share ONE definition — a field rename
 * can't drift the three apart silently. The Bearer token is NOT part of this
 * config; it lives encrypted in `knowledge_sync_credentials` and is read via
 * `readSyncCredential`.
 *
 * Front is a MULTI-KB vendor: one install enumerates the company's knowledge
 * bases (`GET /knowledge_bases`) and creates one collection per KB (the PRD's
 * "each KB maps to a collection"). Each collection's config is therefore
 * KB-scoped: it pins the knowledge-base id its client crawls. Front's API is a
 * fixed vendor host (`api2.frontapp.com`), so — unlike Confluence — there is no
 * customer-supplied base URL to persist; every request still goes through the
 * SSRF egress guard at fetch time (defence in depth; the AC's "host through the
 * egress guard").
 */

/** The built-in Front Knowledge Base catalog slug + row id. */
export const FRONT_SLUG = "front";
export const FRONT_CATALOG_ID = "catalog:front";
/** Vendor slug stamped into `atlas_source` as `connector:front`. */
export const FRONT_VENDOR = "front";

/** The Front Core API base — a fixed vendor host, never customer-supplied. */
export const FRONT_API_BASE = "https://api2.frontapp.com";

/** The non-secret config persisted on each per-KB `workspace_plugins` row. */
export interface FrontCollectionConfig {
  /** The Front knowledge base this collection mirrors (one KB per collection). */
  readonly knowledge_base_id: string;
  /** Human KB name, for the admin surface. */
  readonly knowledge_base_name: string;
  readonly description?: string;
}

export type ParsedFrontConfig =
  | { readonly ok: true; readonly knowledgeBaseId: string }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * field means someone edited the row out of band; re-installing repairs it.
 */
export function parseFrontConfig(
  config: Record<string, unknown> | null,
): ParsedFrontConfig {
  const knowledgeBaseId =
    typeof config?.knowledge_base_id === "string" ? config.knowledge_base_id.trim() : "";
  if (knowledgeBaseId === "") {
    return {
      ok: false,
      error: "Collection has no Front knowledge base configured — re-install it.",
    };
  }
  return { ok: true, knowledgeBaseId };
}
