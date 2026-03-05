# Plugin Architecture Design

> Design doc for Atlas's plugin system and admin console strategy. Informed by Better Auth's plugin infrastructure.

## Status

**v1.0 Plugin SDK complete** ([#45](https://github.com/AtlasDevHQ/atlas/issues/45)). All planned items shipped:
- [x] `@useatlas/plugin-sdk` package with five interfaces ([#153](https://github.com/AtlasDevHQ/atlas/pull/153))
- [x] Plugin lifecycle + `definePlugin()` factory ([#153](https://github.com/AtlasDevHQ/atlas/pull/153))
- [x] Runtime wiring — tools, hooks, context ([#158](https://github.com/AtlasDevHQ/atlas/pull/158))
- [x] Mutation hooks — `beforeQuery` can rewrite/reject ([#176](https://github.com/AtlasDevHQ/atlas/pull/176))
- [x] Typed plugin config — Zod schema validation at boot ([#177](https://github.com/AtlasDevHQ/atlas/pull/177))
- [x] Semantic layer fragments + dialect hints ([#178](https://github.com/AtlasDevHQ/atlas/pull/178))
- [x] Config loader validation ([#168](https://github.com/AtlasDevHQ/atlas/issues/168))
- [x] `$InferServerPlugin` pattern for client-side type inference ([#193](https://github.com/AtlasDevHQ/atlas/issues/193))
- [x] Schema-driven migrations — `atlas migrate` CLI command
- [x] CLI commands — `atlas plugin list`, `atlas plugin create`, `atlas plugin add`
- [x] Sandbox plugin type (5th interface) — pluggable explore backends ([#192](https://github.com/AtlasDevHQ/atlas/issues/192))
- [x] SSE transport for MCP interaction plugin ([#194](https://github.com/AtlasDevHQ/atlas/issues/194))
- [x] 14 reference implementations across all 5 plugin types
- [x] SDK documentation — README, authoring guide, plugin READMEs

## Decision

**Code-first plugin system, admin console later.** Build the four plugin interfaces during v0.7-v0.9 (as internal implementations), formalize into a Plugin SDK at v1.0, then add an optional admin console at v1.1+.

## Three Distinct Surfaces

Atlas has three user-facing concerns that should not be conflated:

| Surface | Who uses it | What it does | Where it lives |
|---------|------------|--------------|----------------|
| **Query UI** | End users (analysts, PMs) | Ask questions, see results, charts | `examples/` templates, `create-atlas` output |
| **Admin console** | Atlas operators (eng leads, data team) | Configure datasources, manage semantic layer, set up Slack/Teams, define action permissions, manage users/roles | `apps/console` (v1.1+) |
| **Code config** | Developers deploying Atlas | `atlas.config.ts`, `atlas` CLI, Plugin SDK | `packages/api`, `packages/cli` |

`packages/web` remains the Next.js query UI reference. It is **not** the admin console.

## Plugin Model (inspired by Better Auth)

### Core Pattern

Better Auth's architecture: plugin = function returning a typed config object, registered via a plugin array in the main config. Server plugins define endpoints + schema + hooks. Client plugins infer types from server plugins via `$InferServerPlugin`. This pattern maps directly to Atlas.

### Atlas Plugin Interface

> The pseudocode below reflects the original design intent. For the definitive shipped interfaces, see [`packages/plugin-sdk/src/types.ts`](../packages/plugin-sdk/src/types.ts).

```typescript
// Core plugin type — all plugins share this base
interface AtlasPluginBase<TConfig = undefined> {
  id: string;
  type: "datasource" | "context" | "interaction" | "action" | "sandbox";
  version: string;
  name?: string;
  config?: TConfig;

  initialize?(ctx: AtlasPluginContext): Promise<void>;
  healthCheck?(): Promise<PluginHealthResult>;
  teardown?(): Promise<void>;

  schema?: Record<string, PluginTableDefinition>;
  hooks?: PluginHooks;  // beforeQuery, afterQuery, beforeExplore, afterExplore, onRequest, onResponse
}
```

### Five Plugin Types

```typescript
// Stores of Data — things Atlas can query
interface AtlasDatasourcePlugin<TConfig> extends AtlasPluginBase<TConfig> {
  type: "datasource";
  connection: { create(): PluginDBConnection; dbType: PluginDBType };
  entities?: EntityProvider;
  dialect?: string;
}

// Stores of Context — what the agent knows
interface AtlasContextPlugin<TConfig> extends AtlasPluginBase<TConfig> {
  type: "context";
  contextProvider: { load(): Promise<string>; refresh?(): Promise<void> };
}

// Systems of Interaction — how users reach Atlas
interface AtlasInteractionPlugin<TConfig> extends AtlasPluginBase<TConfig> {
  type: "interaction";
  routes?: (app: Hono) => void;  // Optional — MCP stdio doesn't need routes
}

// Systems of Action — things Atlas can do (write-back)
interface AtlasActionPlugin<TConfig> extends AtlasPluginBase<TConfig> {
  type: "action";
  actions: PluginAction[];  // { name, tool, actionType, reversible, defaultApproval, requiredCredentials }
}

// Sandboxed Explore — pluggable isolation for the explore tool
interface AtlasSandboxPlugin<TConfig> extends AtlasPluginBase<TConfig> {
  type: "sandbox";
  sandbox: { create(semanticRoot: string): PluginExploreBackend; priority?: number };
  security?: { networkIsolation?: boolean; filesystemIsolation?: boolean; unprivilegedExecution?: boolean; description?: string };
}
```

### Configuration

```typescript
// atlas.config.ts
import { defineConfig } from "@atlas/api/lib/config";
import { snowflakePlugin } from "@atlas/plugin-snowflake";
import { slackPlugin } from "@atlas/plugin-slack";
import { chartsPlugin } from "@atlas/plugin-charts";

export default defineConfig({
  plugins: [
    snowflakePlugin({ account: "xyz", warehouse: "COMPUTE_WH" }),
    slackPlugin({ botToken: process.env.SLACK_BOT_TOKEN! }),
    chartsPlugin(),
  ],
});
```

When no plugins are specified, Atlas works exactly as today (env-var-based single datasource, built-in tools, no actions).

### Server + Client Plugin Pairs

Following Better Auth's `$InferServerPlugin` pattern:

```typescript
// Server plugin (packages/api or standalone package)
export const snowflakePlugin = (config: SnowflakeConfig) => {
  return {
    id: "snowflake",
    type: "datasource" as const,
    endpoints: {
      testConnection: createPluginEndpoint("/snowflake/test", ...),
      getSyncStatus: createPluginEndpoint("/snowflake/status", ...),
    },
    schema: {
      snowflake_connections: {
        fields: {
          account: { type: "string", required: true },
          warehouse: { type: "string", required: true },
          lastSync: { type: "date" },
        },
      },
    },
    connection: {
      create: () => new SnowflakeConnection(config),
      profiler: snowflakeProfiler,
    },
  } satisfies AtlasDataSourcePlugin;
};

// Client plugin (for admin console — infers server types)
export const snowflakeClientPlugin = () => ({
  id: "snowflake",
  $InferServerPlugin: {} as ReturnType<typeof snowflakePlugin>,
  // Optional: custom admin panel component
  adminPanel: SnowflakeSettingsPanel,
}) satisfies AtlasClientPlugin;
```

### Schema-Driven Migrations

Plugins declare their DB schema needs. Atlas CLI handles migrations:

```bash
atlas migrate          # Generate migrations from plugin schemas
atlas migrate --apply  # Apply pending migrations to internal DB
```

This follows Better Auth's pattern — plugins never run raw SQL to create their tables. The framework owns migration orchestration.

## Implementation Timeline

### v0.7-v0.9: Build Interfaces Internally

Each feature in v0.7-v0.9 is built **as if it were a plugin**, but isn't externalized yet:

| Version | Feature | Internal pattern |
|---------|---------|-----------------|
| v0.7 | Snowflake adapter | Follows `AtlasDataSourcePlugin.connection` shape |
| v0.7 | CSV/Parquet ingest | Follows `AtlasDataSourcePlugin.connection` shape (DuckDB) |
| v0.8 | Slack bot | Follows `AtlasInteractionPlugin.routes` shape |
| v0.8 | API/SDK | Follows `AtlasInteractionPlugin.endpoints` shape |
| v0.9 | Slack notify action | Follows `AtlasActionPlugin.tools` shape |
| v0.9 | JIRA ticket action | Follows `AtlasActionPlugin.tools` shape |

This proves the interfaces with real features before committing to a public API.

### v1.0: Plugin SDK ✅

All shipped:
- `@useatlas/plugin-sdk` package with five interfaces (datasource, context, interaction, action, sandbox)
- `createPlugin()` + `definePlugin()` factories with Zod config validation
- `$InferServerPlugin` for client-side type inference
- Plugin lifecycle: `register` → `initialize(ctx)` → `healthCheck()` → `teardown()`
- CLI: `atlas plugin list`, `atlas plugin create`, `atlas plugin add`
- Mutation hooks: `beforeQuery` and `beforeExplore` can rewrite or reject
- Schema-driven migrations: `atlas migrate` / `atlas migrate --apply`
- 14 reference implementations across all 5 plugin types
- [SDK README](../packages/plugin-sdk/README.md) and [authoring guide](./plugin-authoring-guide.md)

### v1.1+: Admin Console

- `apps/console` — separate Next.js app (or embedded in query UI as admin routes)
- Discovers installed plugins from `atlas.config.ts`
- Renders each plugin's admin panel (if provided)
- Plugin endpoints handle the actual CRUD
- Better Auth `organization()` plugin for role-based access (viewer, analyst, admin)

The admin console is almost trivial once the plugin system exists:
1. Read plugin registry
2. For each plugin, call its admin endpoints and render its UI component
3. Plugin owns its own settings/config — console is just the shell

## Design Principles

1. **Code-first, UI-second** — Every plugin capability must work via `atlas.config.ts` and CLI before getting an admin UI. The admin console is a convenience layer, not a requirement.

2. **Plugins are functions** — Factory function pattern (like Better Auth). Plugins take typed config options and return a typed object. No class hierarchies, no abstract base classes.

3. **Type inference over codegen** — `$InferServerPlugin` pattern means client plugins get type-safe access to server endpoints without OpenAPI specs or code generation.

4. **Schema is declarative** — Plugins declare what they need, the framework handles migrations. No plugin should ever run raw DDL.

5. **Everything is a plugin** — Even built-in features (explore tool, SQL execution, report generation) should follow the plugin interface internally. This ensures the SDK is battle-tested before external developers use it.

6. **Backward compatible** — Env-var-based single-datasource deployments work forever. The plugin system is additive.

## Reference

- [Plugin SDK README](../packages/plugin-sdk/README.md) — comprehensive SDK reference
- [Plugin authoring guide](./plugin-authoring-guide.md) — step-by-step tutorial
- [Plugin type definitions](../packages/plugin-sdk/src/types.ts) — definitive TypeScript interfaces
- [Reference plugins](../plugins/) — 14 implementations across all 5 types
- Better Auth plugin docs: https://www.better-auth.com/docs/concepts/plugins
- Config system: `packages/api/src/lib/config.ts`
- Tool registry: `packages/api/src/lib/tools/registry.ts`
- Connection registry: `packages/api/src/lib/db/connection.ts`
