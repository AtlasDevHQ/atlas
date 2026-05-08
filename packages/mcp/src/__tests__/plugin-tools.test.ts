/**
 * Integration test for the plugin MCP tool extension point (#2078).
 *
 * Verifies the end-to-end wire: a plugin contributes tools via
 * `mcpTools()` → `wireMcpToolPlugins` populates the global registry →
 * `registerPluginTools` mounts them on the MCP server → an MCP client
 * sees them in `tools/list` and can invoke them.
 *
 * The native tools (`explore`, `executeSQL`, the typed semantic tools)
 * register first; plugin tools register on top with the
 * `<plugin-id>.<name>` namespace so a misbehaving plugin cannot shadow
 * native tools.
 */

import { describe, expect, it, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { z } from "zod/v4";

const TEST_ACTOR = createAtlasUser("u_plugin", "managed", "plugin@test", {
  role: "admin",
  activeOrganizationId: "org_plugin",
});

const __mockedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
  source: "env",
  plugins: [],
};

mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => __mockedConfig),
  getConfig: mock(() => __mockedConfig),
  loadConfig: mock(async () => __mockedConfig),
  configFromEnv: mock(() => __mockedConfig),
  validateAndResolve: mock(() => __mockedConfig),
  defineConfig: (c: unknown) => c,
  applyDatasources: mock(async () => undefined),
  validateToolConfig: mock(async () => undefined),
  formatZodErrors: () => "",
  _resetConfig: mock(() => undefined),
  _setConfigForTest: mock(() => undefined),
  _warnPoolDefaultsInSaaS: mock(() => undefined),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => ""),
  },
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mock(async () => ({ success: false, error: "no datasource" })),
  },
}));

const { createAtlasMcpServer } = await import("../server.js");
const { pluginMcpToolRegistry } = await import(
  "@atlas/api/lib/plugins/mcp-tools"
);

describe("plugin MCP tools — tools/list integration", () => {
  it(
    "shows plugin-contributed tools alongside native tools when registered",
    async () => {
      pluginMcpToolRegistry._reset();
      pluginMcpToolRegistry.register("acme", {
        name: "ping",
        description: "Test plugin tool — returns the input message",
        inputSchema: z.object({ message: z.string() }),
        handler: async ({ message }) => ({ echo: message }),
      });

      const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
      const client = new Client({ name: "test-client", version: "0.0.1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toContain("acme.ping");
      // Native tools still present:
      expect(names).toContain("executeSQL");
      expect(names).toContain("explore");

      pluginMcpToolRegistry._reset();
    },
  );

  it(
    "invokes a plugin tool and returns its JSON result via MCP",
    async () => {
      pluginMcpToolRegistry._reset();
      pluginMcpToolRegistry.register("acme", {
        name: "echo",
        description: "Echo plugin tool",
        inputSchema: z.object({ value: z.string() }),
        handler: async ({ value }) => ({ value }),
      });

      const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
      const client = new Client({ name: "test-client", version: "0.0.1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "acme.echo",
        arguments: { value: "hi" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(JSON.parse(text)).toEqual({ value: "hi" });
      expect(result.isError).toBeUndefined();

      pluginMcpToolRegistry._reset();
    },
  );

  it(
    "rejects an invocation whose input violates the registered Zod schema",
    async () => {
      // Schema validation runs at the MCP SDK boundary (before our
      // handler is called). The SDK returns its own protocol-level
      // error envelope for bad inputs — verify the call rejects so an
      // LLM agent sees a recoverable error rather than a silent success.
      // Envelope-shape coverage for our `validation_failed` code lives
      // in the api-side `plugin-mcp-tools.test.ts` (which exercises the
      // dispatch handler directly without the MCP SDK in between).
      pluginMcpToolRegistry._reset();
      pluginMcpToolRegistry.register("acme", {
        name: "strict",
        description: "Strict plugin tool",
        inputSchema: z.object({ n: z.number().int().min(1) }),
        handler: async ({ n }) => ({ n }),
      });

      const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
      const client = new Client({ name: "test-client", version: "0.0.1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "acme.strict",
        arguments: { n: 0 },
      });
      // The SDK marks `isError: true` on schema-rejected inputs. The
      // exact envelope shape (MCP-protocol error vs our `validation_failed`)
      // is asserted in the api-side test where we bypass the SDK.
      expect(
        result.isError,
        "Bad input must surface as isError so an LLM agent can see the failure",
      ).toBe(true);

      pluginMcpToolRegistry._reset();
    },
  );

  it(
    "wraps handler throws in an internal_error envelope with request_id",
    async () => {
      pluginMcpToolRegistry._reset();
      pluginMcpToolRegistry.register("acme", {
        name: "boom",
        description: "Plugin tool that throws",
        inputSchema: z.object({}),
        handler: async () => {
          throw new Error("kaboom");
        },
      });

      const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
      const client = new Client({ name: "test-client", version: "0.0.1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "acme.boom",
        arguments: {},
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      const body = JSON.parse(text);
      expect(body.code).toBe("internal_error");
      expect(body.message).toBe("kaboom");
      expect(body.request_id).toMatch(/^mcp-plugin-/);
      expect(result.isError).toBe(true);

      pluginMcpToolRegistry._reset();
    },
  );
});
