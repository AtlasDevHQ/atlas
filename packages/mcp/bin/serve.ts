#!/usr/bin/env bun
/**
 * Atlas MCP server entry point.
 *
 * Supports two transports:
 * - stdio (default): JSON-RPC over stdin/stdout for Claude Desktop, Cursor, etc.
 * - sse: Streamable HTTP (SSE) over an HTTP server for browser/remote clients.
 *
 * Usage:
 *   bun packages/mcp/bin/serve.ts                              # stdio (default)
 *   bun packages/mcp/bin/serve.ts --transport sse              # SSE on :8080
 *   bun packages/mcp/bin/serve.ts --transport sse --port 9090  # SSE on :9090
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "atlas": {
 *         "command": "bun",
 *         "args": ["packages/mcp/bin/serve.ts"],
 *         "cwd": "/path/to/atlas"
 *       }
 *     }
 *   }
 *
 * For SSE transport (browser/remote clients):
 *   bun packages/mcp/bin/serve.ts --transport sse --port 8080
 *   # Connect via: http://localhost:8080/mcp
 */

import { createAtlasMcpServer } from "../src/server.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let transport = "stdio";
  let port = 8080;
  let corsOrigin = process.env.ATLAS_CORS_ORIGIN ?? "*";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport" && args[i + 1]) {
      transport = args[i + 1];
      i++;
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--cors-origin" && args[i + 1]) {
      corsOrigin = args[i + 1];
      i++;
    }
  }

  if (transport !== "stdio" && transport !== "sse") {
    console.error(`[atlas-mcp] Unknown transport: "${transport}". Use "stdio" or "sse".`);
    process.exit(1);
  }

  if (transport === "sse" && (isNaN(port) || port <= 0)) {
    console.error(`[atlas-mcp] Invalid port: "${port}". Must be a positive integer.`);
    process.exit(1);
  }

  return { transport: transport as "stdio" | "sse", port, corsOrigin };
}

async function main() {
  const { transport, port, corsOrigin } = parseArgs(process.argv);

  if (transport === "sse") {
    const { startSseServer } = await import("../src/sse.js");
    const handle = await startSseServer(
      () => createAtlasMcpServer(),
      { port, corsOrigin },
    );

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await handle.close();
      } catch (err) {
        console.error(`[atlas-mcp] Error closing SSE server: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.error(`[atlas-mcp] Server running on http://${handle.server.hostname}:${handle.server.port}/mcp`);
    return;
  }

  // stdio transport (default)
  const server = await createAtlasMcpServer();
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (err) {
      console.error(`[atlas-mcp] Error closing server: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Log to stderr so it doesn't interfere with JSON-RPC on stdout
  console.error("[atlas-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[atlas-mcp] Fatal:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
