# @useatlas/plugin-sdk

Type definitions and helpers for authoring Atlas plugins. Plugins extend Atlas with new datasources, context providers, interaction surfaces, actions, and sandbox backends.

## Quick Start

```typescript
import { createPlugin } from "@useatlas/plugin-sdk";
import { z } from "zod";

export const myPlugin = createPlugin({
  configSchema: z.object({ url: z.string() }),
  create: (config) => ({
    id: "my-datasource",
    type: "datasource" as const,
    version: "1.0.0",
    config,
    connection: {
      create: () => makeConnection(config.url),
      dbType: "postgres",
    },
  }),
});
```

Register in `atlas.config.ts`:

```typescript
import { defineConfig } from "@atlas/api/lib/config";
import { myPlugin } from "./my-plugin";

export default defineConfig({
  plugins: [myPlugin({ url: process.env.MY_DB_URL! })],
});
```

## Plugin Types

Atlas has five plugin types. Each extends `AtlasPluginBase` with variant-specific fields.

### Datasource (`AtlasDatasourcePlugin`)

Connect to a database. Provides a connection factory, SQL dialect hints, and optional entity definitions.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection.create()` | `() => PluginDBConnection` | Yes | Factory that returns a connection with `query()` and `close()` |
| `connection.dbType` | `PluginDBType` | Yes | Database type identifier (`postgres`, `mysql`, `clickhouse`, `snowflake`, `duckdb`, or custom) |
| `entities` | `EntityProvider` | No | Semantic layer fragments merged into the table whitelist at boot |
| `dialect` | `string` | No | SQL dialect guidance injected into the agent system prompt |

**Reference:** [`clickhouse-datasource`](../../plugins/clickhouse-datasource/index.ts)

### Context (`AtlasContextPlugin`)

Inject knowledge into the agent. Context plugins load additional system prompt fragments, semantic layer extensions, or external metadata.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contextProvider.load()` | `() => Promise<string>` | Yes | Returns context string appended to the agent system prompt |
| `contextProvider.refresh()` | `() => Promise<void>` | No | Cache invalidation hook |

**Reference:** [`yaml-context`](../../plugins/yaml-context/index.ts)

### Interaction (`AtlasInteractionPlugin`)

Add communication surfaces. Interaction plugins mount HTTP routes or manage non-HTTP transports (stdio, SSE).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `routes` | `(app: Hono) => void` | No | Mount Hono routes for webhooks, OAuth, etc. Optional for non-HTTP transports |

**Reference:** [`slack-interaction`](../../plugins/slack-interaction/src/index.ts), [`mcp-interaction`](../../plugins/mcp-interaction/src/index.ts)

### Action (`AtlasActionPlugin`)

Enable agent side-effects. Action plugins provide AI SDK tools with approval controls.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `actions` | `PluginAction[]` | Yes | Array of action definitions |
| `actions[].name` | `string` | Yes | Tool name |
| `actions[].tool` | `ToolSet[string]` | Yes | AI SDK tool definition |
| `actions[].actionType` | `string` | Yes | Category identifier (e.g. `jira:create`) |
| `actions[].reversible` | `boolean` | Yes | Whether the action can be undone |
| `actions[].defaultApproval` | `ActionApprovalMode` | Yes | `auto`, `manual`, or `admin-only` |
| `actions[].requiredCredentials` | `string[]` | Yes | Config fields needed at runtime |

**Reference:** [`jira-action`](../../plugins/jira-action/index.ts), [`email-action`](../../plugins/email-action/index.ts)

### Sandbox (`AtlasSandboxPlugin`)

Provide code isolation for the explore tool. Sandbox plugins create backends that execute shell commands in an isolated environment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox.create(semanticRoot)` | `(string) => PluginExploreBackend` | Yes | Factory that creates an explore backend |
| `sandbox.priority` | `number` | No | Higher = tried first. Built-in: Vercel=100, E2B=90, Daytona=85, nsjail=75, sidecar=50, just-bash=0. Plugin default: 60 |
| `security` | `object` | No | Informational metadata about isolation guarantees |

**Reference:** [`nsjail-sandbox`](../../plugins/nsjail-sandbox/index.ts), [`vercel-sandbox`](../../plugins/vercel-sandbox/index.ts)

## Base Fields

All plugins share these fields from `AtlasPluginBase`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier (e.g. `clickhouse-datasource`) |
| `type` | `PluginType` | Yes | One of `datasource`, `context`, `interaction`, `action`, `sandbox` |
| `version` | `string` | Yes | SemVer version |
| `name` | `string` | No | Human-readable display name |
| `config` | `TConfig` | No | Plugin-specific configuration |
| `initialize(ctx)` | `(AtlasPluginContext) => Promise<void>` | No | Called once at server boot. Throw to block startup |
| `healthCheck()` | `() => Promise<PluginHealthResult>` | No | Periodic health probe |
| `teardown()` | `() => Promise<void>` | No | Graceful shutdown (LIFO order) |
| `hooks` | `PluginHooks` | No | Agent lifecycle and HTTP hooks |
| `schema` | `Record<string, PluginTableDefinition>` | No | Declarative table definitions for the internal DB |

## Lifecycle

```
register → initialize(ctx) → healthCheck() → ... → teardown()
```

1. **Register** — Plugins are listed in the `plugins` array in `atlas.config.ts`. Config is validated at factory call time (before server starts).
2. **Initialize** — Called once at server boot with `AtlasPluginContext`. Throw to signal fatal initialization failure. Context provides:
   - `ctx.db` — Internal Postgres (auth/audit DB). Null when `DATABASE_URL` is not set.
   - `ctx.connections` — Connection registry for analytics datasources.
   - `ctx.tools` — Tool registry for adding agent tools.
   - `ctx.logger` — Pino-compatible child logger scoped to the plugin.
   - `ctx.config` — Resolved Atlas configuration.
3. **Health check** — Periodic probe. Return `{ healthy: false, message }` to signal degradation. Never throw.
4. **Teardown** — Graceful shutdown in reverse registration order (LIFO).

> **v1.1 note:** `AtlasPluginContext` will gain `executeQuery`, `conversations`, and `actions` fields for full host-level decoupling. Currently, interaction plugins that need these inject them via config callbacks.

## Config Validation

Use `createPlugin()` with a Zod schema for typed, validated configuration:

```typescript
import { createPlugin } from "@useatlas/plugin-sdk";
import { z } from "zod";

const configSchema = z.object({
  url: z.string().url(),
  poolSize: z.number().int().positive().optional(),
});

export const myPlugin = createPlugin({
  configSchema,
  create: (config) => ({
    id: "my-datasource",
    type: "datasource" as const,
    version: "1.0.0",
    config,
    connection: { create: () => connect(config.url), dbType: "postgres" },
  }),
});
```

The factory validates config at call time — invalid config fails fast during startup, not at first use. The `configSchema` accepts any object with a `parse(input)` method (Zod schemas satisfy this).

For simple plugins without config validation, use `definePlugin()`:

```typescript
import { definePlugin } from "@useatlas/plugin-sdk";

export default definePlugin({
  id: "my-context",
  type: "context",
  version: "1.0.0",
  contextProvider: { async load() { return "Extra context..."; } },
});
```

## Hooks

Hooks use a matcher + handler pattern inspired by Better Auth. Matchers are optional — omit to always fire.

```typescript
hooks: {
  beforeQuery: [{
    matcher: (ctx) => ctx.connectionId === "warehouse",
    handler: (ctx) => {
      // Return { sql } to rewrite, throw to reject, return void to pass through
      return { sql: ctx.sql.replace(/SELECT \*/, "SELECT id, name") };
    },
  }],
  afterQuery: [{
    handler: (ctx) => {
      console.log(`Query took ${ctx.durationMs}ms, returned ${ctx.result.rows.length} rows`);
    },
  }],
}
```

| Hook | Context | Mutation | Description |
|------|---------|----------|-------------|
| `beforeQuery` | `{ sql, connectionId? }` | `{ sql }` | Fires before SQL execution. Return to rewrite, throw to reject |
| `afterQuery` | `{ sql, connectionId?, result, durationMs }` | — | Fires after SQL execution |
| `beforeExplore` | `{ command }` | `{ command }` | Fires before explore command. Return to rewrite, throw to reject |
| `afterExplore` | `{ command, output }` | — | Fires after explore command |
| `onRequest` | `{ path, method, headers }` | — | HTTP-level: fires before routing |
| `onResponse` | `{ path, method, status }` | — | HTTP-level: fires after response |

## Schema Migrations

Plugins declare internal database tables via the `schema` property:

```typescript
schema: {
  slack_installations: {
    fields: {
      team_id: { type: "string", required: true, unique: true },
      bot_token: { type: "string", required: true },
      installed_at: { type: "date" },
    },
  },
},
```

Run migrations with the CLI:

```bash
atlas migrate          # Preview migration SQL
atlas migrate --apply  # Apply to internal DB
```

Tables are prefixed with the plugin ID to avoid collisions.

## `$InferServerPlugin`

Extract plugin types on the client side without importing server code:

```typescript
import type { $InferServerPlugin } from "@useatlas/plugin-sdk";
import type { clickhousePlugin } from "@atlas/plugin-clickhouse-datasource";

type CH = $InferServerPlugin<typeof clickhousePlugin>;
// CH["Config"]   → { url: string; database?: string }
// CH["Type"]     → "datasource"
// CH["DbType"]   → "clickhouse"
// CH["Actions"]  → never (not an action plugin)
// CH["Security"] → never (not a sandbox plugin)
```

Works with both `createPlugin()` factory functions and `definePlugin()` direct objects.

Available inferred fields: `Config`, `Type`, `Id`, `Name`, `Version`, `DbType` (datasource only), `Actions` (action only), `Security` (sandbox only).

## CLI

```bash
atlas plugin list                              # List installed plugins from atlas.config.ts
atlas plugin create <name> --type <type>       # Scaffold a new plugin (datasource|context|interaction|action|sandbox)
atlas plugin add <package-name>                # Install a plugin package via bun
```

`atlas plugin create` generates a `plugins/<name>/` directory with `src/index.ts`, `src/index.test.ts`, `package.json`, and `tsconfig.json`.

## Type Guards

```typescript
import {
  isDatasourcePlugin,
  isContextPlugin,
  isInteractionPlugin,
  isActionPlugin,
  isSandboxPlugin,
} from "@useatlas/plugin-sdk";

if (isDatasourcePlugin(plugin)) {
  // plugin is AtlasDatasourcePlugin — connection, entities, dialect available
}
```

## Reference Implementations

> **Note:** These are internal workspace packages (`@atlas/plugin-*`) within the monorepo, not published to npm. Use them as reference when authoring your own plugins.

| Plugin | Type | Package | Description |
|--------|------|---------|-------------|
| [clickhouse-datasource](../../plugins/clickhouse-datasource/) | Datasource | `@atlas/plugin-clickhouse-datasource` | ClickHouse HTTP transport adapter |
| [mysql-datasource](../../plugins/mysql-datasource/) | Datasource | `@atlas/plugin-mysql-datasource` | MySQL pool-based adapter |
| [snowflake-datasource](../../plugins/snowflake-datasource/) | Datasource | `@atlas/plugin-snowflake-datasource` | Snowflake callback-based adapter |
| [duckdb-datasource](../../plugins/duckdb-datasource/) | Datasource | `@atlas/plugin-duckdb-datasource` | DuckDB in-process adapter |
| [yaml-context](../../plugins/yaml-context/) | Context | `@atlas/plugin-yaml-context` | YAML semantic layer context provider |
| [mcp-interaction](../../plugins/mcp-interaction/) | Interaction | `@atlas/plugin-mcp-interaction` | MCP server lifecycle (stdio + SSE) |
| [slack-interaction](../../plugins/slack-interaction/) | Interaction | `@atlas/plugin-slack-interaction` | Slack bot (slash commands, threads, OAuth) |
| [jira-action](../../plugins/jira-action/) | Action | `@atlas/plugin-jira-action` | Create JIRA tickets from analysis |
| [email-action](../../plugins/email-action/) | Action | `@atlas/plugin-email-action` | Send email reports via Resend |
| [nsjail-sandbox](../../plugins/nsjail-sandbox/) | Sandbox | `@atlas/plugin-nsjail-sandbox` | Linux namespace isolation via nsjail |
| [sidecar-sandbox](../../plugins/sidecar-sandbox/) | Sandbox | `@atlas/plugin-sidecar-sandbox` | HTTP-isolated container sidecar |
| [vercel-sandbox](../../plugins/vercel-sandbox/) | Sandbox | `@atlas/plugin-vercel-sandbox` | Firecracker microVM via @vercel/sandbox |
| [daytona-sandbox](../../plugins/daytona-sandbox/) | Sandbox | `@atlas/plugin-daytona-sandbox` | Daytona managed cloud sandbox |
| [e2b-sandbox](../../plugins/e2b-sandbox/) | Sandbox | `@atlas/plugin-e2b-sandbox` | E2B Firecracker microVM (managed) |

## Source

The definitive type definitions are in [`src/types.ts`](./src/types.ts). Factory functions and type guards are in [`src/helpers.ts`](./src/helpers.ts).
