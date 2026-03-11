# Contributing to Atlas

Thanks for your interest in contributing to Atlas! This guide covers everything
you need to get started.

## Prerequisites

- **[bun](https://bun.sh/)** >= 1.3.10 — package manager and runtime
- **[Docker](https://www.docker.com/)** — for the local Postgres database and sandbox sidecar

## Dev Setup

```bash
git clone https://github.com/AtlasDevHQ/atlas.git
cd atlas
bun install
bun run db:up          # Start Postgres + sandbox sidecar
cp .env.example .env   # Set your LLM provider key
bun run atlas -- init  # Profile the database and generate semantic layer
bun run dev            # Start API (:3001) + web (:3000)
```

Default dev credentials: **admin@atlas.dev / atlas-dev**

## Project Structure

```
atlas/
├── packages/
│   ├── api/              # Hono API server, backend logic, shared types
│   ├── web/              # Next.js frontend + chat UI components
│   ├── cli/              # atlas CLI (profiler, schema diff, enrichment)
│   ├── mcp/              # MCP server (Model Context Protocol)
│   ├── sdk/              # TypeScript SDK for the Atlas API
│   ├── plugin-sdk/       # Type definitions & helpers for authoring plugins
│   └── sandbox-sidecar/  # Isolated explore sidecar (Railway)
├── apps/
│   └── www/              # Landing page (useatlas.dev)
├── plugins/              # Atlas plugins (datasource, context, interaction, action, sandbox)
├── examples/             # Deploy templates (Docker, Next.js standalone)
├── semantic/             # Semantic layer (YAML entity/metric files)
├── docs/                 # Guides (docs/guides/) and design ADRs (docs/design/)
└── create-atlas/         # Scaffolding CLI (bun create atlas-agent)
```

Cross-package imports use `@atlas/api/*`. The web package uses `@/*` for
internal paths. See [CLAUDE.md](./CLAUDE.md) for the full architecture reference.

## Code Conventions

- **bun only** — never npm, yarn, or node
- **TypeScript strict mode** — monorepo path aliases: `@atlas/api/*` for
  cross-package, `@/*` within web
- **Tailwind CSS 4** — via `@tailwindcss/postcss`
- **shadcn/ui v2** — always use shadcn/ui primitives for UI elements. Add new
  components with `npx shadcn@latest add <component>` from `packages/web/`
- **nuqs for URL state** — use [nuqs](https://nuqs.47ng.com/) for any state
  that belongs in the URL (pagination, filters, view modes). Transient UI state
  stays as `useState`
- **React Compiler handles memoization** — do not add `useMemo`, `useCallback`,
  or `React.memo` for performance. The compiler auto-memoizes
- **Immutable array operations** — use `toSorted()`, `toReversed()`,
  `toSpliced()` instead of `.sort()`, `.reverse()`, `.splice()`
- **No async waterfalls** — use `Promise.all([a(), b()])` for independent
  awaits, not sequential `await a(); await b();`
- **Dynamic imports** — use `next/dynamic` for Monaco, Recharts, syntax
  highlighters, and other large client-only libraries
- **Flat ESLint config** — use `eslint.config.mjs`, not `.eslintrc`
- **Frontend is a pure HTTP client** — `@atlas/web` imports `@atlas/api` for
  types only; all data flows over HTTP
- **Server external packages** — native/worker-thread packages (`pg`, `mysql2`,
  etc.) must be listed in `serverExternalPackages` in `next.config.ts`

## Testing

```bash
bun run test              # Run all tests (isolated per-file runner)
bun test path/to/file.ts  # Run a single test file
```

**Never run bare `bun test`** against a directory. Bun's `mock.module()` is
process-global and irreversible — running all files in one process causes mock
contamination. The project uses an isolated test runner that spawns each file in
its own subprocess.

When using `mock.module()`, mock **every** named export the real module
provides. Partial mocks cause `SyntaxError: Export named 'X' not found` in other
test files.

## PR Process

### Branch naming

Use the format `type/short-description`:

- `feat/add-chart-export`
- `fix/sql-validation-edge-case`
- `docs/update-deploy-guide`
- `refactor/extract-auth-middleware`

### Commits

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add chart export to PDF
fix: handle NULL values in SQL validation
docs: update deploy guide for Railway
refactor: extract auth middleware from routes
```

### PR checklist

- Types pass (`bun run type`)
- Tests pass (`bun run test`)
- Lint passes (`bun run lint`)
- Labels added (type label + area label)
- CHANGELOG.md updated (if user-facing change)

## Semantic Layer

The semantic layer lives in `semantic/` as YAML files. Entity files define
tables, columns, types, joins, and query patterns.

```bash
bun run atlas -- init              # Profile DB and generate semantic layer
bun run atlas -- init --enrich     # Profile + LLM enrichment
bun run atlas -- diff              # Compare DB schema against semantic layer
```

See [CLAUDE.md § Adding to the Semantic Layer](./CLAUDE.md) for the YAML format.

## Plugin Development

Atlas supports five plugin types: **datasource**, **context**, **interaction**,
**action**, and **sandbox**. Plugins are factory functions returning typed objects using
`definePlugin()` from `@useatlas/plugin-sdk`.

Reference implementations live in `plugins/`. For authoring guidance, see
the [Plugin Authoring Guide](https://docs.useatlas.dev/docs/plugins/authoring-guide).
