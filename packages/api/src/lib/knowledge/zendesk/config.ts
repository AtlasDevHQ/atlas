/**
 * Zendesk Guide connector identity + stored-config contract (#4396, PRD #4395).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), and the admin-knowledge
 * surface (recognizes the catalog id) share ONE definition — a field rename
 * can't drift the three apart silently. The API token is NOT part of this
 * config; it lives encrypted in `knowledge_sync_credentials` and is read via
 * `readSyncCredential`.
 *
 * Zendesk is the tier's first MULTI-BRAND vendor: one install enumerates the
 * account's help-center-enabled brands and creates one collection per brand
 * (the PRD's "each brand maps to a collection"). Each collection's config is
 * therefore BRAND-scoped: it pins the brand's own `*.zendesk.com` subdomain
 * (the article host its client fetches) alongside the account subdomain the
 * install enumerated from. Hosts are always composed from a validated
 * subdomain label — never a customer-supplied URL — and every fetch still
 * goes through the SSRF egress guard.
 */

/** The built-in Zendesk Guide Knowledge Base catalog slug + row id. */
export const ZENDESK_SLUG = "zendesk";
export const ZENDESK_CATALOG_ID = "catalog:zendesk";
/** Vendor slug stamped into `atlas_source` as `connector:zendesk`. */
export const ZENDESK_VENDOR = "zendesk";

/**
 * A Zendesk subdomain label (`acme` in `acme.zendesk.com`). Composing hosts
 * from this validated label (rather than accepting a URL) keeps the egress
 * surface to `*.zendesk.com` by construction.
 */
export const ZENDESK_SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The API base for a Zendesk subdomain. `subdomain` MUST be pre-validated. */
export function zendeskHostFor(subdomain: string): string {
  return `https://${subdomain}.zendesk.com`;
}

/** The non-secret config persisted on each per-brand `workspace_plugins` row. */
export interface ZendeskCollectionConfig {
  /** The ACCOUNT subdomain the install enumerated brands from. */
  readonly subdomain: string;
  /** Zendesk account email — the Basic-auth username (`{email}/token`). */
  readonly email: string;
  /** The brand this collection mirrors (stringified numeric brand id). */
  readonly brand_id: string;
  /** The BRAND's subdomain — the help-center host this collection fetches. */
  readonly brand_subdomain: string;
  /** Human brand name, for the admin surface. */
  readonly brand_name: string;
  readonly description?: string;
}

export type ParsedZendeskConfig =
  | {
      readonly ok: true;
      readonly email: string;
      readonly brandId: string;
      readonly brandSubdomain: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * field means someone edited the row out of band; re-installing repairs it.
 */
export function parseZendeskConfig(
  config: Record<string, unknown> | null,
): ParsedZendeskConfig {
  const email = typeof config?.email === "string" ? config.email.trim() : "";
  const brandId = typeof config?.brand_id === "string" ? config.brand_id.trim() : "";
  const brandSubdomain =
    typeof config?.brand_subdomain === "string" ? config.brand_subdomain.trim().toLowerCase() : "";
  if (email === "") {
    return { ok: false, error: "Collection has no Zendesk account email configured — re-install it." };
  }
  if (brandId === "") {
    return { ok: false, error: "Collection has no Zendesk brand configured — re-install it." };
  }
  if (brandSubdomain === "" || !ZENDESK_SUBDOMAIN_PATTERN.test(brandSubdomain)) {
    return {
      ok: false,
      error: "Collection has no valid Zendesk brand subdomain configured — re-install it.",
    };
  }
  return { ok: true, email, brandId, brandSubdomain };
}
