You are helping decide what to work on next in Atlas.

**Step 1: Read current state**

Run these in parallel:
- `gh issue list -R AtlasDevHQ/atlas --state open --limit 30 --json number,title,labels,milestone` — all open issues
- `git log --oneline -15` — what shipped recently
- Read `.claude/research/ROADMAP.md` — shipped history and Ideas/Backlog

**Step 2: Assess priorities**

Work from the open issues. Priority order:
1. **Bugs and security** — fix before building new things
2. **Current milestone items** — highest priority within the active milestone
3. **Next milestone** — only if current milestone is nearly done
4. **Only if zero open issues** — consult the Ideas/Backlog section of ROADMAP.md and suggest what to plan next

Read the top 2-3 candidate issues in detail: `gh issue view <N> -R AtlasDevHQ/atlas`

**Step 3: Suggest 2-3 issues to work on**

For each suggestion:
- **Issue:** `#N — title`
- **Milestone:** which release it's part of
- **Why now:** Why this is the highest-leverage pick
- **Key files:** Which files to create or modify
- **Approach:** 2-3 sentence implementation sketch

**Guidelines:**
- Security and correctness trump features
- Prefer small, shippable increments over large refactors
- Bias toward things that improve the core experience
- Don't suggest more than one large effort at a time
- If a parent issue's sub-issues are all done, suggest closing it
- **Architecture refactors** (label: `architecture`) are good candidates when bugs are clear and features are on track. These are module-deepening refactors from `/improve-codebase-architecture` — they reduce duplication and improve testability. When suggesting one, note the expected line-count impact from the issue body. After an architecture refactor ships, remind the session to record the win in `.claude/research/architecture-wins.md`

**Docs check:**
After reviewing recent commits, check if docs are stale — especially after renames, config changes, or new features. Grep for old names/paths in `apps/docs/`. Include doc fixes in your suggestions or fix them directly if trivial (< 5 lines).

**File issues for incidental findings:**
During assessment, if you notice bugs, tech debt, stale references, or pre-existing errors that aren't tracked, file GH issues for them immediately — don't just mention them in chat. Use the standard format:
```
gh issue create -R AtlasDevHQ/atlas --title "fix: <description>" --body "<details>" --label "bug,area: <area>"
```
This prevents findings from being lost between sessions.

**Step 4: Output session prompts**

The user runs up to 3 Claude Code sessions in parallel (separate checkouts).

**Independent prompts** — If tasks touch different files with no merge conflicts:
```
### Prompt [N]: [short title]
**Issue:** #N
**Milestone:** X.Y.Z
**Files:** [key files to create/modify]
**Branch:** [suggested branch name]

[Full prompt — detailed enough for a fresh session with only CLAUDE.md context.
Reference the GH issue number. Include acceptance criteria.

IMPORTANT — CI gates (mandatory before PR):
- Before creating a PR, run `/ci` which checks: lint, type, test, syncpack, template drift
- All five gates must pass. If any fail, fix them before pushing.
- You can also run gates individually during development:
  - `bun run lint` — ESLint
  - `bun run type` — TypeScript (tsgo)
  - `bun run test` — all tests (isolated per-file runner), NEVER bare `bun test`
  - `bun x syncpack lint` — dependency version consistency
  - `SKIP_SYNCPACK=1 bash scripts/check-template-drift.sh` — template drift
- To run a single test file: `bun test path/to/file.test.ts`
- When using mock.module(), mock ALL named exports — partial mocks break other test files
- Use `createConnectionMock()` from `packages/api/src/__mocks__/connection.ts` for connection mocks

IMPORTANT — Error handling rules:
- Never silently swallow errors — every catch block must log (log.warn/console.debug) or re-throw
- Always type-narrow: `err instanceof Error ? err.message : String(err)`
- All 500 responses must include requestId
- No explicit `any` — use proper types or `unknown` with narrowing

IMPORTANT — Labels:
- Every issue needs a type label (bug, feature, refactor, chore, docs) and area label(s) (area: api, area: web, area: cli, area: plugins, area: sandbox, area: deploy, area: ci, area: sdk, area: mcp, area: starter)
- Apply labels when creating issues: `gh issue edit N -R AtlasDevHQ/atlas --add-label "feature,area: api"`

IMPORTANT — Incidental findings:
- When you discover bugs, tech debt, stale references, or pre-existing errors during your work that are NOT part of your current task, file a GH issue immediately — do not fix them inline or just mention them in chat
- Use: `gh issue create -R AtlasDevHQ/atlas --title "fix: <description>" --body "<details>" --label "bug,area: <area>"`
- Keep your current work focused — the issue ensures the finding isn't lost

IMPORTANT — Docs impact:
- When your change affects user-facing behavior, configuration, APIs, or plugin interfaces, update the relevant docs:
  - Docs site pages: `apps/docs/content/docs/` (MDX files)
  - Design docs: `docs/design/` and `docs/guides/`
  - READMEs: plugin READMEs in `plugins/*/README.md`, SDK README in `packages/plugin-sdk/README.md`
- Include docs updates in the same PR as the code change — don't leave them for a follow-up
- If a code change has large docs impact (new feature page, restructured sections), note it in the PR description
]
```

**Agent team** — If tasks share interfaces or files, recommend a team instead and explain why.

**How to decide:**
- Different directories (e.g., `packages/web/` vs `packages/cli/` vs `apps/docs/`) -> independent prompts
- Shared types, interfaces, or overlapping files -> agent team
- When in doubt, prefer independent prompts

**Issue hygiene:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands (no default repo set)
- When creating new issues, always include: type label, area label(s), milestone (if one exists)
- If a parent issue has all sub-issues closed and the core work is done, suggest closing it or note what remains

**Label reference:**
- Type: `bug`, `feature`, `refactor`, `chore`, `docs`
- Area: `area: api`, `area: web`, `area: cli`, `area: plugins`, `area: sandbox`, `area: deploy`, `area: ci`, `area: sdk`, `area: mcp`, `area: starter`, `area: docs`, `area: testing`
- Community: `good first issue`, `help wanted`

**Strategic context:** `.claude/research/design/competitive-landscape.md` has competitive analysis and rationale for feature prioritization.
