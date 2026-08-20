---
description: "Return to a clean main baseline. Stops if the tree holds uncommitted or unpushed work. Prunes [gone] marks, installs, and reports the end state it verified. Run after a merge."
---

# Reset

Return to `main` at `origin`. Install dependencies from the lockfile.

Run this after a merge.

## Step 1 — Check before you act

Run these three commands. Read all three results before you continue.

```bash
git rev-parse --show-toplevel                 # which checkout is this?
git status --porcelain                        # uncommitted work
git log --oneline @{u}..HEAD 2>/dev/null      # unpushed commits
```

Stop and report if any row below is true. Do not continue.

| Condition | What to do |
|---|---|
| `git status --porcelain` prints files | `git checkout` moves that work onto `main`. Name the files. Offer `git stash -u` or a commit. Let the operator choose. Never stash without asking — nobody looks for a stash they did not make. |
| `git log @{u}..HEAD` prints commits | The branch holds work that `origin` does not have. Name the commits and the branch, so the operator can find them again by name. |
| `@{u}` gives an error | The branch has no upstream. This is the worse case, not the safer one: every commit on it is unpushed. Compare against `main` instead — `git log --oneline main..HEAD`. |
| The toplevel is not the primary checkout | You are in a worktree. The primary checkout already holds `main`. |

## Step 2 — Reset

```bash
git checkout main
git fetch --prune origin
git pull --ff-only
bun install
```

Two flags are deliberate. Keep them.

- **`--ff-only`** — `main` must fast-forward. Stop and report if it does not. A plain
  `git pull` hides the divergence inside a merge commit.
- **`--prune`** — this is what marks a deleted remote branch as `[gone]`. `/tidy` reads
  that mark. Without the prune, the `/tidy` branch sweep matches nothing and reports clean.

## Step 3 — Report what you verified

Run these three. Report the result of each.

```bash
git rev-parse --abbrev-ref HEAD               # expect: main
git status --porcelain                        # expect: no output
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  && echo "in sync with origin/main" || echo "DIVERGED from origin/main"
```

⚠️ `git rev-parse --short HEAD origin/main` does not work. `--short` takes one revision
only, and two make it exit 128 with *"fatal: Needed a single revision"*. This runbook
shipped that form and it failed on the first real run. Compare the two SHAs and report the
verdict, as above — do not print two strings and leave the reader to match them by eye.

Write **UNKNOWN** for any check you could not run. A skipped step is not a passed step.

`bun install` exits 0 and still prints peer-dependency conflicts. Quote any warning it
prints. Say so if it changed `bun.lock`.

## Out of scope

- Branch and worktree deletion — `/tidy`, which needs the prune above.
- Dev servers — `/dev`.
- Remote branches. This command never pushes and never deletes on `origin`.
