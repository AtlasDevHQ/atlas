# Testing

Long-form reference for the Testing rules summarized in [CLAUDE.md](../../CLAUDE.md) § *Testing* and the Effect test-layer rule in § *Effect.ts*. The terse rules there are the checklist; this doc holds the rationale and the gotchas.

## `bun run test`, never bare `bun test`

The project uses an isolated test runner — each file runs in its own subprocess. Always use `bun run test` (or `test:api` / `test:others` / `test-isolated.ts --affected`). A single file is fine: `bun test path/to/file.test.ts`. **Never** run bare `bun test` against a directory.

The custom `scripts/test-isolated.ts` subprocess-per-file runner is still in use until slice 6 (#2802) lands, because `bun test --parallel` reuses workers across files, so OS-level state (env, cwd, file handles, signal listeners) leaks between files.

## `test:others` is auto-discovered

`bun run test` is `test:api && test:others`:

- **`test:api`** runs `@atlas/api` first and on its own — the heaviest suite, so a failure there short-circuits the local `bun run test` fast. (In CI, `api-tests` and `test-others` are independent parallel jobs, so this ordering is a local-only property.)
- **`test:others`** runs `scripts/test-others.ts`, which **discovers** every other workspace package that declares a `test` script (from the `workspaces` globs in the root `package.json`) and runs each in its own `bun run --filter '<pkg>' test` process, serially, fail-fast.

There is **no hand-maintained package list** — adding a new workspace package with a `test` script means it is picked up automatically and can no longer silently skip the full suite. (The old `test:others` was a `&&` chain of ~32 invocations; forgetting to append a new package was silent both locally and in CI — it bit `railway-sandbox` in #3369 and left `chat` + `email-digest` uncovered until #3372.)

`bun run scripts/test-others.ts --list` prints the discovered set without running anything — use it to eyeball coverage. `@atlas/api` is the single intentional exclusion (it runs via `test:api`); everything else is auto-discovered. This is orthogonal to the per-package isolated runners, so it doesn't entangle with the #2802 `bun test --parallel` cutover.

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

**Any suite that runs Better Auth's real migrator (`migrateAuthTables()`) against shared Postgres needs a dedicated scratch DATABASE, not a scratch schema** (#4647). The migrator's Kysely `getTables()` introspection scans `pg_catalog` across every schema — `search_path` cannot scope it — so concurrent `-pg` tests' temp schemas being created/dropped mid-scan abort the migration with phantom `relation ... does not exist` errors. See the `beforeAll` comment in `staging/__tests__/seed.test.ts` for the full mechanism and the CREATE/DROP DATABASE lifecycle pattern.

## Mutation tables are GENERATED

A "MUTATIONS THIS CATCHES" table is never hand-typed. Each is a checked-in
mutation list under `packages/api/scripts/mutations/<name>.mutations.ts` — exact
`oldString`/`newString` pairs plus the suites to measure them against — rendered
by `scripts/mutate.ts` into `<name>.md`. The test file carries a POINTER, not
numbers.

```bash
cd packages/api && bun run scripts/mutate.ts scripts/mutations/<name>.mutations.ts
cd packages/api && bun run scripts/mutate.ts scripts/mutations/<name>.mutations.ts --check
```

Hand-editing a cell is the thing this exists to prevent: a stored count is a
claim nothing can falsify, so adding one test silently makes N cells false.
`scripts/check-mutation-tables.sh` is the CI gate (`--affected` locally, `--all`
in CI); it globs the directory, so a new spec is covered the moment it lands.

**`-pg` specs need a scratch database.** Without `TEST_DATABASE_URL` those
suites self-skip, the baseline is deflated, and the runner ABORTS rather than
publishing a column of zeros. Every brain suite creates and drops its own schema,
so one scratch database is safe to share — but give a long regeneration its own
so a concurrent `-pg` run cannot perturb the counts:

```bash
bun run db:up
psql -h localhost -p 5433 -U atlas -d postgres -c 'CREATE DATABASE brain_5061_scratch'
export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_5061_scratch
```

Two things the runner cannot do for you:

- **It measures `bun test`, so a TYPE-level mutation measures 0.** That zero is
  honest only if the note beside it names the gate that does catch it (`bun run
  type`), and only if you have RUN that gate rather than reasoned about it. See
  `episode-source-narrowing.mutations.ts` for the worked example.
- **It restores from an in-memory backup, never `git checkout`** — the tree
  normally carries uncommitted work. Never kill a run mid-flight, and never
  commit while one is live: `ps -o pid=,args= -C bun | grep 'mutate\.ts'`.
