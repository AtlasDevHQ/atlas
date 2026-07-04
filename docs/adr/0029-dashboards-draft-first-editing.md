# Dashboards use a draft-first, publish-gated editing model

Every edit to a dashboard — direct manipulation (drag, rename, delete) *and*
agent/chat edits alike — lands in the caller's private per-user **draft**; the
**canvas** renders that draft while editing; **publish** is the single gated
transition (three-way merge, 409 on conflict) that makes changes visible to the
org. A never-published dashboard is private to its creator until its **first
publish**. Decided in the 2026-07-04 dashboard elevation grill; the canonical
vocabulary is in `CONTEXT.md` § *Dashboard editing* and the audit that motivated
it is `.claude/research/dashboard-audit-2026-07-04.md`.

## Context

The pre-existing surface was incoherently two models at once: direct
manipulation committed **live to the whole org instantly** (bare REST
PATCH/POST/DELETE), while agent/chat edits went to a per-user draft — and the
canvas always rendered the *published* copy regardless. The visible symptom was
that asking the agent to build a dashboard produced an **empty canvas** (cards
staged into the draft, canvas showing published), and nothing told a user
whether a given action was private or already live to teammates. The docs
described a unified draft model that was never implemented for direct
manipulation.

## Considered options

- **Live collaborative document** (Google-Sheets style): edits are immediately
  shared; "propose changes" is an explicit opt-in. Rejected — it discards the
  private-workspace promise and leaves the agent-build flow high-stakes (an
  agent's half-built cards would be org-visible instantly).
- **Full content-mode status** (draft/published/archived enum on the dashboard
  row). Rejected as heavier than needed; the one-way "private until first
  publish" gate covers the orphan-dashboard problem without the machinery.
- **Draft-first, publish-gated** (chosen): the only model where letting an agent
  build into your draft, reviewing the diff, and publishing is *safe*, and where
  the canvas can honestly be the turn's answer-bearing artifact.

## Consequences

- The draft needs its **own execution path** — rendering/refresh/parameters must
  run the draft's card SQL, not the published SQL (previously a text-only
  overlay).
- Direct-manipulation routes must write to the draft, not the published tables.
- The publish-diff preview must be computed from the **same** card-equality the
  server merge uses, or it shows the wrong change set.
- Publish must trigger a refresh of changed cards, or the shared view renders new
  definitions over stale cached data.
