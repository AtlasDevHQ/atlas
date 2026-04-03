# Milestone Kickoff

Spin up a new milestone: create GitHub issues from planned work, label them, and assign milestones.

**Run when starting a new milestone** — previous milestones should be shipped and tidied first.

---

**Step 1: Identify the milestone**

Run these in parallel:

1. Read `.claude/research/ROADMAP.md` — find the next planned milestone or the Ideas/Backlog section
2. Current open issues (should be zero or near-zero if tidy was run):
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --limit 30 --json number,title,labels,milestone
   ```
3. Available milestones:
   ```
   gh api repos/AtlasDevHQ/atlas/milestones?state=all --jq '.[] | "\(.number)\t\(.title)\t\(.state)\t\(.open_issues)/\(.closed_issues)"'
   ```

**Step 2: Validate readiness**

Before creating issues:
- Confirm the previous milestone is fully shipped (all issues closed)
- If there are straggler open issues from a previous milestone, flag them and ask the user whether to close, move forward, or defer
- Identify the target milestone name and number — create one if needed:
  ```
  gh api repos/AtlasDevHQ/atlas/milestones -f title="X.Y.Z — Theme Name" -f description="Brief description"
  ```

**Step 3: Plan the issues**

For each planned item in the target milestone:

1. **Parse the line item** — extract the title and any parenthetical notes
2. **Determine issue type and areas:**
   - Type label: `feature` (new capability), `refactor` (restructuring), `chore` (maintenance), `docs` (documentation), `bug` (fix)
   - Area labels: infer from the item description — `area: api`, `area: web`, `area: cli`, `area: plugins`, `area: sandbox`, `area: deploy`, `area: ci`, `area: sdk`, `area: mcp`, `area: starter`, `area: docs`, `area: testing`
3. **Draft the issue body** — Include:
   - One-paragraph description of what needs to be built/changed
   - Key files likely involved
   - Acceptance criteria (3-5 bullet points)
   - Any dependencies on other issues in this milestone

**Before creating anything, present the full plan to the user:**

```
## Milestone Kickoff: X.Y.Z — [Name]

| # | Title | Type | Area(s) | Dependencies |
|---|-------|------|---------|-------------|
| 1 | ... | feature | area: api, area: web | — |
| 2 | ... | feature | area: web | #1 |
| ... | ... | ... | ... | ... |

Total: N issues

Proceed? (y/n)
```

Wait for user confirmation before creating issues.

**Step 4: Create issues**

For each approved issue, run sequentially (to get issue numbers for cross-references):

```bash
ISSUE_URL=$(gh issue create -R AtlasDevHQ/atlas \
  --title "<title>" \
  --label "<type>,<area1>,<area2>" \
  --milestone "X.Y.Z — <Name>" \
  --body "$(cat <<'EOF'
<description>

## Key files
- `path/to/file.ts` — what to change here
- `path/to/other.ts` — what to change here

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Dependencies
- Depends on #N (if applicable)
EOF
)" 2>&1 | tail -1)

echo "Created: $ISSUE_URL"
```

**Step 5: Update ROADMAP**

After all issues are created, update `.claude/research/ROADMAP.md`:
- Add issue numbers to each line item: `- [ ] Feature description (#N)`
- If any items were split into multiple issues, update the line items to reflect the split

---

**Step 6: Suggest first picks**

After creating all issues, recommend 2-3 issues to start with (same format as `/next`):
- Prefer foundational work that unblocks other items
- Consider parallelizability (can multiple sessions work on different items?)

Output session prompts in the same format as `/next` — detailed enough for a fresh Claude Code session.

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Don't create duplicate issues — search for existing ones first
- Every issue must have: type label, area label(s), milestone
- Issue bodies should be actionable — include file paths, acceptance criteria
- Dependencies should reference issue numbers (use `Depends on #N`)
- If a ROADMAP line item is vague, flesh it out based on codebase analysis before creating the issue
- Keep issue titles concise (< 80 chars) and action-oriented ("Add X", "Implement Y", not "X feature")
- Group related sub-tasks under a parent issue when a line item is too large for a single issue
