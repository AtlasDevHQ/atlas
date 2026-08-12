---
description: "Cross-reference README.md against the shipped product — stale pillar coverage, drifted counts, dead commands, wrong package tree. The repo front door drifts because feature work never touches it. Before launches or after a pillar ships."
---

# README Accuracy Audit

Cross-reference `README.md` against the shipped product. The README is the repo's front door — the first thing a GitHub visitor, a prospective contributor, and an LLM crawling the repo all read.

**Mode:** Read-only audit — generate a report with findings. Fix factual drift (< 5 lines, unambiguous) directly. **Positioning changes are the maintainer's call — propose, don't apply.**

**Why this is its own command:** `/audit-www` covers `apps/www`, `/audit-docs` covers `apps/docs`. The README is covered by neither, and it drifts by a mechanism the other two don't share: **nothing in the normal shipping loop touches it.** A milestone can add an entire product pillar — Knowledge Base, dashboards, the brain — and never open `README.md`, because no gate, no route, and no test points at it. Its drift is therefore *omission-shaped* rather than contradiction-shaped: what's written stays true while quietly describing less and less of the product.

**Before starting:** read [docs/agents/audits.md](../../docs/agents/audits.md) (shared audit conventions) and run its **Step 0 self-check** against this command file — fix any drifted references here as part of the run. *Last verified against the codebase: 2026-07-27.*

---

## Execution Strategy

Small surface, one file. Run **3 agents in parallel** — Coverage (A), Verifiable claims (B–C), Mechanics (D–F) — then synthesize. Do not fan out per-section; the sections share too much context.

**Discover, don't enumerate.** Every list below is a worked example from the last run, not an inventory. Read `README.md` top-to-bottom first and build the claim list from what's actually there.

---

## Part A: Pillar coverage (the omission class — HIGHEST VALUE)

**This is the part that finds real problems.** The others find typos.

**Source of truth:** `CLAUDE.md` "Orientation", `docs/adr/` (each ADR is a shipped subsystem), `.claude/research/ROADMAP.md` History.

### Steps

1. Enumerate the product's shipped pillars from ADRs + CLAUDE.md Orientation. Not planned ones — **shipped**.
2. For each, grep the README for any mention:
   ```bash
   for t in knowledge dashboard brain residency durable "answer style" learned "semantic layer" MCP widget; do
     printf "%-16s %s\n" "$t" "$(grep -ci "$t" README.md)"
   done
   ```
3. A pillar with **0 hits** that has a shipped ADR is a finding. Rank by how central it is to the current positioning.

| Check | Severity |
|---|---|
| Shipped pillar with an ADR, 0 README mentions | **HIGH** — the README describes a smaller product than exists |
| Pillar mentioned only inside the `ee/` license paragraph | MEDIUM — present but not positioned |
| README leads with a framing the product has outgrown | **HIGH** — propose, don't rewrite; positioning is the maintainer's call |
| Planned/unshipped work described as present | **CRITICAL** — this is the inverse error and is worse |

**Worked example (2026-07-27):** README had **0 mentions** of Knowledge Base, dashboards, learned patterns, answer styles, and durable sessions — five shipped subsystems, two with their own ADRs (0028, 0029). It described Atlas purely as semantic-layer text-to-SQL, which was the whole product around `v0.0.20` and roughly half of it by `v0.1.0`.

---

## Part B: Counted and enumerated claims

Any number or list in the README is a claim with a shelf life.

### Steps

1. Extract every count and enumeration — plugin count, chat-platform count, database list, package tree, validation-layer count, dataset row counts.
2. For each, find the authoritative source **on disk**, not in another doc.
3. **Guard-first:** check whether a `scripts/check-*.sh` gate already locks it. If one does, run it rather than hand-counting — the gate encodes the counting rule, and hand-counting will disagree with it.

```bash
ls scripts/ | grep -i check          # what's already ratcheted
bash scripts/check-plugin-count.sh   # canonical plugin count + counting rule
```

| Claim | Authority | Note |
|---|---|---|
| Plugin count | `scripts/check-plugin-count.sh` | **Gated.** `ls plugins/ \| wc -l` will over-count — the rule excludes non-plugin dirs |
| Chat platforms | `plugins/chat/src/adapters/` + `implementation_status` in `deploy/api/atlas.config.ts` | Adapter file ≠ installable. See Part C liveness rule |
| Package tree | `ls packages/` | Compare every entry against the ASCII tree |
| Database support | `plugins/` datasource plugins + built-in Postgres | |
| Validation layers | `.claude/rules/api-sql-security.md` | Canonical phrasing is locked across surfaces |

**Worked example (2026-07-27):** the "24 plugins" claim was **correct and gated** — `ls plugins/` returns 25, but `check-plugin-count.sh` excludes one directory. Hand-counting would have produced a false finding. Meanwhile the package tree was silently missing 4 of 14 packages (`oauth-helper`, `okf-bundle`, `fumadocs-okf`, `webhook-publisher`) — ungated, so nothing caught it.

---

## Part C: Liveness claims (verify the premise before reporting)

**The trap:** "X is coming soon" and "N platforms supported" look like drift and usually aren't. Reporting them without verifying wastes a cycle and, worse, invites a "correction" that makes the README *less* accurate.

**Rule:** before flagging any liveness claim, resolve it against the install gate, not the file listing. A built adapter that is `coming_soon` in the catalog is **not** shipped, and an adapter file existing proves nothing.

```bash
grep -n "implementation_status" deploy/api/atlas.config.ts | head -20
```

| Check | Severity |
|---|---|
| README says "coming soon" for something now `available` | HIGH — understates the product |
| README says shipped for something still `coming_soon` | **CRITICAL** — overstates; this is a buyer-facing lie |
| Count includes built-but-not-wired adapters | MEDIUM — decide whether the count means *built* or *installable*, then state it once |

**Worked example (2026-07-27):** README's "six chat platforms … Google Chat coming soon" *looked* like drift — 8 adapter files exist, and www had been corrected days earlier. It was **correct**: `gchat` is the only `coming_soon` entry, and GitHub/Linear are action targets, not chat. See `feedback_verify_audit_liveness_premise`.

---

## Part D: Every command must actually run

The README's code blocks are its most-copied content and its least-tested.

### Steps

1. Extract every shell command, install command, and package name.
2. For each published package referenced, confirm it exists at the named scope:
   ```bash
   npm view <pkg> version
   ```
   **Watch the scope split.** `@atlas/*` is internal and unpublished; `@useatlas/*` is public. A README command naming an `@atlas/*` package is broken for every reader. Note that the public `@useatlas/mcp` and the internal `@atlas/mcp` (`packages/mcp`, `private: true`) are **different packages** — the installer is not the server.
3. Confirm scaffold/deploy commands against the actual scripts (`bun run` script list, `create-atlas/`).
4. Confirm every starter repo linked under Deploy still exists and is public.

| Check | Severity |
|---|---|
| Command references an unpublished package | **CRITICAL** |
| Starter repo 404s or is private | **CRITICAL** |
| Flag/subcommand no longer exists | HIGH |
| WSL2 / platform caveat missing where the repo knows one exists | LOW |

---

## Part E: Security and architecture tables

The README's Security table is a **public claim about isolation**, which puts it in the same risk class as `/security` on www — see `/audit-www` Part B.

### Steps

1. Compare the isolation-tier row against the real backends: `packages/api/src/lib/tools/backends/` + sandbox plugins.
2. Grep for any named technology in the table; confirm it's a tier Atlas *selects*, not an implementation detail of a vendor.
3. Compare the validation-pipeline description against `.claude/rules/api-sql-security.md`.

| Check | Severity |
|---|---|
| Names an isolation tier Atlas doesn't implement | **HIGH** — overstates containment |
| Omits the tier that is actually the default in prod | **HIGH** — misleads self-hosters about what they're getting |
| Validation-layer copy diverges from the canonical phrasing | MEDIUM |

**Worked example (2026-07-27) — VERIFIED FIXED 2026-08-12, do not re-derive.** The table read "nsjail / Firecracker / sidecar". **Firecracker is not an Atlas tier** — it appears in the codebase only as a comment about Vercel Sandbox's underlying MMDS. The row simultaneously omitted `vercel-sandbox`, which is the actual SaaS default. `README.md:243` now reads "Vercel Sandbox, nsjail, or the sidecar — with e2b, Daytona, and Railway available as bring-your-own-cloud backends": Firecracker is gone and the SaaS default is named. Re-check that it still holds; don't re-open it from scratch.

---

## Part F: Links, badges, licensing

1. Every `docs.useatlas.dev/*` link resolves (the docs tree moves; `/getting-started/*` vs `/guides/*` split has churned).
2. Badges point at live workflows and real npm packages.
3. The license paragraph's package lists match the actual AGPL / MIT / commercial split — cross-check `packages/*/LICENSE` and `ee/LICENSE`.
4. Any package named in a license sentence still exists.

---

## Report

Group by severity, then by part. For each finding: the README line, the claim, the authority that contradicts it, and the proposed fix.

**Separate the two piles explicitly** — they need different permission:

- **Factual drift** — wrong count, dead link, unpublished package, non-existent isolation tier. Fix inline; these have a right answer.
- **Positioning gaps** — a pillar the README doesn't cover, a framing the product outgrew. **Propose only.** What the front door leads with is a product decision, not an accuracy one, and an agent should never quietly re-position someone's project.

### Promote-to-CI ratchet

Per the shared conventions: when a finding is mechanically checkable and recurred, propose a `scripts/check-*.sh` gate rather than just fixing it. `check-plugin-count.sh` is the worked precedent — it's why the plugin count is the one README number that has never drifted.

Strong candidates surfaced so far:
- **Package-tree parity** — `ls packages/` vs the README ASCII tree is a 10-line gate and has already drifted once.
- **Published-package existence** — every `@useatlas/*` named in the README resolves on npm.
