---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "packages/api/scripts/**"
---

# Test discipline

- [ ] **`bun test --parallel`, never bare `bun test`** — `--parallel` implies `--isolate`: a fresh global + module registry per file. Bare `bun test` shares one global across every file, so a suite can pass on state a sibling left behind. Single file OK: `bun test path/to/file.test.ts`
- [ ] **Never `--no-isolate`** — it buys speed by letting a worker keep one global across the files it runs. `agent-compaction.test.ts` already leaks module state across same-process runs (false-fails under `--rerun-each`, passes 12/12 under `--parallel`), so this would make that class routine
- [ ] **Use `--changed` for local loops** — `cd packages/api && bun test --parallel --changed=origin/main`. Run full `bun run test` before a PR
- [ ] **Pre-PR gates via `/ci`** — runs `scripts/ci-local.sh`: ~27 gates (stage 0 type-check → stage 1 parallel checks: lint, type-aware lint, syncpack, template/schema/openapi/auth-md drift, ee-imports, twenty-resolver, migration-rename discipline, published-symbols, … → stage 2 full test suite via `bun test --parallel`). All must pass; the `/ci` skill carries the authoritative gate list and count. ⚠️ **Without `TEST_DATABASE_URL` the `test` gate now reports `DECLINED`, not PASS (#5410)** — every `*-pg.test.ts` self-skips, so a bare local run cannot be a clean pre-PR pass
- [ ] **Mock all exports** when using `mock.module()`; use `createConnectionMock()` for connection mocks (never inline)
- [ ] **Tests are self-contained** — No top-level `process.env.X =` or `process.chdir(...)`; `??=` hoist permitted for import-time env reads
- [ ] **A mutation TABLE is GENERATED, never hand-typed** — a "MUTATIONS THIS CATCHES" table is a pointer to `packages/api/scripts/mutations/<name>.md`, rendered from `<name>.mutations.ts` by `scripts/mutate.ts`. Never edit a cell; regenerate. `scripts/check-mutation-tables.sh` is the gate, and it globs the directory. `-pg` specs need `TEST_DATABASE_URL` or the runner aborts on a deflated baseline. (A caveated prose count about ANOTHER suite — `vocabulary-pg.test.ts`'s "measured ONCE, at #5051" sibling list — is not a table and is not a violation; don't "fix" it by deleting it)
- Full rationale, gotchas, and the `??=` vs `=` discipline: [docs/development/testing.md](docs/development/testing.md)
