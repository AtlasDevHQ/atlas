/**
 * Salesforce Knowledge connector identity + stored-config contract (#4397,
 * PRD #4395).
 *
 * A leaf module: the catalog id / slug / vendor constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), and the admin-knowledge
 * surface (recognizes the catalog id) share ONE definition.
 *
 * Unlike every other knowledge vendor, this connector stores NO credential of
 * its own: it reuses the workspace's existing Salesforce OAuth install
 * (`catalog:salesforce`, ADR-0014, #3302) via the lazy plugin loader, so there
 * is no `knowledge_sync_credentials` row and no new secret path. The config
 * is pure scope: which article-version object to mirror and (optionally) which
 * channel-visibility flag gates the mirrored set.
 */

/** The built-in Salesforce Knowledge catalog slug + row id. */
export const SALESFORCE_KNOWLEDGE_SLUG = "salesforce-knowledge";
export const SALESFORCE_KNOWLEDGE_CATALOG_ID = "catalog:salesforce-knowledge";
/** Vendor slug stamped into `atlas_source` as `connector:salesforce`. */
export const SALESFORCE_KNOWLEDGE_VENDOR = "salesforce";

/** The default Lightning Knowledge article-version object. */
export const DEFAULT_ARTICLE_OBJECT = "Knowledge__kav";

/**
 * A Salesforce article-version object API name — `Knowledge__kav` (Lightning
 * Knowledge) or a Classic article type's `<Type>__kav`. The pinned `__kav`
 * suffix keeps the connector on article-version objects by construction, and
 * the identifier pattern keeps the name safe to interpolate into SOQL.
 */
export const ARTICLE_OBJECT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*__kav$/;

/**
 * Channel scopes → the article-version visibility field that gates them
 * (the AC's "channel visibility (`IsVisibleInPkb` etc.) respected per
 * config"). Absent channel = every published article regardless of channel.
 */
export const SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS = {
  app: "IsVisibleInApp",
  pkb: "IsVisibleInPkb",
  csp: "IsVisibleInCsp",
  prm: "IsVisibleInPrm",
} as const;

export type SalesforceKnowledgeChannel = keyof typeof SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS;

export function isSalesforceKnowledgeChannel(value: string): value is SalesforceKnowledgeChannel {
  return Object.hasOwn(SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS, value);
}

/** The non-secret config persisted on the collection's `workspace_plugins` row. */
export interface SalesforceKnowledgeCollectionConfig {
  /** The article-version object this collection mirrors (validated `*__kav`). */
  readonly article_object: string;
  /**
   * Optional channel scope; absent = all channels. Typed as the union so a
   * writer can't stamp an arbitrary string — the read path still re-validates
   * (a DB row can be edited out of band).
   */
  readonly channel?: SalesforceKnowledgeChannel;
  readonly description?: string;
}

export type ParsedSalesforceKnowledgeConfig =
  | {
      readonly ok: true;
      readonly articleObject: string;
      readonly channel: SalesforceKnowledgeChannel | null;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * or invalid field means someone edited the row out of band; re-installing
 * repairs it.
 */
export function parseSalesforceKnowledgeConfig(
  config: Record<string, unknown> | null,
): ParsedSalesforceKnowledgeConfig {
  const rawObject =
    typeof config?.article_object === "string" ? config.article_object.trim() : "";
  const articleObject = rawObject === "" ? DEFAULT_ARTICLE_OBJECT : rawObject;
  if (!ARTICLE_OBJECT_PATTERN.test(articleObject)) {
    return {
      ok: false,
      error: `Collection has an invalid Salesforce article object ("${rawObject}") configured — expected an article-version object like Knowledge__kav; re-install it.`,
    };
  }

  const rawChannel = typeof config?.channel === "string" ? config.channel.trim().toLowerCase() : "";
  let channel: SalesforceKnowledgeChannel | null = null;
  if (rawChannel !== "") {
    if (!isSalesforceKnowledgeChannel(rawChannel)) {
      return {
        ok: false,
        error: `Collection has an invalid Salesforce Knowledge channel ("${rawChannel}") configured — expected one of app, pkb, csp, prm (or none for all channels); re-install it.`,
      };
    }
    channel = rawChannel;
  }

  return { ok: true, articleObject, channel };
}
