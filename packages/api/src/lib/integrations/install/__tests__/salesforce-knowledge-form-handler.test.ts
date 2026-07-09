/**
 * Unit tests for `SalesforceKnowledgeFormInstallHandler` (#4397) — the
 * Salesforce Knowledge connector install. Focus: field validation (channel
 * enum, `*__kav` article-object pattern), the loud pre-write verification
 * against the REUSED Salesforce OAuth install (loader failures → actionable
 * form-level 400s; describe failures → field-level 400s), and the
 * credential-less persistence contract: NO `knowledge_sync_credentials`
 * write, `credentialWritten: false`, config carries scope only. Verification
 * uses an injected fixture loader; no test touches Salesforce.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:salesforce-knowledge" }];
let INSERT_RETURNS_ID = true;
let CROSS_CATALOG_ROWS: { catalog_id: string }[] = [];
const insertCalls: { sql: string; params: unknown[] }[] = [];

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("FROM plugin_catalog")) return CATALOG_ROWS;
  if (sql.includes("catalog_id <> $3")) return CROSS_CATALOG_ROWS;
  if (sql.includes("INSERT INTO workspace_plugins")) {
    insertCalls.push({ sql, params });
    return INSERT_RETURNS_ID ? [{ id: params[0] }] : [];
  }
  throw new Error(`unexpected SQL: ${sql.slice(0, 50)}`);
});

void mock.module("@atlas/api/lib/db/internal", () => buildInternalDbMockDefaults({ internalQuery }));
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const { SalesforceKnowledgeFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/salesforce-knowledge-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);
const { LazyPluginInstallNotFoundError, LazyPluginBuilderMissingError } = await import(
  "@atlas/api/lib/plugins/lazy-loader"
);
const { IntegrationReconnectRequiredError } = await import("@atlas/api/lib/effect/errors");
type SalesforcePluginInstance =
  import("@atlas/api/lib/integrations/salesforce/lazy-builder").SalesforcePluginInstance;
type SalesforceInstanceLoader =
  import("@atlas/api/lib/knowledge/salesforce/connector").SalesforceInstanceLoader;

const WORKSPACE = "org-1" as WorkspaceId;

function kavField(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: "string", custom: false, ...overrides };
}
const KAV_FIELDS: Record<string, unknown>[] = [
  kavField("Id"),
  kavField("KnowledgeArticleId"),
  kavField("ArticleNumber"),
  kavField("Title"),
  kavField("Language"),
  kavField("PublishStatus"),
  kavField("SystemModstamp"),
  kavField("IsVisibleInPkb", { type: "boolean" }),
  kavField("Body__c", { type: "textarea", custom: true, extraTypeInfo: "richtextarea" }),
];

function fakeInstance(overrides: Partial<SalesforcePluginInstance> = {}): SalesforcePluginInstance {
  return {
    id: `salesforce:${WORKSPACE}`,
    types: ["datasource"] as const,
    version: "0.1.0",
    config: { instanceUrl: "https://acme.my.salesforce.com" },
    query: async () => ({ columns: [], rows: [] }),
    queryPage: async () => ({ records: [], done: true, nextRecordsUrl: null }),
    queryMorePage: async () => ({ records: [], done: true, nextRecordsUrl: null }),
    describeObject: async () => ({ fields: KAV_FIELDS }),
    listObjects: async () => [],
    profile: async () => ({ profiles: [] }) as never,
    ...overrides,
  };
}

function loaderOf(result: SalesforcePluginInstance | (() => never)): SalesforceInstanceLoader {
  return {
    async getOrInstantiate() {
      if (typeof result === "function") return result();
      return result;
    },
  };
}

function handler(loader: SalesforceInstanceLoader = loaderOf(fakeInstance())) {
  let n = 0;
  return new SalesforceKnowledgeFormInstallHandler({
    idGenerator: () => `fixed-id-${++n}`,
    loader,
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:salesforce-knowledge" }];
  INSERT_RETURNS_ID = true;
  CROSS_CATALOG_ROWS = [];
  insertCalls.length = 0;
  internalQuery.mockClear();
});

async function fieldErrorOf(promise: Promise<unknown>, field: string): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.fieldErrors[field]?.[0];
    throw err;
  }
  return undefined;
}

async function formErrorOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.formErrors[0];
    throw err;
  }
  return undefined;
}

describe("field validation", () => {
  it("rejects an article object that is not a *__kav name", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { article_object: "Account" }),
      "article_object",
    );
    expect(msg).toMatch(/__kav/);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects an unknown channel", async () => {
    const msg = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, { channel: "twitter" }),
      "channel",
    );
    expect(msg).toMatch(/"app", "pkb", "csp"/);
  });
});

describe("reused-install verification (loud, pre-write)", () => {
  it("surfaces a missing Salesforce install as an actionable form-level 400", async () => {
    const msg = await formErrorOf(
      handler(
        loaderOf(() => {
          throw new LazyPluginInstallNotFoundError(WORKSPACE, "catalog:salesforce");
        }),
      ).validateConfig(WORKSPACE, {}),
    );
    expect(msg).toMatch(/Salesforce is not connected/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("surfaces a reconnect-required install as an actionable form-level 400", async () => {
    const msg = await formErrorOf(
      handler(
        loaderOf(() => {
          throw new IntegrationReconnectRequiredError({
            message: "refresh failed",
            workspaceId: WORKSPACE,
            platform: "salesforce",
            upstreamError: "invalid_grant",
          });
        }),
      ).validateConfig(WORKSPACE, {}),
    );
    expect(msg).toMatch(/Reconnect/);
  });

  it("surfaces a missing builder (operator env) as an actionable form-level 400", async () => {
    const msg = await formErrorOf(
      handler(
        loaderOf(() => {
          throw new LazyPluginBuilderMissingError("catalog:salesforce");
        }),
      ).validateConfig(WORKSPACE, {}),
    );
    expect(msg).toMatch(/SALESFORCE_CLIENT_ID/);
  });

  it("blames article_object when the describe fails (Knowledge not enabled)", async () => {
    const msg = await fieldErrorOf(
      handler(
        loaderOf(
          fakeInstance({
            describeObject: async () => {
              throw new Error("INVALID_TYPE: sObject type 'Knowledge__kav' is not supported");
            },
          }),
        ),
      ).validateConfig(WORKSPACE, {}),
      "article_object",
    );
    expect(msg).toMatch(/could not describe Knowledge__kav/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("blames channel when the object lacks the channel's visibility field", async () => {
    const msg = await fieldErrorOf(
      handler(
        loaderOf(
          fakeInstance({
            describeObject: async () => ({
              fields: KAV_FIELDS.filter((f) => f.name !== "IsVisibleInPkb"),
            }),
          }),
        ),
      ).validateConfig(WORKSPACE, { channel: "pkb" }),
      "channel",
    );
    expect(msg).toMatch(/no IsVisibleInPkb field/);
  });
});

describe("credential-less persistence", () => {
  it("persists one collection row with scope-only config and credentialWritten: false", async () => {
    const rec = await handler().validateConfig(WORKSPACE, {
      channel: "pkb",
      description: "Public help center",
    });
    expect(rec.credentialWritten).toBe(false);
    expect(rec.installRecord).toMatchObject({
      workspaceId: WORKSPACE,
      catalogId: "salesforce-knowledge",
      id: "fixed-id-1",
    });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[3]).toBe("salesforce-knowledge");
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toEqual({
      article_object: "Knowledge__kav",
      channel: "pkb",
      description: "Public help center",
    });
    // Row lands published (the container is live; DOCUMENTS gate at draft),
    // knowledge-pillar.
    expect(insertCalls[0].sql).toContain("'knowledge'");
    expect(insertCalls[0].sql).toContain("'published'");
  });

  it("defaults the article object and omits absent optional fields from config", async () => {
    await handler().validateConfig(WORKSPACE, {});
    const config = JSON.parse(insertCalls[0].params[4] as string);
    expect(config).toEqual({ article_object: "Knowledge__kav" });
  });

  it("respects a custom collection slug via __install_id__", async () => {
    await handler().validateConfig(WORKSPACE, { __install_id__: "support-kb" });
    expect(insertCalls[0].params[3]).toBe("support-kb");
  });

  it("rejects a slug taken by another knowledge catalog BEFORE any write", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    const msg = await fieldErrorOf(handler().validateConfig(WORKSPACE, {}), "__install_id__");
    expect(msg).toMatch(/already used/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("fails loudly when the upsert returns no id", async () => {
    INSERT_RETURNS_ID = false;
    await expect(handler().validateConfig(WORKSPACE, {})).rejects.toThrow(/returned no id/i);
  });
});

describe("catalog preconditions", () => {
  it("fails loudly when the catalog row is missing (seed has not run)", async () => {
    CATALOG_ROWS = [];
    await expect(handler().validateConfig(WORKSPACE, {})).rejects.toThrow(
      /catalog row "salesforce-knowledge" not found/i,
    );
  });
});
