# Project Tidy

Reconcile recent work (commits, PRs) against GitHub issues and ROADMAP. Fix drift, close gaps, clean up stale items.

**Run after a burst of work** — merging PRs, shipping features, fixing bugs — to keep tracking in sync.

---

**Step 1: Gather current state**

Run these in parallel:

1. Recent commits (last 2 days):
   ```
   git log --oneline --since="2 days ago" --format="%h %s (%cr)"
   ```

2. Recently merged PRs (last 20):
   ```
   gh pr list -R AtlasDevHQ/atlas --state merged --limit 20 --json number,title,mergedAt,labels
   ```

3. Open PRs:
   ```
   gh pr list -R AtlasDevHQ/atlas --state open --json number,title,createdAt,labels
   ```

4. All open issues:
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --limit 50 --json number,title,labels,milestone
   ```

5. Recently closed issues (last 2 days):
   ```
   gh issue list -R AtlasDevHQ/atlas --state closed --limit 50 --json number,title,closedAt,labels --jq '.[] | select(.closedAt > "YYYY-MM-DD") | "\(.number)\t\(.title)\t\(.closedAt)"'
   ```
   (Replace YYYY-MM-DD with 2 days ago)

6. CI + deployment status:
   ```
   # GitHub Actions (CI + Sync Starters)
   gh run list -R AtlasDevHQ/atlas --branch main --limit 5 --json status,conclusion,name,createdAt,databaseId

   # Railway deployments (api, web, docs, www, sidecar — uses commit statuses, not check-runs)
   gh api repos/AtlasDevHQ/atlas/commits/main/statuses --jq '[.[] | {context, state, description}] | unique_by(.context) | .[] | "\(.context)\t\(.state)\t\(.description)"'
   ```
   If any CI runs are failing, get the failure details:
   ```
   gh run view <run_id> -R AtlasDevHQ/atlas --log-failed 2>&1 | tail -30
   ```

7. `.claude/research/ROADMAP.md` — Read the current milestone sections (if any active)

---

**Step 2: Cross-reference and identify gaps**

For each category, build a list of actions needed:

### 2a. ROADMAP checkboxes (if active milestone exists)
- Compare merged PRs and closed issues against ROADMAP `- [ ]` items
- Any shipped work still showing `- [ ]` -> change to `- [x]` and add issue/PR refs
- Any new shipped work not listed in ROADMAP -> add as new line items under the appropriate milestone section

### 2b. Issue hygiene
- Open issues whose work is fully shipped (all items done, PR merged) -> close with comment
- **Issues missing labels** -> every issue needs a type label AND area label(s):
  - Type (exactly one): `bug`, `feature`, `refactor`, `chore`, `docs`
  - Area (one or more): `area: api`, `area: web`, `area: cli`, `area: plugins`, `area: sandbox`, `area: deploy`, `area: ci`, `area: sdk`, `area: mcp`, `area: starter`, `area: docs`, `area: testing`
  - Special: `architecture` — for module-deepening refactors from `/improve-codebase-architecture`. When an `architecture` issue is closed, check if `.claude/research/architecture-wins.md` was updated with the win. If not, add a reminder comment on the closed issue
- **Issues missing milestone** -> assign to the appropriate milestone if one exists
- Parent issues with shipped sub-issues -> add status comment listing what shipped and what remains

### 2c. CI + deployment health
- If CI is failing on main, this is **urgent** — diagnose the failure and fix it before other tidy work
- If any Railway deployment is failing (api, web, docs), this is equally urgent — main is broken in production
- Check if failures are from recently merged PRs (regressions) or pre-existing
- Common CI causes: type errors in new code, missing test mocks, dependency drift
- Common Railway causes: missing env var, new dependency not in `serverExternalPackages`, DB migration error, health check timeout
- Railway logs are NOT accessible via `gh` — check the Railway dashboard or ask the user for logs

### 2d. Untracked work
- Merged PRs or commits that don't reference any issue -> assess whether a new issue should be created or if it's too minor (bug fixes, typos = skip)
- New issues needed for significant untracked features or infrastructure changes -> create with appropriate labels

### 2e. Stale branch cleanup (local + remote-tracking)

After a burst of PR merges the repo accumulates local branches whose remote has been deleted ("[gone]") plus orphan worktrees from aborted agent sessions. Clean them up.

1. **Prune remote-tracking refs** — safe; only updates local bookkeeping:
   ```bash
   git fetch --prune origin
   ```

2. **List candidates** — anything tagged `[gone]` in `git branch -vv`:
   ```bash
   git branch -vv | grep '\[gone\]'
   ```
   If nothing matches, skip to Step 3. If the current branch is in the list, first `git checkout main` — you can't delete the branch you're on.

3. **Remove orphan worktrees, then delete branches.** This loop handles both plain branches and ones pinned by worktrees (including locked worktrees whose owning agent PID is dead). The force-unlock is only safe when the PID is not alive — check before using `-f -f`:
   ```bash
   git branch -v | grep '\[gone\]' | sed 's/^[+* ]//' | awk '{print $1}' | while read branch; do
     echo "Processing: $branch"
     worktree=$(git worktree list | grep "\[$branch\]" | awk '{print $1}')
     if [ -n "$worktree" ] && [ "$worktree" != "$(git rev-parse --show-toplevel)" ]; then
       # Try a normal remove first; if locked by a dead PID, force.
       if ! git worktree remove "$worktree" 2>/dev/null; then
         lock_pid=$(git worktree list --porcelain | awk -v p="$worktree" '$2==p {found=1} found && /^locked/ {print; exit}' | grep -oE 'pid [0-9]+' | awk '{print $2}')
         if [ -n "$lock_pid" ] && ! ps -p "$lock_pid" > /dev/null 2>&1; then
           echo "  Lock PID $lock_pid is dead — force-removing worktree"
           git worktree remove -f -f "$worktree"
         else
           echo "  Worktree $worktree still locked by live PID — skipping"
           continue
         fi
       fi
     fi
     git branch -D "$branch"
   done
   ```

4. **Leftover local-only branches** — not tagged `[gone]` because they never tracked a remote (e.g., agent-workflow branches like `worktree-agent-*`). If clearly stale and their commits are already on `main` (or an open PR), delete with `git branch -D <name>`. Never delete a local branch that has unpushed commits you can't find elsewhere.

5. **Skip branches with open PRs** — before deleting any branch, confirm there's no open PR on it:
   ```bash
   gh pr list -R AtlasDevHQ/atlas --state open --head <branch-name>
   ```
   If an open PR exists, leave the branch alone — it's likely the user's in-flight work. A `[gone]` status usually means the remote PR was already closed/merged, but double-check for work-in-progress.

**Don't delete remote branches from `tidy`.** That's destructive across machines/collaborators. GitHub auto-deletes merged branches when "Delete branch on merge" is on; anything else (a stale remote with no PR) warrants a user decision, not an automated sweep.

---

**Step 3: Execute changes**

Make all changes — ROADMAP edits, issue updates, new issues. Group related operations.

For ROADMAP changes: use Edit tool to update checkboxes and add new items.

For issue updates:
```bash
# Add labels
gh issue edit N -R AtlasDevHQ/atlas --add-label "feature,area: api"

# Set milestone
gh issue edit N -R AtlasDevHQ/atlas --milestone "<milestone name>"

# Add comment
gh issue comment N -R AtlasDevHQ/atlas --body "status update..."

# Close
gh issue close N -R AtlasDevHQ/atlas --comment "Shipped in PR #X"
```

---

**Step 4: Commit and report**

If `.claude/research/ROADMAP.md` was changed:
1. `git add .claude/research/ROADMAP.md`
2. Commit with message like: `docs: tidy — check off shipped items`
3. `git push`

Output a summary:
- ROADMAP items checked off (count)
- ROADMAP items added (count)
- Issues updated (labels, milestones, comments, closed)
- New issues created
- Label/milestone gaps fixed
- Stale branches + worktrees removed (counts)
- Anything that looks off but wasn't auto-fixable

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Don't close issues that have open sub-issues — add a status comment instead
- Don't create issues for trivial fixes (typos, one-line bug fixes)
- Don't duplicate existing issues — search before creating
- Keep ROADMAP style consistent with existing sections (use `[x]`, link PRs/issues, match formatting)
- When adding status comments to parent issues, use bold headers and bullet lists
- Every issue must have: type label, area label(s), milestone (if one exists)
