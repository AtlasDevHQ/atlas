# Testing

Long-form reference for the Testing rules summarized in [CLAUDE.md](../../CLAUDE.md) § *Testing* and the Effect test-layer rule in § *Effect.ts*. The terse rules there are the checklist; this doc holds the rationale and the gotchas.

## `bun run test`, never bare `bun test`

The project uses an isolated test runner — each file runs in its own subprocess. Always use `bun run test` (or `test:api` / `test:others` / `test-isolated.ts --affected`). A single file is fine: `bun test path/to/file.test.ts`. **Never** run bare `bun test` against a directory.

The custom `scripts/test-isolated.ts` subprocess-per-file runner is still in use until slice 6 (#2802) lands, because `bun test --parallel` reuses workers across files, so OS-level state (env, cwd, file handles, signal listeners) leaks between files.

## Fast local feedback loop

```bash
cd packages/api && bun run scripts/test-isolated.ts --affected     # only tests whose source graph your branch touched vs origin/main
cd packages/api && bun run scripts/test-isolated.ts --since HEAD~3  # last-3-commit window
```

Typical PRs drop from ~225s to 10–60s. Run the full `bun run test` before opening a PR. The runner throws loudly if the git detector can't resolve the base ref — don't ignore it.

## Pre-PR gates via `/ci`

`/ci` runs lint + type + test + syncpack + template drift + railway-watch. All five must pass before opening a PR. In CI the api suite is sharded 4-way; locally it runs serial.

## Mocking

- **Mock all exports** — when using `mock.module()`, mock every named export. Partial mocks cause `SyntaxError` in other files.
- **Use the shared mock factory** — connection mocks use `createConnectionMock()` from `packages/api/src/__mocks__/connection.ts`. Don't create inline connection mocks.
- `mock.module()` does **not** need a paired `mock.restore()` — bun's `--isolate` resets module mocks between files.

## Effect test layers preferred

For new tests, prefer `createConnectionTestLayer()` / `TestAppLayer` / `buildTestLayer()` from `packages/api/src/__test-utils__/layers.ts` (or `createXxxTestLayer()` from `services.ts`) over `mock.module()`. Composable Layers are type-safe and don't leak state between tests. Prefer `Layer.provide` over `mock.module()` for new Effect-based tests.

**Never mutate a registry / singleton at test module top-level** (`plugins.register(...)`, `connections.set(...)`, etc.) — that state survives across files sharing a bun worker under `bun test --parallel` (1.5.4 / #2796). Use `createPluginRegistryTestLayer()` / `createConnectionTestLayer()` to get a fresh scoped instance, or fall back to an explicit `afterAll(() => singleton._reset())` when the production code path reads the global singleton directly (see `mcp-boot.test.ts` for that pattern).

## Tests are self-contained

No top-level `process.env.X = ...` or `process.chdir(...)` at module scope. The hoisted `??=` pattern **is** permitted when an import-time env read requires the var to be set before the file's first import (see `actions.test.ts` for the template).

`scripts/check-test-discipline.sh` (drift CI job) treats `??=` and `=` differently — only unconditional `=` is blocked. For path-typed test-owned vars (`ATLAS_SEMANTIC_ROOT = tmpRoot`), unconditional `=` is **required** so a parent-env value doesn't break hermetic isolation.

## Real-Postgres migration smoke

`migrate-pg.test.ts` runs every migration end-to-end against `TEST_DATABASE_URL` (Postgres service container in api-tests). Catches SQL planning errors mock-pool tests can't see. To opt in locally:

```bash
bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
```

Migrations referencing Better Auth tables (`user`, `session`, `organization`, `account`, `verification`) **must** be added to `MANAGED_AUTH_MIGRATIONS` in `packages/api/src/lib/db/internal.ts` — the smoke test fails otherwise, keeping boot-time skip wiring in lockstep with the migration set.
