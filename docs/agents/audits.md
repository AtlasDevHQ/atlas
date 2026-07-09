# Audit commands: shared conventions

Conventions shared by the `-audit` family — `/docs-audit` (docs vs code), `/www-audit` (marketing/legal vs reality), `/prod-audit` (runtime readiness vs prod requirements). Each command reads this file before spawning its agents.

**Why this file exists:** a 2026-07 sweep found all three commands had drifted from the codebase — dead file paths, shipped features still described as open issues, checks that silently matched nothing (a grep against a file that no longer contained the pattern), and a security check whose success criterion was inverted for SaaS. Audit commands are snapshots of reality, and reality moves. These conventions are the mechanics that make drift self-announcing instead of silent.

---

## Step 0 — self-verify the command before trusting it

Before spawning agents, extract every repo path the command file references and confirm it exists:

```bash
CMD=.claude/commands/<command>.md
grep -oE '(packages|apps|ee|plugins|scripts|deploy|create-atlas|docs)/[A-Za-z0-9_./*-]+' "$CMD" \
  | sed 's/[.,)`]*$//' | sort -u | while read -r p; do
    case "$p" in
      *\**) compgen -G "$p" > /dev/null || echo "MISS $p" ;;
      *)    [ -e "$p" ] || echo "MISS $p" ;;
    esac
  done
```

Triage each `MISS` — placeholders (`foo.mdx`, `<handler>.ts`), prose fragments the regex over-matched, and paths the command *describes as absent* are expected false positives; a real reference that no longer exists means the command has drifted. Handle real drift as part of the run:

1. Find where the thing moved (or confirm it was removed) and **fix the command file in the same session** — the audit's first deliverable is a correct audit.
2. Add an "Audit-command drift" section to the report so the fix is visible.
3. A check whose source path is gone has been **silently passing** — re-run that check against the real location before reporting PASS for its domain.

## Discover, don't enumerate

Every hardcoded list in a command (routes, plugins, env vars, regions, page surfaces) is **illustrative**; the discovery command next to it is **authoritative**. When writing a new check, phrase the source of truth as a command (`ls`, `grep`, `find`) with the current snapshot as a hint — never as a bare list an agent could trust without looking. A list with no discovery command beside it is a bug in the command.

## Guard-first: run the existing gate, audit only the residue

If a fact is already enforced by a CI guard or generator, the audit **runs the guard** instead of re-deriving the fact:

- schema ↔ migration mirrors → `scripts/check-schema-drift.sh`
- two-phase drop discipline → `scripts/check-migration-rename-discipline.sh`
- SaaS env-var docs page → `scripts/check-saas-env-doc.sh` (page is generated — never hand-diff)
- OpenAPI docs → `bun packages/api/scripts/extract-openapi.ts && git diff apps/docs/openapi.json`
- ee-import boundary → `scripts/check-ee-imports.sh`

The audit's manual checks cover only what no guard covers. **The ratchet:** when an audit finds the same *class* of drift in two separate runs, that's the signal to promote the check to a CI guard (or generator) and delete the manual step from the command. Audits are the nursery for CI gates, not a permanent home.

## State snapshots decay — verify before flagging

Issue numbers, "currently X", "shipped in Y", and "#NNNN tracks this, it is not done" are hints frozen at write time. Before flagging a finding that depends on one, check the current state (`gh issue view NNNN -R AtlasDevHQ/atlas`, or read the code). Two real failure modes:

- **Shipped-but-still-"open"**: the command says a feature is a tracked gap; it shipped months ago. Flagging it wastes a finding and erodes trust in the report.
- **Snapshot-as-permission**: the command asserts "we do not hold certification X" — if that changed, the assertion inverts a CRITICAL check. Reality outranks the command text.

When you correct one of these, update the command file (Step 0 discipline applies to state, not just paths).

## Memory files are optional; the repo is the fallback

Commands may cite session-memory files (`memory/railway.md`, `reference_openstatus.md`, …). Those live in user-level memory and don't exist in remote or fresh sessions. When absent: fall back to the in-repo source named alongside them, and mark anything only memory could answer as "operator should verify". In-repo SSOTs:

- **Deployed services/regions/domains** → the `deploy/` directory (one subdirectory per service: `api`, `api-eu`, `api-apac`, `web`, `www`, `docs`, `dns`)
- **SaaS boot contract** → `SAAS_ENV_KEYS` in `packages/api/src/lib/effect/saas-env.ts`
- **Sub-processor list** → `apps/www/data/sub-processors.json`

## The docs three-tree layout

Referenced by `/docs-audit` and `/www-audit`'s docs cross-checks. Roots are disjoint (`CONTENT_ROOTS` in `apps/docs/src/lib/audience-taxonomy.ts`); a build-time gate enforces placement, but content-level audience drift is audit work.

| Tree | Audience class | Served at |
|------|---------------|-----------|
| `apps/docs/content/docs/` | `saas-only` | `/` (site root) |
| `apps/docs/content/self-hosted/` | `self-hosted-only` | `/self-hosted` |
| `apps/docs/content/shared/` | `shared` | **both** mounts |

Link resolution: a root path resolves to `docs/` or `shared/`; a `/self-hosted/...` path resolves to `self-hosted/` or `shared/`. Any grep over docs content covers all three trees.

## Release-cycle window

When an audit runs as an end-of-cycle gate (before `/release`), scope discovery-style parts to the commits since the last tag:

```bash
git fetch --tags origin        # remote/ephemeral clones often lack tags
LAST_TAG=$(git describe --tags --abbrev=0)
```

Reference-drift parts (does the docs table match the code) still run unscoped — drift accumulates regardless of when it was introduced. `/docs-audit` Part K is the worked example.

## Report discipline

Shared across all three commands: severity ladder CRITICAL > HIGH > MEDIUM > LOW; fix trivial issues (< 5 lines) directly; file GH issues for larger gaps (labels per each command's Execution section); never re-file a gap an open issue already tracks — cite the issue instead. Each command keeps its own output-table columns (Doc File / Page / Path) since the audited surface differs.
