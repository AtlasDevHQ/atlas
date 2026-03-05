# Plugin Authoring Guide

Step-by-step guide to building an Atlas plugin. We'll build a complete datasource plugin, then cover how the other four types differ.

## Prerequisites

- `@useatlas/plugin-sdk` — type definitions and helpers
- `zod` — config schema validation
- `bun` — runtime and test runner
- An Atlas project with `atlas.config.ts`

## 1. Scaffold

Use the CLI to generate a plugin skeleton:

```bash
bun run atlas -- plugin create my-datasource --type datasource
```

This creates `plugins/my-datasource/` with:

```
plugins/my-datasource/
├── src/
│   ├── index.ts         # Plugin entry point
│   └── index.test.ts    # Test scaffold
├── package.json
└── tsconfig.json
```

Or create the files manually — the CLI is a convenience, not a requirement.

## 2. Config Schema

Define what your plugin accepts using Zod:

```typescript
// src/config.ts
import { z } from "zod";

export const ConfigSchema = z.object({
  url: z
    .string()
    .min(1, "URL must not be empty")
    .refine(
      (u) => u.startsWith("postgresql://") || u.startsWith("postgres://"),
      "URL must start with postgresql:// or postgres://",
    ),
  poolSize: z.number().int().positive().max(500).optional(),
});

export type PluginConfig = z.infer<typeof ConfigSchema>;
```

The schema is validated at factory call time — before the server starts. Invalid config fails fast.

## 3. Connection Factory

Implement `PluginDBConnection` — the interface Atlas uses to query your database:

```typescript
// src/connection.ts
import type { PluginDBConnection, PluginQueryResult } from "@useatlas/plugin-sdk";
import type { PluginConfig } from "./config";

export function createConnection(config: PluginConfig): PluginDBConnection {
  // Lazy-load the driver so it's an optional peer dependency
  let Pool: typeof import("pg").Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error("This plugin requires the pg package. Install it with: bun add pg");
    }
    throw err;
  }

  const pool = new Pool({
    connectionString: config.url,
    max: config.poolSize ?? 10,
  });

  return {
    async query(sql: string, timeoutMs?: number): Promise<PluginQueryResult> {
      const client = await pool.connect();
      try {
        if (timeoutMs) {
          await client.query(`SET statement_timeout = ${timeoutMs}`);
        }
        const result = await client.query(sql);
        return {
          columns: result.fields.map((f) => f.name),
          rows: result.rows,
        };
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
```

Key points:
- `query()` returns `{ columns: string[], rows: Record<string, unknown>[] }`
- `close()` cleans up resources
- Lazy-load the driver with `require()` + `MODULE_NOT_FOUND` handling so it can be an optional peer dependency

## 4. Plugin Object

Wire everything together with `createPlugin()`:

```typescript
// src/index.ts
import { createPlugin } from "@useatlas/plugin-sdk";
import type { AtlasDatasourcePlugin, PluginHealthResult } from "@useatlas/plugin-sdk";
import { ConfigSchema, type PluginConfig } from "./config";
import { createConnection } from "./connection";

export function buildPlugin(config: PluginConfig): AtlasDatasourcePlugin<PluginConfig> {
  let cachedConnection: ReturnType<typeof createConnection> | undefined;

  return {
    id: "my-datasource",
    type: "datasource" as const,
    version: "1.0.0",
    name: "My DataSource",
    config,

    connection: {
      create: () => {
        if (!cachedConnection) {
          cachedConnection = createConnection(config);
        }
        return cachedConnection;
      },
      dbType: "postgres",
    },

    // Optional: semantic layer fragments
    entities: [],

    // Optional: SQL dialect tips for the agent
    dialect: "This datasource uses PostgreSQL. Use DATE_TRUNC() for date truncation.",

    async initialize(ctx) {
      ctx.logger.info("My datasource plugin initialized");
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      try {
        const conn = createConnection(config);
        await conn.query("SELECT 1", 5000);
        await conn.close();
        return { healthy: true, latencyMs: Math.round(performance.now() - start) };
      } catch (err) {
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },
  };
}

export const myPlugin = createPlugin({
  configSchema: ConfigSchema,
  create: buildPlugin,
});
```

## 5. Register

Add to `atlas.config.ts`:

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { myPlugin } from "./plugins/my-datasource/src/index";

export default defineConfig({
  plugins: [
    myPlugin({ url: process.env.MY_DB_URL! }),
  ],
});
```

## 6. Test

The ClickHouse plugin tests ([`plugins/clickhouse-datasource/__tests__/clickhouse.test.ts`](../plugins/clickhouse-datasource/__tests__/clickhouse.test.ts)) demonstrate the canonical test pattern. Key sections:

**Mock the driver** — Use `mock.module()` before any imports. Mock every named export the real module provides:

```typescript
import { mock, beforeEach } from "bun:test";

const mockQuery = mock(() => Promise.resolve({ rows: [{ count: 42 }] }));
const mockEnd = mock(() => Promise.resolve());

mock.module("pg", () => ({
  Pool: mock(() => ({
    connect: mock(() => Promise.resolve({
      query: mockQuery,
      release: mock(() => {}),
    })),
    end: mockEnd,
  })),
}));
```

**Test config validation** — Verify Zod rejects bad input:

```typescript
test("rejects empty URL", () => {
  expect(() => myPlugin({ url: "" })).toThrow(/URL must not be empty/);
});

test("rejects non-postgres URL", () => {
  expect(() => myPlugin({ url: "mysql://localhost/db" })).toThrow(/must start with postgresql/);
});
```

**Test plugin shape** — Verify required fields:

```typescript
test("returns a valid datasource plugin", () => {
  const plugin = myPlugin({ url: "postgresql://localhost/db" });
  expect(plugin.id).toBe("my-datasource");
  expect(plugin.type).toBe("datasource");
  expect(plugin.connection.dbType).toBe("postgres");
});
```

**Test connection factory** — Verify query behavior:

```typescript
test("query returns { columns, rows }", async () => {
  const conn = createConnection({ url: "postgresql://localhost/db" });
  const result = await conn.query("SELECT 1");
  expect(result.columns).toBeDefined();
  expect(result.rows).toBeDefined();
});
```

**Test health check** — Verify it returns `{ healthy }`, never throws:

```typescript
test("returns healthy when ping succeeds", async () => {
  const plugin = myPlugin({ url: "postgresql://localhost/db" });
  const result = await plugin.healthCheck!();
  expect(result.healthy).toBe(true);
});

test("returns unhealthy (not throws) when connection fails", async () => {
  mockQuery.mockImplementation(() => Promise.reject(new Error("refused")));
  const plugin = myPlugin({ url: "postgresql://localhost/db" });
  const result = await plugin.healthCheck!();
  expect(result.healthy).toBe(false);
});
```

Run tests with:

```bash
bun test plugins/my-datasource/src/index.test.ts
```

## 7. Publish

For npm packages:

```json
{
  "name": "atlas-plugin-my-datasource",
  "dependencies": {
    "@useatlas/plugin-sdk": "workspace:*"
  },
  "peerDependencies": {
    "pg": ">=8.0.0"
  },
  "peerDependenciesMeta": {
    "pg": { "optional": true }
  }
}
```

Convention: `@useatlas/plugin-sdk` as a direct dependency, database driver as an optional peer dependency. This lets users control driver versions and avoids bundling unused drivers.

## Other Plugin Types

### Context Plugin

Context plugins load knowledge into the agent. Simpler than datasource — just implement `contextProvider.load()`:

```typescript
export default definePlugin({
  id: "my-context",
  type: "context",
  version: "1.0.0",
  contextProvider: {
    async load() { return "## Extra Context\n\nDomain-specific info..."; },
    async refresh() { /* clear cache */ },
  },
});
```

The returned string is appended to the agent's system prompt. Cache the result and implement `refresh()` for invalidation. See [`yaml-context`](../plugins/yaml-context/index.ts) for a full implementation that reads YAML files.

### Interaction Plugin

Interaction plugins add communication surfaces. They may mount Hono routes (Slack, webhooks) or manage non-HTTP transports (MCP stdio):

```typescript
export default definePlugin({
  id: "my-webhook",
  type: "interaction",
  version: "1.0.0",
  routes(app) {
    app.post("/webhooks/my-service", async (c) => {
      // Handle incoming webhook
      return c.json({ ok: true });
    });
  },
});
```

The `routes` field is optional — stdio-based transports like MCP omit it. Runtime dependencies (agent executor, conversations) are currently injected via config callbacks. See [`slack-interaction`](../plugins/slack-interaction/src/index.ts) for the full pattern with OAuth and thread tracking.

### Action Plugin

Action plugins give the agent side-effects with approval controls:

```typescript
import { z } from "zod";
import { tool } from "ai";

const myAction: PluginAction = {
  name: "createTicket",
  description: "Create a support ticket",
  tool: tool({
    description: "Create a support ticket",
    parameters: z.object({ title: z.string(), body: z.string() }),
    execute: async ({ title, body }) => { /* ... */ },
  }),
  actionType: "ticket:create",
  reversible: true,
  defaultApproval: "manual",
  requiredCredentials: ["apiKey"],
};
```

Every action declares `reversible`, `defaultApproval`, and `requiredCredentials`. See [`jira-action`](../plugins/jira-action/index.ts) and [`email-action`](../plugins/email-action/index.ts).

### Sandbox Plugin

Sandbox plugins provide isolation backends for the explore tool:

```typescript
sandbox: {
  create(semanticRoot: string): PluginExploreBackend {
    return {
      async exec(command: string) {
        // Execute command in isolation, return { stdout, stderr, exitCode }
      },
      async close() { /* cleanup */ },
    };
  },
  priority: 60,  // Between nsjail (75) and sidecar (50)
},
security: {
  networkIsolation: true,
  filesystemIsolation: true,
  unprivilegedExecution: true,
  description: "My isolation mechanism...",
},
```

The `security` metadata is informational — it's the plugin's self-declaration, not enforced by the host. See [`nsjail-sandbox`](../plugins/nsjail-sandbox/index.ts) for Linux namespace isolation, [`vercel-sandbox`](../plugins/vercel-sandbox/index.ts) for Firecracker microVMs, and [`e2b-sandbox`](../plugins/e2b-sandbox/index.ts) for managed cloud VMs.

## Common Patterns

### Health Checks

Always return `{ healthy, message?, latencyMs? }`, never throw:

```typescript
async healthCheck(): Promise<PluginHealthResult> {
  try {
    const start = performance.now();
    await ping();
    return { healthy: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { healthy: false, message: err instanceof Error ? err.message : String(err) };
  }
}
```

### Error Handling

- **Throw from `initialize()`** to block server startup (fatal misconfiguration)
- **Return unhealthy from `healthCheck()`** for runtime degradation (transient errors)
- **Never throw from `healthCheck()` or `teardown()`**

### Lazy-Loading Peer Dependencies

```typescript
let Driver: typeof import("some-driver");
try {
  Driver = require("some-driver");
} catch (err) {
  const isNotFound =
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
  if (isNotFound) {
    throw new Error("Install the driver: bun add some-driver");
  }
  throw err;
}
```

### Config-Driven Credentials

Pass credentials via plugin config, not environment variables:

```typescript
// Good — explicit, type-safe
myPlugin({ apiKey: process.env.MY_API_KEY! })

// Bad — hidden dependency on env var name
// inside plugin: process.env.MY_API_KEY
```

## Troubleshooting

**"Plugin config validation failed"** — The config you passed doesn't match the Zod schema. Check required fields and types.

**"Plugin create() failed"** — The plugin builder threw. Check that all required fields (`id`, `type`, `version`, plus variant-specific fields) are present.

**"Plugin id must not be empty" / "Plugin version must not be empty"** — `definePlugin()` and `createPlugin()` validate these at creation time.

**`SyntaxError: Export named 'X' not found`** — When using `mock.module()`, you must mock every named export the real module provides. Partial mocks cause this error in other test files that share a process. See [CLAUDE.md testing rules](../CLAUDE.md) for details.

**Health check returns unhealthy but plugin works** — Health checks run on a separate schedule. Transient network issues or slow cold starts can cause initial failures. The plugin remains functional.
