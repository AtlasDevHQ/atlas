/**
 * Tests for the Salesforce Knowledge KnowledgeSyncConnector (#4397) — the
 * createClient factory contract: parse the stored scope config, resolve the
 * workspace's EXISTING Salesforce OAuth install through the (injected) lazy
 * loader with POSITIVE error classification, and bind it into a vendor
 * client. No credential store is involved — that is the point of the vendor.
 */

import { describe, expect, it } from "bun:test";
import {
  createSalesforceKnowledgeConnector,
  instanceUrlOf,
  type SalesforceInstanceLoader,
} from "@atlas/api/lib/knowledge/salesforce/connector";
import {
  SALESFORCE_KNOWLEDGE_CATALOG_ID,
  SALESFORCE_KNOWLEDGE_VENDOR,
} from "@atlas/api/lib/knowledge/salesforce/config";
import {
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
} from "@atlas/api/lib/plugins/lazy-loader";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import type { SalesforcePluginInstance } from "@atlas/api/lib/integrations/salesforce/lazy-builder";

const WSID = "org-1";

function fakeInstance(overrides: Partial<SalesforcePluginInstance> = {}): SalesforcePluginInstance {
  return {
    id: `salesforce:${WSID}`,
    types: ["datasource"] as const,
    version: "0.1.0",
    name: "Salesforce",
    config: { instanceUrl: "https://acme.my.salesforce.com", scope: "api" },
    query: async () => ({ columns: [], rows: [] }),
    queryPage: async () => ({ records: [], done: true, nextRecordsUrl: null }),
    queryMorePage: async () => ({ records: [], done: true, nextRecordsUrl: null }),
    describeObject: async () => ({ fields: [] }),
    listObjects: async () => [],
    profile: async () => ({ profiles: [], errors: [] }),
    ...overrides,
  };
}

function loaderReturning(result: SalesforcePluginInstance | (() => never)): SalesforceInstanceLoader {
  return {
    async getOrInstantiate(_workspaceId: string, _catalogId: string) {
      if (typeof result === "function") return result();
      return result;
    },
  };
}

function ctx(config: Record<string, unknown> | null) {
  return { workspaceId: WSID, collectionSlug: "sf-kb", config, maxDocs: 1000 };
}

describe("createSalesforceKnowledgeConnector", () => {
  it("advertises the salesforce-knowledge catalog id and the salesforce vendor slug", () => {
    const connector = createSalesforceKnowledgeConnector();
    expect(connector.catalogId).toBe(SALESFORCE_KNOWLEDGE_CATALOG_ID);
    expect(connector.vendor).toBe(SALESFORCE_KNOWLEDGE_VENDOR);
  });

  it("builds a vendor client from a valid config + the reused OAuth instance", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(fakeInstance()),
    });
    const client = await connector.createClient(ctx({ article_object: "Knowledge__kav" }));
    expect(typeof client.fetchChanges).toBe("function");
    expect(typeof client.fetchAll).toBe("function");
  });

  it("defaults an absent article_object to Knowledge__kav and accepts an absent channel", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(fakeInstance()),
    });
    const client = await connector.createClient(ctx({}));
    expect(typeof client.fetchAll).toBe("function");
  });

  it("builds the default scope from a null config (out-of-band-edited row)", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(fakeInstance()),
    });
    const client = await connector.createClient(ctx(null));
    expect(typeof client.fetchAll).toBe("function");
  });

  it("throws an actionable error for a non-__kav article object", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(fakeInstance()),
    });
    await expect(
      connector.createClient(ctx({ article_object: "Account" })),
    ).rejects.toThrow(/invalid Salesforce article object/i);
  });

  it("throws an actionable error for an unknown channel", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(fakeInstance()),
    });
    await expect(connector.createClient(ctx({ channel: "twitter" }))).rejects.toThrow(
      /invalid Salesforce Knowledge channel/i,
    );
  });

  it("maps a missing Salesforce install to a connect-first message", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(() => {
        throw new LazyPluginInstallNotFoundError(WSID, "catalog:salesforce");
      }),
    });
    await expect(connector.createClient(ctx({}))).rejects.toThrow(
      /Salesforce is not connected — connect it under Admin → Integrations/i,
    );
  });

  it("maps a reconnect-required install to a Reconnect message", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(() => {
        throw new IntegrationReconnectRequiredError({
          message: "refresh failed permanently",
          workspaceId: WSID,
          platform: "salesforce",
          upstreamError: "invalid_grant",
        });
      }),
    });
    await expect(connector.createClient(ctx({}))).rejects.toThrow(/click Reconnect/i);
  });

  it("maps a missing builder to the operator-facing env message", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(() => {
        throw new LazyPluginBuilderMissingError("catalog:salesforce");
      }),
    });
    await expect(connector.createClient(ctx({}))).rejects.toThrow(/SALESFORCE_CLIENT_ID/);
  });

  it("propagates an unknown instantiation failure loudly (decrypt errors stay actionable)", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(() => {
        throw new Error("failed to decrypt integration_credentials — key rotated");
      }),
    });
    await expect(connector.createClient(ctx({}))).rejects.toThrow(/failed to decrypt/i);
  });

  it("rejects an instance that lacks the paged query/describe surface", async () => {
    const partial = fakeInstance();
    // Simulate a custom builder registered for catalog:salesforce without the
    // #4397 surface.
    delete (partial as Record<string, unknown>).queryPage;
    const connector = createSalesforceKnowledgeConnector({ loader: loaderReturning(partial) });
    await expect(connector.createClient(ctx({}))).rejects.toThrow(
      /does not expose the paged query\/describe surface/i,
    );
  });

  it("rejects an instance that carries no instance URL", async () => {
    const connector = createSalesforceKnowledgeConnector({
      loader: loaderReturning(fakeInstance({ config: { scope: "api" } })),
    });
    await expect(connector.createClient(ctx({}))).rejects.toThrow(/no instance URL/i);
  });
});

describe("instanceUrlOf", () => {
  it("reads the instance URL from the plugin instance config", () => {
    expect(instanceUrlOf(fakeInstance())).toBe("https://acme.my.salesforce.com");
  });
  it("throws actionably when the config is not an object", () => {
    expect(() => instanceUrlOf(fakeInstance({ config: undefined }))).toThrow(/no instance URL/i);
  });
});
