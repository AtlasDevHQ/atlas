# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues at `AtlasDevHQ/atlas`. Use the `gh` CLI for all operations, and **always pass `-R AtlasDevHQ/atlas`** — this workstation has multiple Atlas-adjacent clones and `gh` can otherwise resolve to the wrong remote.

## Conventions

- **Create an issue**: `gh issue create -R AtlasDevHQ/atlas --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R AtlasDevHQ/atlas --comments`.
- **List issues**: `gh issue list -R AtlasDevHQ/atlas --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment**: `gh issue comment <number> -R AtlasDevHQ/atlas --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R AtlasDevHQ/atlas --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R AtlasDevHQ/atlas --comment "..."`

Prefer REST over GraphQL when scripting (the org has historically hit GraphQL rate limits faster — see project memory).

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `AtlasDevHQ/atlas`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R AtlasDevHQ/atlas --comments`.

---

## Issue title format

`<type>: <concise, action-oriented description>` — e.g. `fix: explore tool doesn't handle symlinks`, `feat: add createDashboard tool`. Keep titles under 80 chars.

## Issue body format

**Every Atlas issue body uses these sections, in this order:**

```markdown
<1–2 paragraph description of what needs to happen and why it matters>

## Key files
- `path/to/file.ts` — what to change here
- `path/to/other.ts` — what's relevant

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Dependencies
- Depends on #N (if applicable)
```

For bugs / investigations, optionally add a `## Findings` section between the description and `## Key files`. For PRDs, add `## Scope`, `## Out of scope`, `## Open questions` after `## Acceptance criteria`.

**This format is load-bearing.** `/tidy`, `/closeout`, and `/next` all parse it. Skills that create issues from other formats (e.g. `/to-issues` "tracer-bullet vertical slices") **must adapt their output to this structure** — keep the vertical-slice mindset, but render it as `## Key files` + `## Acceptance criteria`. Don't invent new section headers.

## Required labels (two dimensions, both required)

Every Atlas issue carries labels from **two orthogonal axes**:

### 1. Kind + location (Atlas convention)

- **Exactly one type label**: `bug` / `feature` / `refactor` / `chore` / `docs`
- **One or more area labels**: `area: api` / `area: web` / `area: cli` / `area: plugins` / `area: sandbox` / `area: deploy` / `area: ci` / `area: sdk` / `area: mcp` / `area: starter` / `area: docs` / `area: testing`
- **Optional cross-cutting labels**: `architecture` (module-deepening refactors from `/improve-codebase-architecture`), `security`, `design`, `blocked`

### 2. Triage state (Matt Pocock convention)

See `docs/agents/triage-labels.md`. One of: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`.

These five exist *in addition* to the kind/area labels — they don't replace them.

**Putting it together:**

```bash
# A community bug report, fresh, needs evaluation
gh issue edit 123 -R AtlasDevHQ/atlas --add-label "bug,area: api,needs-triage"

# Same bug, after triage — fully specified, ready for an AFK agent
gh issue edit 123 -R AtlasDevHQ/atlas --remove-label "needs-triage" --add-label "ready-for-agent"
```

## Milestone

Every issue should be assigned to the current active milestone unless it's explicitly deferred. Check active milestones:

```bash
gh api repos/AtlasDevHQ/atlas/milestones --jq '.[] | select(.state=="open") | "\(.number)\t\(.title)"'
```

## Creating an issue end-to-end

```bash
ISSUE_URL=$(gh issue create -R AtlasDevHQ/atlas \
  --title "fix: <description>" \
  --label "bug,area: api,needs-triage" \
  --milestone "1.4.4 — Multi-environment semantic layer" \
  --body "$(cat <<'EOF'
<1–2 paragraph description>

## Key files
- `packages/api/src/...` — what to change

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Dependencies
- Depends on #N
EOF
)" 2>&1 | tail -1)

echo "Created: $ISSUE_URL"
```

## Searching before filing

Always check for an existing issue before creating a new one:

```bash
gh issue list -R AtlasDevHQ/atlas --state open --search "<keywords>" --json number,title,labels --limit 10
```

If a matching issue exists, comment on it instead of duplicating.

## Detaching unfinished issues at milestone closeout

**Closed milestones reflect only what shipped.** An issue that was scoped into a milestone but didn't make the cut must be detached *before* the milestone is closed — otherwise `gh issue list -m <N>` (and the milestone page on github.com) misrepresent what the milestone delivered.

The convention is to move detached work to the open **`Architecture Backlog`** milestone (#49) — long-running architecture work that doesn't fit a specific milestone. Pick from it when a slice naturally fits an active milestone.

```bash
# During /closeout, for any issue scoped to the milestone but still open:
gh issue edit <number> -R AtlasDevHQ/atlas --milestone "Architecture Backlog"
```

**Don't** strip the milestone outright (`--remove-milestone`). Milestone-less issues become invisible to `/next` and lose the discoverability that the backlog milestone gives them. The `architecture` label complements but does not replace the backlog milestone.

**Audit gate.** As part of closeout, run:

```bash
gh api repos/AtlasDevHQ/atlas/milestones --paginate \
  --jq '.[] | select(.state=="closed" and .open_issues>0) | {number, title, open_issues}'
```

Output must be empty before the milestone closeout is complete. If it isn't, migrate the open issues to `Architecture Backlog` (or another active milestone if the work is being picked up immediately).

**Carry-over watch.** An issue that gets detached during one closeout, then re-attached to a later milestone without being completed, then detached again, is a signal — the scope is genuinely long-running architecture rather than a single milestone slice. Examples from project history: #2123 (explore tool refactor) was detached from 1.4.1 closeout, pulled into 1.5.1 at kickoff as a candidate refactor, never picked up, and detached again at 1.5.1 closeout. These belong in `Architecture Backlog` semi-permanently — pull them into an active milestone only when there's a concrete plan and an owner.
