Tag the current `main` SHA for a prod deploy. Bundles `/ci` + annotated tag + push + `prod`-branch fast-forward + GitHub Release. Usage: `/release v0.0.1` (explicit) or `/release` (auto-bump patch from last tag).

See [docs/development/release-process.md](../../docs/development/release-process.md) for the operational flow and [ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md) for the versioning rules this skill enforces.

**Step 1: Confirm we're on `main` and clean**

```bash
git branch --show-current                    # must be `main`
git status --short                           # must be empty
git fetch origin && git rev-parse HEAD       # must equal origin/main
```

If not on `main`, refuse — tags are cut from `main`, not feature branches. If dirty or behind, refuse — the tag would include unintended state.

**Step 2: Determine the target version**

If an argument is passed, validate it:
- Must match `^v[0-9]+\.[0-9]+\.[0-9]+$` (no pre-release, no metadata — per ADR-0008)
- Must not already exist: `git tag -l <arg>` returns empty

If no argument is passed, infer the next patch from the most recent tag:
```bash
git tag -l 'v*.*.*' --sort=-v:refname | head -1
# e.g. last=v0.0.1 → next=v0.0.2
```

If no tag exists yet (first release), default to `v0.0.1` — the start of the pre-launch `v0.0.x` development train (per ADR-0008; `v0.1.0` is reserved for the public launch). Confirm with the user before tagging.

**Step 3: Run `/ci` — refuse to tag if anything fails**

```
/ci
```

All gates must pass: lint, type, test, syncpack, template drift, security headers drift, railway-watch, schema drift, OAuth helper drift, test discipline, twenty resolver imports, published symbols. Remote: CI, Sync Starters, Railway (api/web/docs) — all green on the SHA being tagged.

If any local gate fails, fix it and re-run `/release`. If a remote check is yellow/red on the head SHA, stop — tags are immutable, don't tag broken code.

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

This is what Railway actually watches. The 5 prod services (`api`, `api-eu`, `api-apac`, `web`, `www`) are wired to autodeploy on `prod`-branch pushes; the tag itself is the audit trail, not the trigger. See [release-process.md § Mental model](../../docs/development/release-process.md#mental-model) for the rationale.

- `<version>^{}` dereferences the annotated tag to its underlying commit SHA — `git push origin <annotated-tag>:prod` would push the tag object, not the commit.
- `--force-with-lease` (never bare `--force`) refuses to rewind if `origin/prod` has advanced since the local fetch. Concurrent `/release` runs fail safely; the losing party reruns with the next patch.
- `docs` is intentionally not in this list — it stays on `main`-direct-to-prod (static export + Caddy, no runtime to gate).

**Step 7: Create the GitHub Release with auto-generated notes**

```bash
gh release create <version> -R AtlasDevHQ/atlas --generate-notes --verify-tag
```

`--generate-notes` produces a commit + PR list as the body. `--verify-tag` makes sure the tag we just pushed exists on the remote (sanity check).

For minor tags, edit the GitHub Release body afterward to lead with the user-facing summary; the auto-notes are good but verbose. Patches typically ship with the auto-notes as-is.

**Step 8: Watch the prod deploy**

The `prod`-branch push (step 6) triggers Railway prod deploys across the 5 services watching `prod` (`api`, `api-eu`, `api-apac`, `web`, `www`). Output the watch commands:

```bash
gh api repos/AtlasDevHQ/atlas/commits/<sha>/statuses --jq '.[] | "\(.context)\t\(.state)\t\(.description)"'
gh api repos/AtlasDevHQ/atlas/deployments?ref=prod --jq '.[0:5][] | "\(.created_at)\t\(.sha[0:8])\t\(.description // .task)"'
```

Tell the user where the GitHub Release lives, and that prod deploy is in flight. Don't wait — the deploy takes ~5 min; user can monitor.

**Step 9: Output summary**

```
Tagged: v0.0.1
SHA: <abbrev>
prod branch advanced to: <abbrev>
Release: https://github.com/AtlasDevHQ/atlas/releases/tag/v0.0.1
Milestone: v0.0.1 — Release Process Bootstrap (if one exists)
Next: watch Railway prod deploy (~5 min)
```

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
