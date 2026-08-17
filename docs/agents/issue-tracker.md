# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in **`AtlasDevHQ/atlas`**. Use the `gh`
CLI for all operations.

## Atlas conventions (these override the generic template)

- **Always pass `-R AtlasDevHQ/atlas` explicitly.** `gh` can infer the repo from the remote,
  but this project runs several clones and git worktrees in parallel, and inference has
  picked the wrong one. Be explicit every time.
- **Every issue body follows the Atlas format**, and it is load-bearing — tooling and audits
  parse these headings:

  ```markdown
  ## Key files
  ## Acceptance criteria
  ## Dependencies
  ```

  Skills that create issues in another shape (`/to-tickets` and its "tracer-bullet vertical
  slices") **must render their output into this structure**. Keep the vertical-slice
  thinking; don't invent new section headers.
- **Two label axes, both required.** State (below) *and* kind+location: exactly one of
  `bug` / `feature` / `refactor` / `chore` / `docs`, plus one or more `area: *`, plus
  optional `architecture` / `security` / `design` / `blocked`. Note `feature`, never
  `enhancement`.
- ⚠️ **A `#N` written anywhere in a body parses as a real dependency edge**, including inside
  prose. And GitHub's closing keywords ignore negation — *"does not fix #N"* still closes
  `#N`. Write cross-references as links or as `issue 1234` when you do not mean an edge.

## Operations

- **Create**: `gh issue create -R AtlasDevHQ/atlas --title "..." --body "..."` (heredoc for multi-line bodies)
- **Read**: `gh issue view <number> -R AtlasDevHQ/atlas --comments`
- **List**: `gh issue list -R AtlasDevHQ/atlas --state open --json number,title,body,labels --jq '[.[] | {number, title, labels: [.labels[].name]}]'`
- **Comment**: `gh issue comment <number> -R AtlasDevHQ/atlas --body "..."`
- **Label**: `gh issue edit <number> -R AtlasDevHQ/atlas --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R AtlasDevHQ/atlas --comment "..."`

Prefer the REST surface over GraphQL where both work — GraphQL 503s are common enough here
that sweeps should verify by re-listing rather than trusting an exit code.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue, in the Atlas body format above.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R AtlasDevHQ/atlas --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the
  sub-issues endpoint). Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with
  `gh api --method POST repos/AtlasDevHQ/atlas/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`,
  where `<blocker-db-id>` is the blocker's numeric **database id**
  (`gh api repos/AtlasDevHQ/atlas/issues/<n> --jq .id` — *not* the `#number` or `node_id`).
  A ticket is unblocked when every blocker is closed.
- **Frontier query**: the map's open children, minus any with an open blocker
  (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> -R AtlasDevHQ/atlas --add-assignee @me`.
- **Resolve**: comment the answer, close, then append a context pointer to the map's
  Decisions-so-far.
