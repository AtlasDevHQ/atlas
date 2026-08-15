# Agent workflow: Atlas commands × Engineering skills

How `/next`, `/tidy`, `/investigate`, `/elevate`, `/kickoff`, `/closeout`, `/ci`, `/pr` (Atlas project rituals) compose with the Matt Pocock engineering skills (`/diagnosing-bugs`, `/tdd`, `/to-spec`, `/to-tickets`, `/triage`, `/grill-with-docs`, `/grill-me`, `/improve-codebase-architecture`, `/wayfinder`, `/prototype`, `/handoff`).

The Atlas commands own **project rituals** — ROADMAP, milestones, CI/PR gates, deploy. The engineering skills own **craft loops** inside each phase. They don't duplicate — they layer.

> **Where the engineering skills live.** They are installed at the **user level** (`~/.claude/skills/`), not vendored into this repo. Only Atlas-owned skills — `impeccable`, `operator-commands`, `publish-package` — sit in `.claude/skills/`. A checkout on a fresh machine gets the Atlas commands and rules but not the Matt Pocock skills; install those separately. The repo previously carried a vendored fork under `.agents/skills/`, which drifted a full rename cycle behind upstream before it was removed.

---

## The five phases

### Phase 1 — Notice

> "I think there might be something here."

| Situation | Use |
| --- | --- |
| Spotted a bug, rough edge, or tech debt | `/investigate` (Atlas) — light: research → file issue → park-or-fix |
| A shipped surface works but is beneath its potential | `/elevate` (Atlas) — parallel multi-dimension audit → ranked findings doc in `.claude/research/` → hand off to `/grill-with-docs` |
| Have a half-formed idea worth designing | `/to-spec` — synthesise the current conversation into a PRD issue |
| Have a plan but want it stress-tested first | `/grill-me` — interview until every branch of the decision tree is resolved |
| Plan touches domain terminology or contradicts a past decision | `/grill-with-docs` — grill + update `CONTEXT.md` and `docs/adr/` inline |

**Decision rule:** three tiers by size of the itch. One-issue-sized (< half a day of work) → `/investigate`. Surface-sized — a whole feature beneath its potential, problems likely at the seams → `/elevate`, whose findings doc feeds `/grill-with-docs` → `/to-spec` → `/to-tickets` (the chat answer-styles cycle #4292 and the 2026-07-04 dashboard elevation are the worked examples). Already know what to build → `/to-spec` directly (optionally after `/grill-with-docs`). Purely presentational, page-scoped itch → `/revamp` skips the cycle entirely.

### Phase 2 — Plan

> "What does this turn into?"

| Situation | Use |
| --- | --- |
| New milestone, items already in `.claude/research/ROADMAP.md` | `/kickoff` (Atlas) — creates child issues from ROADMAP line items |
| New milestone driven by a PRD issue (the 1.4.x / 1.5.x pattern) | `/to-tickets` against the PRD issue — produces tracer-bullet vertical slices |
| Adding new line items to ROADMAP without creating issues yet | `/roadmap-extend` (Atlas) |

**Decision rule:** PRD-driven milestones (`#2336`, `#2362`, `#2291`) use `/to-spec` → `/to-tickets`. ROADMAP-driven milestones use `/kickoff`. Both paths produce GitHub issues that follow the Atlas issue body format (see `issue-tracker.md`).

### Phase 3 — Build

> "I picked an issue. Now what?"

The agent's first move depends on the issue's shape. Default sequence:

```
unfamiliar territory?  →  /wayfinder            (Matt Pocock — broader context)
                          /research            (Atlas — module map)

is it a bug?           →  /diagnosing-bugs            (Matt Pocock — reproduce → minimise → hypothesise → instrument → fix → regression-test)
                          THEN /tdd to lock the fix with a regression test

is it a feature?       →  domain-heavy?        /grill-with-docs first (sharpen CONTEXT.md + ADRs)
                          design uncertain?    /prototype (throwaway terminal app or 3 UI variants)
                          design clear?        go straight to /tdd

always for new code    →  /tdd                 (Matt Pocock — red-green-refactor, one slice at a time)
```

**Decision rule:** never write `/tdd` tests against a bug you haven't `/diagnosing-bugs`d. The regression test you write before isolating the root cause will lock in the wrong behaviour.

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
| Pre-PR gate | Remote CI on a **draft** PR — push first, review while it runs. Local pre-flight is only `--affected` + `lint` + `type` |
| Full local battery — 36 gates, ~25 min | `/ci` (Atlas) — only when remote CI is broken, a mutation anchor moved, or before `/release`. See `/ship-issue` Step 4 |
| Open a PR | `/pr` (Atlas) — branch, commit, push, create PR (add `--draft` when the panel hasn't run yet) |
| Milestone is fully shipped | `/closeout` (Atlas) — docs audit, changelog, close GH milestone |
| Handing the in-flight session to another agent / clone / day | `/handoff` (Matt Pocock — compacts the session into a handoff doc) |
| Need a recurring run of any of the above | `/loop` or `/schedule` (Claude Code) |
| Want the phases to drive themselves (agents prompting agents) | See `docs/agents/loops.md` — L0–L3 loop designs over the `Agent` + `subscribe_pr_activity` primitives |

`/handoff` is the missing piece in Atlas's existing flow. Before splitting work across parallel sessions or stepping away mid-task, `/handoff` produces a doc the next session can pick up cold.

---

## Skills not currently mapped in

These are useful but don't slot into the daily Atlas rituals yet:

- **`/prototype`** — for design-uncertain spikes inside Phase 3. Worth pulling out when a feature's interaction model isn't clear (e.g. the chat-as-dashboard-editor #2362 drawer; the dashboardScreenshot vision tool #2366 spike).
- **`/wayfinder`** — for planning work too big for one session, as a map of investigation tickets resolved one at a time. Also the reach-for when you (or another agent) hit an unfamiliar package at the start of a `/next` prompt.
- **`/grill-me` vs `/grill-with-docs`** — `/grill-me` is plain interview; `/grill-with-docs` updates `CONTEXT.md` + `docs/adr/` inline. Prefer the latter for anything that names a domain concept. (`/grilling` is the same interview under its current upstream name; either resolves.)

## Renamed upstream

The engineering skills were renamed upstream while this repo still referenced the old names, which left several `/`-invocations pointing at nothing. Current names:

| Was | Now |
| --- | --- |
| `/to-prd` | `/to-spec` |
| `/to-issues` | `/to-tickets` |
| `/diagnose` | `/diagnosing-bugs` |
| `/zoom-out` | `/wayfinder` |
| `/design-an-interface` | `/codebase-design` |
| `/ubiquitous-language` | `/domain-modeling` |
| `/write-a-skill` | `/writing-great-skills` |
| `/request-refactor-plan` | `/implement` |

`/caveman`, `/migrate-to-shoehorn`, `/scaffold-exercises`, `/setup-pre-commit`, `/git-guardrails-claude-code`, `/qa`, `/edit-article`, `/obsidian-vault` and the `/writing-*` set are gone — none were ever invoked from an Atlas flow.

---

## Issue body format

Every issue created by any of these flows (whether through `/investigate`, `/kickoff`, `/to-spec`, `/to-tickets`) **must follow the Atlas issue body format** documented in `docs/agents/issue-tracker.md`. `/tidy` and `/closeout` depend on this format to do their work.

## Labels

Every Atlas issue carries **two label dimensions**:

1. **State** (from `/triage`): one of `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.
2. **Kind + location** (from existing Atlas conventions): exactly one of `bug` / `feature` / `refactor` / `chore` / `docs` + one or more `area: *` + optional `architecture` / `security` / `design`.

Both axes apply; they don't replace each other.
