/**
 * Tests for the `querySalesforce` agent tool — OAuth per-Workspace path (#3311).
 *
 * Mirrors `linear-tool.test.ts`: fakes are injected via the
 * `QuerySalesforceToolDeps` constructor (loader, workspace/request id, and the
 * whitelist resolver) so the execute path runs without booting the lazy loader
 * or the semantic layer.
 *
 * The Salesforce-specific surface is the SOQL validation + object whitelist
 * (reused from `@useatlas/salesforce`): an empty whitelist → structural-only,
 * a populated whitelist → per-object membership enforced, a throwing resolver
 * → fail-closed (`scan_unavailable`).
 */

import { describe, expect, it, mock, type Mock } from "bun:test";

import {
  createQuerySalesforceTool,
  type QuerySalesforceToolDeps,
} from "../salesforce-tool";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
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
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("querySalesforce — input validation", () => {
  it("rejects an empty soql at the Zod boundary", async () => {
    const tool = createQuerySalesforceTool(makeDeps(makeFakeInstance()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputSchema = (tool as any).inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(inputSchema.safeParse({ soql: "", explanation: "x" }).success).toBe(false);
    expect(inputSchema.safeParse({ soql: "SELECT Id FROM Account", explanation: "x" }).success).toBe(true);
  });
});
