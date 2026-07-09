# Contracts Audit (semver evidence for /release)

Diff every **committed contract surface** against the last release tag, classify each change as breaking / additive / internal, and output the evidence that drives the next tag's semver position. Run before `/release` at the end of a code cycle.

**Mode:** Read-only audit — generate a classification report. Fix trivial issues (< 5 lines, e.g. a missed `stability.mdx` note) directly. File GH issues for larger gaps.

**Why this is its own command:** /docs-audit checks that docs *describe* the code; this command checks that the code *kept its promises*. The source of truth is [apps/docs/content/shared/reference/stability.mdx](../../apps/docs/content/shared/reference/stability.mdx) — the per-surface stability contract — plus [ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md)'s semver rules. Its output feeds two decisions: the tag's semver position, and whether any change violates the v0.x additive-only policy.

**Before starting:** read [docs/agents/audits.md](../../docs/agents/audits.md) (shared audit conventions) and run its **Step 0 self-check** against this command file. *Last verified against the codebase: 2026-07-09.*

---

## The semver rule being enforced (ADR-0008 + stability.mdx)

- **Contract break → major.** Majors are **reserved for `v1.0.0`** — so within the current `v0.x` train, a breaking change to a committed surface is not "bump major", it is a **POLICY VIOLATION** to surface as CRITICAL. The options are: revert it, ship it additively (new endpoint / new tool name / new optional field), or make an explicit recorded exception.
- **Customer-visible change → minor.** New endpoints, new tools, new optional fields, new features.
- **Bug/perf/docs only → patch.**

The committed surfaces and their break definitions come from `stability.mdx` (read it fresh — it's the SSOT, this command is the worked procedure). Surfaces with **no contract** (agent behavior/prompts, chat UI, dashboards UI, admin console) are out of scope — changes there never force the semver position above minor.

---

## Setup: the cycle window

```bash
git fetch --tags origin
LAST_TAG=$(git describe --tags --abbrev=0)
git log --oneline "$LAST_TAG"..HEAD | wc -l
```

Every part below diffs `$LAST_TAG..HEAD` on its surface's files. A surface with zero commits in the window is a fast PASS — record it and move on.

---

## Part A: REST API wire contract (`/api/v1/*`)

**Contract:** stable wire format within `v0.x`; additive only. The precise contract is the OpenAPI spec.
**Files:** `packages/api/src/api/routes/openapi.ts`, `apps/docs/openapi.json` (generated), `packages/schemas/src/`, `packages/types/src/`, route handlers under `packages/api/src/api/routes/`

### Steps

1. **Spec-level diff** — the fastest wire-level signal:
   ```bash
   git diff "$LAST_TAG"..HEAD -- apps/docs/openapi.json
   ```
   Regenerate first if stale (`bun packages/api/scripts/extract-openapi.ts`). Classify every hunk:
   - Removed path / method / field / status code → **BREAKING**
   - New required request field, narrowed enum, changed default or validation → **BREAKING**
   - Changed auth requirements on an existing endpoint → **BREAKING**
   - New path, new optional field, new response field, new enum value → **ADDITIVE**
2. **Schema-level diff** — Zod schemas are the request-validation truth:
   ```bash
   git diff "$LAST_TAG"..HEAD --stat -- packages/schemas/src/ packages/types/src/
   ```
   For each changed schema, check the direction: `.optional()` removed, a field renamed, a `z.enum` narrowed, a passthrough tightened → breaking for existing clients even if the OpenAPI page didn't change (undocumented-but-shipped fields count — "an existing well-formed client would observe it").
3. **Semantics drift** — the diff can't show meaning changes. For endpoints whose *handler* changed but whose schema didn't, spot-check that existing parameters kept their semantics (default values, side effects, pagination behavior).

---

## Part B: MCP tool surface

**Contract:** tool set, names, and parameter shapes stable within `v0.x`; breaking changes ship under a **new tool name** (`executeSQL` → `executeSQL2`), never mutate in place.
**Files:** `packages/mcp/src/` (tool definitions: `datasource-tools.ts`, `query-tool.ts`, `plugin-tools.ts`, `mcp-dispatch.ts`, `prompts/`), `packages/api/src/lib/mcp/` (spine)

### Steps

1. ```bash
   git diff "$LAST_TAG"..HEAD --stat -- packages/mcp/src/ packages/api/src/lib/mcp/
   ```
2. For each changed tool definition, classify:
   - Renamed/removed tool, renamed required parameter, changed parameter or return shape **in place** → **BREAKING** (the "MCP client cached the old schema" failure mode the name-bump rule exists to prevent)
   - New tool, new optional parameter → **ADDITIVE**
   - Description/behavior improvements → **INTERNAL** (explicitly not a break per the contract)
3. If a break shipped correctly (new tool name + old name still exposed), verify the old name still resolves and the deprecation is noted in docs + release notes material.

---

## Part C: Plugin SDK (`@useatlas/plugin-sdk`)

**Contract:** `definePlugin()`, core lifecycle hooks, and the `AtlasPlugin` type signature stable within `v0.x`; new optional hooks/capabilities additive.
**Files:** `packages/plugin-sdk/src/` (esp. `index.ts`, `types.ts`, `helpers.ts`)

### Steps

1. ```bash
   git diff "$LAST_TAG"..HEAD -- packages/plugin-sdk/src/
   ```
2. Classify: removed/renamed export, hook signature change, required field added to `AtlasPlugin` → **BREAKING** (out-of-tree plugin authors compile against this). New optional hook/capability → **ADDITIVE**.
3. **Chat-plugin contract doc** — if the window touched `plugins/chat/src/`, `packages/api/src/lib/slack/`, or `packages/api/src/lib/integrations/install/*-oauth-handler.ts`, the table in [docs/architecture/chat-plugin-atlas-contract.md](../../docs/architecture/chat-plugin-atlas-contract.md) must have been updated in the same commits, and open ⚠ rows block closeout (shared check with /docs-audit K4 — don't double-report, cross-reference).

---

## Part D: Semantic layer wire format

**Contract:** entity / metric / glossary YAML schemas stable for documented fields; additive only; round-trippable across tags (a YAML authored on tag N-1 parses cleanly on tag N).
**Files:** `packages/api/src/lib/semantic/shapes.ts` (`EntityShape` — the wire-format SSOT), the YAML parsers under `packages/api/src/lib/semantic/`

### Steps

1. ```bash
   git diff "$LAST_TAG"..HEAD -- packages/api/src/lib/semantic/
   ```
2. Classify parser/shape changes: a field removed, retyped, or given new semantics → **BREAKING** (customer-authored YAMLs stop round-tripping). New optional field → **ADDITIVE**.
3. Round-trip spot-check when shapes changed: take a `semantic/entities/*.yml` from `$LAST_TAG` (`git show "$LAST_TAG":semantic/entities/<file>.yml`) and confirm the current parser accepts it.

---

## Part E: Published package export surface (`@useatlas/*`)

**Contract:** independent semver per package with the `0.0.x` exact-pin rule; removing/renaming a public export is a break for pinned consumers.
**Files:** `packages/{types,schemas,sdk,react,plugin-sdk,webhook-publisher}/src/index.ts` (+ package.json versions)

### Steps

1. Guard-first: `scripts/check-published-symbols.ts` and `scripts/check-unpublished-versions.ts` cover use-before-publish and forgotten-publish. Run them (or confirm the `drift` CI job is green on HEAD); audit only the residue below.
2. Export-surface diff per package:
   ```bash
   for p in types schemas sdk react plugin-sdk webhook-publisher; do
     git diff "$LAST_TAG"..HEAD -- "packages/$p/src/index.ts" | grep -E '^[-+]export' && echo "^^ packages/$p"
   done
   ```
   A `-export` line with no matching rename → **BREAKING** for that package; its version bump must reflect it and the release sequencing rules (publish before ref-bump, ≤3 tags per push) apply.

---

## Output Format

```markdown
## Semver Recommendation
**Recommended position: <patch|minor>** (major is reserved — see violations)
Basis: <one sentence — e.g. "2 additive REST endpoints + 1 new MCP tool → minor">

## Policy Violations (BREAKING changes on committed surfaces — CRITICAL)
| Surface | Change | Commit | Evidence | Remediation (revert / ship additively / recorded exception) |
|---|---|---|---|---|

## Additive Changes (drive minor)
| Surface | Change | Commit |
|---|---|---|

## Internal / No-Contract Changes (patch-eligible)
- <summarized, not exhaustive>

## Surfaces Unchanged This Cycle
- <surface>: 0 commits in window — PASS
```

---

## Execution

Establish `$LAST_TAG` first, then run 3 agents in parallel:

1. **REST wire contract** (Part A) — spec diff + schema diff + semantics spot-check
2. **MCP + Plugin SDK** (Parts B + C) — tool-surface and SDK-surface classification
3. **Semantic + Published packages** (Parts D + E) — wire-format round-trip + export diffs

Each agent returns its classification table with commit SHAs as evidence. Compile into the output format; the Semver Recommendation goes to `/release`. Any Policy Violation is a stop-the-line finding — raise it to the user before tagging, with the three remediation options.
