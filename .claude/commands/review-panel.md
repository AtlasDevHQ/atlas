Run the internal review panel on the current diff — the four tuned specialist reviewers, fan-out in parallel, fresh context.

**Input:** `$ARGUMENTS` — optional base ref to diff against. Default: `origin/main`. (Inside a PR, diff the PR branch against its base.)

This is the shared review primitive both `/ship-issue` (L0) and `/ship-milestone` (L2) call. It reviews **before** the PR opens, with fresh-context agents rather than the author re-reading its own diff. See `docs/agents/loops.md` and `.claude/agents/README.md`.

---

**Step 1: Compute the diff**

```bash
BASE="${ARGUMENTS:-origin/main}"
git fetch origin --quiet
git diff "$BASE"...HEAD --stat   # scope
```
If there is nothing to review, say so and stop.

**Step 2: Fan out the panel — IN PARALLEL, fresh context**

Launch all four in a single message (multiple `Agent` tool calls, one response) so they run concurrently. Each gets the diff scope and is told to review only the changed lines:

- `Agent(silent-failure-hunter)` — error handling & silent failures
- `Agent(type-design-analyzer)` — type invariants & safety
- `Agent(pr-test-analyzer)` — test coverage & discipline
- `Agent(comment-analyzer)` — comment accuracy & idiom

Each is read-only/advisory. Give every agent the same context: the base ref, the changed files, and "review only this diff against Atlas's CLAUDE.md standards; report findings with file:line + severity."

**Step 3: Collect, dedupe, prioritize**

Merge the four reports. Drop duplicates (e.g. an untested error path flagged by both silent-failure-hunter and pr-test-analyzer → one entry). Sort by severity.

**Step 4: Output**

```
## Review panel — <N> findings

### Must fix (CRITICAL / HIGH)
- [silent-failure] file:line — <issue> → <fix>
- [type-design]   file:line — <issue> → <fix>

### Should consider (MEDIUM)
- ...

### Clean axes
- <agents that found nothing>
```

End with a one-line verdict: **CLEAN** (nothing must-fix) or **CHANGES REQUESTED** (≥1 must-fix). Callers gate on this verdict.

**Rules:**
- Read-only. The panel reports; it never edits code.
- Fresh context per agent — never let the implementer "review" its own diff in-context; that rubber-stamps.
- This is the specialist layer. The repo's `/code-review` and `/simplify` remain the canonical generic passes — don't duplicate them here.
