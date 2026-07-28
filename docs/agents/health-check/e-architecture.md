## Part E: Architecture Compliance — HIGH

### E1. Frontend Isolation

**Rule:** `@atlas/web` does NOT depend on `@atlas/api`. Frontend talks to API over HTTP only.

```
Check: packages/web/package.json should NOT list @atlas/api as a dependency
Grep for: @atlas/api in packages/web/src/ — should find ZERO matches
```

**Exception:** `examples/nextjs-standalone/` embeds `@atlas/api` server-side via catch-all route (this is intentional).

---

### E2. Import Hygiene

| Check | What to Verify |
|-------|----------------|
| No cross-boundary relative imports | No `../../../packages/` style imports crossing workspace boundaries |
| Correct aliases | `@atlas/api` uses package name for imports. `@atlas/web` uses `@/` |
| Package exports respected | Imports use paths defined in package.json `exports` field |

```
Grep for: \.\./\.\./\.\./packages in packages/ — should find ZERO
Grep for: from ['"]\.\./ in packages/api/src/ — check none cross package boundaries
```

---

### E3. Server External Packages

**Rule:** `pg`, `mysql2`, `@clickhouse/client`, `just-bash`, `pino`, `pino-pretty` must stay in `serverExternalPackages` in the `create-atlas` template.

```
Check: create-atlas/ template's next.config — verify serverExternalPackages list is complete
Check: examples/nextjs-standalone/ next.config — same verification
```

---

### E4. bun Only

**Rule:** Never npm, yarn, or node.

```
Grep for: npm run|npm install|yarn |npx |node_modules/\.bin in packages/ and scripts/ and .github/
Exclude: CLAUDE.md, README.md, docs/ (documentation may mention npm for context)
```

All scripts, CI, and Dockerfiles should use `bun` exclusively.

---
