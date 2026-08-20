---
description: "Reconcile merged work against issues, labels, ROADMAP and stale branches. Applies only fact-determined fixes; proposes every judgement call with its evidence. Run after a burst of merged PRs."
---

# Tidy

Reconcile recent merged work against GitHub issues, labels, the ROADMAP, and local
branches.

Run it after a burst of PRs land.

**Companion:** `/triage` moves *inbound* issues through the state machine. `/tidy`
reconciles work that is *already tracked*. Run `/triage` first when external issues wait.

## Two lanes

The previous version did everything itself. It judged which issues had shipped and closed
them. It wrote the ROADMAP entry for the work. It approved its own edits. All of that
happened in the session that had just done the work. `docs/agents/practices.md` names the
shape: **the actor that builds a check may not be its only judge.**

So this command has two lanes. The test is **does a printable fact decide the action**,
not is the action risky.

| Lane | Test | Behaviour |
|---|---|---|
| **APPLY** | A fact decides it. The remote branch is gone. The issue is closed. A merged PR carries a closing keyword for an issue that is closed. | Act. Report what you did. |
| **PROPOSE** | A person decides it. *Which* area label. *Whether* this shipped. *What* the ROADMAP entry says. *Whether* this needs an issue. | Print the proposal and the evidence. Stop. |

Do not apply a PROPOSE item because it looks obvious. "Obvious to the session that wrote
the code" is the failure this split exists to stop.

⚠️ **Never truncate the report.** No `head`, no `cut`, no "and 12 more".

## Step 1 — Gather

```bash
SINCE=$(date -d '2 days ago' +%F)      # macOS: SINCE=$(date -v-2d +%F)

git log --oneline --since="$SINCE" --format='%h %s'
gh pr list -R AtlasDevHQ/atlas --state merged --limit 30 --json number,title,body,mergedAt
gh pr list -R AtlasDevHQ/atlas --state open --json number,title,headRefName
gh issue list -R AtlasDevHQ/atlas --state open --limit 100 --json number,title,labels,milestone
gh issue list -R AtlasDevHQ/atlas --state closed --limit 100 --search "closed:>=$SINCE" \
  --json number,title,labels
```

Pass `-R AtlasDevHQ/atlas` to every `gh` call. Prefer REST over GraphQL: GraphQL returns
503 often enough here that a sweep must verify by re-listing (`docs/agents/issue-tracker.md`).

Read only the `## Next` section of `.claude/research/ROADMAP.md`. The archive is cold
storage; reading it costs context and reconciles nothing.

## Step 2 — APPLY

### 2a. Stale waiting-labels on closed issues

`needs-triage` and `needs-info` assert a live obligation. They are wrong on a closed issue.
`ready-for-agent`, `ready-for-human` and `wontfix` record routing and verdict, so **keep**
them. `docs/agents/triage-labels.md` is the convention. Trust it over this paragraph.

```bash
for L in needs-triage needs-info; do
  gh api --paginate "repos/AtlasDevHQ/atlas/issues?state=closed&labels=$L&per_page=100" \
    --jq '.[] | select(.pull_request == null) | .number'
done
gh api -X DELETE "repos/AtlasDevHQ/atlas/issues/<N>/labels/<label>"
```

Re-list after the deletes. Report the **second** count as the result. A 503 on a DELETE
prints no error you will notice, so a first count reports removals that did not happen.

### 2b. Stale branches and orphan worktrees

This needs the prune from `/reset`. Run `git fetch --prune origin` first if you skipped it.
Without the prune nothing is ever marked `[gone]`, and this sweep reports clean after
reading nothing.

```bash
git branch -vv | grep ': gone\]'
```

Git writes the mark as `[origin/<branch>: gone]`. A literal `[gone]` pattern matches
nothing, and reads as "no stale branches" rather than as a broken grep.

Take each candidate through these three checks in order.

1. **Open PR on it — skip.**
   `gh pr list -R AtlasDevHQ/atlas --state open --head <branch>`
2. **Merged PR on it — safe, delete.**
   `gh pr list -R AtlasDevHQ/atlas --state merged --head <branch> --json number,mergedAt`
3. **No PR at all — look for unmerged work.**
   `git cherry main <branch>`. Any line that starts `+` has no patch-equivalent on `main`.
   Report those. Do not delete.

⚠️ **Do not use `git log main..<branch>` for check 3.** It is the obvious choice and it is
wrong here. This repo squash-merges, so a merged branch keeps its original SHAs and
`main..<branch>` never empties. The guard would report unmerged work on every branch and
delete nothing, while it reads as careful. Measured on
`fix/5233-bridge-window-object-cmp-trace`: merged as PR #5315, landed on `main` under a new
SHA, and `main..<branch>` still listed its commit. `git cherry` compares patch-ids and got
that one right, but a multi-commit branch squashed into one has no patch-equivalent either.
**Check 2 is the signal. `git cherry` only covers branches GitHub never saw.**

Then remove any owning worktree and delete the branch:

```bash
git branch -vv | grep ': gone\]' | sed 's/^[+* ]//' | awk '{print $1}' | while read branch; do
  worktree=$(git worktree list | grep "\[$branch\]" | awk '{print $1}')
  if [ -n "$worktree" ] && [ "$worktree" != "$(git rev-parse --show-toplevel)" ]; then
    if ! git worktree remove "$worktree" 2>/dev/null; then
      lock_pid=$(git worktree list --porcelain | awk -v p="$worktree" '$2==p {f=1} f && /^locked/ {print; exit}' | grep -oE 'pid [0-9]+' | awk '{print $2}')
      if [ -n "$lock_pid" ] && ! ps -p "$lock_pid" > /dev/null 2>&1; then
        git worktree remove -f -f "$worktree"          # only with a confirmed-dead PID
      else
        echo "  $worktree locked by a live PID — skipping"; continue
      fi
    fi
  fi
  git branch -D "$branch"
done
```

**Never delete a remote branch here.** That reaches other machines and other people, and
GitHub already deletes merged branches for you.

### 2c. ROADMAP checkboxes

Change `- [ ]` to `- [x]` only when a merged PR body carries a closing keyword for issue N
**and** N is closed. Anything weaker belongs in 3c.

⚠️ A `#N` anywhere in a PR body parses as a real edge, and a closing keyword ignores
negation — *"does not fix #N"* still closes it (`docs/agents/issue-tracker.md`). So confirm
against the closed state of N. Do not trust the keyword alone.

## Step 3 — PROPOSE

Print each item with its evidence. Apply nothing in this step.

### 3a. Missing labels

Two axes are required: exactly one of `bug` / `feature` / `refactor` / `chore` / `docs`,
plus one or more `area: *`. `docs/agents/issue-tracker.md` holds the list.

Detecting a missing axis is mechanical. Choosing the value is a reading of the issue, so
propose it:

`#N "<title>" — missing an area label. Suggest `area: api` (body names packages/api/src/lib/brain).`

### 3b. Issues that look shipped

Give the number, the PR you believe closed it, and the acceptance criteria you believe are
met. Never close an issue from this command.

Never close an issue that has open sub-issues. Propose a status comment instead.

### 3c. ROADMAP entries

Propose the text. Do not write it.

Match the shape of the entries around it. Read them first. Today that shape is:

- `**Shipped YYYY-MM-DD — <hook>** ([#N](url); PR [#M](url)) — what changed, and why.`
- `⭐` marks a transferable finding. `⚠️` marks a hazard or a breaking change. Each one ends
  in the general form of the claim.
- Detail lives in the issue, the PR body, and `.claude/research/architecture-wins.md` for
  refactors that deepen a module. Link to it. Do not copy it.
- When a milestone closes, collapse its section to one `- [x]` line. Move the detail
  verbatim to `ROADMAP-archive.md`, so `ROADMAP.md` stays cheap to edit.

Not every closed `architecture` issue earns an `architecture-wins.md` entry. That file
tracks a contract that had copies and now has one home. A guard refinement, or a feature
that touches many files, stops at the ROADMAP.

### 3d. Untracked work

Merged PRs that reference no issue. Propose an issue only for significant work. Typos and
one-line fixes are noise. Search first, so you do not propose a duplicate.

## Step 4 — Report

```markdown
### Applied
- Waiting-labels removed: N (verified by re-list: N)
- Branches deleted: <names> · Worktrees removed: <paths> · Skipped: <name — reason>
- ROADMAP checkboxes ticked: N

### Proposed — needs your call
<one block per item: what, the evidence, the command that applies it>

### Could not check
<anything that errored, and what is therefore unverified>
```

Commit a changed `.claude/research/ROADMAP.md` as `docs: tidy — …`. **Do not push unless
asked.** A push reaches other people, and this command often runs unattended.

## What is not a rule here

Everything in Step 3 is a note, in the sense `docs/agents/practices.md` defines. It informs
judgement and gates nothing. No gate can tell a good ROADMAP entry from a plausible one.
APPLY is the only lane whose correctness is checkable, and that is why it is the only lane
that acts.
