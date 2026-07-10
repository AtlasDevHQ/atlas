# Retire the notebook surface

Status: accepted (2026-07-10, notebook elevation grill — audit: `.claude/research/notebook-audit-2026-07-10.md`)

The notebook shipped as a cell-based curation layer painted over a chat transcript. Its elevation audit found that the curation was largely a display-only illusion — every CRITICAL (rerun truncation, fork-metadata erasure, share-ships-the-raw-transcript, deletes-that-don't-delete) was a variant of one root: the notebook projection and the persisted/shared truth had silently diverged. Fixing that class required committing to a real document/projection model. Meanwhile the two dashboard elevation cycles ([ADR-0029](./0029-dashboards-draft-first-editing.md), [ADR-0034](./0034-dashboard-draft-cache-single-edit-mechanism.md)) gave dashboards the notebook's headline job — agent-built, curated, shareable artifacts — on a sounder model (per-user draft, publish gate, data-only snapshot shared view, bound editor as a creation instrument).

**We decided to kill the surface** rather than fix it, in the pre-customer clean-break window (CONTEXT.md § Deployment posture) — the cheapest moment we will ever have to delete a shipped surface.

## Considered options

- **Commit narrowly** — keep the notebook as the report-authoring surface and make the projection persisted and universally honored (every reader — loader, share, export — renders through it). Coherent, but it funds a third transcript surface whose remaining unique jobs didn't justify it (below).
- **Fold into chat** — a light "curate & share" pass on chat instead of a surface. Rejected: it smuggles the same projection-vs-truth problem into chat and still kills forking.
- **Kill** — chosen.

## What the kill explicitly costs (accepted in the grill)

1. **Branching exploration dies with no successor.** Fork/"what if" was the one job neither chat nor dashboards cover — and the audit showed it was already a data-loss trap (fork metadata erased by ordinary edits; dangling branch pointers; multi-level trees fragmenting). We are deleting a broken promise, not a working feature. If ever missed, it would be rebuilt on chat, not by resurrecting notebooks.
2. **The memo deliverable has no home for now.** The point-in-time narrated analysis (linear prose interleaved with evidence — the *memo*, vs the dashboard's *monitor*) is deferred to a future dashboard extension. Its price of admission is a **frozen** presentation (as-of-pinned, refresh disabled): a dashboard's defining behavior is that data moves, a memo's is that it doesn't, and no tile-staleness badge rescues prose that cites a number a refresh just changed — prose isn't a tile. The dashboard shared view's data-only snapshot + single as-of instant already point in this direction.

## Consequences

- The removal deletes the notebook routes/components, the fork/branch endpoints and `branches` JSONB pointers, the chat→notebook conversion, the "Share as Report" path, and (two-phase, per migration discipline) the `notebook_state` column and `"notebook"` `Surface` value. The `partitionTurn` → `AssistantTurn`/`AgentTurn` render convergence (#4301) is chat's renderer and survives; the add-to-dashboard bridge survives wherever chat uses it.
- The audit's findings stand as evidence for this decision, not as a fix backlog; the one filed issue (#4535, notebook↔dashboard association stripped on save) is closed as superseded.
- The glossary's reserved "report — a separate shared-conversation concept" is retired and re-pinned as the deferred memo deliverable (CONTEXT.md § Notebooks, retired).
