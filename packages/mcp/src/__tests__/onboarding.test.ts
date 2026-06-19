/**
 * Tests for the anonymous onboarding caller (`start_trial`, ADR-0018, #3649).
 *
 *   1. The tool provisions into grace and hands back the connect URL, over the
 *      in-memory Client/Server transport — the same seam `tools.test.ts` uses.
 *   2. Input is collected via tool args OR MCP elicitation.
 *   3. Typed provisioning failures surface as `AtlasMcpToolError` envelopes.
 *   4. The tool + router are SaaS-only: absent off-SaaS.
 *   5. The onboarding server exposes ONLY `start_trial` — no read/write tools —
 *      so the anonymous caller can never reach the dispatch gate.
 */

import { describe, expect, it, mock, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import { TrialProvisioningError } from "@atlas/ee/onboarding/provision-trial";

// Control deployMode via getConfig — mirrors hosted.test.ts. `mockDeployMode`
// is mutable so individual tests can flip SaaS on/off.
let mockDeployMode: "saas" | "self-hosted" = "saas";
const __mockedConfig = () => ({ deployMode: mockDeployMode });
mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => __mockedConfig()),
  getConfig: mock(() => __mockedConfig()),
  loadConfig: mock(async () => __mockedConfig()),
  configFromEnv: mock(() => __mockedConfig()),
  validateAndResolve: mock(() => __mockedConfig()),
  defineConfig: (c: unknown) => c,
  applyDatasources: mock(async () => undefined),
  validateToolConfig: mock(async () => undefined),
  formatZodErrors: () => "",
  _resetConfig: mock(() => undefined),
  _setConfigForTest: mock(() => undefined),
  _warnPoolDefaultsInSaaS: mock(() => undefined),
}));

import {
  registerStartTrialTool,
  createOnboardingMcpServer,
  createOnboardingMcpRouter,
  type ProvisionTrialFn,
} from "../onboarding.js";

// The elicitation requestState is HMAC'd from BETTER_AUTH_SECRET; set one for
// the round-trip test and restore after (self-contained, no top-level mutation).
const ORIG_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-32-chars-long";
});
afterAll(() => {
  if (ORIG_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIG_AUTH_SECRET;
});

const okProvision: ProvisionTrialFn = async (input) => ({
  workspaceId: "org_new",
  connectUrl: "https://mcp.test/mcp/org_new/sse",
  state: input.orgName.includes("locked") ? "locked" : "grace",
});

async function wireTool(
  provision: ProvisionTrialFn,
  opts: { withElicitation?: { email: string; orgName: string } } = {},
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerStartTrialTool(server, { provision });

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    opts.withElicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.withElicitation) {
    const reply = opts.withElicitation;
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { email: reply.email, orgName: reply.orgName },
    }));
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}

describe("start_trial tool", () => {
  it("exposes only start_trial (no read/write tools reach the anonymous caller)", async () => {
    const { client } = await wireTool(okProvision);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["start_trial"]);
  });

  it("provisions into grace and returns { workspaceId, connectUrl, state } from args", async () => {
    const { client } = await wireTool(okProvision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "founder@acme.com", orgName: "Acme" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      workspaceId: "org_new",
      connectUrl: "https://mcp.test/mcp/org_new/sse",
      state: "grace",
    });
  });

  it("passes a locked state through unchanged", async () => {
    const { client } = await wireTool(okProvision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "founder@acme.com", orgName: "locked-acme" },
    });
    expect(
      (result.structuredContent as { state: string }).state,
    ).toBe("locked");
  });

  it("collects email + orgName via MCP elicitation when omitted", async () => {
    const seen: Array<{ email: string; orgName: string }> = [];
    const provision: ProvisionTrialFn = async (input) => {
      seen.push(input);
      return {
        workspaceId: "org_elicited",
        connectUrl: "https://mcp.test/mcp/org_elicited/sse",
        state: "grace",
      };
    };
    const { client } = await wireTool(provision, {
      withElicitation: { email: "elicited@acme.com", orgName: "Elicited Co" },
    });
    const result = await client.callTool({ name: "start_trial", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([{ email: "elicited@acme.com", orgName: "Elicited Co" }]);
    expect(
      (result.structuredContent as { workspaceId: string }).workspaceId,
    ).toBe("org_elicited");
  });

  it("maps a TrialProvisioningError(invalid_input) to a validation_failed envelope", async () => {
    const provision: ProvisionTrialFn = async () => {
      throw new TrialProvisioningError("invalid_input", "bad email");
    };
    const { client } = await wireTool(provision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "x@y.com", orgName: "Acme" },
    });
    expect(result.isError).toBe(true);
    const arr = result.content as Array<{ type: string; text: string }>;
    const err = parseAtlasMcpToolError(arr[0]!.text);
    expect(err?.code).toBe("validation_failed");
  });

  it("maps an unexpected error to internal_error with a request_id", async () => {
    const provision: ProvisionTrialFn = async () => {
      throw new Error("kaboom");
    };
    const { client } = await wireTool(provision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "x@y.com", orgName: "Acme" },
    });
    expect(result.isError).toBe(true);
    const arr = result.content as Array<{ type: string; text: string }>;
    const err = parseAtlasMcpToolError(arr[0]!.text);
    expect(err?.code).toBe("internal_error");
    expect(err?.request_id).toBeTruthy();
  });
});

describe("onboarding SaaS gating", () => {
  it("createOnboardingMcpServer returns a server on SaaS, null off-SaaS", () => {
    mockDeployMode = "saas";
    expect(createOnboardingMcpServer({ provision: okProvision })).not.toBeNull();
    mockDeployMode = "self-hosted";
    expect(createOnboardingMcpServer({ provision: okProvision })).toBeNull();
    mockDeployMode = "saas";
  });

  it("router has no /sse route off-SaaS (404), present on SaaS (not 404)", async () => {
    mockDeployMode = "self-hosted";
    const offRouter = createOnboardingMcpRouter();
    const off = await offRouter.request("/sse", { method: "POST" });
    expect(off.status).toBe(404);

    mockDeployMode = "saas";
    const onRouter = createOnboardingMcpRouter();
    const on = await onRouter.request("/sse", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(on.status).not.toBe(404);
  });
});
