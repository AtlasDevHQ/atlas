# Agent workflow: Atlas commands × Engineering skills

How `/next`, `/tidy`, `/investigate`, `/kickoff`, `/closeout`, `/ci`, `/pr` (Atlas project rituals) compose with the Matt Pocock engineering skills (`/diagnose`, `/tdd`, `/to-prd`, `/to-issues`, `/triage`, `/grill-with-docs`, `/grill-me`, `/improve-codebase-architecture`, `/zoom-out`, `/prototype`, `/handoff`).

The Atlas commands own **project rituals** — ROADMAP, milestones, CI/PR gates, deploy. The engineering skills own **craft loops** inside each phase. They don't duplicate — they layer.

---

## The five phases

### Phase 1 — Notice

> "I think there might be something here."

| Situation | Use |
| --- | --- |
| Spotted a bug, rough edge, or tech debt | `/investigate` (Atlas) — light: research → file issue → park-or-fix |
| Have a half-formed idea worth designing | `/to-prd` — synthesise the current conversation into a PRD issue |
| Have a plan but want it stress-tested first | `/grill-me` — interview until every branch of the decision tree is resolved |
| Plan touches domain terminology or contradicts a past decision | `/grill-with-docs` — grill + update `CONTEXT.md` and `docs/adr/` inline |

**Decision rule:** if the finding fits in one issue (< half a day of work), use `/investigate`. If it would span a milestone or change architecture, use `/to-prd` (optionally after `/grill-with-docs`).

### Phase 2 — Plan

> "What does this turn into?"

| Situation | Use |
| --- | --- |
| New milestone, items already in `.claude/research/ROADMAP.md` | `/kickoff` (Atlas) — creates child issues from ROADMAP line items |
| New milestone driven by a PRD issue (the 1.4.x / 1.5.x pattern) | `/to-issues` against the PRD issue — produces tracer-bullet vertical slices |
| Adding new line items to ROADMAP without creating issues yet | `/roadmap-extend` (Atlas) |

**Decision rule:** PRD-driven milestones (`#2336`, `#2362`, `#2291`) use `/to-prd` → `/to-issues`. ROADMAP-driven milestones use `/kickoff`. Both paths produce GitHub issues that follow the Atlas issue body format (see `issue-tracker.md`).

### Phase 3 — Build

> "I picked an issue. Now what?"

The agent's first move depends on the issue's shape. Default sequence:

```
unfamiliar territory?  →  /zoom-out            (Matt Pocock — broader context)
                          /research            (Atlas — module map)

is it a bug?           →  /diagnose            (Matt Pocock — reproduce → minimise → hypothesise → instrument → fix → regression-test)
                          THEN /tdd to lock the fix with a regression test

is it a feature?       →  domain-heavy?        /grill-with-docs first (sharpen CONTEXT.md + ADRs)
                          design uncertain?    /prototype (throwaway terminal app or 3 UI variants)
                          design clear?        go straight to /tdd

always for new code    →  /tdd                 (Matt Pocock — red-green-refactor, one slice at a time)
```

**Decision rule:** never write `/tdd` tests against a bug you haven't `/diagnose`d. The regression test you write before isolating the root cause will lock in the wrong behaviour.

### Phase 4 — Reconcile

> "A burst of work landed. Are tracking and the codebase in sync?"

| Situation | Use |
| --- | --- |
| Burst of PRs merged — reconcile ROADMAP, close issues, prune branches | `/tidy` (Atlas) |
| `/tidy` finds module duplication or coupling → file a refactor issue | `/improve-codebase-architecture` (Matt Pocock — `architecture` label, log in `architecture-wins.md`) |
| External / community issues piled up in the inbox | `/triage` (Matt Pocock — state machine: `needs-triage` → `needs-info` → `ready-for-agent` / `ready-for-human` / `wontfix`) |

`/tidy` and `/triage` are complementary:
- `/tidy` reconciles **already-tracked** work against what shipped.
- `/triage` processes **inbound** issues into a ready-to-pick-up state.

When Atlas opens to a community, `/triage` runs first (move new issues through the state machine), then `/tidy` (reconcile shipped work against ROADMAP).

### Phase 5 — Ship

> "Take it to main."

| Situation | Use |
| --- | --- |
| Pre-PR gate — lint, type, test, syncpack, template drift, railway-watch | `/ci` (Atlas) — all five must pass |
| Open a PR | `/pr` (Atlas) — branch, commit, push, create PR |
| Milestone is fully shipped | `/closeout` (Atlas) — docs audit, changelog, close GH milestone |
| Handing the in-flight session to another agent / clone / day | `/handoff` (Matt Pocock — compacts the session into a handoff doc) |
| Need a recurring run of any of the above | `/loop` or `/schedule` (Claude Code) |

`/handoff` is the missing piece in Atlas's existing flow. Before splitting work across parallel sessions or stepping away mid-task, `/handoff` produces a doc the next session can pick up cold.

---

## Skills not currently mapped in

These are useful but don't slot into the daily Atlas rituals yet:

- **`/prototype`** — for design-uncertain spikes inside Phase 3. Worth pulling out when a feature's interaction model isn't clear (e.g. the chat-as-dashboard-editor #2362 drawer; the dashboardScreenshot vision tool #2366 spike).
- **`/zoom-out`** — for when you (or another agent) hit an unfamiliar package. Most useful at the start of a `/next` prompt where the issue touches code outside the agent's recent context.
- **`/caveman`** — token-compression mode. Not workflow; turn on when conversation context is getting tight.
- **`/grill-me` vs `/grill-with-docs`** — `/grill-me` is plain interview; `/grill-with-docs` updates `CONTEXT.md` + `docs/adr/` inline. Prefer the latter for anything that names a domain concept.

## Skills explicitly NOT in scope here

- `/setup-pre-commit`, `/git-guardrails-claude-code` — one-time repo setup; not a daily flow.
- `/migrate-to-shoehorn`, `/scaffold-exercises` — Matt Pocock's course material; unused in Atlas.
- `/write-a-skill` — for authoring new skills, not for daily code work.

---

## Issue body format

Every issue created by any of these flows (whether through `/investigate`, `/kickoff`, `/to-prd`, `/to-issues`) **must follow the Atlas issue body format** documented in `docs/agents/issue-tracker.md`. `/tidy` and `/closeout` depend on this format to do their work.

## Labels

Every Atlas issue carries **two label dimensions**:

1. **State** (from `/triage`): one of `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.
2. **Kind + location** (from existing Atlas conventions): exactly one of `bug` / `feature` / `refactor` / `chore` / `docs` + one or more `area: *` + optional `architecture` / `security` / `design`.

Both axes apply; they don't replace each other.
