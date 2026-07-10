# Draft cards carry their own cached data; the draft is the only edit mechanism

Status: accepted (2026-07-10, second dashboard elevation grill — amends
[ADR-0029](./0029-dashboards-draft-first-editing.md))

The first elevation cycle (ADR-0029) made every dashboard edit land in a
private per-user **draft**, but left two gaps the second audit
(`.claude/research/dashboards-audit-2026-07-10.md`) surfaced: a draft-only
(never-published) card had **no data home** — render/refresh 404'd on the
published-table lookup, so an agent-built board was a grid of "Never run"
tiles that only publishing could populate — and destructive bound-editor ops
lived in a **second store** (`dashboard_stage_changes` accept/discard ghosts,
#2365) that publish silently ignored. We decided both gaps close the same
way: **the draft is the one home for private work — its data and its edits.**

## Decision 1 — the draft cache

A draft card carries its **own cached data** (the *draft cache*, see
`CONTEXT.md` § Dashboard editing). Executing a card while holding a draft —
refresh, parameter change, retry, first load — reads and writes the draft
cache, never the published card's cached data and never the shared Query
Cache. The draft execution path is reachable for draft-only cards (the
published-card 404 gate yields to the draft resolution when the caller views
their draft). Seeding: `createDashboard` / bound `addCard` execute each staged
card **inside the tool call** (concurrent, wall-clock-budgeted, fail-soft per
card) and report per-card outcomes to the agent, so it can self-correct
instead of announcing a board with empty or broken cards; anything left
unseeded falls back to a canvas-mount draft render.

Rejected: **ephemeral-only draft execution** (every canvas mount re-runs every
draft card's SQL — a 12-card board costs 12 queries per reload and tile
age/staleness is meaningless); **cache-only without a reachable exec path**
(fixes the empty canvas but refresh/params/retry stay dead until publish);
**agent-step execution** (1+ step per card against the 25-step default budget
risks exhaustion mid-build, and a prompt instruction enforces nothing).

## Decision 2 — retire the stage tracker

Destructive bound-editor ops (`removeCard`, `updateCardSql`) apply **directly
to the caller's draft** like every other edit, with a lightweight inline undo,
and `dashboard_stage_changes` retires (two-phase drop per migration
discipline). This deliberately reverses #2365, which added the accept/discard
gate **before** drafts were universally publish-gated. Now that every edit is
private, reversible, and diffed at publish, the per-op accept gate duplicated
the draft's own review mechanism at the cost of a second mental model — and a
real trap: publish merges the draft only, so a staged-but-unaccepted change
was silently stranded.

Rejected: **keeping both stores with a legible seam** (publish warns on
pending stages) — it preserves a permanent two-model tax to defend a safety
property the draft already provides; **staging everything** (every agent op
becomes a proposal) — it fights the live-materializing canvas the bound editor
is built on.

## Consequences

- The draft snapshot card gains data fields; per-user drafts grow by their
  cached rows (the abandoned-draft sweep already bounds retention).
- Draft results never touch the published cached data or the Query Cache —
  the privacy invariant ADR-0029 stated is now held by construction, since
  draft executions have their own home.
- Tile trust semantics (age, stale, errored, empty, never-run) apply
  uniformly to draft and published data.
- `dashboard_stage_changes` drops via the two-phase discipline; the bound
  editor's accept/discard UI and ghost overlays retire with it.
