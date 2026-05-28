Tag the current `main` SHA for a prod deploy. Bundles `/ci` + annotated tag + push + GitHub Release. Usage: `/release v0.1.0` (explicit) or `/release` (auto-bump patch from last tag).

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
# e.g. last=v0.1.3 → next=v0.1.4
```

If no tag exists yet (first release), default to `v0.1.0`. Confirm with the user before tagging.

**Step 3: Run `/ci` — refuse to tag if anything fails**

```
/ci
```

All gates must pass: lint, type, test, syncpack, template drift, security headers drift, railway-watch, schema drift, OAuth helper drift, test discipline, twenty resolver imports, published symbols. Remote: CI, Sync Starters, Railway (api/web/docs) — all green on the SHA being tagged.

If any local gate fails, fix it and re-run `/release`. If a remote check is yellow/red on the head SHA, stop — tags are immutable, don't tag broken code.

**Step 4: Draft the tag message**

Summarize what's in this tag. For minor tags, pull from the milestone scope (substitute the target version — don't hard-code `v0.1.0`):
```bash
VERSION=v0.1.0  # the tag being cut
gh api 'repos/AtlasDevHQ/atlas/milestones?state=open' \
  --jq ".[] | select(.title | startswith(\"$VERSION\")) | .description"
```

For patches, use commit subjects since the previous tag:
```bash
git log <prev-tag>..HEAD --pretty=format:'%s' --no-merges | head -20
```

Draft a 1–3 line summary suitable for an annotated tag message. Example:
```
v0.1.0 — Release Process Bootstrap

First public release. Establishes tag-gated prod deploys, stability contract,
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

**Step 6: Create the GitHub Release with auto-generated notes**

```bash
gh release create <version> -R AtlasDevHQ/atlas --generate-notes --verify-tag
```

`--generate-notes` produces a commit + PR list as the body. `--verify-tag` makes sure the tag we just pushed exists on the remote (sanity check).

For minor tags, edit the GitHub Release body afterward to lead with the user-facing summary; the auto-notes are good but verbose. Patches typically ship with the auto-notes as-is.

**Step 7: Watch the prod deploy**

The tag push triggers Railway prod deploys across all 6 services. Output the watch commands:

```bash
gh api repos/AtlasDevHQ/atlas/commits/<sha>/statuses --jq '.[] | "\(.context)\t\(.state)\t\(.description)"'
```

Tell the user where the GitHub Release lives, and that prod deploy is in flight. Don't wait — the deploy takes ~5 min; user can monitor.

**Step 8: Output summary**

```
Tagged: v0.1.0
SHA: <abbrev>
Release: https://github.com/AtlasDevHQ/atlas/releases/tag/v0.1.0
Milestone: v0.1.0 — Release Process Bootstrap (if minor)
Next: watch Railway prod deploy (~5 min)
```

**Rules:**

- Tags are immutable. Don't `git tag -d` or `git tag -f` to retag. If a release goes wrong, ship a forward patch (`v0.x.(y+1)`).
- No pre-release tags (`-rc.1`, `-beta`). Use staging as the soak environment. See [ADR-0008](../../docs/adr/0008-versioning-and-release-tags.md#no-pre-release-tags).
- No release branches. Hotfixes land on `main` and tag immediately. See [release-process.md § Hotfix flow](../../docs/development/release-process.md#hotfix-flow).
- Patches don't get milestones. Only minor tags do.
- If a milestone exists matching the tag name, the auto-notes will reference it. If not, no milestone — that's fine for patches.
- Always use `-R AtlasDevHQ/atlas` with `gh` commands.

**When NOT to run /release:**

- On a feature branch — `/release` only tags from `main`.
- When `/ci` fails — fix first.
- When prod is currently mid-deploy from a previous tag — wait, then tag.
- To roll back — instead, tag the previous good SHA as the next patch: `git tag -a v0.1.(y+1) <prev-sha> -m "rollback to v0.1.y" && git push origin v0.1.(y+1)`.
