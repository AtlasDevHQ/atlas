# Docs Accuracy Audit

Cross-reference documentation (`apps/docs/content/`) against source code to find stale, missing, or incorrect content. Run before releases or after large feature work.

**Mode:** Read-only audit — generate a report with findings. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps.

**Before starting:** read [docs/agents/audits.md](../../docs/agents/audits.md) (shared audit conventions) and run its **Step 0 self-check** against this command file — fix any drifted references in this file as part of the run. *Last verified against the codebase: 2026-07-10.*

## Docs Layout: Three Audience Trees (PRD #4257)

The docs portal is segmented by audience. Every content file lives in exactly ONE of three disjoint roots (`CONTENT_ROOTS` in `apps/docs/src/lib/audience-taxonomy.ts`):

| Tree | Audience class | Served at | Contents |
|------|---------------|-----------|----------|
| `apps/docs/content/docs/` | `saas-only` | `/` (site root) | SaaS/Cloud docs: guides, platform-ops, deployment, security, integrations + generated `api-reference/` |
| `apps/docs/content/self-hosted/` | `self-hosted-only` | `/self-hosted` | Self-hosted docs: quick-start, deployment, frameworks, contributing, self-hosted guides |
| `apps/docs/content/shared/` | `shared` | **BOTH** mounts | Single-sourced pages (reference, plugins, sdk, semantic-layer, architecture, comparisons) — one file on disk, rendered in both trees |

A build-time gate (`validateContentTaxonomy` in `apps/docs/src/lib/source.ts`) fails `next build` on orphans, invalid/ambiguous `audience:` frontmatter, or un-marked cross-audience duplicates (deliberate divergence requires a matching `fork:` frontmatter key on both files). The gate checks *placement*, not *content* — content-level audience drift is this audit's job (Part I4).

**Audit implication:** any grep over docs content must cover all three trees (`apps/docs/content/`), not just `content/docs/`. When checking whether a feature is documented, remember SaaS-only features belong in `content/docs/`, self-hosted-only in `content/self-hosted/`, and audience-neutral facts in `content/shared/`.

---

## Execution Strategy

Run 4 agents in parallel, one per audit domain. Each agent reads docs pages and cross-references against the authoritative source files.

---

## Part A: Environment Variables (HIGH RISK)

**Docs:** `apps/docs/content/shared/reference/environment-variables.mdx`
**Source of truth:** `packages/api/src/lib/config.ts` (the `configFromEnv()` function) and `.env.example`

### Steps

1. Extract ALL `process.env.*` reads from `packages/api/src/lib/config.ts` (the `configFromEnv()` function) AND from across `packages/api/src/` — this is the authoritative list of what the code actually reads. Include ALL prefixes (ATLAS_*, DATABASE_*, BETTER_AUTH_*, SLACK_*, GOOGLE_*, GITHUB_*, MICROSOFT_*, OPENAI_*, OLLAMA_*, OTEL_*, PORT, NODE_ENV, VERCEL, etc.)
2. Extract all **settings-registry keys** from `packages/api/src/lib/settings.ts` (`key: "ATLAS_..."` entries). These are runtime-controllable knobs read via the registry, NOT via `process.env` — the grep in step 1 misses them. Each needs docs coverage AND correct framing: precedence is `workspace > platform > env > default`, so docs must not describe a registry-backed knob as env-only (on SaaS it's set in the Admin console, never by redeploy)
3. Extract all env vars from `.env.example`
4. Extract all env vars mentioned in `apps/docs/content/shared/reference/environment-variables.mdx`
5. Cross-reference:

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
grep -oP '[A-Z][A-Z_]+[A-Z]' apps/docs/content/shared/reference/environment-variables.mdx | sort -u

# .env.example: all vars (uncommented and commented)
grep -oP '^#?\s*[A-Z][A-Z_]+[A-Z]' .env.example | sed 's/^#\s*//' | sort -u
```

### A2. SaaS boot contract page (generated — check drift, never hand-edit)

**Docs:** `apps/docs/content/docs/platform-ops/saas-environment-variables.mdx` (SaaS tree)
**Source of truth:** `SAAS_ENV_KEYS` in `packages/api/src/lib/effect/saas-env.ts`

This page's env-var table is **machine-generated** by `scripts/generate-saas-env-doc.ts` and drift-checked in `/ci` by `scripts/check-saas-env-doc.sh`. Don't hand-diff the table — run the check:

```bash
bash scripts/check-saas-env-doc.sh   # non-zero exit = page is stale → regenerate, don't hand-edit
```

Still worth spot-checking: the prose around the generated table (boot-guard behavior, `SAAS_IMMUTABLE_KEYS` claims) against `saas-guards.ts` and `docs/development/saas-env-audit.md`.

---

## Part B: CLI Reference (HIGH RISK)

**Docs:** `apps/docs/content/shared/reference/cli.mdx`
**Source of truth:** `packages/cli/bin/atlas.ts` (workspace-facing `atlas` binary) AND `packages/cli/bin/atlas-operator.ts` (tenant-data operator binary, split out per ADR-0025 / #4045)

### Steps

1. Extract all CLI subcommands from BOTH `packages/cli/bin/atlas.ts` and `packages/cli/bin/atlas-operator.ts` (look for `.command()` calls or command dispatch). The docs page covers both binaries — check operator commands (`proactive`, `seed`, `ops wipe`, `ops smoke-crm`, `ops teardown-verify-accounts`, `export`, `learn`, …) are documented under the correct binary, including their double-gates (`ATLAS_WIPE_OK`, `ATLAS_TEARDOWN_OK`)
2. Extract all documented commands from `apps/docs/content/shared/reference/cli.mdx`
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
# Code: command names (both binaries)
grep -P '\.command\(|case "' packages/cli/bin/atlas.ts packages/cli/bin/atlas-operator.ts | head -50

# Code: option flags
grep -P '\.option\(' packages/cli/bin/atlas.ts packages/cli/bin/atlas-operator.ts | head -60

# Docs: documented commands
grep -P '^#{2,3}.*`atlas' apps/docs/content/shared/reference/cli.mdx
```

---

## Part C: Configuration Reference (HIGH RISK)

**Docs:** `apps/docs/content/shared/reference/config.mdx`
**Source of truth:** `packages/api/src/lib/config.ts` (the `AtlasConfigSchema` Zod schema)

### Steps

1. Read the Zod schema `AtlasConfigSchema` from `packages/api/src/lib/config.ts`
2. Extract all top-level and nested config keys with their types and defaults
3. Read `apps/docs/content/shared/reference/config.mdx`
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
OpenAPIHono typed routes (auto-generated) + staticPaths in routes/openapi.ts (hand-curated)
    ↓  merged by buildAtlasOpenApiDocument() in packages/api/src/api/index.ts
    ↓  bun packages/api/scripts/extract-openapi.ts
apps/docs/openapi.json                    ← GENERATED ARTIFACT (never edit directly!)
    ↓  cd apps/docs && bun ./scripts/generate-openapi.ts
apps/docs/content/docs/api-reference/     ← GENERATED MDX pages
```

**NEVER edit `apps/docs/openapi.json` directly** — it will be overwritten on next extraction.
To add/fix endpoints: edit `openapi.ts`, then run the extraction + generation scripts.

### Steps

1. Extract all route paths from `packages/api/src/api/index.ts` (the route mounting file)
2. Extract all endpoints in the spec: the bulk is auto-generated from OpenAPIHono typed route definitions; hand-curated static entries for plain-Hono routes live in `packages/api/src/api/routes/openapi.ts` (`staticPaths`/`staticTags`); the merge happens in `buildAtlasOpenApiDocument()` (`packages/api/src/api/index.ts`)
3. Cross-reference — every mounted route should appear in the merged spec (plain-`Hono` routers are structurally excluded, and routes can opt out via `hide: true` with a rationale — check for those conventions before flagging):

| Check | How |
|-------|-----|
| **Missing from openapi.ts** | Route in code but not in programmatic spec → HIGH |
| **Stale in openapi.ts** | Endpoint in spec but removed from code → HIGH |
| **Wrong methods** | GET vs POST mismatch → HIGH |
| **Schema drift** | Response shapes in openapi.ts don't match actual c.json() returns → HIGH |
| **openapi.json stale** | Run `bun packages/api/scripts/extract-openapi.ts` and check if output differs from committed file → MEDIUM |

### Fixing missing endpoints

1. Read the route handler in `packages/api/src/api/routes/<handler>.ts`
2. For an OpenAPIHono-mounted route, fix/extend its typed zod-openapi route definition; for a plain-Hono route, add a static entry to `staticPaths` in `openapi.ts`
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

**Docs:** `apps/docs/content/shared/plugins/`
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

**Docs:** `apps/docs/content/shared/reference/sdk.mdx`, `apps/docs/content/shared/reference/react.mdx`
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

**Docs:** `apps/docs/content/shared/reference/error-codes.mdx`
**Source of truth:** `packages/types/src/errors.ts`

### Steps

1. Extract all error code constants from `packages/types/src/errors.ts`
2. Extract all documented error codes from `apps/docs/content/shared/reference/error-codes.mdx`
3. Cross-reference:

| Check | How |
|-------|-----|
| **Missing codes** | Code in source but not in docs → MEDIUM |
| **Stale codes** | Code in docs but removed from source → HIGH |
| **Wrong retryability** | Docs say retryable but source says not (or vice versa) → HIGH |
| **Missing guidance** | Error code documented but no troubleshooting steps |

---

## Part H: Guide Accuracy Spot-Check (MEDIUM RISK)

**Docs:** guides live in all three trees — `apps/docs/content/docs/guides/` (SaaS), `apps/docs/content/self-hosted/{getting-started,deployment,guides,frameworks}/` (self-hosted), `apps/docs/content/shared/guides/` (both audiences)
**Source of truth:** Various source files

Pick the 5 most recently changed guides across ALL THREE trees (by git log) and spot-check:

| Check | How |
|-------|-----|
| **Import paths** | Do `import` statements in code examples resolve to real exports? |
| **Config snippets** | Do `atlas.config.ts` examples validate against current schema? |
| **File paths** | Do referenced file paths (`semantic/entities/*.yml`, etc.) exist in the expected structure? |
| **Screenshots** | If guide references UI elements, do they still exist? (check component names) |
| **Prerequisites** | Are version requirements and dependency lists current? |

### Grep patterns
```bash
# Find recently modified guides (all three trees) — use $LAST_TAG..HEAD when running end-of-cycle (Part K)
git log --oneline --since="2 weeks ago" -- apps/docs/content/docs/guides/ apps/docs/content/self-hosted/ apps/docs/content/shared/guides/ | head -10

# Check import paths in code examples
grep -rP 'from ["'"'"']@' apps/docs/content/docs/guides/ apps/docs/content/self-hosted/ apps/docs/content/shared/guides/ --include='*.mdx' | grep -v node_modules
```

---

## Part I: Cross-Cutting Checks (LOW-MEDIUM RISK)

### I1. Stale Package References

```bash
# Check for references to old package names or paths (ALL content trees)
grep -rP '@atlas/web|@atlas/cli|@atlas/mcp' apps/docs/content/ --include='*.mdx' -l
# These are internal packages — docs should reference @useatlas/* public packages instead
# Exception: deployment/architecture docs may legitimately reference internal packages
```

### I2. Dead Links (Internal)

Internal-path and `#anchor` resolution is now a CI gate (promoted per the
ratchet — #4480): `bun scripts/check-docs-links.ts` validates every internal
link against the tree mounts and every anchor against `github-slugger`-computed
heading slugs, per mount. Run the gate first; this audit checks only the residue
the gate can't see:

- `href={...}` JSX expressions (not statically resolvable)
- Anchors into generated `api-reference/` pages (JSX `<APIPage>` body — the
  gate checks page existence only)
- A `shared/` page hard-linking a saas-only page with a root path: the link
  *resolves* (no 404), but sends a `/self-hosted` reader on a cross-section
  jump — judge whether audience-appropriate phrasing or `<AudienceLink>` fits

### I3. Notebook Docs Currency

**Docs:** `apps/docs/content/docs/guides/notebook.mdx`
**Source:** `packages/web/src/ui/components/notebook/`

Check that the docs page reflects the CURRENT state of the notebook by reading the source files. Don't assume what's shipped — verify against code:
- Current keyboard shortcuts (read `use-keyboard-nav.ts`)
- Current cell operations (read `use-notebook.ts` — includes text cells, fork, reorder, export)
- Persistence model (read `use-notebook.ts` — server-side with localStorage cache)
- Export capabilities (read `notebook-export.ts` — Markdown + HTML)

### I4. Audience Drift (content-level — the build gate can't catch this)

The taxonomy gate validates *placement*; this check validates *content* against the audience the tree promises:

| Check | How |
|-------|-----|
| **SaaS instructions in shared/** | A `content/shared/` page telling readers to edit env vars / redeploy / `docker compose` — those steps don't apply to SaaS readers, where config lives in the Admin console (settings registry). Shared pages must be audience-neutral or branch explicitly |
| **Self-hosted-only features in the SaaS tree** | `content/docs/` pages describing `.env`-only knobs, `atlas.config.ts`, nsjail, sidecar, etc. that SaaS customers can't touch → move or re-scope |
| **SaaS-only features in shared/ or self-hosted/** | Marketplace, residency, billing plans, SSO/SCIM (SaaS flavors), platform-ops surfaces described as if available self-hosted → mis-scoped |
| **Fork pairs drifted** | Files sharing a `fork:` frontmatter key are deliberately divergent duplicates. `grep -rn '^fork:' apps/docs/content/` — for each pair, check both sides were updated when the underlying feature changed (the gate only checks the markers exist). As of 2026-07 **zero fork pairs exist** — audience branching is done in-page via `<WhenSaaS>`/`<WhenSelfHosted>`/`<AudienceLink>` components, so an empty grep is a PASS, not a broken check |

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

For each route file, search ALL THREE content trees (`grep -r <feature> apps/docs/content/`) for mentions of the feature. New route files (onboarding, demo, admin-sso, admin-usage, etc.) often ship without guide pages.

When a feature is undocumented, note which tree the missing page belongs in: SaaS/enterprise features (`ee/`-gated, platform-ops, billing, residency, marketplace) → `content/docs/`; self-hosted deploy/config features → `content/self-hosted/`; audience-neutral facts (reference, plugins, SDK, semantic layer) → `content/shared/`.

### J2. New internal DB tables without docs

Internal-DB tables are created by SQL migrations (`db/migrations/####_*.sql`), NOT inline in `internal.ts` — grep the migrations:

```bash
# All tables created by migrations — these represent features
grep -hoP "CREATE TABLE( IF NOT EXISTS)? \"?\w+" packages/api/src/lib/db/migrations/*.sql | sort -u

# When scoping to a release cycle (Part K), only the migrations added since the last tag:
git diff --name-only --diff-filter=A $(git describe --tags --abbrev=0)..HEAD -- packages/api/src/lib/db/migrations/
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

### J4. Recently shipped features

Read `.claude/research/ROADMAP.md` and find all `[x]` items in the most recent milestone(s). For each shipped feature, verify there's a corresponding docs page or section. This catches features that were built but never documented.

---

## Part K: Release-Cycle Scoping (end-of-cycle runs)

When running this audit at the end of a code cycle (before `/release`), scope the discovery parts to what actually changed since the last tag, and add the release-specific checks below. The full-repo parts (A–G) still run unscoped — reference drift accumulates regardless of when it was introduced.

### K1. Establish the cycle window

```bash
git fetch --tags origin          # remote/ephemeral clones often lack tags — fetch first
LAST_TAG=$(git describe --tags --abbrev=0)
git log --oneline "$LAST_TAG"..HEAD | wc -l          # cycle size
git log "$LAST_TAG"..HEAD --pretty='%s' | grep -P '^(feat|fix)' # customer-visible candidates
```

Use `$LAST_TAG..HEAD` as the window everywhere a recency filter appears (Part H's "5 most recent guides", J2's new migrations, this part). Per ADR-0008, customer-visible changes since the tag are what forces the next tag's semver position — the audit's shipped-feature list doubles as that input.

### K2. Per-feature docs coverage for the cycle

For each customer-visible commit/PR in the window (dedupe by feature — use PR titles, milestone issues via `gh api repos/AtlasDevHQ/atlas/milestones`, and ROADMAP `[x]` items from J4):

| Check | How |
|-------|-----|
| **Docs exist** | Feature has a page/section in the correct audience tree (see layout table at top) → missing = HIGH |
| **Docs updated, not just existing** | If the feature *changed* an already-documented behavior, was the page touched in the same window? `git log $LAST_TAG..HEAD -- apps/docs/content/` vs the feature's code paths |
| **Generated surfaces regenerated** | New/changed routes → openapi.json + api-reference MDX regenerated (Part D); SAAS_ENV_KEYS changes → saas-environment-variables.mdx regenerated (Part A2) |

### K3. Stability commitments

**Docs:** `apps/docs/content/shared/reference/stability.mdx`

If any commit in the window touched a contract that page documents as stable (wire types, REST endpoints, plugin SDK, MCP tools), flag it CRITICAL — it either needs a docs update, a semver decision, or both. Contract breaks are reserved for major versions.

### K4. Chat-plugin × Atlas contract doc (milestone-closeout blocker)

**Docs:** `docs/architecture/chat-plugin-atlas-contract.md`

If the window includes commits touching `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `packages/api/src/lib/integrations/install/*-oauth-handler.ts`, the contract table must have been updated in those same commits. Also check for open ⚠ rows — they block milestone closeout regardless of this audit.

```bash
git log "$LAST_TAG"..HEAD --oneline -- plugins/chat/src/ packages/api/src/lib/slack/ 'packages/api/src/lib/integrations/install/*-oauth-handler.ts'
grep -n '⚠' docs/architecture/chat-plugin-atlas-contract.md
```

### K5. Changelog material (hand-off, not a fix)

The per-tag changelog entry (`apps/docs/src/components/changelog-data.ts` `releases[]`) is written by `/release`, not here — don't add it. But the audit's shipped-feature list from K2 is the raw material: include it in the report under a "Changelog input" heading so `/release` doesn't re-derive it.

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

## Changelog input (end-of-cycle runs only — Part K5)
- Shipped features since <last tag> with docs status, for /release to consume
```

---

## Execution

Run 4 agents in parallel:

1. **Env + Config agent** — Parts A + C (both reference `config.ts`; A includes A2 + settings-registry keys)
2. **CLI + API agent** — Parts B + D (route and command verification, both CLI binaries)
3. **Plugin + SDK agent** — Parts E + F + G (package exports and error codes)
4. **Guides + Cross-cutting + Discovery agent** — Parts H + I + J (spot-checks, link verification, audience drift, and undocumented feature discovery)

For end-of-cycle runs, do Part K1 (establish `$LAST_TAG` and the commit window) **before** spawning agents and pass the window into each agent's prompt; K2–K5 fold into agent 4's scope.

Each agent should:
- Read the docs page(s)
- Read the source-of-truth file(s)
- Perform the cross-reference checks
- Report findings with severity

After agents complete, compile into the output format above. Fix trivial issues (< 5 lines) directly. File GH issues for larger gaps using the CURRENT open milestone (check with `gh api repos/AtlasDevHQ/atlas/milestones?state=open --jq '.[0].title'`):
```bash
gh issue create -R AtlasDevHQ/atlas --title "docs: <description>" --body "<details>" --label "docs,area: docs" --milestone "<current milestone>"
```
