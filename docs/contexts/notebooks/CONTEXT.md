# Notebooks (retired)

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-17 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Notebooks (retired)` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).

> ## 🪦 History only — this surface does not exist
>
> The notebook was removed end-to-end on 2026-07-10 ([ADR-0035](../../adr/0035-retire-the-notebook-surface.md),
> #4587). This context is kept, per #5302, so the words do not dangle: *notebook* and
> *report* still turn up in old issues, changelog entries and conversation, and a reader who
> meets them needs to know they name nothing shippable. **Nothing here describes current
> behaviour, and nothing new is built on it.** Its job — the agent-built, curated, shareable
> artifact — belongs to **dashboards** ([ADR-0029](../../adr/0029-dashboards-draft-first-editing.md)).


The notebook surface was retired on 2026-07-10 ([ADR-0035](../../adr/0035-retire-the-notebook-surface.md)), killed in the pre-customer window after its elevation audit. These terms are pinned so the words don't dangle.

- **Notebook**:
  Retired surface — a cell-based analysis document painted over a chat transcript. Nothing new is built on it: exploration lives in chat; persistent, shareable, agent-built artifacts are **dashboards**.
  _Avoid_: proposing notebook features; branching/forking a conversation died with the surface, deliberately — it has no successor.

- **Report**:
  The point-in-time narrated analysis deliverable — linear prose interleaved with evidence, all written about one as-of instant (the *memo*, where a dashboard is the *monitor*). Has **no home in Atlas today**: deferred to a future dashboard extension whose price of admission is a frozen (never-refreshed, as-of-pinned) presentation, because prose cites numbers and refresh moves them out from under it.
  _Avoid_: "report" for a dashboard, a shared view, or a shared chat transcript (the retired "Share as Report" misnomer — it shipped a raw transcript).
