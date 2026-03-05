You are helping decide what to work on next in Atlas.

**Step 1: Read current state**

Run these in parallel:
- `gh issue list -R AtlasDevHQ/atlas --state open --limit 30` — all open issues with labels
- `gh project item-list 1 --owner AtlasDevHQ --format json` — project board status (Backlog/Ready/In Progress/In Review/Done)
- `git log --oneline -15` — what shipped recently
- Check `.claude/research/ROADMAP.md` if it exists — high-level milestone summary (but GitHub Issues are the source of truth for task details)

**Step 2: Assess priorities**

Issues are labeled by milestone (`v0.5`, `v0.6`, etc.) and type (`bug`, `security`, `dx`, etc.).

Priority order:
1. **Bugs and security** — `bug`, `security` labels. Fix before building new things
2. **Current milestone leftovers** — lowest versioned milestone with open issues
3. **DX / infrastructure** — `dx`, `infrastructure` labels. Unblocks future work
4. **Next milestone** — only if current milestone is clean

Read the top 2-3 issues in detail: `gh issue view <N> -R AtlasDevHQ/atlas`

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
   gh project item-list 1 --owner AtlasDevHQ --format json | jq '.items[] | select(.content.number == N) | .id'

2. Move to "In Progress" when starting:
   gh project item-edit --project-id PVT_kwDOD8aze84BQhKC --id <ITEM_ID> --field-id PVTSSF_lADOD8aze84BQhKCzg-nP_w --single-select-option-id 47fc9ee4

3. When done, create a PR linked to #N (use "Closes #N" in the PR body), then move to "Done":
   gh project item-edit --project-id PVT_kwDOD8aze84BQhKC --id <ITEM_ID> --field-id PVTSSF_lADOD8aze84BQhKCzg-nP_w --single-select-option-id 98236657
]
```

**Agent team** — If tasks share interfaces or files, recommend a team instead and explain why.

**How to decide:**
- Different directories (e.g., `src/app/` vs `bin/` vs `create-atlas/`) → independent prompts
- Shared types, interfaces, or overlapping files → agent team
- When in doubt, prefer independent prompts

**Issue/board hygiene:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands (no default repo set)
- GitHub Project #1 (`PVT_kwDOD8aze84BQhKC`) under AtlasDevHQ org is the project board — issues track status there
- When creating new issues, add them to the board: `gh project item-add 1 --owner AtlasDevHQ --url <issue_url>`
- Label new issues with the appropriate milestone (`v0.5`, `v0.6`, etc.) and type (`bug`, `security`, `dx`, etc.)
