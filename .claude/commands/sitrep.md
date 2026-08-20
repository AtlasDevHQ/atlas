---
description: "Read-only orientation: commits, issues, milestones, CI, deploy state, package drift, release distance. Marks anything it could not read as UNKNOWN. Run at session start or when switching context."
---

# Sitrep

Read-only orientation. Where the project stands right now.

**This command writes nothing.** No issues, no labels, no edits, no commits, no pushes.

Run it at the start of a session, when you switch context, or before you pick up work.

## The rule that makes it worth running

A sitrep that always produces a confident picture is a measurement that cannot fail.

So: read every field from a command, or print it as **UNKNOWN** with the reason. Never
fill a gap by inference. You will act on this report. Once a guessed field is in the
table, it looks exactly like a read one.

Two habits follow from that.

- **Derive lists. Do not hard-code them.** Every list below comes from disk or from the API
  at read time. The previous version of this command carried a four-row package table
  while five packages publish.
- **Never truncate a finding.** Print failing CI lines in full.

## Step 1 — Gather

Set the window first, so no `YYYY-MM-DD` placeholder reaches a command:

```bash
SINCE=$(date -d '3 days ago' +%F)      # macOS: SINCE=$(date -v-3d +%F)
```

Run the rest in parallel. Pass `-R AtlasDevHQ/atlas` to every `gh` call — this box runs
several clones and worktrees, and repo inference has picked the wrong one
(`docs/agents/issue-tracker.md`).

**1. Commits and open PRs**
```bash
git log --oneline --since="$SINCE" --format='%h %s (%cr)'
gh pr list -R AtlasDevHQ/atlas --state open --json number,title,isDraft,headRefName
```

**2. Issues — open, and closed inside the window**
```bash
gh issue list -R AtlasDevHQ/atlas --state open --limit 100 --json number,title,labels,milestone
gh issue list -R AtlasDevHQ/atlas --state closed --limit 100 \
  --search "closed:>=$SINCE" --json number,title,labels
```

**3. Milestones**
```bash
gh api repos/AtlasDevHQ/atlas/milestones?state=open \
  --jq '.[] | "\(.title): \(.open_issues) open / \(.closed_issues) closed"'
```

**4. CI on `main`**
```bash
gh run list -R AtlasDevHQ/atlas --branch main --limit 5 \
  --json name,status,conclusion,createdAt,databaseId
gh run view <databaseId> -R AtlasDevHQ/atlas --log-failed 2>&1 | tail -60   # if any failed
```

**5. Deploy state and release distance**
```bash
gh api repos/AtlasDevHQ/atlas/commits/main/statuses \
  --jq '[.[] | {context, state}] | unique_by(.context) | .[] | "\(.context): \(.state)"'
git fetch origin prod --quiet 2>/dev/null
git rev-parse --short origin/prod 2>/dev/null       || echo "prod: UNKNOWN"
git rev-list --count origin/prod..origin/main 2>/dev/null || echo "distance: UNKNOWN"
```

This command does not say which service tracks `main` and which tracks `prod`. `/deploy`
says that. Read it there.

Always report the `prod`-to-`main` count, even when nothing is wrong. CLAUDE.md makes it
the precondition for a hotfix: a non-zero count means a tag cut from `main` also ships an
unreleased arc.

**6. Published packages, with drift**
```bash
for p in $(grep -L '"private": *true' packages/*/package.json); do
  name=$(jq -r .name "$p"); local=$(jq -r .version "$p")
  pub=$(npm view "$name" version 2>/dev/null || echo UNKNOWN)
  [ "$local" = "$pub" ] && flag="" || flag="  <- DRIFT"
  printf '%-28s local %-10s npm %-10s%s\n' "$name" "$local" "$pub" "$flag"
done
```

Drift is the column that matters, not the version. A local version ahead of npm means a
publish is pending. Bumping consuming refs before that publish lands breaks Deploy
Validation scaffolds on `npm install` (CLAUDE.md).

**7. The record**

Read the `## Next` section of `.claude/research/ROADMAP.md`, and every ⚠️ in it. That file
is the record. An open warning there outranks anything you infer from issue counts.

## Step 2 — Report

```markdown
## Atlas Sitrep — <date>

### Health          <- always first; a red row here outranks everything below
| System | State |
|---|---|
| CI (main) | green / FAILING: <job> + the failure lines in full / UNKNOWN |
| Deploy statuses | <context: state, one per row> / UNKNOWN |
| `prod` to `main` | N commits behind (`prod` @ <sha>) / UNKNOWN |

### Activity (since <SINCE>)
Commits: N · Issues closed: N · Open PRs: N (M draft)
Themes: <from the feat/fix/refactor/docs/chore prefixes>

### Open work (N total)
| Type | Count | Areas |
|---|---|---|
<one row per type label present; areas from the `area: *` labels>

Blocked: <issues carrying `blocked`, by number> / none

### Milestones
<title: open/closed, one per line> / none open

### Packages
<the derived table from step 6, with the drift column>

### From the record
<the `## Next` heading, then each ⚠️ in one line>

### Could not determine
<every UNKNOWN above, with its reason. Omit this section only when it is empty.>
```

## What this command no longer produces

The previous version ended with **What Matters Now**: two or three sentences of strategy,
in the same table style as the readings. It is gone. **Could not determine** takes its
place.

Ask for a recommendation as a separate question. Then the answer arrives labelled as a
judgement, not as a reading. Here, only the CI row and `Blocked` say what to do next, and
this command reads both.
