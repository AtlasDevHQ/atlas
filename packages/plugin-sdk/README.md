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
    types: ["datasource"] as const,
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

**Reference:** [`clickhouse`](../../plugins/clickhouse/index.ts)

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

**Reference:** [`slack`](../../plugins/slack/src/index.ts), [`mcp`](../../plugins/mcp/src/index.ts)

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

**Reference:** [`jira`](../../plugins/jira/index.ts), [`email`](../../plugins/email/index.ts)

### Sandbox (`AtlasSandboxPlugin`)

Provide code isolation for the explore tool. Sandbox plugins create backends that execute shell commands in an isolated environment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox.create(semanticRoot)` | `(string) => PluginExploreBackend` | Yes | Factory that creates an explore backend |
| `sandbox.priority` | `number` | No | Higher = tried first. Built-in: Vercel=100, E2B=90, Daytona=85, nsjail=75, sidecar=50, just-bash=0. Plugin default: 60 |
| `security` | `object` | No | Informational metadata about isolation guarantees |

**Reference:** [`nsjail`](../../plugins/nsjail/index.ts), [`vercel-sandbox`](../../plugins/vercel-sandbox/index.ts)

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
3. **Health check** — Periodic probe. Return `{ healthy: false, message }` to signal degradation. Never throw. Results surface in the `plugins` component of `GET /api/v1/health` — a failing probe shifts the top-level status to `degraded` (HTTP 200, never 503).
4. **Teardown** — Graceful shutdown in reverse registration order (LIFO). Use `teardown()` to release state Atlas can't see — external webhook subscriptions, third-party connections, drained queues. **Note:** `teardown()` runs on server shutdown, *not* on a per-workspace uninstall (uninstall is a DB-row removal, not a process event).

> **v1.1 note:** `AtlasPluginContext` will gain `executeQuery`, `conversations`, and `actions` fields for full host-level decoupling. Currently, interaction plugins that need these inject them via config callbacks.

## Uninstall Contract

`DELETE /api/v1/admin/marketplace/:id` removes a plugin from a workspace. The cleanup contract:

| State | Survives uninstall? | Notes |
|-------|---------------------|-------|
| `workspace_plugins` row | No (deleted) | Canonical "is this plugin installed?" record. |
| `scheduled_tasks` rows tagged with the plugin's `catalog_id` | No (deleted) | Scoped by `(plugin_id, org_id)` so cleanup never crosses workspaces. `scheduled_task_runs` cascade via FK. |
| `plugin_<pluginId>_*` tables (declared via `schema`) | **Yes** (retained) | Reinstall picks up where it left off — cached digest history, sync cursors, etc. Hard-reset only via workspace purge. |
| In-process hook registrations | Dropped at server shutdown via `teardown()` | Not persisted. |
| Webhook subscriptions registered with external platforms | **Yes** (unless your `teardown()` removes them) | Atlas has no visibility into external state. |

If your plugin creates `scheduled_tasks` rows, set `plugin_id = $catalogId` and `org_id = $orgId` on insert so the uninstall cleanup picks them up. Untagged tasks (`plugin_id IS NULL`) are treated as user-created and survive uninstall. See the [authoring guide](https://docs.useatlas.dev/plugins/authoring-guide#uninstall-contract) for the full lifecycle.

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
    types: ["datasource"] as const,
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
  types: ["context"],
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
import type { clickhousePlugin } from "@useatlas/clickhouse";

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

> **Note:** These are workspace packages (`@useatlas/*`) within the monorepo. Use them as reference when authoring your own plugins.

| Plugin | Type | Package | Description |
|--------|------|---------|-------------|
| [clickhouse](../../plugins/clickhouse/) | Datasource | `@useatlas/clickhouse` | ClickHouse HTTP transport adapter |
| [mysql](../../plugins/mysql/) | Datasource | `@useatlas/mysql` | MySQL pool-based adapter |
| [snowflake](../../plugins/snowflake/) | Datasource | `@useatlas/snowflake` | Snowflake callback-based adapter |
| [duckdb](../../plugins/duckdb/) | Datasource | `@useatlas/duckdb` | DuckDB in-process adapter |
| [yaml-context](../../plugins/yaml-context/) | Context | `@useatlas/yaml-context` | YAML semantic layer context provider |
| [mcp](../../plugins/mcp/) | Interaction | `@useatlas/mcp` | MCP server lifecycle (stdio + SSE) |
| [slack](../../plugins/slack/) | Interaction | `@useatlas/slack` | Slack bot (slash commands, threads, OAuth) |
| [jira](../../plugins/jira/) | Action | `@useatlas/jira` | Create JIRA tickets from analysis |
| [email](../../plugins/email/) | Action | `@useatlas/email` | Send email reports via Resend |
| [nsjail](../../plugins/nsjail/) | Sandbox | `@useatlas/nsjail` | Linux namespace isolation via nsjail |
| [sidecar](../../plugins/sidecar/) | Sandbox | `@useatlas/sidecar` | HTTP-isolated container sidecar |
| [vercel-sandbox](../../plugins/vercel-sandbox/) | Sandbox | `@useatlas/vercel-sandbox` | Firecracker microVM via @vercel/sandbox |
| [daytona](../../plugins/daytona/) | Sandbox | `@useatlas/daytona` | Daytona managed cloud sandbox |
| [e2b](../../plugins/e2b/) | Sandbox | `@useatlas/e2b` | E2B Firecracker microVM (managed) |

## Source

The definitive type definitions are in [`src/types.ts`](./src/types.ts). Factory functions and type guards are in [`src/helpers.ts`](./src/helpers.ts).
