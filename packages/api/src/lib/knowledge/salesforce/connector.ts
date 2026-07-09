/**
 * The Salesforce Knowledge {@link KnowledgeSyncConnector} (#4397, PRD #4395) —
 * the catalog-id-keyed adapter the sync cycle dispatches on. It owns only the
 * factory contract from ADR-0030: bind the stored per-collection scope config
 * + the workspace's EXISTING Salesforce OAuth connection into a vendor client.
 * Scheduling, backoff, reconciliation, caps, and ingest are the shared
 * engine's.
 *
 * Credential sourcing is this connector's one departure from the tier: there
 * is NO `knowledge_sync_credentials` row. `createClient` resolves the lazy
 * Salesforce plugin instance (`catalog:salesforce` — the same per-workspace
 * OAuth install, refresh flow, and encrypted `integration_credentials` bundle
 * the `querySalesforce` agent tool uses; ADR-0014, #3302), so installing this
 * connector registers no new connected app and opens no new secret path.
 *
 * `createClient` is where a missing/broken Salesforce install becomes an
 * actionable error surfaced on `/admin/knowledge`: the lazy-loader failure is
 * classified positively (`classifyLazyInstantiateError`) and each kind maps to
 * a message that says exactly what to fix — never a silent no-op sync.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { lazyPluginLoader, type LazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import { SALESFORCE_CATALOG_ID } from "@atlas/api/lib/integrations/install/salesforce-oauth-handler";
import { classifyLazyInstantiateError } from "@atlas/api/lib/integrations/_shared/lazy-plugin-tool";
import type { SalesforcePluginInstance } from "@atlas/api/lib/integrations/salesforce/lazy-builder";
import {
  getKnowledgeSyncConnector,
  registerKnowledgeSyncConnector,
  type ConnectorInstallContext,
  type ConnectorVendorClient,
  type KnowledgeSyncConnector,
} from "../connectors";
import {
  createSalesforceKnowledgeVendorClient,
  type SalesforceKnowledgeApi,
} from "./client";
import {
  SALESFORCE_KNOWLEDGE_CATALOG_ID,
  SALESFORCE_KNOWLEDGE_VENDOR,
  parseSalesforceKnowledgeConfig,
} from "./config";

const log = createLogger("knowledge.salesforce.connector");

/** The loader slice the connector needs — injectable for tests. */
export type SalesforceInstanceLoader = Pick<LazyPluginLoader, "getOrInstantiate">;

export interface SalesforceKnowledgeConnectorDeps {
  /** Injected loader for tests; defaults to the process-wide lazy loader. */
  readonly loader?: SalesforceInstanceLoader;
}

/**
 * Resolve the workspace's lazy Salesforce plugin instance, mapping every
 * failure kind to an actionable, admin-facing error (they land in
 * `knowledge_sync_state.error` — and, at install time, in the form's 400).
 * Exported for the install handler, which runs the same resolution as its
 * loud pre-write verification.
 */
export async function resolveSalesforceKnowledgeInstance(
  loader: SalesforceInstanceLoader,
  workspaceId: string,
): Promise<SalesforcePluginInstance> {
  let raw: unknown;
  try {
    raw = await loader.getOrInstantiate(workspaceId, SALESFORCE_CATALOG_ID);
  } catch (err) {
    // The original failure rides along as `cause` so the forensic detail
    // (invalid_grant, the builder's own message) survives the remap.
    switch (classifyLazyInstantiateError(err)) {
      case "install_not_found":
        throw new Error(
          "This collection reuses the workspace's Salesforce integration, but Salesforce is not connected — connect it under Admin → Integrations, then sync again.",
          { cause: err },
        );
      case "reconnect_required":
        throw new Error(
          "The workspace's Salesforce integration needs to be reconnected — open Admin → Integrations and click Reconnect on the Salesforce card, then sync again.",
          { cause: err },
        );
      case "builder_missing":
        throw new Error(
          "Salesforce integration is not configured on this deploy (SALESFORCE_CLIENT_ID/SALESFORCE_CLIENT_SECRET or ATLAS_PUBLIC_API_URL unset) — contact your operator.",
          { cause: err },
        );
      case "unknown":
        // Credential decrypt failure, missing bundle/instance_url, or
        // construction error — already loud + actionable, never swallowed.
        throw err;
    }
  }
  if (!hasKnowledgeSurface(raw)) {
    // A custom/BYOC builder registered for catalog:salesforce that lacks the
    // paged-query surface — fail loud rather than truncate a crawl.
    throw new Error(
      "The workspace's Salesforce integration instance does not expose the paged query/describe surface the Knowledge connector requires.",
    );
  }
  return raw;
}

/**
 * Structural check for the #4397 surface, run BEFORE the instance is trusted
 * as a {@link SalesforcePluginInstance} — the loader's return type is only
 * `PluginLike`, and a plugin/BYOC builder may have registered something else.
 */
function hasKnowledgeSurface(raw: unknown): raw is SalesforcePluginInstance {
  if (raw === null || typeof raw !== "object") return false;
  const candidate = raw as Record<string, unknown>;
  return (
    typeof candidate.queryPage === "function" &&
    typeof candidate.queryMorePage === "function" &&
    typeof candidate.describeObject === "function"
  );
}

/** Read the instance's org URL — required for article links + provenance. */
export function instanceUrlOf(instance: SalesforcePluginInstance): string {
  const config = instance.config;
  const url =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).instanceUrl
      : undefined;
  if (typeof url !== "string" || url === "") {
    throw new Error(
      "The workspace's Salesforce integration instance carries no instance URL — disconnect and reconnect Salesforce under Admin → Integrations.",
    );
  }
  return url;
}

/** Build the Salesforce Knowledge connector. `deps` is test-only injection. */
export function createSalesforceKnowledgeConnector(
  deps: SalesforceKnowledgeConnectorDeps = {},
): KnowledgeSyncConnector {
  const loader = deps.loader ?? lazyPluginLoader;
  return {
    catalogId: SALESFORCE_KNOWLEDGE_CATALOG_ID,
    vendor: SALESFORCE_KNOWLEDGE_VENDOR,
    async createClient(ctx: ConnectorInstallContext): Promise<ConnectorVendorClient> {
      const parsed = parseSalesforceKnowledgeConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);

      const instance = await resolveSalesforceKnowledgeInstance(loader, ctx.workspaceId);
      const api: SalesforceKnowledgeApi = {
        describeObject: (objectName) => instance.describeObject(objectName),
        queryPage: (soql) => instance.queryPage(soql),
        queryMorePage: (nextRecordsUrl) => instance.queryMorePage(nextRecordsUrl),
      };
      return createSalesforceKnowledgeVendorClient(api, {
        collectionSlug: ctx.collectionSlug,
        articleObject: parsed.articleObject,
        channel: parsed.channel,
        instanceUrl: instanceUrlOf(instance),
      });
    },
  };
}

/**
 * Register the Salesforce Knowledge connector idempotently — called from the
 * boot seam that also registers install handlers
 * (`registerBuiltinInstallHandlers`), and from tests.
 * `registerKnowledgeSyncConnector` throws on a duplicate catalog id, so gate
 * on the registry first.
 */
export function registerSalesforceKnowledgeConnector(): void {
  if (getKnowledgeSyncConnector(SALESFORCE_KNOWLEDGE_CATALOG_ID) !== undefined) return;
  registerKnowledgeSyncConnector(createSalesforceKnowledgeConnector());
  log.info(
    { catalogId: SALESFORCE_KNOWLEDGE_CATALOG_ID },
    "Registered Salesforce Knowledge sync connector",
  );
}
