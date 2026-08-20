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

`.claude/research/ROADMAP.md` is the record, and `## Next` holds the in-flight tag's
entries. Read it — but read it for what it is.

**A ⚠️ there marks a finding an entry PRODUCED, not an open defect.** They accumulate:
almost all are attached to work that shipped, and the entry says so. There are over a
hundred. Reprinting them is a copy, not a reading — and a copy that mixes shipped lessons
with live defects is worse than none, because the reader cannot tell which is which.

So the reading is **which warnings are still live**, and that is a fact you can check:

1. Take the ⚠️ from entries dated inside the Step 1 window (`$SINCE`), plus anything under
   `## Today` or an explicitly in-flight heading. Count the rest; do not read them.
2. For every issue number a ⚠️ cites, read its state. One call, never an inference:
   ```bash
   gh issue view <N> -R AtlasDevHQ/atlas --json number,title,state,milestone
   ```
3. Sort each ⚠️ into exactly one of three, by what you just read:

   | Class | Test | What to print |
   |---|---|---|
   | **closed** | cites an issue now CLOSED, or a merged PR/SHA that fixed it | nothing |
   | **tracked** | cites an OPEN issue | its number only — it is already in the Step 2 counts |
   | **UNFILED** | names a live defect and cites no issue | **in full** |

**UNFILED is the entire product of this step.** It is the only class the issue counts
cannot show you, and it is why the record is read at all. If every ⚠️ in the window is
closed or tracked, say exactly that in one line — that is a clean result, not an empty one.

A ⚠️ outside the window is **unread, not clean**. Its count goes in **Could not
determine**, with the window as the reason.

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
UNFILED — a live defect the record names and no issue tracks:
<each in full, with the entry it came from / "none">

Tracked: <#N, #N — open issues, already counted above> / none
Read: <N> ⚠️ from entries since <SINCE>. Unread: <N> older ⚠️ (see Could not determine).

### Could not determine
<every UNKNOWN above, with its reason. Omit this section only when it is empty.>
```

## What this command no longer produces

The previous version ended with **What Matters Now**: two or three sentences of strategy,
in the same table style as the readings. It is gone. **Could not determine** takes its
place.

Ask for a recommendation as a separate question. Then the answer arrives labelled as a
judgement, not as a reading. Here, only the CI row, `Blocked`, and the UNFILED list say
what to do next, and this command reads all three.

Nor does it reprint the record. Step 7 used to say *"read every ⚠️"*, and a run on
2026-08-20 did what that asked: it pasted six findings from the two newest entries, four of
which were already closed or already tracked issues, and reported the other 103 as *"not
read"*. Every line was true and the section was still useless — the reader could not tell a
shipped lesson from a live defect, which is the only question the record is read to answer.
The classification above replaces it, and the class that matters is the one nothing else in
this report can surface.
