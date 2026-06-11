/**
 * Tests for the `querySalesforce` agent tool — OAuth per-Workspace path (#3311).
 *
 * Mirrors `linear-tool.test.ts`: fakes are injected via the
 * `QuerySalesforceToolDeps` constructor (loader, workspace/request id, and the
 * whitelist resolver) so the execute path runs without booting the lazy loader
 * or the semantic layer.
 *
 * The Salesforce-specific surface is the SOQL validation + object whitelist
 * (core-local `./salesforce/soql-validation.ts`): an empty whitelist →
 * structural-only, a populated whitelist → per-object membership enforced, a
 * throwing resolver → fail-closed (`scan_unavailable`).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

import {
  createQuerySalesforceTool,
  type QuerySalesforceToolDeps,
} from "../salesforce-tool";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";
import {
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
  type LazyPluginLoader,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";
import { SALESFORCE_CATALOG_ID } from "../install/salesforce-oauth-handler";
import { IntegrationReconnectRequiredError } from "../install/salesforce-token-refresh";

const WSID = "ws-salesforce-tool-test";

interface FakeInstance {
  query: Mock<(soql: string, timeoutMs?: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>>;
}

function makeFakeInstance(
  impl?: (soql: string, timeoutMs?: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>,
): FakeInstance {
  return {
    query: mock(
      (impl ??
        (() =>
          Promise.resolve({
            columns: ["Id", "Name"],
            rows: [{ Id: "001", Name: "Acme" }],
          }))) as (soql: string, timeoutMs?: number) => Promise<{
        columns: string[];
        rows: Record<string, unknown>[];
      }>,
    ),
  };
}

function makeLoader(
  target: FakeInstance | "no_install" | Error,
): Pick<LazyPluginLoader, "getOrInstantiate"> {
  const getOrInstantiate = (async (
    _workspaceId: string,
    catalogId: string,
  ): Promise<PluginLike> => {
    expect(catalogId).toBe(SALESFORCE_CATALOG_ID);
    if (target === "no_install") {
      throw new LazyPluginInstallNotFoundError(_workspaceId, catalogId);
    }
    if (target instanceof Error) {
      throw target;
    }
    return target as unknown as PluginLike;
  }) as LazyPluginLoader["getOrInstantiate"];
  return { getOrInstantiate };
}

/** Narrow shape of the AI SDK tool object exercised by these tests. */
interface ExecutableTool {
  execute: (args: unknown, options?: unknown) => Promise<unknown>;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
}

async function runTool<T = unknown>(tool: unknown, args: unknown): Promise<T> {
  const t = tool as ExecutableTool;
  if (!t?.execute) throw new Error("tool has no execute");
  return (await t.execute(args, undefined)) as T;
}

function makeDeps(
  target: FakeInstance | "no_install" | Error,
  opts: Partial<QuerySalesforceToolDeps> = {},
): QuerySalesforceToolDeps {
  return {
    loader: makeLoader(target),
    resolveWorkspaceId: () => WSID,
    resolveRequestId: () => "req-test-1",
    // Default: empty whitelist → structural-only (so SOQL validation passes on
    // any well-formed SELECT). Individual tests override.
    resolveWhitelist: () => Promise.resolve(new Set<string>()),
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// no_workspace
// ---------------------------------------------------------------------------

describe("querySalesforce — no_workspace", () => {
  it("returns no_workspace when activeOrganizationId is unset", async () => {
    const tool = createQuerySalesforceTool({
      ...makeDeps("no_install"),
      resolveWorkspaceId: () => undefined,
    });
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("no_workspace");
    expect(result.message).toMatch(/workspace/i);
  });
});

// ---------------------------------------------------------------------------
// no_install
// ---------------------------------------------------------------------------

describe("querySalesforce — no_install", () => {
  it("returns no_install when no catalog:salesforce install is enabled", async () => {
    const tool = createQuerySalesforceTool(makeDeps("no_install"));
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("no_install");
    expect(result.message).toMatch(/\/admin\/integrations/);
  });
});

// ---------------------------------------------------------------------------
// Happy path — end-to-end SOQL execution
// ---------------------------------------------------------------------------

describe("querySalesforce — ok", () => {
  it("executes a SOQL query end-to-end for an OAuth-installed workspace", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));

    const result = await runTool<{
      status: string;
      row_count: number;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
    }>(tool, { soql: "SELECT Id, Name FROM Account", explanation: "list accounts" });

    expect(result.status).toBe("ok");
    expect(result.row_count).toBe(1);
    expect(result.columns).toEqual(["Id", "Name"]);
    expect(result.rows).toEqual([{ Id: "001", Name: "Acme" }]);
    expect(result.truncated).toBe(false);
    expect(instance.query).toHaveBeenCalledTimes(1);
    // Auto-LIMIT appended.
    const calledSoql = instance.query.mock.calls[0]?.[0] as string;
    expect(calledSoql).toMatch(/LIMIT\s+\d+$/i);
  });
});

// ---------------------------------------------------------------------------
// Whitelist enforcement
// ---------------------------------------------------------------------------

describe("querySalesforce — whitelist", () => {
  it("rejects an object not in a populated whitelist (invalid_query) without instantiating", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(
      makeDeps(instance, {
        resolveWhitelist: () => Promise.resolve(new Set(["Account"])),
      }),
    );
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Contact",
      explanation: "blocked",
    });
    expect(result.status).toBe("invalid_query");
    expect(result.message).toMatch(/Contact/);
    expect(instance.query).not.toHaveBeenCalled();
  });

  it("allows a whitelisted object", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(
      makeDeps(instance, {
        resolveWhitelist: () => Promise.resolve(new Set(["Account"])),
      }),
    );
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "allowed",
    });
    expect(result.status).toBe("ok");
  });

  it("does not phantom-reject when a string literal contains 'from <word>' (whitelist mode)", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(
      makeDeps(instance, {
        resolveWhitelist: () => Promise.resolve(new Set(["Account"])),
      }),
    );
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account WHERE Description = 'order from Supplier'",
      explanation: "literal contains from",
    });
    expect(result.status).toBe("ok");
    expect(instance.query).toHaveBeenCalledTimes(1);
  });

  it("still appends auto-LIMIT when the word LIMIT appears inside a string literal", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account WHERE Name = 'no LIMIT here'",
      explanation: "literal contains LIMIT",
    });
    expect(result.status).toBe("ok");
    const calledSoql = instance.query.mock.calls[0]?.[0] as string;
    expect(calledSoql).toMatch(/LIMIT\s+\d+$/i);
  });

  it("rejects a DML/mutation SOQL even in structural-only mode (invalid_query)", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "UPDATE Account SET Name = 'x'",
      explanation: "mutation",
    });
    expect(result.status).toBe("invalid_query");
    expect(instance.query).not.toHaveBeenCalled();
  });

  it("fails CLOSED (scan_unavailable) when the whitelist resolver throws", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(
      makeDeps(instance, {
        resolveWhitelist: () => Promise.reject(new Error("semantic scan failed")),
      }),
    );
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("scan_unavailable");
    expect(instance.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reconnect / misconfigured / query_failure surfaces
// ---------------------------------------------------------------------------

describe("querySalesforce — failure surfaces", () => {
  it("returns reconnect_required when instantiation throws IntegrationReconnectRequiredError", async () => {
    const tool = createQuerySalesforceTool(
      makeDeps(
        new IntegrationReconnectRequiredError({
          message: "reconnect",
          workspaceId: WSID,
          platform: "salesforce",
          upstreamError: "invalid_grant",
        }),
      ),
    );
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("reconnect_required");
    expect(result.message).toMatch(/Reconnect/i);
  });

  it("returns reconnect_required when the query itself throws IntegrationReconnectRequiredError mid-call", async () => {
    const instance = makeFakeInstance(() =>
      Promise.reject(
        new IntegrationReconnectRequiredError({
          message: "mid-call",
          workspaceId: WSID,
          platform: "salesforce",
          upstreamError: "invalid_grant",
        }),
      ),
    );
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("reconnect_required");
  });

  it("returns misconfigured when the loader throws LazyPluginBuilderMissingError", async () => {
    const tool = createQuerySalesforceTool(
      makeDeps(new LazyPluginBuilderMissingError(SALESFORCE_CATALOG_ID)),
    );
    const result = await runTool<{ status: string; requestId: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("misconfigured");
    expect(result.requestId).toBe("req-test-1");
  });

  it("scrubs sensitive query errors to a generic message", async () => {
    const instance = makeFakeInstance(() =>
      Promise.reject(new Error("INVALID_SESSION_ID: session expired for password reset")),
    );
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("query_failure");
    expect(result.message).toMatch(/check server logs/i);
    expect(result.message).not.toMatch(/password/i);
  });

  it("returns query_failure with a scrubbed message for a non-sensitive query error", async () => {
    const instance = makeFakeInstance(() =>
      Promise.reject(new Error("MALFORMED_QUERY: unexpected token")),
    );
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("query_failure");
    expect(result.message).toMatch(/MALFORMED_QUERY/);
  });

  it("scrubs a sensitive INSTANTIATION error (not just query errors) to a generic message", async () => {
    // Plain Error (not a tagged class) → instantiation fallthrough branch.
    const tool = createQuerySalesforceTool(
      makeDeps(new Error("decrypt failed: INVALID_CLIENT_ID for stored credential")),
    );
    const result = await runTool<{ status: string; message: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "x",
    });
    expect(result.status).toBe("query_failure");
    expect(result.message).toMatch(/check server logs/i);
    expect(result.message).not.toMatch(/INVALID_CLIENT_ID/);
    expect(result.message).not.toMatch(/credential/i);
  });
});

// ---------------------------------------------------------------------------
// ATLAS_ROW_LIMIT lazy resolution (#3400)
//
// The SOQL auto-LIMIT must resolve ATLAS_ROW_LIMIT per call via getSetting
// (DB override > env var > default 1000) — matching getRowLimit() in
// tools/sql.ts — not freeze it from env at module import. Uses the
// _resetPool(mockPool) injection pattern from settings.test.ts so setSetting
// writes a real platform DB override into the settings cache.
// ---------------------------------------------------------------------------

describe("querySalesforce — ATLAS_ROW_LIMIT lazy resolution (#3400)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origRowLimit = process.env.ATLAS_ROW_LIMIT;

  const mockPool: InternalPool = {
    query: async () => ({ rows: [] }),
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    end: async () => {},
    on: () => {},
  };

  beforeEach(() => {
    delete process.env.ATLAS_ROW_LIMIT;
    _resetSettingsCache();
  });

  afterEach(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origRowLimit !== undefined) process.env.ATLAS_ROW_LIMIT = origRowLimit;
    else delete process.env.ATLAS_ROW_LIMIT;
    _resetPool(null);
    _resetSettingsCache();
  });

  function enableInternalDB() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
  }

  it("honors a platform DB override written AFTER module import", async () => {
    enableInternalDB();
    // The tool module was imported long before this write — a frozen
    // module-level const would still append the env/default limit.
    await setSetting("ATLAS_ROW_LIMIT", "5", "admin-test");

    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "db override honored",
    });

    expect(result.status).toBe("ok");
    const calledSoql = instance.query.mock.calls[0]?.[0] as string;
    expect(calledSoql).toMatch(/LIMIT 5$/);
  });

  it("computes `truncated` against the DB override, not an import-time value", async () => {
    enableInternalDB();
    await setSetting("ATLAS_ROW_LIMIT", "1", "admin-test");

    const instance = makeFakeInstance(); // default fake returns exactly 1 row
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string; truncated: boolean }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "truncated vs override",
    });

    expect(result.status).toBe("ok");
    expect(result.truncated).toBe(true); // 1 row >= overridden limit 1
  });

  it("falls back to the env var when no DB override exists", async () => {
    process.env.ATLAS_ROW_LIMIT = "7";

    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "env fallback",
    });

    expect(result.status).toBe("ok");
    const calledSoql = instance.query.mock.calls[0]?.[0] as string;
    expect(calledSoql).toMatch(/LIMIT 7$/);
  });

  it("defaults to 1000 when neither DB override nor env var is set", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "registry default",
    });

    expect(result.status).toBe("ok");
    const calledSoql = instance.query.mock.calls[0]?.[0] as string;
    expect(calledSoql).toMatch(/LIMIT 1000$/);
  });

  it("uses the 1000 default for an invalid (non-numeric) value", async () => {
    process.env.ATLAS_ROW_LIMIT = "not-a-number";

    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "invalid value falls back",
    });

    expect(result.status).toBe("ok");
    const calledSoql = instance.query.mock.calls[0]?.[0] as string;
    expect(calledSoql).toMatch(/LIMIT 1000$/);
  });
});

// ---------------------------------------------------------------------------
// ATLAS_QUERY_TIMEOUT lazy resolution (#3402)
//
// The SOQL query timeout must resolve ATLAS_QUERY_TIMEOUT per call via
// getSetting (DB override > env var > default 30000) — matching
// getQueryTimeout() in tools/sql.ts — not freeze it from env at module
// import. Same injection pattern as the #3400 block above; asserts the
// timeout argument passed to the plugin instance's query().
// ---------------------------------------------------------------------------

describe("querySalesforce — ATLAS_QUERY_TIMEOUT lazy resolution (#3402)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origQueryTimeout = process.env.ATLAS_QUERY_TIMEOUT;

  const mockPool: InternalPool = {
    query: async () => ({ rows: [] }),
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    end: async () => {},
    on: () => {},
  };

  beforeEach(() => {
    delete process.env.ATLAS_QUERY_TIMEOUT;
    _resetSettingsCache();
  });

  afterEach(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origQueryTimeout !== undefined) process.env.ATLAS_QUERY_TIMEOUT = origQueryTimeout;
    else delete process.env.ATLAS_QUERY_TIMEOUT;
    _resetPool(null);
    _resetSettingsCache();
  });

  function enableInternalDB() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
  }

  it("honors a platform DB override written AFTER module import", async () => {
    enableInternalDB();
    // The tool module was imported long before this write — a frozen
    // module-level const would still pass the env/default timeout.
    await setSetting("ATLAS_QUERY_TIMEOUT", "5000", "admin-test");

    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "db override honored",
    });

    expect(result.status).toBe("ok");
    expect(instance.query.mock.calls[0]?.[1]).toBe(5000);
  });

  it("falls back to the env var when no DB override exists", async () => {
    process.env.ATLAS_QUERY_TIMEOUT = "7000";

    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "env fallback",
    });

    expect(result.status).toBe("ok");
    expect(instance.query.mock.calls[0]?.[1]).toBe(7000);
  });

  it("defaults to 30000 when neither DB override nor env var is set", async () => {
    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "registry default",
    });

    expect(result.status).toBe("ok");
    expect(instance.query.mock.calls[0]?.[1]).toBe(30000);
  });

  it("uses the 30000 default for an invalid (non-numeric) value", async () => {
    process.env.ATLAS_QUERY_TIMEOUT = "not-a-number";

    const instance = makeFakeInstance();
    const tool = createQuerySalesforceTool(makeDeps(instance));
    const result = await runTool<{ status: string }>(tool, {
      soql: "SELECT Id FROM Account",
      explanation: "invalid value falls back",
    });

    expect(result.status).toBe("ok");
    expect(instance.query.mock.calls[0]?.[1]).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("querySalesforce — input validation", () => {
  it("rejects an empty soql at the Zod boundary", async () => {
    const tool = createQuerySalesforceTool(makeDeps(makeFakeInstance()));
    const { inputSchema } = tool as unknown as ExecutableTool;
    expect(inputSchema.safeParse({ soql: "", explanation: "x" }).success).toBe(false);
    expect(inputSchema.safeParse({ soql: "SELECT Id FROM Account", explanation: "x" }).success).toBe(true);
  });
});
