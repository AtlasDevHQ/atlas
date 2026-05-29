# ADR-0008: Versioning and release tags

**Status:** Accepted
**Date:** 2026-05-28
**Context milestone:** v0.0.1 — Release Process Bootstrap
**Depends on:** none
**Related:** [ADR-0009](./0009-tag-organized-roadmap.md)

> **Amendment (2026-05-28, same day):** The original decision started the git-tag train at `v0.1.0`. Revised the same day — before any non-premature tag was cut — to start at **`v0.0.1`** and reserve **`v0.1.0` for the public launch** (target July 2026). Rationale: there is a month+ of pre-launch runway, and stamping a docs/tooling bundle as `v0.1.0` overclaims maturity. A `v0.0.x` development train makes the pre-1.0 contract status *more* legible, not less, and leaves `v0.1.0` to mean something — "Atlas is publicly launched." The premature `v0.1.0` tag + GitHub release cut earlier today were deleted (no customers existed, so no external reference broke). The `v0.0.1`-prefixed sentences below reflect the amended decision; the old "start at v0.1.0" reasoning is preserved under § Alternatives considered.

## Context

Atlas has been shipping continuously into production via merge-to-`main` since the 1.0.0 SaaS launch (internal milestone #24). There are no public version numbers. The repo carries three coexisting version namespaces that have been quietly drifting:

1. **Internal milestone numbers** (`1.5.4`, `1.6.0`, `1.7.0`) — track architectural progress. These were never customer-facing; they live in GitHub Milestone titles, `ROADMAP.md` headings, and CHANGELOG section labels. The numbers are unanchored — `1.0.0 — SaaS Launch` (#24) shipped in 2026-03 but the API surface is not frozen and there's been no public commitment that it is.
2. **`@useatlas/*` npm package versions** (e.g. `@useatlas/types@0.1.6`, `@useatlas/sdk@0.0.14`) — each package carries independent semver. The 0.0.x exact-pin rule (`^0.0.2` ≠ `0.0.3`) is documented in CLAUDE.md.
3. **The product itself** — has no git tag, no release identifier, no published version. Every Railway deploy of `main` is the "current" Atlas.

Three problems fall out:

- **Hotfix attribution is hard.** A regression discovered on prod is "the version that's running right now," not "version X.Y.Z." Operators can't say "we're on 0.6.2, please patch 0.6.x" — there is no 0.6.x.
- **No staging gate before prod.** Every merge-to-`main` deploys directly to prod across 6 Railway services. The grilling-session decision (Q5) introduces a dual Railway trigger: `main` → staging, annotated git tag → prod (via a dedicated `prod` branch advanced only by `/release` — see § Release branches for the wiring rationale). That requires git tags to exist as a release-identifier namespace.
- **The `1.0.0 — SaaS Launch` milestone collides with the future git tag `v1.0.0`.** They mean different things. The internal milestone shipped the hosted-SaaS launch event (3 regions live). The future git tag `v1.0.0` will mean "REST + MCP + plugin contracts are frozen" — a much stronger commitment, not yet earned.

The grilling-session decision: introduce git tags as the **third independent version train**, sized for "what gates a deploy to prod" — not for marketing milestones, not for npm package coordination.

## Decision

**Three independent version trains. None of them coordinate. Each train answers a different question.**

| Train | Format | Answers | Authoring surface |
|-------|--------|---------|-------------------|
| Git tags | `v0.0.1`, `v0.0.2`, `v0.1.0` (semver) | "What ships to prod?" | `/release` skill, `gh release create` |
| Internal milestones | Tag-named going forward (`v0.0.1`, `v0.0.2`, `Architecture Backlog`) | "What scope is grouped together?" | GitHub Milestones |
| npm packages | Per-package semver (`@useatlas/types@0.1.6`) | "What's the public package contract?" | `package.json` + `npm publish` |

The git-tag train **starts at `v0.0.1`** (not `v0.1.0`, not `v1.0.0`), cut as soon as the v0.0.1 bundle is ready. The `v0.0.x` series is the **pre-launch development train**: each bump banks a milestone of pre-launch work (release-process bootstrap, REST datasources, …) and gives prod a real release identifier without claiming the product is publicly launched. The internal milestone `1.0.0 — SaaS Launch` (#24) keeps its number in the archive as a historical record of the SaaS-launch event but is **not** the git tag `v1.0.0`; that tag is reserved.

**`v0.1.0` is the public launch (target: July 2026).** The first minor bump out of the `v0.0.x` development train marks the public launch announcement — the moment Atlas is presented to the world with a banked changelog (the accumulated `v0.0.x` train: release-process plumbing, REST datasources, staging environment live, etc.). Cutting `v0.0.x` tags now validates the release-process plumbing on low-stakes surfaces while nobody is watching; `v0.1.0` is held back so it means something. The launch event is tracked outside the tag train (#2919).

### Semver discipline rules for git tags

| Change type | Tag bump | Examples |
|-------------|----------|----------|
| Frozen-contract break (REST/MCP/plugin) | **Major** | `/api/v1/*` removal, MCP tool rename, plugin SDK breaking change |
| Public launch | **Minor → `v0.1.0`** | The July 2026 launch event; first minor out of the `v0.0.x` train |
| Customer-visible behavior break, no contract | **Minor** (post-launch) | UI redesign that changes admin workflow, new required env var, removing a deprecated flag |
| New feature, no break | **Minor** (post-launch) / **patch** (pre-launch `v0.0.x`) | New integration, new admin page, new agent tool |
| Bug fix / refactor / perf / docs | **Patch** | Schema drift fix, hotfix for a prod regression, dependency bump |
| Hotfix on prod | **Patch** (immediately, no waiting) | Tag the fix as `v0.x.(y+1)` right away — don't batch with the next bump |

During the **pre-launch `v0.0.x` phase**, the patch position is where development milestones land (`v0.0.1`, `v0.0.2`, … each a meaningful chunk of pre-launch work) — the same convention Atlas already uses for `@useatlas/*` npm packages, where every `0.0.x` bump is significant. Once `v0.1.0` (public launch) ships, the standard minor/patch split applies.

The contract-vs-not-contract distinction is the load-bearing one. Git-tag `v1.0.0` is **reserved for the moment all three frozen contracts are committed**:

1. `/api/v1/*` REST endpoints — breaking changes only via `/api/v2/*` rollout with 12-month deprecation window
2. MCP tool surface — additive only within a major; breaking changes bump the tool name (`executeSQL` → `executeSQL2`)
3. Plugin SDK — `@useatlas/plugin-sdk` 1.0 stable

Customer-facing details for these contracts live at [docs/reference/stability](../../apps/docs/content/docs/reference/stability.mdx). The semantic layer wire format (`semantic/*.yml` entity / metric / glossary schemas) is also a stable contract — customer-authored YAML must round-trip across tags — and breaking changes follow the same v2-style rollout as REST. Everything else (agent behavior, chat UI, dashboards, admin console) may evolve within `v0.x` git tags without bumping major.

### No pre-release tags

No `v0.0.1-rc.1`, no `v0.0.1-beta`, no `v0.0.1-alpha`. The dual Railway trigger gives us staging as the soak environment; pre-release tags would be a third namespace that nobody needs. If a tag needs a hotfix, the next patch tag is the rollout.

### Annotated tags only

`git tag -a v0.0.1 -m "<summary>"` — never `git tag v0.0.1`. Annotated tags carry the author, timestamp, and message; lightweight tags don't. The `/release` skill enforces this.

### Release branches: none

No `release/v0.0.x` branches. `main` is the single integration branch. A hotfix on prod is: branch from `main`, fix, merge to `main`, tag immediately. If `main` has drifted ahead of the prod tag, the hotfix lands on `main` and the tag captures the cumulative diff — that's intentional (avoids the maintenance overhead of cherry-picking onto a release branch for a solo maintainer).

**The `prod` branch is not a release branch.** It exists as a Railway-tracking artifact: a single-pointer ref that `/release` fast-forwards to each tag's SHA, so Railway's branch-driven autodeploy can fire the prod deploy. No PR ever targets `prod`. No work happens on `prod`. It does not version, fork, or accumulate state. Branch protection blocks PRs and direct pushes; only the `/release` skill (`git push origin <tag-sha>^{}:prod --force-with-lease`) advances it. This exists because Railway has no native tag-trigger and the Railway CLI cannot deploy an arbitrary SHA on a GitHub-linked service — `railway up` ships a local tarball, severing the GitHub Deployments link. The prod-branch tracker is the simplest composable primitive that preserves Railway autodeploy semantics.

### Patches don't get milestones

GitHub milestones exist for **minor tags** (`v0.1.0`, `v0.2.0`, …) plus each **pre-launch `v0.0.x` development tag** (`v0.0.1`, `v0.0.2`, …), since the latter are the unit of pre-launch scope. True patches of a launched minor (`v0.1.1`, `v0.1.2`) just get tags + auto-generated release notes via `gh release create --generate-notes`. This keeps the milestone list short and meaningful.

## Alternatives considered

### Start the tag train at `v0.1.0` (rejected — this was the original decision, reversed same-day)

The first cut of this ADR started the train at `v0.1.0`: "start fresh at `v0.1.0` (not `v0.0.1`, not `v1.0.0`), cut as soon as the bundle is ready," with the public launch as a separate later event pointing at banked `v0.1.x` patches. Rejected on reflection: the launch is a month+ out, and the first tagged bundle is docs + tooling (the release-process plumbing). Calling that `v0.1.0` spends the most legible pre-1.0 signaling number on a non-feature and leaves nothing distinct to mark the actual public launch. Starting at `v0.0.1` keeps the development train honestly labeled as early, and reserves `v0.1.0` to mean "publicly launched." With no customers yet, the reversal cost nothing — the premature `v0.1.0` tag + release were deleted and renumbered.

### Calendar versioning (rejected)

`2026.05.0`, `2026.05.1`, etc. Tempting because Atlas is continuous-delivery, but loses the semver signal that customers need to gauge upgrade risk. The frozen-contract → major-bump rule is the actual contract being made; calver would obscure it.

### Single shared version (rejected)

Bump every train together — npm package versions match the git tag, milestone numbers match the git tag. Rejected because the trains have different cadences: `@useatlas/types` ships independently every few days for a brand type addition; git tags ship on demand; milestones are sprint-shaped. Forcing coordination would either freeze the fast-moving trains or churn the slow-moving ones.

### Start at `v1.0.0` (rejected)

"Atlas is in prod, paying customers — call it 1.0." Tempting but breaks the frozen-contract semantic. Customers signing up today understand that Atlas is pre-1.0; the SaaS works, but the REST API may change between minor tags. Starting at `v0.0.x` makes the contract status legible. `v1.0.0` is reserved for when we commit to the frozen-contract triple.

### Pre-release tags (rejected)

`v0.0.1-rc.1` on staging, `v0.0.1` on prod. Rejected — staging is gated by the `main` Railway trigger, not by a tag. Tags exist for prod deploys; that's the whole point. A pre-release namespace would add ceremony without changing what ships where.

## Consequences

**For deploys:**
- The dual Railway trigger (Q5) hangs off this ADR. `main` push → staging autodeploy (3 services: api/web/www). Annotated tag → `/release` fast-forwards `prod` branch to the tag SHA → prod autodeploy across 5 services (api/api-eu/api-apac/web/www). `docs` continues watching `main` directly. See `docs/development/release-process.md`.
- The first prod deploy under tag-gating was `v0.0.1`, cut 2026-05-29 (`9c68fc17`). The prior "every merge to `main` auto-deploys prod" flow is retired. The public launch (`v0.1.0`, July 2026) is a separate event, tracked independently.

**For CHANGELOG.md:**
- The existing `CHANGELOG.md` link to `CLAUDE.md#versioning--release-strategy` resolves to this ADR going forward. CHANGELOG sections will be reorganized around git tags (`## v0.0.1 — 2026-05-XX`) once tagging starts; internal-milestone-labeled sections remain in place as historical record.

**For internal milestones:**
- Going forward, GitHub milestone titles use the tag name as a prefix: `v0.0.2 — REST Datasources` (rename of `1.7.0 — Generic REST / Non-SQL Datasources` per [ADR-0009](./0009-tag-organized-roadmap.md)).
- The shipped `1.0.0 — SaaS Launch` milestone (#24) is **not renamed**. It keeps its number as a historical anchor for the SaaS-launch event. Reference it as "internal milestone 1.0.0" to disambiguate from the future git tag `v1.0.0`.

**For npm packages:**
- No change. `@useatlas/*` packages continue with independent semver. The 0.0.x exact-pin rule continues.
- A frozen `@useatlas/plugin-sdk@1.0.0` is one of the three commitments required to bump the git tag train to `v1.0.0`. The other two (REST + MCP) live in the Atlas server itself.

**For CLAUDE.md:**
- The existing "Versioning" section (currently: "Public semver starts fresh post-v1.0 as beta 0.0.1") is wrong and gets replaced by a pointer to this ADR. `v0.0.1` is the first git tag; `v0.1.0` is reserved for the public launch, not a beta after v1.0.

**For the `/release` skill:**
- New skill at `.claude/commands/release.md` bundles `/ci` + annotated tag + push + `gh release create --generate-notes`. See the release-process doc for the operational flow.

## References

- Tag-organized milestone shape: [ADR-0009](./0009-tag-organized-roadmap.md)
- Operational release flow: `docs/development/release-process.md`
- Customer-facing stability commitments: `apps/docs/content/docs/reference/stability.mdx`
- Branch protection (the gate tags pass through): `docs/development/branch-protection.md`
- 0.0.x exact-pin npm rule: CLAUDE.md "Publishing `@useatlas/*` packages"
