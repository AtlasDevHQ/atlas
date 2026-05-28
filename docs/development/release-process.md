# Release process

How Atlas ships to prod. Two flows: **normal release** (merge → soak → tag) and **hotfix** (merge → tag immediately).

> **Status as of 2026-05-28:** This doc describes the target shape that ships with `v0.1.0`, cut as soon as the bundle is ready. Until that point, `main` continues to auto-deploy to prod on every push (status quo). The dual Railway trigger described below replaces that flow at `v0.1.0`. Tag-cut is decoupled from the public launch announcement — the launch event (target: July 2026) is tracked separately and points at the banked changelog accumulated under the tag train.

## Mental model

- **`main`** is the single integration branch. Every merge to `main` triggers a deploy to **staging**.
- **Annotated git tags** (`v0.1.0`, `v0.1.1`, `v0.2.0`) trigger deploys to **prod**.
- **Tags are the prod gate.** A merge to `main` does not reach customers until someone tags it.

Why two triggers: a single push trigger (the status quo) couples merge to prod, which means a half-day's worth of PRs lands together and any of them can break prod with no soak window. The tag trigger lets us batch a coherent release, watch it on staging, then promote.

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

Standard PR flow — `/ci` to pass gates, `/pr` to open the PR, review, merge. The merge triggers a Railway deploy of `main` to staging across all 6 services.

### 2. Soak on staging

Staging URL: TBD (filled in once the staging build track lands per `docs/prd/staging-environment.md`).

What to check before tagging:
- All 6 Railway services on staging are green: `api` + `api-eu` + `api-apac` (three regional API instances) + `web` + `docs` + `www`. The `sidecar` deploys independently and is checked separately.
- `/api/health` returns OK on each of the three regional API instances (US/EU/APAC).
- Any user-visible changes shipped since the last tag work as expected. Run the change yourself; don't infer from a green CI.
- For risky changes (new migration, new agent tool, new admin surface), monitor staging logs for ~30 min before tagging.

There is no fixed soak time. Tag when you're confident; rollback (via the next tag) if a problem surfaces.

### 3. Tag with `/release`

```
/release v0.1.0
```

The skill runs:
1. **`/ci`** — refuses to tag if any gate fails. Tags are immutable; don't tag broken code.
2. **`git tag -a v0.1.0 -m "<auto-summary>"`** — annotated tag with author/timestamp/message. Never lightweight tags.
3. **`git push origin <version>`** — pushes the single tag to GitHub. Don't use `--tags` — that pushes every local tag and can leak experimental ones.
4. **`gh release create v0.1.0 --generate-notes`** — creates a GitHub Release with auto-generated commit + PR list.

The `--generate-notes` output is the customer-facing changelog for that tag. Edit it on GitHub afterward if it needs polish.

### 4. Watch prod

The tag push triggers a Railway prod deploy of all 6 services. Monitor via:
- Railway dashboard (manual)
- `gh api repos/AtlasDevHQ/atlas/commits/$(git rev-list -n 1 <version>)/statuses` for commit-status mirrors on the tagged SHA (not `main` — they diverge during rollback, where the new patch tag points at the previous good SHA)
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
- Will not push to prod directly. Tags push to prod via Railway; `/release` only creates the tag.
- Will not skip the annotated-tag rule. Lightweight tags don't carry author/timestamp; the skill always uses `git tag -a`.
- Will not retag an existing version. If `v0.1.0` already exists and you re-run `/release v0.1.0`, the skill refuses. Use the next patch.

## Common pitfalls

**"I tagged but prod didn't deploy."**
Check the Railway dashboard — the tag trigger may not be wired on a service. Tag-gated prod requires every service's Railway config to use the tag trigger; the dual-trigger PR (staging build track) lands that wiring.

**"I want a beta tag for testing."**
We don't have pre-release tags (see ADR-0008). Use staging as the soak environment. If a feature needs a customer-facing preview, ship behind a feature flag in a normal tag.

**"Two of us tagged at the same time."**
Tags are unique — the second `git push --tags` fails. The losing party re-runs `/release` against the current state of `main` and gets the next patch.

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
- Staging environment design: `docs/prd/staging-environment.md` (forthcoming)
