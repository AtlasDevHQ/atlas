---
description: "Tag the current main SHA for a prod deploy — /ci + docs changelog entry + annotated tag + prod-branch fast-forward + GitHub Release. Usage: /release v0.0.1, or bare to auto-bump patch."
---

Tag the current `main` SHA for a prod deploy. Bundles `/ci` + annotated tag + push + `prod`-branch fast-forward + GitHub Release. Usage: `/release v0.0.1` (explicit) or `/release` (auto-bump patch from last tag).

See [docs/development/release-process.md](../../docs/development/release-process.md) for the operational flow and [ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md) for the versioning rules this skill enforces.

**Step 1: Confirm we're on `main` and clean**

```bash
git branch --show-current                    # must be `main`
git status --short                           # must be empty
git fetch origin --tags && git rev-parse HEAD # must equal origin/main
```

If not on `main`, refuse — tags are cut from `main`, not feature branches. If dirty or behind, refuse — the tag would include unintended state.

`--tags` is not decoration: Step 2 reads the **local** tag list, and no local check can prove it matches the remote's. A clone that has not fetched tags reports an empty release train, and the remedy for an empty train is to pass a version by hand — which would then be validated against that same blind list. Fetch first.

**Step 2: Determine the target version**

`scripts/next-release-tag.sh` resolves the version, both with and without an argument. Don't infer by hand — see the warning below for why.

```bash
VERSION=$(scripts/next-release-tag.sh)          # infer the next patch
VERSION=$(scripts/next-release-tag.sh v0.2.16)  # validate an explicit version
```

It prints the resolved version on stdout and nothing else. Both paths pass through the **same** validation before it prints:
- Must match `^v[0-9]+\.[0-9]+\.[0-9]+$` (no pre-release, no metadata — per ADR-0008)
- Must not already exist

Exit codes: `0` resolved · `1` refused (wrong shape, or the tag already exists) · `2` cannot run · `3` no tag on the release train. On anything but `0`, stop — stdout is empty and the message on stderr says which.

> ⚠️ **This repo runs ~20 tag trains, not one.** Every published `@useatlas/*` package plus the sandbox and connector trains tag in this same repository (`vercel-sandbox-v0.0.5`, `yaml-context-v0.0.5`, `chat-v1.2.3`, …). That is why the pattern is anchored (`'v[0-9]*.[0-9]*.[0-9]*'` **plus** a `^v[0-9]+\.[0-9]+\.[0-9]+$` filter on the result) rather than the looser `'v*.*.*'` this step used to carry — `git tag -l` matches the glob against the whole tag name, so `v*.*.*` matched `vercel-sandbox-v0.0.5`, which version-sorts **above** `v0.2.15`. Cutting `v0.2.15` on 2026-08-22, the old command named `vercel-sandbox-v0.0.5` as the most recent release tag; a bare `/release` would have inferred `vercel-sandbox-v0.0.6`, and nothing downstream would have objected — it is a plausible version, it doesn't exist, and the tag, `prod` fast-forward, Release and changelog all proceed normally onto a train that isn't prod's. Tags are immutable, so there is no taking it back (#5384). If you edit the pattern, `scripts/__tests__/next-release-tag.test.sh` is what holds it.

Exit `3` means no tag on the release train — **not** "no tags". If this really is the first release, pass `v0.0.1` explicitly: the start of the pre-launch `v0.0.x` development train (per ADR-0008; `v0.1.0` is reserved for the public launch). Confirm with the user before tagging.

**Step 3: REMOTE CI on the tagged SHA is the gate. `/ci` is advisory.**

```bash
gh pr checks <PR> --watch          # or, for a merged SHA:
gh api repos/AtlasDevHQ/atlas/commits/$(git rev-parse HEAD)/check-runs \
  --jq '.check_runs[] | select(.conclusion != "success") | "\(.name): \(.conclusion // "pending")"'
```

Every remote check must be green **on the exact SHA being tagged**: CI (including the four `api-tests` shards), Sync Starters, Railway (api/web/docs). If a remote check is yellow or red on that SHA, stop — tags are immutable, don't tag broken code.

> ⚠️ **This step used to read "run `/ci` — refuse to tag if anything fails", and that rule blocked every release including the ones already serving production.** `scripts/ci-local.sh` does not go green on an unchanged tree. Measured on `main` at f3f32a7c7 (2026-08-24), full run with `TEST_DATABASE_URL` set: **2 of 42 gates FAIL** — `gate-fixtures` (7 pre-existing fixture failures in `check-mutation-tables.test.sh` and `check-docs-brain-snippets.test.sh`, present with the DB URL set *or* unset) and `test` (1 failure of 22,276, `identity-consumers-pg.test.ts`, which passes 76/76 in isolation). Neither is a defect in the tree being tagged, and a mandatory gate that cannot pass is not a gate — it is a step everyone learns to override, which is worse than not having one.
>
> Remote CI is the better gate because it runs `api-tests` **sharded four ways against a dedicated Postgres service container**, so each shard drives ~22 of the 87 `*-pg.test.ts` suites instead of all 87 against one local server contended by 32 bun workers — a smaller worker pool per database, on a machine doing nothing else. That structural difference is the *likely* reason remote CI was green on all 37 checks for a SHA a local run was red on; it is **not** established as the cause, and #5410 deliberately stops short of claiming it. What is established is the negative: the local wrapper's red does not track defects in the tree. See #5410 for the measurements, including five hypotheses tested and refuted.

Run `/ci` anyway if you like — it is a fast, useful pre-flight and it catches drift gates remote CI also runs. But read its output as **advice**, and do not tag on a local green either: without `TEST_DATABASE_URL` a local run self-skips all 104 real-Postgres suites (1,432 assertions when last measured — 2026-08-24, at 87 suites), and since #5410 it reports `DECLINED`/exit 3 rather than a false PASS to say so.

**Step 4: Draft the tag message**

Summarize what's in this tag. For tags with a milestone, pull from the milestone scope (substitute the target version — don't hard-code `v0.0.1`):
```bash
VERSION=v0.0.1  # the tag being cut
gh api 'repos/AtlasDevHQ/atlas/milestones?state=open' \
  --jq ".[] | select(.title | startswith(\"$VERSION\")) | .description"
```

For patches, use commit subjects since the previous tag:
```bash
git log <prev-tag>..HEAD --pretty=format:'%s' --no-merges | head -20
```

Draft a 1–3 line summary suitable for an annotated tag message. Example:
```
v0.0.1 — Release Process Bootstrap

First dev tag. Establishes tag-gated prod deploys, stability contract,
and the /release flow. Slice 6 bun-test-parallel cutover; docs polish.
```

**Step 5: Create the annotated tag and push**

```bash
git tag -a <version> -m "$(cat <<'EOF'
<draft from step 4>
EOF
)"
git push origin <version>
```

Never use lightweight tags (`git tag <version>` without `-a`). Annotated tags carry the tagger identity, timestamp, and message; lightweight tags don't.

Push the single tag, not `--tags` — pushing all tags can leak local-only experimental tags.

**Step 6: Advance the `prod` branch to the tagged commit**

```bash
# Fetch first so --force-with-lease has a fresh view of origin/prod
git fetch origin prod
git push origin <version>^{}:prod --force-with-lease
```

This is what Railway actually watches. The 4 prod services (`api`, `api-eu`, `api-apac`, `web`) are wired to autodeploy on `prod`-branch pushes; the tag itself is the audit trail, not the trigger. See [release-process.md § Mental model](../../docs/development/release-process.md#mental-model) for the rationale.

- `<version>^{}` dereferences the annotated tag to its underlying commit SHA — `git push origin <annotated-tag>:prod` would push the tag object, not the commit.
- `--force-with-lease` (never bare `--force`) refuses to rewind if `origin/prod` has advanced since the local fetch. Concurrent `/release` runs fail safely; the losing party reruns with the next patch.
- `docs` and `www` are intentionally not in this list — both stay on `main`-direct-to-prod (static `output: "export"`, no runtime to gate). A merge touching `apps/www/**` goes live on www.useatlas.dev immediately, not on the tag.

**Step 7: Create the GitHub Release with auto-generated notes**

```bash
gh release create <version> -R AtlasDevHQ/atlas --generate-notes --verify-tag
```

`--generate-notes` produces a commit + PR list as the body. `--verify-tag` makes sure the tag we just pushed exists on the remote (sanity check).

The GitHub Release `--generate-notes` body is the raw commit/PR list; the curated, customer-facing summary lives in the docs-site changelog entry added in the next step (`docs.useatlas.dev/changelog`), which links back to this Release. For minor tags, optionally edit the GitHub Release body to lead with that user-facing summary; patches typically ship with the auto-notes as-is.

**Step 8: Append the docs-site changelog entry (now that the Release exists)**

The public changelog at `docs.useatlas.dev/changelog` is a per-tag feed (ADR-0008 — *not* banked for `v0.1.0`). Add one entry for this tag so the docs site reflects the release. Do this **after** the GitHub Release exists (Step 7), never before: the entry links to `releases/tag/<version>`, so publishing it earlier would advertise a dead link, and a failure in tagging / prod / release-create would strand a stale entry on the live docs site.

1. Add a new object to the **top** of the `releases` array in `apps/docs/src/components/changelog-data.ts`:
   ```ts
   {
     version: "<version>",          // the git tag, e.g. "v0.0.2"
     title: "<theme>",              // milestone theme, e.g. "REST Datasources"
     date: "<YYYY-MM-DD>",          // tag date (matches the Release)
     summary: "<2–4 sentences, customer-facing — what shipped and why it matters>",
     highlights: ["<bullet>", "<bullet>", "..."],  // optional, 3–8 curated items
   },
   ```
   Curate from the milestone scope / the Step 4 tag message — customer-facing prose, not a commit dump. The component derives the GitHub Release link from `version`, so **do not** set `githubMilestone` on tag entries (that field belongs to the `developmentHistory` track only). Draft the prose from the tag message and the milestone scope — customer-facing, Keep-a-Changelog shape (Added / Changed / Fixed) with PR links.

   **Endpoint removals get a "Removed (REST):" highlight.** Enumerate this tag's window with `bun scripts/check-openapi-removals.ts --base <previous tag>` — any removed data-plane path it reports belongs in this entry as a Removed line naming the endpoints, the ADR, and the migration path, and must already have its row in stability.mdx's "Removals within v0.x" ledger (the `openapi-removals` CI gate enforces the ledger half; this step is the changelog half — the v0.0.47/v0.0.55 entries are the models).

2. Type-check the docs app so a broken entry can't reach the docs build (the docs service deploys from `main`), then commit + push:
   ```bash
   node_modules/.bin/tsgo --noEmit -p apps/docs/tsconfig.json   # from repo root
   git add apps/docs/src/components/changelog-data.ts
   git commit -m "docs(changelog): <version> — <theme>"
   git push origin main
   ```
   This commit is docs-data only and is intentionally **not** part of the tagged release SHA — `/ci` (Step 3) already gated the release code, and decoupling keeps the changelog from ever advertising a release that doesn't exist.

3. Rollback (rare): if the release is later superseded or rolled back, revert this commit so the changelog doesn't advertise a withdrawn release — `git revert <changelog-commit> && git push origin main`.

**Step 9: Confirm each prod service is serving the tagged commit**

The `prod`-branch push (step 6) triggers Railway prod deploys across the 4 services watching `prod` (`api`, `api-eu`, `api-apac`, `web`). **Health checks and a green "SUCCESS" do not, on their own, prove the release landed:** `/api/health` returns `ok` for *whatever* build is running (it carries no git SHA), and Railway keeps the previous deployment serving when a new build fails. The authoritative signal is the **commit hash of each service's active deployment**.

First, the fast view (live health + GitHub-reported statuses — useful, but not conclusive):

```bash
SHA=$(git rev-parse v<version>^{})   # the tagged commit, e.g. v0.0.2^{} → ca72ca1c…
gh api repos/AtlasDevHQ/atlas/commits/$SHA/statuses \
  --jq '[.[]|{context,state,description}]|group_by(.context)|map(.[0])[]|"\(.context)\t\(.state)\t\(.description)"'
for r in api api-eu api-apac; do curl -sf "https://$r.useatlas.dev/api/health" | jq -c '{r:.region,s:.status}'; done
```

Note: the prod runtime services (`api`/`web`/…) **do not reliably post a commit status** on the tag SHA — when they do, it's often only to say "no deployment needed". So the `statuses` call is a hint, not the proof.

Then **assert the deployed commit per service** via the Railway MCP `list_deployments` (project `08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241`, env `production` = `a0a5532e-8e2a-416f-bd24-ae8d2088b330`):

| Service | service_id |
|---------|-----------|
| api | `0ec88244-06d9-47cc-8874-0884eea6548b` |
| api-eu | `5de4ea32-0d74-4ce5-907d-67d0d785bcd4` |
| api-apac | `4b47dffe-aa4d-4eb0-bb5b-009de2735e05` |
| web | `9c00bb31-808a-40d5-92d4-184a03a10bdc` |

`list_deployments` returns `id | status | timestamp | commit-hash`. **Pass condition per service:** the latest deployment is `SUCCESS` at the tagged commit **and** the prior tag's deployment is now `REMOVED` (so the old build is fully retired, not running in parallel). Railway dashboard equivalent: service → Deployments → the live deployment's source commit. If the Railway MCP is logged out, `list_deployments` errors `Unauthorized` — ask the user to reconnect (`/mcp`) or read the SHA from the dashboard.

**Legitimate exception — "watched paths not modified":** a service whose watched paths weren't in the tag's diff won't rebuild; it stays `SUCCESS` on its *previous* SHA and its commit status reads `No deployment needed - watched paths not modified`. That is a pass — it's running unchanged code by design (e.g. `web` when a release only touches `packages/api`). What is **not** a pass: a latest deployment in `FAILED`/`CRASHED`/`WAITING` that never settles, or one still `SUCCESS` on the old SHA with no skip reason — that service did not take the release even though its endpoint may still look healthy on the old build.

`docs` and `www` are not in this set — both track `main`-direct-to-prod, so they land `main` commits, not the tag SHA. Verify each separately: `docs` at `docs.useatlas.dev/changelog` (the new `<version>` entry should render as the latest), and `www` at `www.useatlas.dev` (it serves whatever `main` commit last touched `apps/www/**`, independent of the tag).

Don't block on the rollout (~5 min). If watching to completion, re-poll `list_deployments` until each service flips `WAITING`/`BUILDING` → `SUCCESS` at the tagged commit. Tell the user where the GitHub Release lives.

**Step 9b: Assert no parked region was restarted by this release**

```bash
bash scripts/check-parked-regions.sh
```

A `prod` push deploys **every** service watching that branch — including any region the config has parked. Measured on 2026-09-04: the v0.2.30 push deployed `api-eu` and `api-apac` alongside `api` and `web`, and both had been running for the three days since #5582 parked them, because the park shipped its config half and never stopped the services. Every surface reported them as parked the whole time; the only thing that could have seen it is a comparison between what the config claims and what Railway is running, which is what this gate does.

Exit codes: `0` every parked region is stopped and cannot restart itself · `1` one is running or has autodeploy enabled — **fix before you call the release done**, see [parked-regions.md](../../docs/development/parked-regions.md) · `3` DECLINED, no Railway credentials, so nothing was verified.

⚠️ **`3` is not a pass.** If you get it, the gate looked at nothing — run it from a shell where `railway whoami` works.

Skip this step only when the config marks no region parked; the gate says so itself and exits `0`.

**Step 10: Output summary**

```
Tagged: v0.0.1
SHA: <abbrev>
prod branch advanced to: <abbrev>
prod services on tagged commit: api ✓  api-eu ✓  api-apac ✓  web ✓   (docs + www verify separately — main-direct-to-prod, not tag-gated)
Release: https://github.com/AtlasDevHQ/atlas/releases/tag/v0.0.1
Milestone: v0.0.1 — Release Process Bootstrap (if one exists)
docs changelog: <version> entry live at docs.useatlas.dev/changelog
```

Only claim "deployed" once Step 9's per-service commit-hash assertion passes — not on health `ok` alone.

**Rules:**

- Tags are immutable. Don't `git tag -d` or `git tag -f` to retag. If a release goes wrong, ship a forward patch (`v0.x.(y+1)`).
- No pre-release tags (`-rc.1`, `-beta`). Use staging as the soak environment. See [ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md#no-pre-release-tags).
- No release branches. Hotfixes land on `main` and tag immediately. See [release-process.md § Hotfix flow](../../docs/development/release-process.md#hotfix-flow). The `prod` branch is not a release branch — it's a Railway-tracking artifact, single-pointer, no PRs.
- The `prod` branch push always uses `--force-with-lease`. Never bare `--force` — that would let concurrent releases silently rewind each other.
- Milestones exist for pre-launch `v0.0.x` dev tags and post-launch minor tags. True patches of a launched minor (`v0.1.1`) don't get milestones.
- If a milestone exists matching the tag name, the auto-notes will reference it. If not, no milestone — that's fine for patches.
- Always use `-R AtlasDevHQ/atlas` with `gh` commands.

**When NOT to run /release:**

- On a feature branch — `/release` only tags from `main`.
- When `/ci` fails — fix first.
- When prod is currently mid-deploy from a previous tag — wait, then tag.
- To roll back — instead, tag the previous good SHA as the next patch and advance `prod` to it:
  ```bash
  git tag -a v0.1.(y+1) <prev-sha> -m "rollback to v0.1.y"
  git push origin v0.1.(y+1)
  git fetch origin prod
  git push origin v0.1.(y+1)^{}:prod --force-with-lease
  ```
  The new prod-branch push fires the Railway autodeploy of the prior good code.
