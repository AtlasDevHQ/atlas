Investigate something you've noticed — a bug, tech debt, rough edge, or idea — that isn't tracked anywhere. Research it, file a GH issue, and decide whether to fix it now or park it.

**Input:** $ARGUMENTS (describe what you noticed — e.g., "the explore tool doesn't handle symlinks", "sql validation lets UNION through", "we should add retry logic to sidecar calls")

---

**Step 1: Research the issue**

Use the `/research` module map to find relevant files. Trace through the code to understand:
- **What's happening** — reproduce or confirm the issue by reading code paths
- **Scope** — how many files/packages are affected?
- **Impact** — who does this affect? (users, developers, deploy, security)
- **Root cause** — why does this happen? Is it a bug, missing feature, or tech debt?

Be thorough but efficient — read the key files, grep for related patterns, check tests. Don't spend time on tangential exploration.

**Step 2: Check it's not already tracked**

```bash
gh issue list -R AtlasDevHQ/atlas --state open --search "<keywords>" --json number,title,labels --limit 10
```

If a matching issue exists, tell the user and link it. Add any new findings as a comment on the existing issue instead of creating a duplicate:
```bash
gh issue comment <N> -R AtlasDevHQ/atlas --body "<new findings>"
```
Then skip to Step 4.

**Step 3: Classify and file the issue**

Determine:
- **Type label:** `bug` (broken behavior), `feature` (new capability), `refactor` (structural improvement), `chore` (maintenance/cleanup), `docs` (documentation gap)
- **Area label(s):** `area: api`, `area: web`, `area: cli`, `area: plugins`, `area: sandbox`, `area: deploy`, `area: ci`, `area: sdk`, `area: mcp`, `area: starter`, `area: docs`, `area: testing`
- **Milestone:** `0.0.x — Pre-release` (#6) for standalone fixes. If it clearly belongs to an upcoming milestone, use that instead
- **Priority:** P0 (security/correctness), P1 (important), P2 (nice-to-have)
- **Size:** XS (< 1 hour), S (1-4 hours), M (half day), L (1-2 days), XL (3+ days)

Create the issue:
```bash
ISSUE_URL=$(gh issue create -R AtlasDevHQ/atlas \
  --title "<type>: <concise description>" \
  --label "<type>,<area1>,<area2>" \
  --milestone "<milestone name>" \
  --body "$(cat <<'EOF'
<1-2 paragraph description of the issue, what was found, and why it matters>

## Key files
- `path/to/file.ts` — what's relevant here
- `path/to/other.ts` — what's relevant here

## Findings
- Finding 1
- Finding 2
- Finding 3

## Suggested fix
<Brief description of the approach — enough for someone picking this up cold>

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
EOF
)" 2>&1 | tail -1)

echo "Created: $ISSUE_URL"
```

**Step 4: Summarize and recommend next steps**

Output a summary:

```
## Investigation: <title>

**Issue:** #N — <title>
**Type:** bug/feature/refactor/chore/docs
**Priority:** P0/P1/P2 | **Size:** XS/S/M/L/XL
**Milestone:** 0.x.0 — <name>

### Findings
<2-4 bullet summary of what you found>

### Recommendation
<One of:>
```

Then ask the user to choose:

1. **Park it** — Issue is filed. Pick it up later via `/next`. Done.
2. **Fix it now** — Output a session prompt (same format as `/next`) so the user can start immediately.

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Don't create duplicate issues — always search first (Step 2)
- Every issue must have: type label, area label(s), milestone
- Issue titles should be action-oriented and prefixed with type: `fix:`, `feat:`, `refactor:`, `chore:`, `docs:`
- The issue body should contain enough context for someone to pick it up cold — include file paths, code snippets, and reproduction steps where applicable
- If research reveals multiple distinct issues, file them separately — don't bundle unrelated findings
- If the issue turns out to be a non-issue (code is correct, behavior is intentional), say so and skip filing
