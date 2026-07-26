---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "packages/api/scripts/**"
---

# Test discipline

- [ ] **`bun run test`, never bare `bun test`** — Isolated per-file runner. Single file OK: `bun test path/to/file.test.ts`. Never bare `bun test` against a directory
- [ ] **Use `--affected` for local loops** — `cd packages/api && bun run scripts/test-isolated.ts --affected`. Run full `bun run test` before a PR
- [ ] **Pre-PR gates via `/ci`** — runs `scripts/ci-local.sh`: ~27 gates (stage 0 type-check → stage 1 parallel checks: lint, type-aware lint, syncpack, template/schema/openapi/auth-md drift, ee-imports, twenty-resolver, migration-rename discipline, published-symbols, … → stage 2 full isolated test suite). All must pass; the `/ci` skill carries the authoritative gate list
- [ ] **Mock all exports** when using `mock.module()`; use `createConnectionMock()` for connection mocks (never inline)
- [ ] **Tests are self-contained** — No top-level `process.env.X =` or `process.chdir(...)`; `??=` hoist permitted for import-time env reads
- Full rationale, gotchas, and the `??=` vs `=` discipline: [docs/development/testing.md](docs/development/testing.md)
