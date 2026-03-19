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

1. Extract ALL `process.env.*` reads from `packages/api/src/lib/config.ts` (the `configFromEnv()` function) AND from across `packages/api/src/` — this is the authoritative list of what the code actually reads. Include ALL prefixes (ATLAS_*, DATABASE_*, BETTER_AUTH_*, SLACK_*, GOOGLE_*, GITHUB_*, MICROSOFT_*, OPENAI_*, OLLAMA_*, OTEL_*, PORT, NODE_ENV, VERCEL, etc.)
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
# Code: ALL env vars read across the entire API package (not just config.ts)
grep -rP 'process\.env\.\w+' packages/api/src/ --include='*.ts' -h | grep -oP 'process\.env\.\w+' | sort -u

# Also check ee/ for enterprise env vars
grep -rP 'process\.env\.\w+' ee/src/ --include='*.ts' -h 2>/dev/null | grep -oP 'process\.env\.\w+' | sort -u

# Docs: all vars mentioned
grep -oP '[A-Z][A-Z_]+[A-Z]' apps/docs/content/docs/reference/environment-variables.mdx | sort -u

# .env.example: all vars (uncommented and commented)
grep -oP '^#?\s*[A-Z][A-Z_]+[A-Z]' .env.example | sed 's/^#\s*//' | sort -u
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

### How to find schema sections
Don't use a hardcoded list. Read the `AtlasConfigSchema` from `packages/api/src/lib/config.ts` and extract ALL top-level keys dynamically. As of this writing these include datasources, rls, cache, pool, sandbox, python, session, learn, actions, scheduler, enterprise — but new sections may have been added. The schema is the source of truth.

---

## Part D: API Endpoints / OpenAPI Spec (MEDIUM-HIGH RISK)

**Docs:** `apps/docs/content/docs/api-reference/` (auto-generated from OpenAPI)
**Source of truth:** `packages/api/src/api/routes/openapi.ts` (programmatic spec built from Zod schemas)

### CRITICAL: OpenAPI Codegen Pipeline

The API reference docs are generated, NOT hand-maintained. The pipeline is:

```
packages/api/src/api/routes/openapi.ts    ← SOURCE OF TRUTH (Zod → JSON Schema)
    ↓  bun packages/api/scripts/extract-openapi.ts
apps/docs/openapi.json                    ← GENERATED ARTIFACT (never edit directly!)
    ↓  cd apps/docs && bun ./scripts/generate-openapi.ts
apps/docs/content/docs/api-reference/     ← GENERATED MDX pages
```

**NEVER edit `apps/docs/openapi.json` directly** — it will be overwritten on next extraction.
To add/fix endpoints: edit `openapi.ts`, then run the extraction + generation scripts.

### Steps

1. Extract all route paths from `packages/api/src/api/index.ts` (the route mounting file)
2. Extract all endpoints defined in `packages/api/src/api/routes/openapi.ts` (the `buildSpec()` function)
3. Cross-reference — every mounted route should have a corresponding entry in `openapi.ts`:

| Check | How |
|-------|-----|
| **Missing from openapi.ts** | Route in code but not in programmatic spec → HIGH |
| **Stale in openapi.ts** | Endpoint in spec but removed from code → HIGH |
| **Wrong methods** | GET vs POST mismatch → HIGH |
| **Schema drift** | Response shapes in openapi.ts don't match actual c.json() returns → HIGH |
| **openapi.json stale** | Run `bun packages/api/scripts/extract-openapi.ts` and check if output differs from committed file → MEDIUM |

### Fixing missing endpoints

1. Read the route handler in `packages/api/src/api/routes/<handler>.ts`
2. Add the endpoint definition to `openapi.ts`'s `buildSpec()` function, using Zod schemas where available (import and use `toJsonSchema()`)
3. Run `bun packages/api/scripts/extract-openapi.ts` to regenerate `apps/docs/openapi.json`
4. Run `cd apps/docs && bun ./scripts/generate-openapi.ts` to regenerate MDX pages
5. Commit all generated files alongside the source change

### Grep patterns
```bash
# Code: all mounted routes
grep -P '\.route\(|\.get\(|\.post\(|\.patch\(|\.delete\(|\.put\(' packages/api/src/api/index.ts packages/api/src/api/routes/*.ts | grep -oP '["'"'"']/[^"'"'"']+' | sort -u

# openapi.ts: all paths in spec
grep -oP '"/api/[^"]+"|"/widget[^"]*"' packages/api/src/api/routes/openapi.ts | sort -u

# Check if openapi.json is stale (should produce no diff if in sync)
bun packages/api/scripts/extract-openapi.ts && git diff apps/docs/openapi.json
```

---

## Part E: Plugin Documentation (MEDIUM RISK)

**Docs:** `apps/docs/content/docs/plugins/`
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

Check that the docs page reflects the CURRENT state of the notebook by reading the source files. Don't assume what's shipped — verify against code:
- Current keyboard shortcuts (read `use-keyboard-nav.ts`)
- Current cell operations (read `use-notebook.ts` — includes text cells, fork, reorder, export)
- Persistence model (read `use-notebook.ts` — server-side with localStorage cache)
- Export capabilities (read `notebook-export.ts` — Markdown + HTML)

---

## Part J: Undocumented Features Discovery (HIGH RISK)

This is the most important check — finding features that exist in code but have NO documentation at all.

### J1. New routes without docs

Discover all route files and check each has corresponding docs coverage:
```bash
# All route files in the API
ls packages/api/src/api/routes/*.ts

# All pages in the web app (feature surfaces)
find packages/web/src/app -name "page.tsx" -not -path "*/node_modules/*"
```

For each route file, search docs for mentions of the feature. New route files (onboarding, demo, admin-sso, admin-usage, etc.) often ship without guide pages.

### J2. New internal DB tables without docs

```bash
# All CREATE TABLE statements in internal.ts — these represent features
grep -oP "CREATE TABLE IF NOT EXISTS (\w+)" packages/api/src/lib/db/internal.ts
```

Each table represents a user-facing feature. Check if there's a corresponding docs page or section explaining the feature (usage_events → usage metering docs, sso_providers → SSO guide, demo_leads → demo mode docs, etc.)

### J3. New packages/directories without docs

```bash
# Top-level directories that may need docs
ls -d ee/ packages/*/

# New app pages (signup, demo, etc.)
find packages/web/src/app -maxdepth 1 -type d
```

Check if new top-level features (ee/, signup flow, demo mode) have corresponding docs pages.

### J4. Recently shipped features from ROADMAP

Read `.claude/research/ROADMAP.md` and find all `[x]` items in the current milestone. For each shipped feature, verify there's a corresponding docs page or section. This catches features that were built but never documented.

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
4. **Guides + Cross-cutting + Discovery agent** — Parts H + I + J (spot-checks, link verification, and undocumented feature discovery)

Each agent should:
- Read the docs page(s)
- Read the source-of-truth file(s)
- Perform the cross-reference checks
- Report findings with severity

After agents complete, compile into the output format above. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps using the CURRENT open milestone (check with `gh api repos/AtlasDevHQ/atlas/milestones?state=open --jq '.[0].title'`):
```bash
gh issue create -R AtlasDevHQ/atlas --title "docs: <description>" --body "<details>" --label "docs,area: docs" --milestone "<current milestone>"
```
