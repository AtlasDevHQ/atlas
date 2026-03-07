# Project Tidy

Reconcile recent work (commits, PRs) against GitHub issues, project board, and ROADMAP. Fix drift, close gaps, clean up stale items.

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
   gh issue list -R AtlasDevHQ/atlas --state open --limit 50 --json number,title,labels,milestone,projectItems
   ```

5. Recently closed issues (last 2 days):
   ```
   gh issue list -R AtlasDevHQ/atlas --state closed --limit 50 --json number,title,closedAt,labels --jq '.[] | select(.closedAt > "YYYY-MM-DD") | "\(.number)\t\(.title)\t\(.closedAt)"'
   ```
   (Replace YYYY-MM-DD with 2 days ago)

6. Full project board:
   ```
   gh project item-list 2 --owner AtlasDevHQ --format json --limit 100 | jq -r '.items[] | "\(.status)\t#\(.content.number // "draft")\t\(.title)"' | sort
   ```

7. CI status (last 5 runs on main):
   ```
   gh run list -R AtlasDevHQ/atlas --branch main --limit 5 --json status,conclusion,name,createdAt,databaseId
   ```
   If any CI runs are failing, get the failure details:
   ```
   gh run view <run_id> -R AtlasDevHQ/atlas --log-failed 2>&1 | tail -30
   ```

8. `.claude/research/ROADMAP.md` — Read the current milestone sections (if it exists)

---

**Step 2: Cross-reference and identify gaps**

For each category, build a list of actions needed:

### 2a. ROADMAP checkboxes
- Compare merged PRs and closed issues against ROADMAP `- [ ]` items
- Any shipped work still showing `- [ ]` → change to `- [x]` and add "— Shipped" to section header if all items done
- Any new shipped work not listed in ROADMAP → add as new line items under the appropriate milestone section

### 2b. Project board status
- Items marked "Done" on board but issue still OPEN with open sub-issues → move to "In Progress"
- Issues that are CLOSED but board shows "Todo" or "In Progress" → move to "Done"
- Duplicate items (same title, issue + PR both on board) → remove the PR entry, keep the issue
- Board item IDs:
  - Project: `PVT_kwDOD8aze84BRASF`
  - Status field: `PVTSSF_lADOD8aze84BRASFzg-9gBo`
  - Backlog: `f75ad846`, Ready: `61e4505c`, In Progress: `47fc9ee4`, In Review: `df73e18b`, Done: `98236657`

### 2c. Issue hygiene
- Open issues whose work is fully shipped (all items done, PR merged) → close with comment
- Issues missing labels → add appropriate labels (check existing label set first)
- Parent issues with shipped sub-issues → add status comment listing what shipped and what remains

### 2d. CI health
- If CI is failing on main, this is **urgent** — diagnose the failure and fix it before other tidy work
- Check if failures are from recently merged PRs (regressions) or pre-existing
- Common causes: type errors in new code, missing test mocks, dependency drift

### 2e. Untracked work
- Merged PRs or commits that don't reference any issue → assess whether a new issue should be created or if it's too minor (bug fixes, typos = skip)
- New issues needed for significant untracked features or infrastructure changes → create with appropriate labels and add to project board

---

**Step 3: Execute changes**

Make all changes — ROADMAP edits, board moves, issue updates, new issues. Group related operations.

For ROADMAP changes: use Edit tool to update checkboxes and add new items.

For board changes:
```bash
# Get item ID
ITEM_ID=$(gh project item-list 2 --owner AtlasDevHQ --format json --limit 100 | jq -r '.items[] | select(.content.number == N) | .id')

# Move to status
gh project item-edit --project-id PVT_kwDOD8aze84BRASF --id "$ITEM_ID" --field-id PVTSSF_lADOD8aze84BRASFzg-9gBo --single-select-option-id <STATUS_ID>

# Remove duplicate
gh project item-delete 2 --owner AtlasDevHQ --id "$ITEM_ID"

# Add issue to board
gh project item-add 2 --owner AtlasDevHQ --url <issue_url>
```

For issue updates:
```bash
# Add labels
gh issue edit N -R AtlasDevHQ/atlas --add-label "label1,label2"

# Add comment
gh issue comment N -R AtlasDevHQ/atlas --body "status update..."

# Close
gh issue close N -R AtlasDevHQ/atlas --comment "Shipped in PR #X"
```

---

**Step 4: Commit and report**

If `.claude/research/ROADMAP.md` was changed:
1. `git add .claude/research/ROADMAP.md`
2. Commit with message like: `Update ROADMAP: mark <milestone> items as shipped, add missing items`
3. `git push`

Output a summary:
- ROADMAP items checked off (count)
- ROADMAP items added (count)
- Board items moved (list: #N from X → Y)
- Board items removed (duplicates)
- Issues updated (labels, comments, closed)
- New issues created
- Anything that looks off but wasn't auto-fixable

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Don't close issues that have open sub-issues — move to "In Progress" instead
- Don't create issues for trivial fixes (typos, one-line bug fixes)
- Don't duplicate existing issues — search before creating
- Keep ROADMAP style consistent with existing sections (use `[x]`, link PRs/issues, match formatting)
- When adding status comments to parent issues, use bold headers and bullet lists
