# ADR-0009: Tag-organized roadmap

**Status:** Accepted
**Date:** 2026-05-28
**Context milestone:** v0.0.1 — Release Process Bootstrap
**Depends on:** [ADR-0008](./0008-versioning-and-release-tags.md)

> **Amendment (2026-05-28, same day):** Per the same-day amendment to [ADR-0008](./0008-versioning-and-release-tags.md), the tag train starts at `v0.0.1` (not `v0.1.0`), and `v0.1.0` is reserved for the public launch (July 2026). The milestone names and migration table below were updated to the `v0.0.x` scheme: `v0.0.1 — Release Process Bootstrap`, `v0.0.2 — REST Datasources`. The roadmap *structure* this ADR establishes (five sections, tag-organized) is unchanged.

## Context

[ADR-0008](./0008-versioning-and-release-tags.md) establishes git tags (`v0.0.1`, `v0.0.2`, …) as the third version train and the gate for prod deploys. Once tags become the unit of release, two adjacent structures are misshaped against them:

1. **GitHub milestones** are numbered against the internal `1.5.4` / `1.6.0` / `1.7.0` series. The numbers are unanchored from any deploy event and don't map to anything customer-facing. As of 2026-05-28, four open milestones: `1.5.4 — Test Suite Self-Containment`, `1.6.1 — CRM Lead Capture Hotfixes` (empty: 0 open / 8 closed), `1.7.0 — Generic REST / Non-SQL Datasources`, `Architecture Backlog`.
2. **`.claude/research/ROADMAP.md`** mirrors the milestone numbering with sections like `## Shipped Milestones (0.6.0 → 1.6.0)`, `## Active`, `## Planned`, `## Parked`, `## Closed parallel tracks`. The structure has accumulated five top-level groupings over 22 months of edits, with overlap between Active/Planned/Closed and the milestone list itself.

Both structures answer "what's the architectural roadmap" but neither answers "what's in the next tag" — the question that becomes load-bearing the moment git tags gate prod.

## Decision

**Tags become the organizing principle for milestones and the roadmap.** Both restructure to point at git tags as the primary axis; the previous internal-milestone numbering folds into history.

### GitHub milestone shape going forward

- **Milestones are named after tags.** `v0.0.1 — Release Process Bootstrap`, `v0.0.2 — REST Datasources`. The title prefix is the tag this milestone groups; the suffix is a short human label. Each pre-launch `v0.0.x` development tag gets a milestone (per ADR-0008, the `v0.0.x` series is the unit of pre-launch scope), as do post-launch minor tags (`v0.1.0`, `v0.2.0`, …).
- **True patches don't get milestones.** Patches of a launched minor (`v0.1.1`, `v0.1.2`) don't — they ship under the prior milestone's umbrella and inherit its issue list, or they ship pure-hotfix with no milestone at all.
- **One non-tag milestone persists: `Architecture Backlog`.** This is the holding pen for "we want to do this, no tag yet." Issues graduate out by being moved to a `v0.x.0` milestone when work begins.
- **Empty milestones get closed.** A milestone with 0 open issues and a stable tag-shipped state is closed; the issues remain searchable via the `milestone:` qualifier.

### `.claude/research/ROADMAP.md` shape going forward

Five sections, in order:

1. **`## Today`** — 1–2 paragraph snapshot of the product as it exists right now. No version numbers, no roadmap. Updated whenever the product shape changes materially. Audience: someone landing here cold who wants to know "what is Atlas, today?"
2. **`## Next: v<TAG> — <Label>`** — the current in-flight tag (`v0.0.1` today). Bullet list mirroring the milestone scope. One section, one tag.
3. **`## Planned tags`** — lightweight forward-look: "v0.0.2 likely includes REST datasources (#2868)." One line per tag, no committed scope. Updated as conviction firms up.
4. **`## Backlog`** — one-line pointer to the `Architecture Backlog` milestone. Detail lives in GitHub, not here.
5. **`## History`** — one-line pointer to `ROADMAP-archive.md`. All shipped milestone scope (currently `## Shipped Milestones (0.6.0 → 1.6.0)` + `## Shipped` collapsible + `## Closed parallel tracks`) moves to the archive verbatim.

The existing `## Active`, `## Planned`, `## Parked`, `## Closed parallel tracks` sections collapse. `Parked` content folds into `Backlog` (via the Architecture Backlog milestone) or into the archive's appropriate sections.

### Migration of the current open milestones

| Current title | Action | New title |
|---------------|--------|-----------|
| `1.5.4 — Test Suite Self-Containment` | Move single open issue (#2802) into `v0.0.1`, close | (closed) |
| `1.6.1 — CRM Lead Capture Hotfixes` | Already empty — close | (closed) |
| `1.7.0 — Generic REST / Non-SQL Datasources` | Rename via milestone ID (preserves issue links) | `v0.0.2 — REST Datasources` |
| `Architecture Backlog` | Unchanged | `Architecture Backlog` |
| (new) | Create | `v0.0.1 — Release Process Bootstrap` |

`v0.0.1 — Release Process Bootstrap` scope:
- #2802 (slice 6 cutover, parked on bun 1.4.0 GA)
- Stability Contract docs (new issue, per ADR-0008)
- ROADMAP restructure (this ADR's implementation)
- `/prod-audit` pre-launch pass (new issue)
- `/release` skill creation (new issue)

### Patches don't get milestones (restated)

Per ADR-0008, milestones exist for tags-that-scope-work — pre-launch `v0.0.x` development tags and post-launch minor tags. A post-launch `v0.1.1` hotfix tag does not create a `v0.1.1` milestone — the fix's PR references `v0.1.0` as the milestone if it's tracked at all, or no milestone if it's a one-shot.

### Two more decoupling moves

**Staging env build is NOT a v0.0.1 tag-cut gate.** The grilling session also produced a staging-environment design (Q1–Q4), captured separately in a PRD at `docs/prd/staging-environment.md`. Staging is on its own work track with a late-June target. `v0.0.1` ships when its bundle is ready (Stability Contract docs + #2802 + ROADMAP restructure + `/prod-audit` pass + `/release` skill); staging may or may not be live by then. The tag-gated Railway trigger (push tag → prod) needs staging to be useful; until staging lands, the trigger is "tag → prod" with no soak environment. That's acceptable for the v0.0.1 ship because everything in the v0.0.1 scope is docs + tooling, not runtime code.

**The `v0.0.x` train is decoupled from the public launch (`v0.1.0`).** `v0.0.1` cuts as soon as the bundle is ready. The public launch event (target: July 2026) is the `v0.1.0` tag — a separate moment that points at the banked changelog accumulated under the `v0.0.x` train: release-process plumbing, REST datasources (`v0.0.2`), staging live, etc. Cutting `v0.0.x` tags early gives weeks of staging-soak data and finds rough edges in the release-process plumbing before any customer is watching, while reserving `v0.1.0` to mean "publicly launched."

## Alternatives considered

### Keep internal milestone numbering, add git tags as a parallel namespace (rejected)

`1.7.0 — Generic REST / Non-SQL Datasources` ships under git tag `v0.0.2`; the milestone number and tag number drift independently. Tempting because it's the path of least disruption — nothing renames.

Rejected because the two-namespace world is exactly what we have today and it's confusing. The merge with `1.0.0 — SaaS Launch` ≠ `v1.0.0` collision (per ADR-0008) shows the cost. The shipped milestones (which can't be renamed without churning issue links) keep their numbers in the archive; new milestones use the tag name as the title.

### Keep `## Active` / `## Planned` / `## Parked` in ROADMAP.md (rejected)

The five-section shape has organic context — "Parked" means "we'd build this if signal appeared," distinct from "Backlog." But the distinction is rarely consulted; the file's actual readers (Claude sessions, the user mid-decision) want to know "what's the next tag, what's after that." Collapsing into `Today / Next / Planned / Backlog / History` matches actual usage.

### Patches get milestones too (rejected)

`v0.1.1 — bun 1.4 cutover` would be a tidy way to scope a hotfix. Rejected because patches by definition don't ship coordinated scope — they're single-fix or small-bundle. A milestone with 1–2 issues is signal noise. The auto-generated release notes from `gh release create --generate-notes` carry the issue list for patches.

## Consequences

**For GitHub:**
- One `gh api PATCH` to rename `1.7.0 — Generic REST / Non-SQL Datasources` → `v0.0.2 — REST Datasources` (milestone ID stays the same, so issue references survive).
- Three milestone ops: close `1.5.4` (after moving #2802 to `v0.0.1`), close `1.6.1` (empty), create `v0.0.1 — Release Process Bootstrap`.
- Going forward, new milestones use `v<MAJOR>.<MINOR>.0 — <Label>` shape.

**For `.claude/research/ROADMAP.md`:**
- Five-section restructure per above. Existing `## Shipped Milestones (0.6.0 → 1.6.0)` content (lines 108–146 as of `be59d9e5`) moves to the archive verbatim. The existing `## Shipped` collapsible (~80 lines) is already in the archive's voice and moves wholesale. `## Closed parallel tracks` content gets archived into the closest milestone's section.
- The `## North Star: 1.0.0 — SaaS Launch` section retires. The hosted SaaS at app.useatlas.dev is live; the next aspiration (frozen contracts → git tag `v1.0.0`) gets surfaced in `## Today` instead.

**For `ROADMAP-archive.md`:**
- Receives all migrated content. Existing entries unchanged (frozen history per the handoff).

**For new contributors / Claude sessions:**
- Single canonical question per file: "what's the next tag" → `ROADMAP.md ## Next`. "What's shipped" → `ROADMAP-archive.md`. "Where do new ideas go" → `Architecture Backlog` milestone.

**For CLAUDE.md:**
- Existing "Issue tracker" + "Triage labels" sections still apply unchanged. New rule: milestone titles use the `v<MAJOR>.<MINOR>.0 — <Label>` shape going forward.

**For the `/release` skill:**
- Closes a tag → reads the tag's associated milestone (if one exists) to summarize scope in the auto-generated release notes. Patches without milestones fall back to commit-list-since-last-tag.

## References

- Versioning + tag rules: [ADR-0008](./0008-versioning-and-release-tags.md)
- Operational release flow: `docs/development/release-process.md`
- Roadmap source: `.claude/research/ROADMAP.md` + `.claude/research/ROADMAP-archive.md`
- GitHub Issues + Milestones: https://github.com/AtlasDevHQ/atlas
