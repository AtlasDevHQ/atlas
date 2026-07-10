/**
 * Freshdesk Solutions connector identity + stored-config contract (#4401,
 * PRD #4395).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), and the admin-knowledge
 * surface (recognizes the catalog id) share ONE definition — a field rename
 * can't drift the three apart silently. The API key is NOT part of this config;
 * it lives encrypted in `knowledge_sync_credentials` and is read via
 * `readSyncCredential`.
 *
 * Freshdesk is a MULTI-CATEGORY vendor: one install enumerates the account's
 * Solutions categories (`GET /api/v2/solutions/categories`) and creates one
 * collection per category (the PRD's "each product/portal maps to a
 * collection" — a Freshdesk category is the top-level Solutions grouping;
 * Freshdesk itself may portal-scope a category via `visible_in_portals`, but the
 * connector mirrors every enumerated category regardless of portal visibility).
 * Each collection's config is therefore CATEGORY-scoped: it pins the category
 * id whose folder→subfolder→article tree its client walks, alongside the
 * account subdomain the install enumerated from. Hosts are always composed from
 * a validated subdomain label — never a customer-supplied URL — so the egress
 * surface stays `*.freshdesk.com` by construction, and every fetch still goes
 * through the SSRF egress guard.
 */

/** The built-in Freshdesk Solutions Knowledge Base catalog slug + row id. */
export const FRESHDESK_SLUG = "freshdesk";
export const FRESHDESK_CATALOG_ID = "catalog:freshdesk";
/** Vendor slug stamped into `atlas_source` as `connector:freshdesk`. */
export const FRESHDESK_VENDOR = "freshdesk";

/**
 * A Freshdesk subdomain label (`acme` in `acme.freshdesk.com`). Composing
 * hosts from this validated label (rather than accepting a URL) keeps the
 * egress surface to `*.freshdesk.com` by construction.
 */
export const FRESHDESK_SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The API base for a Freshdesk subdomain. `subdomain` MUST be pre-validated. */
export function freshdeskHostFor(subdomain: string): string {
  return `https://${subdomain}.freshdesk.com`;
}

/** The non-secret config persisted on each per-category `workspace_plugins` row. */
export interface FreshdeskCollectionConfig {
  /** The account subdomain the install enumerated categories from. */
  readonly subdomain: string;
  /** The Solutions category this collection mirrors (stringified numeric id). */
  readonly category_id: string;
  /** Human category name, for the admin surface + provenance `product`. */
  readonly category_name: string;
  readonly description?: string;
}

export type ParsedFreshdeskConfig =
  | {
      readonly ok: true;
      readonly subdomain: string;
      readonly categoryId: string;
      readonly categoryName: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * field means someone edited the row out of band; re-installing repairs it.
 */
export function parseFreshdeskConfig(
  config: Record<string, unknown> | null,
): ParsedFreshdeskConfig {
  const subdomain =
    typeof config?.subdomain === "string" ? config.subdomain.trim().toLowerCase() : "";
  const categoryId = typeof config?.category_id === "string" ? config.category_id.trim() : "";
  const categoryName =
    typeof config?.category_name === "string" ? config.category_name.trim() : "";
  if (subdomain === "" || !FRESHDESK_SUBDOMAIN_PATTERN.test(subdomain)) {
    return {
      ok: false,
      error: "Collection has no valid Freshdesk subdomain configured — re-install it.",
    };
  }
  if (categoryId === "") {
    return {
      ok: false,
      error: "Collection has no Freshdesk Solutions category configured — re-install it.",
    };
  }
  return { ok: true, subdomain, categoryId, categoryName };
}
