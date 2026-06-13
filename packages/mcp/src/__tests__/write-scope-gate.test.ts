/**
 * #3504 — `mcp:write` enforcement gate.
 *
 * Two layers:
 *   1. Unit tests of `writeScopeOrNull` — the pure gate decision (stdio
 *      exempt, hosted requires `mcp:write`, fail-closed on missing scopes).
 *   2. An end-to-end "stub write tool" registered on a real MCP server +
 *      in-memory client, gated exactly how a future mutating tool will gate:
 *      wrap dispatch in `withRequestContext({ scopes })`, read the scopes
 *      back off the context, and call `writeScopeOrNull`. Proves the token's
 *      scopes flow through the dispatch frame to the gate and that an
 *      `mcp:read`-only client is denied while an `mcp:write` client passes.
 */

import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext, withRequestContext } from "@atlas/api/lib/logger";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import { writeScopeOrNull } from "../tools.js";

const ACTOR = createAtlasUser("u_test", "managed", "test@example.com", {
  role: "admin",
  activeOrganizationId: "org_test",
});

function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

describe("writeScopeOrNull (#3504 mcp:write gate)", () => {
  it("exempts stdio (no clientId) regardless of scopes", () => {
    expect(writeScopeOrNull({ clientId: undefined, scopes: undefined })).toBeNull();
    expect(writeScopeOrNull({ clientId: undefined, scopes: ["mcp:read"] })).toBeNull();
  });

  it("allows a hosted client carrying mcp:write", () => {
    expect(
      writeScopeOrNull({ clientId: "claude-desktop", scopes: ["mcp:read", "mcp:write"] }),
    ).toBeNull();
  });

  it("denies a hosted client with only mcp:read (forbidden envelope)", () => {
    const result = writeScopeOrNull({ clientId: "claude-desktop", scopes: ["mcp:read"] });
    expect(result?.isError).toBe(true);
    const env = parseAtlasMcpToolError(getContentText(result?.content));
    expect(env?.code).toBe("forbidden");
    expect(env?.message).toContain("mcp:write");
  });

  it("fails closed for a hosted client whose scopes weren't threaded", () => {
    const result = writeScopeOrNull({ clientId: "claude-desktop", scopes: undefined });
    expect(result?.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(result?.content))?.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a stub write tool gated the way a real mutating tool will be.
// ---------------------------------------------------------------------------

async function clientForStubWriteTool(opts: {
  clientId?: string;
  scopes?: readonly string[];
}): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  server.registerTool(
    "stub_write",
    { title: "Stub write tool", description: "Mutating stub for the mcp:write gate test.", inputSchema: {} },
    async () => {
      // Mirror the real dispatch frame: stamp the session scopes onto the
      // RequestContext, then gate by reading them back off the context.
      return withRequestContext(
        {
          requestId: "stub-write",
          user: ACTOR,
          agentOrigin: "mcp",
          ...(opts.scopes ? { scopes: opts.scopes } : {}),
        },
        async () => {
          const denied = writeScopeOrNull({
            clientId: opts.clientId,
            scopes: getRequestContext()?.scopes,
          });
          if (denied) return denied;
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
        },
      );
    },
  );

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("stub write tool through the dispatch seam (#3504)", () => {
  it("denies a hosted mcp:read-only client", async () => {
    const client = await clientForStubWriteTool({ clientId: "claude-desktop", scopes: ["mcp:read"] });
    const result = await client.callTool({ name: "stub_write", arguments: {} });
    expect(result.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(result.content))?.code).toBe("forbidden");
  });

  it("allows a hosted mcp:write client", async () => {
    const client = await clientForStubWriteTool({
      clientId: "claude-desktop",
      scopes: ["mcp:read", "mcp:write"],
    });
    const result = await client.callTool({ name: "stub_write", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(getContentText(result.content)).toContain('"ok":true');
  });

  it("allows stdio (no clientId, no scopes)", async () => {
    const client = await clientForStubWriteTool({});
    const result = await client.callTool({ name: "stub_write", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(getContentText(result.content)).toContain('"ok":true');
  });
});
