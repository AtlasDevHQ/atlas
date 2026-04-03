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
