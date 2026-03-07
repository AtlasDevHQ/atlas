You are helping decide what to work on next in Atlas.

**Step 1: Read current state**

Run these in parallel:
- `gh issue list -R AtlasDevHQ/atlas --state open --limit 30` — all open issues
- `gh project item-list 2 --owner AtlasDevHQ --format json` — project board status
- `git log --oneline -15` — what shipped recently

**Step 2: Assess priorities**

Work from the open issues. If there are open issues on the board, suggest them — don't skip past them to theorize about future directions. The board IS the plan.

Priority order:
1. **Bugs and security** — fix before building new things
2. **In Progress / Ready items** — finish what's started
3. **Backlog items** — pick the highest-leverage ones to clear
4. **Only if the board is truly empty** (zero open issues) — ask the user what direction they want to go. Don't invent work.

Read the top 2-3 candidate issues in detail: `gh issue view <N> -R AtlasDevHQ/atlas`

**Step 3: Suggest 2-3 issues to work on**

For each suggestion:
- **Issue:** `#N — title`
- **Why now:** Why this is the highest-leverage pick
- **Effort:** small / medium / large
- **Key files:** Which files to create or modify
- **Approach:** 2-3 sentence implementation sketch

**Guidelines:**
- Security and correctness trump features
- Prefer small, shippable increments over large refactors
- Bias toward things that improve the core experience
- Don't suggest more than one large effort at a time
- If a parent issue's sub-issues are all done, suggest closing it

**Step 4: Output session prompts**

The user runs up to 3 Claude Code sessions in parallel (separate checkouts).

**Independent prompts** — If tasks touch different files with no merge conflicts:
```
### Prompt [N]: [short title]
**Issue:** #N
**Files:** [key files to create/modify]
**Branch:** [suggested branch name]

[Full prompt — detailed enough for a fresh session with only CLAUDE.md context.
Reference the GH issue number. Include acceptance criteria.

IMPORTANT — Testing:
- Run tests with `bun run test` (isolated per-file runner), NEVER bare `bun test` (causes 177 false failures from mock.module() contamination across files)
- To run a single test file: `bun test path/to/file.test.ts`
- When using mock.module(), mock ALL named exports — partial mocks break other test files

IMPORTANT — Update the project board as you work:

1. Find the item ID for issue #N:
   gh project item-list 2 --owner AtlasDevHQ --format json | jq '.items[] | select(.content.number == N) | .id'

2. Move to "In Progress" when starting:
   gh project item-edit --project-id PVT_kwDOD8aze84BRASF --id <ITEM_ID> --field-id PVTSSF_lADOD8aze84BRASFzg-9gBo --single-select-option-id 47fc9ee4

3. When done, create a PR linked to #N (use "Closes #N" in the PR body), then move to "Done":
   gh project item-edit --project-id PVT_kwDOD8aze84BRASF --id <ITEM_ID> --field-id PVTSSF_lADOD8aze84BRASFzg-9gBo --single-select-option-id 98236657
]
```

**Agent team** — If tasks share interfaces or files, recommend a team instead and explain why.

**How to decide:**
- Different directories (e.g., `src/app/` vs `bin/` vs `create-atlas/`) → independent prompts
- Shared types, interfaces, or overlapping files → agent team
- When in doubt, prefer independent prompts

**Issue/board hygiene:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands (no default repo set)
- GitHub Project #2 (`PVT_kwDOD8aze84BRASF`) under AtlasDevHQ org is the project board
- When creating new issues, add them to the board: `gh project item-add 2 --owner AtlasDevHQ --url <issue_url>`
- If a parent issue has all sub-issues closed and the core work is done, suggest closing it or note what remains
