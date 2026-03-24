# Future Work — Architectural Review

Items identified during project review. Organized by area. Each is a potential issue to file when ready.

---

## Semantic Layer

### Semantic layer needs a management UI

**Priority:** High — this is the moat

`atlas init` generates YAMLs, `atlas diff` checks for drift. That's the entire management story. For a product whose value proposition is "the agent reads the semantic layer before writing SQL," the tooling around the semantic layer is surprisingly thin.

**What's missing:**
- Web UI to browse entities, edit descriptions, see relationships
- Validation preview — "what will the agent see for this question?"
- Version history / diff view for entity changes
- Collaborative editing (multiple team members managing the layer)

The YAML-on-disk format is great for `git diff` and version control. But someone managing 62 entities (cybersec demo scale) needs more than a text editor. The semantic layer is what makes Atlas better than raw ChatGPT-with-SQL — invest here.

### Pre-index semantic layer instead of runtime exploration

**Priority:** High — token efficiency + consistency

Every conversation starts with the agent calling `explore` to `ls` and `cat` semantic YAML files. On a 62-entity deployment, that's multiple tool calls just to orient — burning tokens and steps on the same static files every time.

**Proposed approach:**
- Build a compressed semantic index at boot (or on `atlas init`)
- Inject the relevant subset into the system prompt based on the user's question (embedding similarity or keyword match)
- Reserve `explore` for edge cases where the agent needs deeper detail
- Expected savings: 3-5 tool calls per conversation, more consistent results

---

## Plugin SDK

### ~~Hooks should support mutation, not just observation~~ — Shipped ([#176](https://github.com/AtlasDevHQ/atlas/pull/176))

Hooks now support mutation. `beforeQuery` can return `{ sql: string }` to rewrite or throw to reject. `beforeExplore` can return `{ command: string }`. Handlers returning `void` behave as before (backward compatible).

### ~~Plugins need typed configuration (factory pattern)~~ — Shipped ([#177](https://github.com/AtlasDevHQ/atlas/pull/177))

`definePlugin` now accepts a Zod config schema via `configSchema` field. Plugin factories validate config at boot. `atlas.config.ts` uses: `plugins: [bigqueryPlugin({ projectId: "x", dataset: "y" })]`.

### Replace `unknown` escape hatches with optional peer dep types

**Priority:** Medium — DX improvement

`tool: unknown`, `routes: (app: unknown) => void`, `PluginAction.tool: unknown` — these avoid hard deps on `ai` and `hono` but give plugin authors zero type safety on the most important parts.

**Proposed change:**
- Ship thin type re-exports: `@useatlas/plugin-sdk/ai`, `@useatlas/plugin-sdk/hono`
- Optional peer dependencies — plugin authors who want types import them
- Zero runtime cost (type-only imports)

### ~~Datasource plugins should ship semantic layer fragments~~ — Shipped ([#178](https://github.com/AtlasDevHQ/atlas/pull/178))

Datasource connections now support optional `entities` (bundled entity YAMLs or factory function) and `dialectHints` (string injected into agent prompt, e.g. "use SAFE_DIVIDE, not /") fields.

### ~~Validate plugin shapes in config loader~~ — Shipped ([#168](https://github.com/AtlasDevHQ/atlas/issues/168))

Plugin config validation now checks `id`, `type`, `version` presence during config loading. `bun run dev` fails fast with clear messages for malformed plugins.

### Support non-SQL datasources (Salesforce as litmus test)

**Priority:** Medium — determines plugin ecosystem scope

`PluginDBConnection.query(sql)` assumes SQL. Salesforce speaks SOQL. The `validateSQL` pipeline would reject every Salesforce query. The plugin SDK has no hook for custom query validation.

**The design question:** Does the plugin system support non-SQL data sources?

**Proposed change:**
- Add optional `validate?(query: string): { valid: boolean; reason?: string }` on connection config
- When present, replaces `validateSQL` for that connection
- When absent, standard SQL validation applies
- Extract Salesforce into `@atlas/plugin-salesforce` to validate the approach

---

## Project Structure

### ~~Consolidate monorepo packages~~ ✓

Done in PR #209. Consolidated from 8 → 6 packages: `@atlas/shared` collapsed into `@atlas/api`, `@atlas/ui` absorbed into `@atlas/web`, TanStack Start deleted.

### ~~Pick one frontend framework~~ ✓

Done in PR #209. Next.js won — TanStack Start removed, `@atlas/ui` absorbed into `@atlas/web`.

### ~~Narrow deployment surface~~ ✓

Done in PR #211. Consolidated from 3 → 2 example directories: deleted `examples/api-only/` (subset of Docker example), renamed `examples/docker-hono/` → `examples/docker/`.

Four sandbox tiers remain (Vercel/Firecracker, nsjail, sidecar, just-bash) — these serve genuinely different deployment contexts.

### Simplify auth modes

**Priority:** Low — reduce early complexity

Four auth modes (none, API key, Better Auth, BYOT/JWT) before there's a large user base. Each with its own middleware path, test file, and configuration. Detection logic infers mode from env vars.

**Proposed approach:**
- Ship API key auth as the default
- Add managed auth when users need login flows
- Add BYOT when enterprise customers ask
- Could be a phased rollout rather than removing existing code
