/**
 * Tests for the `createLinearIssue` agent tool (#2750).
 *
 * Coverage mirrors `email-tool.test.ts`; Linear-specific surface is the
 * dual-catalog dispatch:
 *
 *   - OAuth install found at `catalog:linear` → uses that instance.
 *   - OAuth absent, API-key install found at `catalog:linear-apikey` →
 *     falls back to that instance.
 *   - Neither installed → `no_install` with the /admin/integrations copy.
 *
 * The unit test injects fakes via the `CreateLinearIssueToolDeps`
 * constructor — no `mock.module()` — so the loader interactions can be
 * driven precisely without booting the real lazy loader.
 */

import { describe, expect, it, mock, type Mock } from "bun:test";

import {
  createCreateLinearIssueTool,
  type CreateLinearIssueToolDeps,
} from "../linear-tool";
import {
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
  type LazyPluginLoader,
} from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";
import {
  LinearApiKeyDecryptFailureError,
  LinearApiKeyRejectedError,
  LinearGraphQLError,
  LINEAR_CATALOG_ID,
} from "../linear/lazy-builder";
import { IntegrationReconnectRequiredError } from "../install/linear-token-refresh";

const WSID = "ws-linear-tool-test";

interface FakeInstance {
  createLinearIssue: Mock<(...args: unknown[]) => Promise<unknown>>;
}

function makeFakeInstance(impl?: (args: unknown) => Promise<unknown>): FakeInstance {
  return {
    createLinearIssue: mock(impl ?? (() =>
      Promise.resolve({
        id: "issue-uuid",
        identifier: "ENG-1",
        url: "https://linear.app/x",
        title: "T",
      })) as (args: unknown) => Promise<unknown>),
  };
}

interface FakeLoaderState {
  oauth?: FakeInstance | "no_install" | Error;
  apikey?: FakeInstance | "no_install" | Error;
}

function makeLoader(state: FakeLoaderState): Pick<LazyPluginLoader, "getOrInstantiate"> {
  const getOrInstantiate = (async (
    _workspaceId: string,
    catalogId: string,
  ): Promise<PluginLike> => {
    const target = catalogId === LINEAR_CATALOG_ID ? state.oauth : state.apikey;
    if (target === "no_install" || target === undefined) {
      throw new LazyPluginInstallNotFoundError(_workspaceId, catalogId);
    }
    if (target instanceof Error) {
      throw target;
    }
    return target as unknown as PluginLike;
  }) as LazyPluginLoader["getOrInstantiate"];
  return { getOrInstantiate };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
}

function makeDeps(state: FakeLoaderState, opts: Partial<CreateLinearIssueToolDeps> = {}): CreateLinearIssueToolDeps {
  return {
    loader: makeLoader(state),
    resolveWorkspaceId: () => WSID,
    resolveRequestId: () => "req-test-1",
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// no_workspace
// ---------------------------------------------------------------------------

describe("createLinearIssue — no_workspace", () => {
  it("returns no_workspace when activeOrganizationId is unset", async () => {
    const tool = createCreateLinearIssueTool({
      ...makeDeps({}),
      resolveWorkspaceId: () => undefined,
    });
    const result = await runTool<{ status: string; message: string }>(tool, {
      title: "ping",
    });
    expect(result.status).toBe("no_workspace");
    expect(result.message).toMatch(/workspace/i);
  });
});

// ---------------------------------------------------------------------------
// no_install
// ---------------------------------------------------------------------------

describe("createLinearIssue — no_install", () => {
  it("returns no_install when neither catalog row has an install", async () => {
    const tool = createCreateLinearIssueTool(makeDeps({ oauth: "no_install", apikey: "no_install" }));
    const result = await runTool<{ status: string; message: string }>(tool, {
      title: "ping",
    });
    expect(result.status).toBe("no_install");
    expect(result.message).toMatch(/\/admin\/integrations/);
  });
});

// ---------------------------------------------------------------------------
// Dispatch — OAuth wins, API-key fallback
// ---------------------------------------------------------------------------

describe("createLinearIssue — dispatch", () => {
  it("uses the OAuth install when present", async () => {
    const oauth = makeFakeInstance();
    const apikey = makeFakeInstance();
    const tool = createCreateLinearIssueTool(makeDeps({ oauth, apikey }));

    const result = await runTool<{ status: string; mode: string }>(tool, { title: "x" });

    expect(result.status).toBe("created");
    expect(result.mode).toBe("oauth");
    expect(oauth.createLinearIssue).toHaveBeenCalled();
    expect(apikey.createLinearIssue).not.toHaveBeenCalled();
  });

  it("falls back to the API-key install when OAuth has no install row", async () => {
    const apikey = makeFakeInstance();
    const tool = createCreateLinearIssueTool(makeDeps({ oauth: "no_install", apikey }));

    const result = await runTool<{ status: string; mode: string }>(tool, { title: "x" });

    expect(result.status).toBe("created");
    expect(result.mode).toBe("apikey");
    expect(apikey.createLinearIssue).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reconnect surfaces — distinct mode tag for each install path
// ---------------------------------------------------------------------------

describe("createLinearIssue — reconnect surfaces", () => {
  it("returns reconnect_required (mode=oauth) when OAuth instantiation throws IntegrationReconnectRequiredError", async () => {
    const tool = createCreateLinearIssueTool(
      makeDeps({
        oauth: new IntegrationReconnectRequiredError({
          message: "reconnect",
          workspaceId: WSID,
          platform: "linear",
          upstreamError: "invalid_grant",
        }),
      }),
    );
    const result = await runTool<{ status: string; mode: string; message: string }>(tool, {
      title: "x",
    });
    expect(result.status).toBe("reconnect_required");
    expect(result.mode).toBe("oauth");
    expect(result.message).toMatch(/Linear \(OAuth\)/);
  });

  it("returns reconnect_required (mode=apikey) when API-key issueCreate throws LinearApiKeyRejectedError", async () => {
    const apikey = makeFakeInstance(() =>
      Promise.reject(new LinearApiKeyRejectedError(WSID)),
    );
    const tool = createCreateLinearIssueTool(makeDeps({ oauth: "no_install", apikey }));
    const result = await runTool<{ status: string; mode: string; message: string }>(tool, {
      title: "x",
    });
    expect(result.status).toBe("reconnect_required");
    expect(result.mode).toBe("apikey");
    expect(result.message).toMatch(/Linear \(API Key\)|personal API key/i);
  });

  it("returns reconnect_required (mode=oauth) when OAuth issueCreate mid-call throws IntegrationReconnectRequiredError", async () => {
    // Hits the post-instantiate branch — the instance was created, but
    // the actual call failed because the builder's `withRetry` couldn't
    // refresh successfully and rethrew.
    const oauth = makeFakeInstance(() =>
      Promise.reject(
        new IntegrationReconnectRequiredError({
          message: "mid-call",
          workspaceId: WSID,
          platform: "linear",
          upstreamError: "invalid_grant",
        }),
      ),
    );
    const tool = createCreateLinearIssueTool(makeDeps({ oauth }));
    const result = await runTool<{ status: string; mode: string }>(tool, { title: "x" });
    expect(result.status).toBe("reconnect_required");
    expect(result.mode).toBe("oauth");
  });
});

// ---------------------------------------------------------------------------
// Failure surfaces — decrypt_failure / misconfigured / create_failure
// ---------------------------------------------------------------------------

describe("createLinearIssue — failure surfaces", () => {
  it("returns decrypt_failure when the API-key builder throws LinearApiKeyDecryptFailureError", async () => {
    const tool = createCreateLinearIssueTool(
      makeDeps({
        oauth: "no_install",
        apikey: new LinearApiKeyDecryptFailureError(WSID, new Error("bad keyset")),
      }),
    );
    const result = await runTool<{ status: string; requestId: string }>(tool, { title: "x" });
    expect(result.status).toBe("decrypt_failure");
    expect(result.requestId).toBe("req-test-1");
  });

  it("returns misconfigured when the loader throws LazyPluginBuilderMissingError", async () => {
    const tool = createCreateLinearIssueTool(
      makeDeps({ oauth: new LazyPluginBuilderMissingError(LINEAR_CATALOG_ID) }),
    );
    const result = await runTool<{ status: string; requestId: string }>(tool, { title: "x" });
    expect(result.status).toBe("misconfigured");
    expect(result.requestId).toBe("req-test-1");
  });

  it("returns create_failure with a scrubbed upstream message when Linear GraphQL rejects the mutation", async () => {
    const oauth = makeFakeInstance(() =>
      Promise.reject(new LinearGraphQLError("team not found")),
    );
    const tool = createCreateLinearIssueTool(makeDeps({ oauth }));
    const result = await runTool<{ status: string; message: string }>(tool, { title: "x" });
    expect(result.status).toBe("create_failure");
    expect(result.message).toMatch(/team not found/);
  });

  it("returns create_failure with errorMessage-scrubbed text when issueCreate throws a plain error", async () => {
    const oauth = makeFakeInstance(() =>
      Promise.reject(new Error("ECONNRESET against api.linear.app")),
    );
    const tool = createCreateLinearIssueTool(makeDeps({ oauth }));
    const result = await runTool<{ status: string; message: string }>(tool, { title: "x" });
    expect(result.status).toBe("create_failure");
    expect(result.message).toMatch(/ECONNRESET/);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("createLinearIssue — input validation", () => {
  it("rejects an empty title at the Zod boundary", async () => {
    const oauth = makeFakeInstance();
    const tool = createCreateLinearIssueTool(makeDeps({ oauth }));
    // The AI SDK's `tool({...}).execute(args, ctx)` runs WITHOUT the
    // schema parse (the parse happens upstream of the tool execution
    // when called via streamText). Test the schema directly to pin
    // the contract.
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const inputSchema = (tool as any).inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(inputSchema.safeParse({ title: "" }).success).toBe(false);
    expect(inputSchema.safeParse({ title: "ok" }).success).toBe(true);
  });

  it("rejects teamKey that isn't uppercase alphanumeric", async () => {
    const oauth = makeFakeInstance();
    const tool = createCreateLinearIssueTool(makeDeps({ oauth }));
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const inputSchema = (tool as any).inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(inputSchema.safeParse({ title: "x", teamKey: "lowercase" }).success).toBe(false);
    expect(inputSchema.safeParse({ title: "x", teamKey: "ENG" }).success).toBe(true);
  });
});
