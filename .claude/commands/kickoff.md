# Milestone Kickoff

Spin up the next milestone: create GitHub issues from ROADMAP line items, label them, and assign milestones.

**Run when starting a new milestone** — all previous milestones should be shipped and tidied first.

---

**Step 1: Identify the next milestone**

Run these in parallel:

1. Read `.claude/research/ROADMAP.md` — find the first milestone section where NOT all items are `[x]`
2. Current open issues (should be zero or near-zero if tidy was run):
   ```
   gh issue list -R AtlasDevHQ/atlas --state open --limit 30 --json number,title,labels,milestone
   ```
3. Available milestones:
   ```
   gh api repos/AtlasDevHQ/atlas/milestones --jq '.[] | "\(.number)\t\(.title)\t\(.state)\t\(.open_issues)/\(.closed_issues)"'
   ```

**Step 2: Validate readiness**

Before creating issues:
- Confirm the previous milestone is fully shipped (all ROADMAP items checked, all issues closed)
- If there are straggler open issues from a previous milestone, flag them and ask the user whether to close, move forward, or defer
- Identify the target milestone name and number (e.g., `0.3.0 — Admin & Operations`, milestone #3)

**Step 3: Plan the issues**

For each unchecked `- [ ]` item in the target milestone section of ROADMAP.md:

1. **Parse the line item** — extract the title and any parenthetical notes
2. **Determine issue type and areas:**
   - Type label: `feature` (new capability), `refactor` (restructuring), `chore` (maintenance), `docs` (documentation), `bug` (fix)
   - Area labels: infer from the item description — `area: api`, `area: web`, `area: cli`, `area: plugins`, `area: sandbox`, `area: deploy`, `area: ci`, `area: sdk`, `area: mcp`, `area: starter`, `area: docs`, `area: testing`
3. **Estimate priority and size:**
   - Priority: P0 (blocking/foundational), P1 (important), P2 (nice-to-have)
   - Size: XS (< 1 hour), S (1-4 hours), M (half day), L (1-2 days), XL (3+ days)
4. **Draft the issue body** — Include:
   - One-paragraph description of what needs to be built/changed
   - Key files likely involved (use the module map from `/research` command)
   - Acceptance criteria (3-5 bullet points)
   - Any dependencies on other issues in this milestone

**Before creating anything, present the full plan to the user:**

```
## Milestone Kickoff: 0.X.0 — [Name]

| # | Title | Type | Area(s) | Priority | Size | Dependencies |
|---|-------|------|---------|----------|------|-------------|
| 1 | ... | feature | area: api, area: web | P0 | M | — |
| 2 | ... | feature | area: web | P1 | L | #1 |
| ... | ... | ... | ... | ... | ... | ... |

Total: N issues (X P0, Y P1, Z P2)

Proceed? (y/n)
```

Wait for user confirmation before creating issues.

**Step 4: Create issues**

For each approved issue, run sequentially (to get issue numbers for cross-references):

```bash
# Create the issue
ISSUE_URL=$(gh issue create -R AtlasDevHQ/atlas \
  --title "<title>" \
  --label "<type>,<area1>,<area2>" \
  --milestone "0.X.0 — <Name>" \
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
- Add issue numbers to each line item: `- [ ] Action approval UI (#N)`
- If any items were split into multiple issues, update the line items to reflect the split

**Step 6: Suggest first picks**

After creating all issues, recommend 2-3 issues to start with (same format as `/next`):
- Prefer P0 items with no dependencies
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
- Group related sub-tasks under a parent issue when a line item is too large for a single issue (L or XL)

**Milestone reference:**
- 0.1.0–0.5.4 — All CLOSED (docs, plugins, admin, chat, launch, polish)
- 0.6.0 — Governance & Operational Hardening (milestone #7, CLOSED)
- 0.7.0 — Performance & Scale (milestone #8, CLOSED)
- 0.7.1–0.7.4 — Refinement arc (CLOSED: cleanup, type safety, error handling, test hardening)
- 0.7.5 — Docs Completeness (milestone #19)
- 0.8.0 — Intelligence & Learning (milestone #9)
- Check live state: `gh api repos/AtlasDevHQ/atlas/milestones --jq '.[] | "\(.title) (\(.state))"'`
