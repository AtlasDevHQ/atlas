You are helping decide what to work on next in Atlas.

**Step 1: Read the current state**

Read these files to understand project status:
- `ROADMAP.md` — Master tracking document (what's shipped, what's next)
- `CLAUDE.md` — Project overview, architecture, conventions
- `package.json` — Dependencies, scripts, current version
- Recent git log (`git log --oneline -20`) — What was just shipped

Check for any open issues or TODOs:
- Grep for `TODO`, `FIXME`, `HACK` across `src/` and `bin/`

**Step 2: Identify areas of work**

Atlas has these major surfaces — assess each:

1. **Agent quality** — How well does the agent answer questions?
   - System prompt in `agent.ts` — is it guiding the agent effectively?
   - Tool definitions — are they giving the LLM enough context?
   - Error handling — does the agent recover gracefully from bad SQL?

2. **SQL validation & safety** — The 5-layer pipeline in `sql.ts`
   - Any edge cases not covered?
   - Performance of the validation pipeline?

3. **Semantic layer tooling** — `bin/atlas.ts` and `bin/enrich.ts`
   - Profiler completeness — missing column types, edge cases?
   - Enrichment quality — are LLM-generated descriptions useful?
   - New database support (MySQL, etc.)?

4. **Chat UI** — `src/app/page.tsx`
   - UX improvements (streaming, error states, history)?
   - Data visualization (charts, tables)?
   - Export capabilities?

5. **Provider support** — `src/lib/providers.ts`
   - New providers (Google, Groq, etc.)?
   - Provider-specific optimizations?

6. **Deployment & DX** — Docker, create-atlas, docs
   - Scaffolding CLI improvements?
   - One-click deploy templates?
   - Better onboarding flow?

7. **Testing** — What test coverage exists?
   - Unit tests for SQL validation?
   - Integration tests for the agent loop?
   - E2E tests for the chat flow?

**Step 3: Suggest 2-3 tasks**

For each suggestion, provide:
- **Task:** Clear description of what to build/fix
- **Why now:** Why this is the highest-leverage next step
- **Effort:** small / medium / large
- **Key files:** Which files to create or modify
- **Approach:** Brief implementation sketch (2-3 sentences)

**Guidelines:**
- Bias toward things that improve the core experience (agent answers questions better)
- Security and correctness trump features
- Prefer small, shippable increments over large refactors
- Consider what would make the best demo or README screenshot
- Don't suggest more than can realistically be done in a focused session

**Step 4: Parallelize the work**

The user has multiple checkouts of this repo and can run up to 3 Claude Code sessions in parallel.

After identifying tasks, decide:

**Independent prompts** — If tasks touch different files/surfaces with no merge conflicts, output each as a standalone prompt:
```
### Prompt [N]: [short title]
**Files:** [key files to create/modify]
**Branch:** [suggested branch name]

[Full prompt — detailed enough for a fresh Claude Code session with only CLAUDE.md context. Reference specific ROADMAP.md items being addressed.]
```

**Agent team** — If tasks are interdependent (shared interfaces, overlapping files, coordination needed), recommend an agent team instead and explain why.

**How to decide:**
- Different directories (e.g., `create-atlas/` vs `src/app/` vs `bin/`) → independent prompts
- Shared types, interfaces, or files → agent team
- When in doubt, prefer independent prompts
