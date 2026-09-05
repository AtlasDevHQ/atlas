# Testing

Long-form reference for the Testing rules summarized in [CLAUDE.md](../../CLAUDE.md) § *Testing* and the Effect test-layer rule in § *Effect.ts*. The terse rules there are the checklist; this doc holds the rationale and the gotchas.

## `bun test --parallel`, never bare `bun test`

Every package's `test` script is `bun test --parallel`. `--parallel` implies `--isolate`: each FILE gets a fresh global and module registry, which is exactly what the old subprocess-per-file runner was buying. A single file is fine: `bun test path/to/file.test.ts`. **Never** run bare `bun test` against a directory — it shares one global across every file, so a suite can pass on state a sibling left behind.

**Never pass `--no-isolate`.** It trades that isolation for speed by letting a worker keep one global across the files it runs. That is not hypothetical here: `agent-compaction.test.ts` leaks module state across same-process runs today — it false-fails under `--rerun-each` (one process, N iterations) while passing 12/12 under `--parallel`. `--no-isolate` would make that class of failure routine.

### The seven custom runners are gone (#2802)

`packages/{api,cli,mcp,react,web}/scripts/test-isolated.ts`, `ee/` and `apps/docs/` — ~1,480 lines — were deleted once bun 1.4 shipped a `--parallel` that behaves. They existed because bun 1.3.14's `--isolate` broke top-level-await module init (#2811), which is fixed on the 1.4 line.

Two things the cutover measured that are worth keeping in mind:

- **The blocker at the end was the logger, not `mock.module`.** `pino-pretty` runs its transport in a `thread-stream` WORKER THREAD; when bun tears down a `--parallel` worker the thread dies and takes the process with it. The failure mode was silent: 1,090 tests ran, 28 failed, and bun exited reporting `Ran 1090 tests across 183 files` when those 183 files hold **4,818** tests — 3,728 never ran. `logger.ts` now takes the plain-JSON branch when `NODE_ENV === "test"` (which is what `bun test` sets). Do not undo that without re-measuring.
- **Shards are balanced by measured duration**, not round-robin file index — `--timings=scripts/test-timings.json`. On the committed data that is a 1.96x → 1.00x skew across four shards. The file is advisory: if it goes stale, sharding stays correct and just gets less balanced. Regenerate with `bun test --parallel --timings=scripts/test-timings.json --update-timings`.

## `test:others` is auto-discovered

`bun run test` is `test:api && test:others`:

- **`test:api`** runs `@atlas/api` first and on its own — the heaviest suite, so a failure there short-circuits the local `bun run test` fast. (In CI, `api-tests` and `test-others` are independent parallel jobs, so this ordering is a local-only property.)
- **`test:others`** runs `scripts/test-others.ts`, which **discovers** every other workspace package that declares a `test` script (from the `workspaces` globs in the root `package.json`) and runs each in its own `bun run --filter '<pkg>' test` process, serially, fail-fast.

There is **no hand-maintained package list** — adding a new workspace package with a `test` script means it is picked up automatically and can no longer silently skip the full suite. (The old `test:others` was a `&&` chain of ~32 invocations; forgetting to append a new package was silent both locally and in CI — it bit `railway-sandbox` in #3369 and left `chat` + `email-digest` uncovered until #3372.)

`bun run scripts/test-others.ts --list` prints the discovered set without running anything — use it to eyeball coverage. `@atlas/api` is the single intentional exclusion (it runs via `test:api`); everything else is auto-discovered. This is orthogonal to how each package runs its own tests, so it was unaffected by the #2802 `bun test --parallel` cutover — every discovered package simply became `bun test --parallel`.

## Fast local feedback loop

```bash
cd packages/api && bun test --parallel --changed=origin/main   # only tests affected by what your branch touched
cd packages/api && bun test --parallel --changed=HEAD~3        # last-3-commit window
```

`--changed` is bun's native replacement for the deleted `--affected`/`--since` flags (and scripts/affected.ts went with them). ⚠️ **Do not run the full `bun run test` locally before a PR.** It is a whole-suite `--parallel` run — one worker per core — and CLAUDE.md makes remote CI on the PR the gate, with the local pre-flight being the cheap subset (`--changed`, plus `lint`, `type`, `lint:type-aware`). `.claude/hooks/guard-bun-test.sh` refuses the whole-suite shapes at the tool boundary, including the ones reached *through* the package scripts, so the rule holds against habit rather than against memory. The full `packages/api` suite is ~3 min under `--parallel` in CI (it was ~51 min through the old runner).

## Pre-PR gates via `/ci`

`/ci` runs `scripts/ci-local.sh` — 47 ci-local gates (lint, type, type-aware lint, syncpack, template/schema/openapi drift, the `check-*.sh` guards, and the full test suite, among others). All must pass before opening a PR; `.claude/commands/ci.md` carries the authoritative roster, and this page deliberately does not keep a second copy of it. In CI the api suite is sharded 4-way (`--shard=N/4`, duration-balanced via `--timings`); locally it runs unsharded.

> ⚠️ **A clean local pass now requires `TEST_DATABASE_URL` (#5410).** Without it every `*-pg.test.ts` file self-skips — 104 real-postgres suites today, 1,432 assertions when last measured (2026-08-24, at 87 of them) — so the `test` gate reports `DECLINED` (exit 3) rather than PASS, and the run is not a clean pre-PR pass however green the other rows look. `bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas`. The `/ci` skill carries the authoritative gate list and count.

## Mocking

- **Mock all exports** — when using `mock.module()`, mock every named export. Partial mocks cause `SyntaxError` in other files.
- **Use the shared mock factory** — connection mocks use `createConnectionMock()` from `packages/api/src/__mocks__/connection.ts`. Don't create inline connection mocks.
- `mock.module()` does **not** need a paired `mock.restore()` — bun's `--isolate` resets module mocks between files.

## One registration, drivable per test (#5645)

**The decision:** the file count is driven by `mock.module()` being file-scoped, and the
fix is a drivable-fixture helper — option 1 of the three the issue posed — not dependency
injection at the seam (option 2) and not "leave the splits" (option 3). It changes no
runtime code.

**Why the constraint looked structural and is not.** `mock.module(specifier, factory)` is
registered once per test file and the last registration wins, so five suites that each
needed a different fixed `getEntity` for `lib/semantic/expert/apply.ts` — a glossary store
that threw on entity reads, a synthetic row keyed on group, a name+group lookup table, a
constant published row, a call-counting refetch — could not be concatenated. But the
registration is the only file-scoped thing. The spy inside it is a bun `Mock`, and a `Mock`
takes `mockImplementation` / `mockImplementationOnce` at any point. One of the five
(`apply-dual-apply`) was already doing exactly that for one spy. Generalise it and the
contradiction disappears: register once, install each `describe`'s baseline in its own
`beforeEach`.

**The one thing bun does not give you.** Measured on bun 1.4.0: `mockReset()` clears the
calls AND the implementation — the spy then returns `undefined` — it does not restore the
function `mock(fn)` was given. So a suite that resets between tests loses its baseline
unless something re-installs it. `drivable(fn)` in `packages/api/src/__mocks__/drivable.ts`
is a `Mock` with a `reset()` that does `mockReset()` and then `mockImplementation(fn)`;
it also flushes any unconsumed `mockImplementationOnce` a previous test queued, which
`mockClear()` alone would leak into the next test.

**The helpers, all under `@atlas/api/testing/*`:**

- `drivable` — the primitive: `drivable(defaultImpl)`, `resetAll(spies)`, and
  `notDriven(name, fixture)` for exports a fixture registers but does not model (throws
  by name on first use — never a link-time `Export named 'X' not found`, never a silent
  `undefined`).
- `logger` — `installLoggerMock()` stubs every value export of `lib/logger.ts` and
  captures `{ level, component, payload, message }`. The factory is typed
  `Record<keyof typeof RealLogger, unknown>` over a type-only import, so a new export in
  `logger.ts` is a compile error in the helper, not a link error in a suite.
- `semantic-store` — `installSemanticStoreMock()` covers `lib/semantic/entities`,
  `lib/semantic` and `lib/semantic/sync` the same way, with typed spy signatures so
  `.mock.calls[n][i]` assertions type-check.

**How it was proved, on the proving ground the issue named.** The five `apply-*.test.ts`
files became `apply-to-entity.test.ts` with every test carried, inputs and assertions
unchanged, and bun's per-run `expect()` count equal before and after. Then one production
branch per former file was deleted in turn — the unscoped fallback lookup, the named-group
glossary scope, the tombstone skip, the pre-image rollback write, the entity hash-carried
claim guard — and the merged suite went red each time. The same was done for the second
cluster (the former `grant-sweep-logging.test.ts` into `grant-sweep.test.ts`: the findings
warn, the row-cap warn), and the static `expect(` count across `packages/api` was compared
before and after. The counts are recorded with the work in #5645 and its PR, not here: a
number in this page is a measurement nothing re-runs.

**Where the split still wins — do not merge these:**

- one suite must exercise the REAL module the other mocks (a test of the logger's own
  scrubbing cannot share a file with a suite that stubs the logger);
- a generated mutation table names the file as a column (`scripts/mutations/*.mutations.ts`
  — `warehouse-producer-logging`, `reconcile-logging`, `alias-proposal-logging`,
  `vocabulary-rekey-logging`). Moving the tests moves the column; regenerate, don't retype;
- the suites test different modules and only happen to share a mock. A merge that buys
  nothing but a lower file count is the count driving the design.

Any other `*-logging.test.ts` sibling without a mutation-table column is eligible under the
same technique; one worked example per cluster is what the issue asked for, and the merge
is now mechanical.

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
`scripts/check-mutation-tables.sh` is the CI gate (`--affected` locally and on
PRs, `--all` on push to `main`, sharded four ways in CI); it globs the directory,
so a new spec is covered the moment it lands, and shard ownership follows from
its position in that glob.

**`-pg` specs need a scratch database.** Without `TEST_DATABASE_URL` those
suites self-skip, the baseline is deflated, and the runner ABORTS rather than
publishing a column of zeros. Every brain suite creates and drops its own schema,
so one scratch database is safe to share — but give a long regeneration its own
so a concurrent `-pg` run cannot perturb the counts:

```bash
bun run db:up   # docker-compose.yml → 127.0.0.1:5432
psql -h localhost -p 5432 -U atlas -d postgres -c 'CREATE DATABASE brain_5061_scratch'
export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/brain_5061_scratch
```

⚠️ **Mind the PORT: the brain suite headers and the mutation specs say `5433`,
and `bun run db:up` does not give you that.** `db:up` brings up
`docker-compose.yml`, which maps `5432`. `5433`/`5434`/`5435` are
`docker-compose.multi-env.yml`'s dev/staging/prod, which is what the
parallel-session workflow runs and what those headers were written against. Either port works — the URL is the only
thing that decides — so read the number as "whichever your compose mapped", not
as part of the instruction.

Things the runner cannot do for you:

- **It measures `bun test`, so a TYPE-level mutation measures 0.** That zero is
  honest only if the note beside it names the gate that does catch it (`bun run
  type`), and only if you have RUN that gate rather than reasoned about it. See
  `episode-source-narrowing.mutations.ts` for the worked example.
- **⚠️ In a git WORKTREE, root `bun run type` can type-check ANOTHER
  checkout's copy of a file.** Not the whole tree, and not predictably: it is
  per-file. A worktree's `node_modules` are usually symlinked to the primary
  checkout, and `packages/{cli,mcp,ee,…}/node_modules/@atlas/api` points there,
  so a `lib/**` file reached through an `@atlas/api/*` specifier resolves to the
  PRIMARY copy while the same file reached relatively resolves to the
  worktree's. **Which copy a given file ends up as is decided per-file and can
  flip when an unrelated import moves**, so treat it as unpredictable rather
  than as a rule you can reason from. Measured here: 1,639 `packages/api/src`
  files came from the worktree, 480 from the primary, and 179 appeared as BOTH —
  the two sets are not even cleanly partitioned. `sources.ts` and
  `ingest/types.ts` were primary-only; `vocabulary-decide.ts`, in the same
  directory, was worktree-only.

  Edit a shadowed file and the type-check reports green on a change it never
  saw. `bun` is unaffected — it resolves to the worktree — so `bun test` and
  every mutation count are sound; only the type gate is exposed. To see the
  split rather than one file:

  ```bash
  bun x tsgo --noEmit --listFiles | grep 'packages/api/src' | grep -v "$PWD" | head
  ```

  Any output means part of your `src` is coming from another checkout. Two ways
  out: type-check the package's own project, `bun x tsgo --noEmit -p
  packages/api/tsconfig.json`, whose `@atlas/api/* → ./src/*` mapping is
  relative and so always reads the worktree; or measure from the primary
  checkout.
- **It restores from an in-memory backup, never `git checkout`** — the tree
  normally carries uncommitted work. Never kill a run mid-flight, and never
  commit while one is live: `ps -o pid=,args= -C bun | grep 'mutate\.ts'`.
- **Do not run ANOTHER gate against the tree while one is live, either.** A
  mutation run has a fault injected on disk for most of its duration, so a
  concurrent `lint`, `type`, `lint:type-aware` or test run can go red on a line
  nobody wrote — and the natural reading of that red is a defect in your branch.
  `scripts/ci-local.sh` already serialises `mutation-tables` for exactly this
  reason. The tell is the same one-liner above: if it prints a PID, any other
  gate's verdict is about a tree you did not author.
- **Never run TWO `mutate.ts` processes in one tree**, which is the likelier
  footgun here given the parallel-session workflow. There is no cross-process
  lock: each run backs up the files it touches IN MEMORY, so two runs whose
  specs share a source file clobber each other's backups and publish numbers
  measured against a doubly-mutated tree — a wrong number that looks exactly
  like a right one. Do not rely on two specs touching different files;
  serialise.
