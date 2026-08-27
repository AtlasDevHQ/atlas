# Docs accuracy audit — 2026-08-27

Window: `8d2a638a` (2026-07-10, the last docs audit's roll-up #4497) → `9822893` (~740 commits).
Method: the four-agent split from the retired `/audit-docs` runbook (env+config / CLI+API / plugins+SDK+errors / guides+cross-cutting+discovery), run against all three content trees. Fixes landed on `claude/docs-audit-updates-dp6a1n` in four commits, one per domain.

## Headline results

- **The docs tracked a ~316k-line window far better than the ratio suggested.** The Company Atlas 7-guide suite, dashboards (ADR-0029), the Query Cache overhaul (#4545–#4551 — including the removed `cache:` block), learned patterns, KB plan caps, all four new KB connectors, and the agent-auth POST allowlist were all already documented and accurate — several brain guides current to commits merged the same day as the audit.
- **Both generated surfaces were FRESH**: `openapi.json` + all 106 api-reference MDX dirs regenerate byte-identical; `check-saas-env-doc.sh` green (25 keys).
- Zero hard-404 internal links; zero fork pairs; error-codes.mdx fully in sync; every documented `ATLAS_*` var resolves to real code.

## What was fixed (by domain)

1. **Plugins/SDK** — the #3414/#4665 Python execution surface was entirely undocumented (e2b/daytona pages, sandbox index, authoring guide); sdk.mdx `QueryResponse` was missing `runId`/`pendingApproval`/`planWarning`; chat.mdx missed `onBridgeReady`/`observeMessage`; assorted smalls (twenty catalog card, `searchBrain` in the native-tool list, `runPython`→`executePython`).
2. **Env/config** — `ATLAS_DATASOURCE_EXPECTED`/`datasourceExpected` (#4854), `ATLAS_RECOMMENDED_MODELS`, the 5 backup-S3 vars + scheduled-backup kill switch, the stale 5-minute cookie-cache claim (real default 30s), six missing brain keys + the stale gateway default model in `.env.example`.
3. **CLI/API** — `ops sweep-residue` (#5187) and `ops gate-export` (#5335) missing from cli.mdx; **stability.mdx was falsified by the window**: seven documented data-plane endpoints removed under ADR-0034/0035 with no acknowledgment — fixed by adding a "Removals within v0.x" ledger (record-or-bug posture) and scoping the additive-only claim. Three CLI help-string drifts fixed in code (missing `publish`, missing `gate-export`, ADR-0043→0044 citation).
4. **Guides** — atlas-sources' warehouse row still said "no producer ships yet" (it shipped, as observations per ADR-0042); the four `/admin/brain/*` surfaces had no guide layer (added a Company Atlas section to admin-console.mdx); the #5498 `x-atlas-write-confirm-ui` gate had zero coverage (documented in openapi-generic + react.mdx); plus searchBrain in mcp.mdx, ADR-0038 naming in data-residency/knowledge-base, semantic-expert audience + window features, learned-patterns injection count, platform-tier settings writes, two SaaS-tree env-var prerequisite nits.

## Deliberately not fixed (needs an owner's decision)

- **26 self-hosted-tree links exit into the SaaS tree** (e.g. `/guides/troubleshooting`, `/guides/slack` from `self-hosted/**`). Not 404s — but the reader silently changes audience. Worth one deliberate decision (move shared-worthy targets to `shared/`, or bless the convention), not 26 accidental ones.
- **Release-notes follow-up for the stability ledger**: if the ADR-0034/0035 endpoint removals shipped in a v0.x tag, that tag's changelog entry should carry them under a Breaking/Removed label — the ledger records them, but `/release` owns the changelog.
- `ATLAS_LOG_STDERR` left undocumented on purpose (code comment says CLI-internal, never set in deployments).
