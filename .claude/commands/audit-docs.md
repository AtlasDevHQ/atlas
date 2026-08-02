---
description: "Cross-reference apps/docs against source code for stale, missing, or wrong documentation. Before releases or after large feature work."
---

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

Run 4 agents in parallel, one per audit domain. Each agent reads docs pages and cross-references against the authoritative source files — and **reads only its own part files** from the table below, not this whole command. Pass every agent the *Docs Layout* section above; all three audience trees are in scope for every part.

---

## Parts

Each part is a separate file — read only the ones you're running. `$ARGUMENTS` may name
part letters (`/audit-docs A D J`); with no argument, run every part in order. Part K is
end-of-cycle only.

| Part | Area | Risk | File |
|------|------|------|------|
| **A** | Environment Variables | HIGH | [`a-env-vars.md`](../../docs/agents/docs-audit/a-env-vars.md) |
| **B** | CLI Reference | HIGH | [`b-cli-reference.md`](../../docs/agents/docs-audit/b-cli-reference.md) |
| **C** | Configuration Reference | HIGH | [`c-configuration.md`](../../docs/agents/docs-audit/c-configuration.md) |
| **D** | API Endpoints / OpenAPI Spec | MEDIUM-HIGH | [`d-api-openapi.md`](../../docs/agents/docs-audit/d-api-openapi.md) |
| **E** | Plugin Documentation | MEDIUM | [`e-plugins.md`](../../docs/agents/docs-audit/e-plugins.md) |
| **F** | SDK & React Reference | MEDIUM | [`f-sdk-react.md`](../../docs/agents/docs-audit/f-sdk-react.md) |
| **G** | Error Codes | MEDIUM | [`g-error-codes.md`](../../docs/agents/docs-audit/g-error-codes.md) |
| **H** | Guide Accuracy Spot-Check | MEDIUM | [`h-guide-accuracy.md`](../../docs/agents/docs-audit/h-guide-accuracy.md) |
| **I** | Cross-Cutting Checks | LOW-MEDIUM | [`i-cross-cutting.md`](../../docs/agents/docs-audit/i-cross-cutting.md) |
| **J** | Undocumented Features | HIGH | [`j-undocumented.md`](../../docs/agents/docs-audit/j-undocumented.md) |
| **K** | Release-Cycle Scoping | end-of-cycle | [`k-release-cycle.md`](../../docs/agents/docs-audit/k-release-cycle.md) |

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
