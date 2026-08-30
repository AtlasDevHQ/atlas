# Dashboard editing

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Dashboard editing` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


How a dashboard is edited and made visible to a team. **Target-state vocabulary** — pinned during the dashboard elevation grill (2026-07-04, audit `.claude/research/dashboard-audit-2026-07-04.md`); the draft-first model below is the design contract, not yet shipped behavior (today direct manipulation commits live and only the agent path drafts).

- **Dashboard**:
  A persistent, shareable grid of **cards** with an optional top-level **parameter bar**. The unit that is created, shared, and published.
  _Avoid_: "board" (informal only), "report" (a distinct point-in-time deliverable with no current home — see docs/contexts/notebooks/CONTEXT.md).

- **Card**:
  The unit on the grid. A **chart card** carries a SQL query + visualization; a **text card** carries markdown (section headers, explainers) and no data.
  _Avoid_: "tile" for the persisted unit — a *tile* is the rendered presentation of a card on the **canvas**; "widget".

- **Canvas**:
  The dashboard grid surface a user looks at. Renders the caller's **draft** when they have one, the **published** state otherwise — so a user always sees the version they are editing, never a stale published copy while they work.
  _Avoid_: "grid" for the concept (the grid is the layout mechanism); "the dashboard view".

- **Draft**:
  The caller's private, per-user working copy of a dashboard. **Every** edit — direct manipulation (drag, rename, delete) and agent/chat edits alike — lands in the draft; it is invisible to teammates until **published**. One draft per (user, dashboard).
  _Avoid_: conflating with the content-mode `draft` status enum (a dashboard row is not content-mode gated); "staged change" (the retired **stage tracker**'s pending-destructive-op concept — decided 2026-07-10: destructive bound-editor ops land directly in the draft like every other edit, with inline undo; there is no second pending-changes store, and publish can no longer strand an unaccepted change).

- **Draft cache**:
  A draft card's own cached data, private to the **draft** it lives in — pinned during the second dashboard elevation grill (2026-07-10). Executing a card while holding a draft (refresh, parameter change, retry, first load of a never-published card) reads and writes the draft cache, never the **published** card's cached data and never the **Query Cache**. Every tile affordance — refresh, staleness, age, retry — works identically whether the card's data comes from the draft cache or the published cached data; a draft-only card is fully operable before **first publish**.
  _Avoid_: "the cache" unqualified on the dashboard surface (three distinct stores: draft cache, published cached data, Query Cache); treating a draft-only card as un-runnable until publish (the 404-until-published behavior is the defect this term retires).

- **Published**:
  The shared, org-visible state of a dashboard — the card set + metadata that teammates and shared links see. The merge target of **publish**.
  _Avoid_: treating "published" as a full content-mode status enum (there is no draft/published/**archived** tier on the dashboard row); conflating the one-time **first publish** visibility transition with the ongoing edit-gating.

- **First publish**:
  The one-time transition that makes a never-published dashboard visible to the rest of the org. Before it, a dashboard is **private to its creator** (a single "has ever been published" gate, not a content-mode status); after it, the dashboard stays org-visible permanently and subsequent **publish**es gate only the *edits*.
  _Avoid_: modeling this as a reversible status (it is a one-way gate — there is no "unpublish"/archive in this design).

- **Publish**:
  The single gated transition that three-way-merges the caller's **draft** into the **published** dashboard (409 on a stale baseline or a same-card conflict). The only path from private edit to teammate-visible.
  _Avoid_: "save" (editing continuously auto-persists to the draft; publish is the *promotion*, not the save).

- **Bound editor**:
  The dashboard-scoped chat drawer through which the agent builds and edits a dashboard. Its edits land in the caller's **draft**; the **canvas** — cards materializing and updating live — is the turn's **answer-bearing artifact**, so the drawer shows conversation + a collapsed **receipt** (per *Chat turn presentation*), not inline card previews. It is also the dashboards surface's own **creation instrument** (pinned 2026-07-10): creating a dashboard from the surface opens the bound editor on the empty canvas — the surface is a first-class creation origin, not a viewer that bounces new users back to main chat.
  _Avoid_: "bound chat" for the surface (say bound editor); rendering the build as full-weight inline tool cards (that is the divergent pre-convergence renderer being retired).

- **View / Edit (canvas modes)**:
  The two interaction modes of the **canvas**, pinned 2026-07-10: **View** is strictly read-only for the dashboard's *definition* — it offers only non-mutating affordances (refresh, fullscreen, CSV export, parameter/filter changes) and can never fork or touch a **draft**; **Edit** is where every definition mutation (remove, rename, duplicate, drag, SQL/config change) lives, all landing in the caller's draft. A browsing gesture must never create a draft.
  _Avoid_: exposing mutating tile controls in View (the pre-2026-07-10 defect); "read-only" to mean no-refresh (refreshing data is a View affordance — read-only gates the *definition*, not the data's freshness).

- **Tile**:
  The rendered presentation of a single **card** on the **canvas**, and the **unit of trust**: a tile carries its own status — loading, fresh, **stale**, errored, empty, not-filtered — surfaced *on the tile*, rather than deferring failures to a page-level banner.
  _Avoid_: using "tile" for the persisted unit (that is a **card**); collapsing *errored* (the query failed), *empty* (the query returned zero rows), and *never-run* (no cached data yet) into one "No cached data" state — they are three distinct tile states.

- **Stale (tile)**:
  A tile whose displayed data predates the current **card** definition (its SQL/config) or the active parameter/filter values — a first-class, *visible-but-quiet* state (a color-shifting age caption — muted → amber → red — plus a subtle body dim and a one-click retry, never a banner). A tile that fails to update stays labeled with its data's age and offers retry; it never silently substitutes old data for a failed new render.
  _Avoid_: "cached" as a synonym (all tile data is cached — staleness is *cache older than the current definition/params*, not the mere fact of caching).

- **Shared view**:
  The read-only, **data-only snapshot presentation** of a **published** dashboard reached through a share token. Exposes title/description + per-card title/kind/chart-config/annotations/cached data/layout — and *nothing else*. Never the raw SQL, connection/owner/org identifiers, refresh cron, or parameter definitions. Uniform across **public** (no-auth) and **org** (authenticated-teammate) share modes.
  Reached as a standalone page or as an **embed** (an iframe-framable presentation of the same shared view — decided 2026-07-10, mirroring the conversation embed): same token, same snapshot, same revocation/expiry; the embed is a frame around the shared view, never a second sharing surface.
  _Avoid_: treating the shared view as a live or inspectable dashboard (query inspection happens in-app, where auth gates it); "public dashboard" (the *dashboard* isn't public — a *token* grants snapshot access); modeling the embed as a new access mode (the token is the access control, framed or not).

### Anti-confusions

- The **draft** is a per-user *working copy*, not a content-mode visibility tier. Two editors have two independent drafts of the same published dashboard; publish merges, never overwrites (except last-writer-wins on title/description).
- **Publish** is not **refresh**. Publish promotes *definitions* (SQL, layout, config); refresh re-executes a card's SQL to update its *cached data*. A publish that changes SQL must trigger a refresh or the **shared view** shows new definitions over stale data.
- The **shared view** is data-only by construction, not by redaction-after-the-fact — the public projection is built from a minimal DTO, so a field can't leak by being forgotten. Raw SQL never reaches the wire on this surface.
- The **shared view** has a single **as-of** instant (decided 2026-07-10): every piece of temporal framing a share viewer sees — parameter chips, "data as of" captions — derives from the shown data's capture instant, never from view time or dashboard creation time. When a refresh updates the rows, all framing moves with them; the page can never contradict itself about what window the numbers cover.
