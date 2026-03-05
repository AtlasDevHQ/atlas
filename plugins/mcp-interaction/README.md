# MCP Interaction Plugin

Reference implementation of `AtlasInteractionPlugin` from `@useatlas/plugin-sdk`.

Manages the lifecycle (init, health, teardown) of the `@atlas/mcp` server as a
plugin, proving the interaction plugin interface works with a real integration.
Tool bridging and resource registration are handled internally by `@atlas/mcp` —
this plugin is a thin lifecycle wrapper.

## Usage

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";
import { mcpPlugin } from "@atlas/plugin-mcp-interaction";

export default defineConfig({
  plugins: [
    mcpPlugin({ transport: "stdio" }),
  ],
});
```

## Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `"stdio" \| "sse"` | `"stdio"` | Transport type. stdio uses stdin/stdout (JSON-RPC) |
| `port` | `number` | — | Port for SSE transport (ignored for stdio) |

## Transport Support

- **stdio** (default) — Communicates via stdin/stdout JSON-RPC. Used by Claude Desktop,
  Cursor, and other MCP-compatible clients. Fully implemented.
- **sse** — Server-Sent Events over HTTP. Defined in config type for future implementation.

## Interface Change

This reference implementation revealed that `AtlasInteractionPlugin.routes` should be
optional. MCP's primary transport (stdio) doesn't involve HTTP routes — making `routes`
mandatory would force stdio-based interaction plugins to provide a meaningless no-op.

**Change:** `routes` on `AtlasInteractionPlugin` is now optional (`routes?: (app: Hono) => void`).
Plugins that don't need HTTP routes (stdio transports, CLI interfaces) can omit it entirely.
Plugins that do need routes (Slack bot, SSE-based MCP, webhooks) still provide them as before.

## Standalone Usage

The `@atlas/mcp` package continues to work standalone without the plugin wrapper:

```bash
bun run mcp             # Start MCP server on stdio
bun run dev:mcp         # Start MCP server with hot reload
bun run atlas -- mcp    # Start via CLI
```

The plugin is an additive wrapper for use with `atlas.config.ts` — it does not
replace the standalone entry points.
