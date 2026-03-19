# Docs Accuracy Audit

Cross-reference documentation (`apps/docs/content/docs/`) against source code to find stale, missing, or incorrect content. Run before releases or after large feature work.

**Mode:** Read-only audit — generate a report with findings. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps.

---

## Execution Strategy

Run 4 agents in parallel, one per audit domain. Each agent reads docs pages and cross-references against the authoritative source files.

---

## Part A: Environment Variables (HIGH RISK)

**Docs:** `apps/docs/content/docs/reference/environment-variables.mdx`
**Source of truth:** `packages/api/src/lib/config.ts` (the `configFromEnv()` function) and `.env.example`

### Steps

1. Extract all `ATLAS_*`, `DATABASE_*`, `BETTER_AUTH_*`, `SLACK_*` env vars from `configFromEnv()` in `packages/api/src/lib/config.ts` — this is the authoritative list of what the code actually reads
2. Extract all env vars from `.env.example`
3. Extract all env vars mentioned in `apps/docs/content/docs/reference/environment-variables.mdx`
4. Cross-reference:

| Check | How |
|-------|-----|
| **Missing from docs** | Var in code but not in docs page → HIGH (users can't discover it) |
| **Missing from .env.example** | Var in code but not in .env.example → MEDIUM (missing from template) |
| **Stale in docs** | Var in docs but not in code → HIGH (misleading) |
| **Wrong defaults** | Compare default values in docs vs code — especially numeric defaults like timeouts, limits |
| **Wrong descriptions** | Spot-check 5-10 vars where the docs description matches the code behavior |

### Grep patterns
```bash
# Code: all env vars read
grep -oP 'process\.env\.(?:ATLAS_|DATABASE_|BETTER_AUTH_|SLACK_)\w+' packages/api/src/lib/config.ts | sort -u

# Code: env vars read outside config.ts (may be missed)
grep -rP 'process\.env\.(?:ATLAS_|DATABASE_|BETTER_AUTH_|SLACK_)\w+' packages/api/src/ --include='*.ts' -h | grep -oP 'process\.env\.\w+' | sort -u

# Docs: all vars mentioned
grep -oP '(?:ATLAS_|DATABASE_|BETTER_AUTH_|SLACK_)\w+' apps/docs/content/docs/reference/environment-variables.mdx | sort -u

# .env.example: all vars
grep -oP '^(?:ATLAS_|DATABASE_|BETTER_AUTH_|SLACK_)\w+' .env.example | sort -u
```

---

## Part B: CLI Reference (HIGH RISK)

**Docs:** `apps/docs/content/docs/reference/cli.mdx`
**Source of truth:** `packages/cli/bin/atlas.ts`

### Steps

1. Extract all CLI subcommands from `packages/cli/bin/atlas.ts` (look for `.command()` calls or command dispatch)
2. Extract all documented commands from `apps/docs/content/docs/reference/cli.mdx`
3. For each command, compare flags/options between code and docs
4. Cross-reference:

| Check | How |
|-------|-----|
| **Missing commands** | Command in code but not in docs → HIGH |
| **Stale commands** | Command in docs but removed from code → HIGH |
| **Missing flags** | Flag in code but not documented → MEDIUM |
| **Wrong flag descriptions** | Spot-check flag defaults and descriptions |
| **Wrong examples** | Do the example commands in docs use correct flag names? |

### Grep patterns
```bash
# Code: command names
grep -P '\.command\(|case "' packages/cli/bin/atlas.ts | head -30

# Code: option flags
grep -P '\.option\(' packages/cli/bin/atlas.ts | head -50

# Docs: documented commands
grep -P '^#{2,3}.*`atlas' apps/docs/content/docs/reference/cli.mdx
```

---

## Part C: Configuration Reference (HIGH RISK)

**Docs:** `apps/docs/content/docs/reference/config.mdx`
**Source of truth:** `packages/api/src/lib/config.ts` (the `AtlasConfigSchema` Zod schema)

### Steps

1. Read the Zod schema `AtlasConfigSchema` from `packages/api/src/lib/config.ts`
2. Extract all top-level and nested config keys with their types and defaults
3. Read `apps/docs/content/docs/reference/config.mdx`
4. Cross-reference:

| Check | How |
|-------|-----|
| **Missing config keys** | Key in Zod schema but not in docs → HIGH |
| **Stale config keys** | Key in docs but removed from schema → HIGH |
| **Wrong types** | Docs say string but schema is number, etc. → HIGH |
| **Wrong defaults** | Default in docs differs from `.default()` in Zod → MEDIUM |
| **Missing nested options** | Sub-objects (rls, cache, pool, python, sandbox, session, learn) fully documented? |
| **defineConfig() example** | Does the main example in docs validate against current schema? |

### Key schema sections to check
- `datasources` — DatasourceConfig shape
- `rls` — RLSConfigSchema (multi-column, array claims, OR-logic)
- `cache` — CacheConfigSchema (enabled, ttl, maxSize)
- `pool` — PoolConfigSchema (perOrg, warmup, drainThreshold)
- `sandbox` — SandboxConfigSchema (priority array)
- `python` — PythonConfigSchema (blockedModules, allowModules)
- `session` — SessionConfigSchema (idleTimeout, absoluteTimeout)
- `learn` — LearnConfigSchema (confidenceThreshold)
- `actions` — ActionConfigSchema
- `scheduler` — SchedulerConfigSchema

---

## Part D: API Endpoints (MEDIUM-HIGH RISK)

**Docs:** `apps/docs/content/docs/api-reference/` (24 pages, auto-generated from OpenAPI)
**Source of truth:** `packages/api/src/api/routes/*.ts` and `apps/docs/openapi.json`

### Steps

1. Extract all route paths from `packages/api/src/api/index.ts` (the route mounting file)
2. Extract all endpoints from `apps/docs/openapi.json`
3. Cross-reference route files against OpenAPI spec:

| Check | How |
|-------|-----|
| **Missing endpoints** | Route in code but not in OpenAPI spec → HIGH |
| **Stale endpoints** | Endpoint in OpenAPI but removed from code → HIGH |
| **Wrong methods** | GET vs POST mismatch → HIGH |
| **Missing new routes** | Recently added routes (check git log) not in spec |

### Grep patterns
```bash
# Code: all mounted routes
grep -P '\.route\(|\.get\(|\.post\(|\.patch\(|\.delete\(|\.put\(' packages/api/src/api/index.ts packages/api/src/api/routes/*.ts | grep -oP '["'"'"']/[^"'"'"']+' | sort -u

# OpenAPI: all paths
grep -oP '"(/api/[^"]+)"' apps/docs/openapi.json | sort -u
```

---

## Part E: Plugin Documentation (MEDIUM RISK)

**Docs:** `apps/docs/content/docs/plugins/` (17+ pages)
**Source of truth:** `plugins/*/package.json`, `plugins/*/src/index.ts`

### Steps

1. List all plugins in `plugins/` directory
2. For each plugin with a docs page, check:

| Check | How |
|-------|-----|
| **Package name matches** | Docs `bun add` command uses correct package name |
| **Import path correct** | Docs import matches actual package export |
| **Config options current** | Plugin Zod schema matches documented options table |
| **Version requirement** | Peer deps in package.json match docs prerequisites |

### Grep patterns
```bash
# All plugins
ls plugins/

# Plugin package names
grep '"name"' plugins/*/package.json

# Plugin exports
grep 'export' plugins/*/src/index.ts | head -30
```

---

## Part F: SDK & React Reference (MEDIUM RISK)

**Docs:** `apps/docs/content/docs/reference/sdk.mdx`, `apps/docs/content/docs/reference/react.mdx`
**Source of truth:** `packages/sdk/src/index.ts`, `packages/react/src/index.ts`

### Steps

1. Extract all public exports from SDK and React package index files
2. Compare against documented API surface in reference pages
3. Check:

| Check | How |
|-------|-----|
| **Missing exports** | Exported from index.ts but not documented → MEDIUM |
| **Stale API** | Documented but no longer exported → HIGH |
| **Wrong signatures** | Function parameters in docs differ from code → HIGH |
| **Missing types** | Key types exported but not in docs type reference |

---

## Part G: Error Codes (MEDIUM RISK)

**Docs:** `apps/docs/content/docs/reference/error-codes.mdx`
**Source of truth:** `packages/types/src/errors.ts`

### Steps

1. Extract all error code constants from `packages/types/src/errors.ts`
2. Extract all documented error codes from `apps/docs/content/docs/reference/error-codes.mdx`
3. Cross-reference:

| Check | How |
|-------|-----|
| **Missing codes** | Code in source but not in docs → MEDIUM |
| **Stale codes** | Code in docs but removed from source → HIGH |
| **Wrong retryability** | Docs say retryable but source says not (or vice versa) → HIGH |
| **Missing guidance** | Error code documented but no troubleshooting steps |

---

## Part H: Guide Accuracy Spot-Check (MEDIUM RISK)

**Docs:** `apps/docs/content/docs/guides/`
**Source of truth:** Various source files

Pick the 5 most recently changed guides (by git log) and spot-check:

| Check | How |
|-------|-----|
| **Import paths** | Do `import` statements in code examples resolve to real exports? |
| **Config snippets** | Do `atlas.config.ts` examples validate against current schema? |
| **File paths** | Do referenced file paths (`semantic/entities/*.yml`, etc.) exist in the expected structure? |
| **Screenshots** | If guide references UI elements, do they still exist? (check component names) |
| **Prerequisites** | Are version requirements and dependency lists current? |

### Grep patterns
```bash
# Find recently modified guides
git log --oneline --since="2 weeks ago" -- apps/docs/content/docs/guides/ | head -10

# Check import paths in code examples
grep -P 'from ["'"'"']@' apps/docs/content/docs/guides/*.mdx | grep -v node_modules
```

---

## Part I: Cross-Cutting Checks (LOW-MEDIUM RISK)

### I1. Stale Package References

```bash
# Check for references to old package names or paths
grep -rP '@atlas/web|@atlas/cli|@atlas/mcp' apps/docs/content/docs/ --include='*.mdx' -l
# These are internal packages — docs should reference @useatlas/* public packages instead
# Exception: deployment/architecture docs may legitimately reference internal packages
```

### I2. Dead Links (Internal)

```bash
# Find all internal doc links
grep -oP '\]\(/docs/[^)]+\)' apps/docs/content/docs/**/*.mdx | sort -u
# Verify each target file exists
```

### I3. Notebook Docs Currency

**Docs:** `apps/docs/content/docs/guides/notebook.mdx`
**Source:** `packages/web/src/ui/components/notebook/`

The notebook is actively changing (0.8.1 milestone). Check that the docs page reflects:
- Current keyboard shortcuts (recently standardized in PR #620)
- Current cell operations
- Current limitations (Phase 2/3 not yet shipped)
- Persistence model (still localStorage, not yet server-side)

---

## Output Format

```markdown
## Summary
- Total checks: X
- PASS: X | DRIFT: X | MISSING: X | STALE: X

## Critical (Must Fix Before Release)
| Section | Doc File | Issue | Source File |
|---------|----------|-------|-------------|

## High (Fix Soon)
| Section | Doc File | Issue | Source File |
|---------|----------|-------|-------------|

## Medium (Should Fix)
| Section | Doc File | Issue | Source File |
|---------|----------|-------|-------------|

## Low (Can Defer)
| Section | Doc File | Issue | Source File |
|---------|----------|-------|-------------|

## Up-to-Date (Verified Accurate)
- [section]: X items verified against source
```

---

## Execution

Run 4 agents in parallel:

1. **Env + Config agent** — Parts A + C (both reference `config.ts`)
2. **CLI + API agent** — Parts B + D (route and command verification)
3. **Plugin + SDK agent** — Parts E + F + G (package exports and error codes)
4. **Guides + Cross-cutting agent** — Parts H + I (spot-checks and link verification)

Each agent should:
- Read the docs page(s)
- Read the source-of-truth file(s)
- Perform the cross-reference checks
- Report findings with severity

After agents complete, compile into the output format above. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps using:
```bash
gh issue create -R AtlasDevHQ/atlas --title "docs: <description>" --body "<details>" --label "docs,area: docs" --milestone "0.8.1 — Notebook Refinement"
```
