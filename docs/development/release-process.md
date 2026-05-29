# Release process

How Atlas ships to prod. Two flows: **normal release** (merge → soak → tag) and **hotfix** (merge → tag immediately).

> **Live as of `v0.0.1`** (first tag of the pre-launch `v0.0.x` train, cut 2026-05-29 at `9c68fc17`): the dual Railway trigger described below is the active flow — `main` → staging, annotated tag → `prod` branch → prod. The pre-`v0.0.1` "every merge to `main` auto-deploys prod" flow is retired. The public launch (`v0.1.0`, target July 2026) is tracked separately and points at the banked changelog accumulated under the `v0.0.x` train.

## Mental model

- **`main`** is the single integration branch. Every merge to `main` triggers a deploy to **staging** across 3 services (`api-staging`, `web-staging`, `www-staging`). `docs` continues to deploy direct from `main` to its production service — static export + Caddy, no runtime surface to gate.
- **Annotated git tags** (`v0.0.1`, `v0.0.2`, `v0.1.0`) gate **prod**. The wiring: `/release` creates the tag, then fast-forwards a dedicated `prod` branch to the tagged SHA via `git push origin <tag-sha>^{}:prod --force-with-lease`. The 5 prod services (`api` / `api-eu` / `api-apac` / `web` / `www`) watch the `prod` branch; the branch push triggers their Railway autodeploys.
- **Tags are the prod gate.** A merge to `main` does not reach customers until `/release` advances `prod`.

Why a `prod` branch instead of a direct tag trigger: Railway has no native git-tag trigger and the Railway CLI cannot deploy an arbitrary SHA on a GitHub-linked service (`railway up` ships a local tarball and severs the GitHub Deployments link). The prod-branch tracker is the simplest composable primitive that preserves Railway's branch-driven autodeploy semantics, the GitHub Deployments integration, and the option to layer "Wait for CI" on prod services. The `prod` branch is a Railway-tracking artifact, not an integration branch — no PR ever targets it, no work happens on it. See [ADR-0008 § Release branches: none](../adr/0008-versioning-and-release-tags.md#release-branches-none) for the longer reasoning.

Why two triggers: a single push trigger (the status quo) couples merge to prod, which means a half-day's worth of PRs lands together and any of them can break prod with no soak window. Splitting via the `prod` branch lets us batch a coherent release, watch it on staging, then promote.

See [ADR-0008](../adr/0008-versioning-and-release-tags.md) for the versioning rationale and [ADR-0009](../adr/0009-tag-organized-roadmap.md) for the milestone shape that aligns with tags.

## Normal release

```
PR → /ci → /pr → review → merge to main
            ↓
       staging deploy (auto, ~5 min)
            ↓
       soak (visual check / smoke / dogfood)
            ↓
       /release v0.x.y
            ↓
       prod deploy (auto, ~5 min)
```

### 1. Land changes on `main`

Standard PR flow — `/ci` to pass gates, `/pr` to open the PR, review, merge. The merge triggers a Railway deploy of `main` to staging across the 3 staging services (`api-staging`, `web-staging`, `www-staging`), and to the `docs` prod service (docs is direct-from-main).

### 2. Soak on staging

Staging URLs:
- API: `https://api.staging.useatlas.dev` (health: `https://api.staging.useatlas.dev/api/health`)
- Web: `https://app.staging.useatlas.dev`
- www: `https://www.staging.useatlas.dev`

All three share the `.staging.useatlas.dev` parent so cross-subdomain session cookies stay isolated from prod's `.useatlas.dev` namespace (issue caught in Codex review of #2933).

What to check before tagging:
- All 3 staging Railway services (`api-staging`, `web-staging`, `www-staging`) are green.
- `https://api.staging.useatlas.dev/api/health` returns OK with `region: "staging"`.
- Any user-visible changes shipped since the last tag work as expected. Run the change yourself; don't infer from a green CI.
- For risky changes (new migration, new agent tool, new admin surface), monitor staging logs for ~30 min before tagging.

Staging is single-region by design — the 3 prod regional API instances are gated as a single tag-promote step, not soaked individually. See [staging PRD](../prd/staging-environment.md) for the rationale.

There is no fixed soak time. Tag when you're confident; rollback (via the next tag) if a problem surfaces.

### 3. Tag with `/release`

```
/release v0.0.1
```

The skill runs:
1. **`/ci`** — refuses to tag if any gate fails. Tags are immutable; don't tag broken code.
2. **`git tag -a v0.0.1 -m "<auto-summary>"`** — annotated tag with author/timestamp/message. Never lightweight tags.
3. **`git push origin <version>`** — pushes the single tag to GitHub. Don't use `--tags` — that pushes every local tag and can leak experimental ones.
4. **`git push origin <version>^{}:prod --force-with-lease`** — fast-forwards the `prod` branch to the tagged commit. This is what Railway watches; the prod-side deploy fires from this push. `--force-with-lease` (never `--force`) refuses to rewind if someone else has advanced `prod` since the local fetch — a safety net against concurrent `/release` runs.
5. **`gh release create v0.0.1 --generate-notes`** — creates a GitHub Release with auto-generated commit + PR list.

The `--generate-notes` output is the customer-facing changelog for that tag. Edit it on GitHub afterward if it needs polish.

### 4. Watch prod

The `prod` branch push triggers Railway prod deploys across the 5 prod services watching it (`api`, `api-eu`, `api-apac`, `web`, `www`). Monitor via:
- Railway dashboard (manual)
- `gh api repos/AtlasDevHQ/atlas/commits/$(git rev-list -n 1 <version>)/statuses` for commit-status mirrors on the tagged SHA (not `main` — they diverge during rollback, where the new patch tag points at the previous good SHA)
- `gh api repos/AtlasDevHQ/atlas/deployments?ref=prod` for the Railway-driven GitHub Deployments list
- Customer-visible incident reports

If prod boots cleanly, the release is done. If not, hotfix flow below.

## Hotfix flow

**Tag immediately. Don't wait for the next normal release.**

```
hotfix branch from main → fix → /ci → merge to main
                                          ↓
                                  staging deploy (auto)
                                          ↓
                              /release v0.x.(y+1)  ← right away
                                          ↓
                                    prod deploy
```

The two key rules:

- **Patch the tag train immediately.** If prod is on `v0.1.3` and you ship a fix for a regression, tag `v0.1.4` as soon as it merges — don't batch with other work. Customers should be able to attribute "this is fixed in v0.1.4" without waiting for the next minor.
- **No release branches.** The hotfix lands on `main` and the tag captures whatever cumulative diff `main` has accumulated since the last tag. If `main` has unrelated work in flight, that work ships with the patch tag. For a solo maintainer this is the right tradeoff — cherry-picking onto a release branch costs more than the occasional accidental-ship of an in-flight change.

If a regression slips out and the fix isn't ready yet, the rollback move is to tag the previous tag's SHA as the next patch: `git tag -a v0.1.4 <SHA-of-v0.1.3> -m "rollback to v0.1.3"`. The new prod deploy boots the prior code; ship a forward fix afterward.

## What gets a major vs minor vs patch

See [ADR-0008 § Semver discipline](../adr/0008-versioning-and-release-tags.md#semver-discipline-rules-for-git-tags) for the table. Quick reference:

- **Major** — only for the future `v1.0.0` (frozen REST + MCP + plugin contracts). Don't bump major in `v0.x` land.
- **Minor** — new feature, customer-visible workflow change, new required env var, removed deprecated flag.
- **Patch** — bug fix, perf, refactor, docs, dependency bump, hotfix.

The `/release` skill infers the bump from the previous tag if you don't pass one explicitly (`/release` with no arg → it picks `v0.1.<prev+1>`).

## What `/release` will NOT do

- Will not tag if `/ci` fails. Fix the failure, then re-run.
- Will not deploy to prod outside the prod-branch push. The skill's only side-effects on remote state are: push the tag, fast-forward `prod` to the tag SHA with `--force-with-lease`, create the GitHub Release. Railway's autodeploy on `prod` does the rest.
- Will not skip the annotated-tag rule. Lightweight tags don't carry author/timestamp; the skill always uses `git tag -a`.
- Will not `--force` the `prod` branch push. Only `--force-with-lease` — refuses to rewind if someone else has advanced `prod` since the local fetch.
- Will not retag an existing version. If `v0.0.1` already exists and you re-run `/release v0.0.1`, the skill refuses. Use the next patch.

## Common pitfalls

**"I tagged but prod didn't deploy."**
Check the Railway dashboard — the 5 prod services (`api`, `api-eu`, `api-apac`, `web`, `www`) must each be watching the `prod` branch (not `main`). If a service slipped back to `main`, prod won't fire from a `prod`-branch push. The `docs` service is intentionally on `main` and isn't part of the tag gate.

Also verify the prod-branch push happened: `git rev-parse origin/prod` should equal the tag's SHA. The `/release` skill normally handles this; if it ran in a partial-success state, push manually with `git push origin <tag>^{}:prod --force-with-lease`.

**"I want a beta tag for testing."**
We don't have pre-release tags (see ADR-0008). Use staging as the soak environment. If a feature needs a customer-facing preview, ship behind a feature flag in a normal tag.

**"Two of us tagged at the same time."**
Tags are unique — the second `git push origin <version>` fails. The losing party re-runs `/release` against the current state of `main` and gets the next patch. The `--force-with-lease` on the prod-branch push provides a second safety net: even if both releases somehow created different tags, the second prod-push refuses to rewind a `prod` advanced by the first.

**"I need to ship to prod but `main` has half-finished work."**
This is the hotfix-batching problem. Two options:
1. Tag anyway — the in-flight work ships. If it's behind a flag or doesn't break boot, this is fine.
2. Revert the in-flight commits on `main`, tag, then re-land them. Costs a revert + re-merge but cleanly isolates the hotfix.

A release branch would solve this; we don't have one because for a solo maintainer the cost outweighs the benefit. Reassess if the team grows.

## References

- Versioning rules: [ADR-0008](../adr/0008-versioning-and-release-tags.md)
- Milestone shape: [ADR-0009](../adr/0009-tag-organized-roadmap.md)
- Customer-facing stability commitments: `apps/docs/content/docs/reference/stability.mdx`
- Branch protection (the gate tags pass through): [branch-protection.md](./branch-protection.md)
- Staging environment design: [staging-environment PRD](../prd/staging-environment.md)
