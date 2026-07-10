# Dashboard surface — second elevation audit (2026-07-10)

Prep for a **`/grill-with-docs`** session on elevating the dashboard surface a
second time — the sequel to the 2026-07-04 audit
(`.claude/research/dashboard-audit-2026-07-04.md`) that produced
[ADR-0029](../../docs/adr/0029-dashboards-draft-first-editing.md), PRD
[#4313](https://github.com/AtlasDevHQ/atlas/issues/4313), and the
`CONTEXT.md` § *Dashboard editing* vocabulary. All 11 slices of that PRD shipped
2026-07-04 in `v0.0.43`. This pass asks: **what is still beneath potential after
that cycle?**

**Dimensions run (4):** end-user viewer/editor UX · the agent-build path ·
backend/data-model & draft→publish lifecycle · the outward face (sharing /
screenshots / embedding). **No live product** was available in this environment
(no Docker daemon, no `.env`) — this is a **code-reading audit** with `file:line`
anchors throughout; no Playwright screenshots. The one CRITICAL and the two lead
HIGHs were **hand-verified** at the cited lines (marked `verified`).

---

## Verdict: the engine is now genuinely finished — the cockpit's primary ignition is still miswired

The 2026-07-04 pass did what it set out to do. The seams it hardened are now
**load-bearing and must be preserved wholesale** — re-verified present in today's
code:

- **One execution pipeline, reach parity intact.** Preview, render, single/bulk
  refresh, KPI comparison, and CSV export all funnel through
  `runUserQueryPipeline` — same guard as the agent's `executeSQL`
  (`routes/dashboards.ts:2140,2244,2427,2549`). No card path bypasses
  validation/RLS/audit/masking.
- **Publish correctness is solid.** Full-precision stale-baseline guard
  (`dashboards.ts:732-750`, `dashboard-versioning.ts:1030-1083`), diff computed
  from the **same** `dashboardCardsEqual` the server merge uses
  (`dashboard-versioning.ts:68,527` ← `@useatlas/schemas`), merge-before-`BEGIN`
  + `FOR UPDATE` re-check + 409-on-conflict, one-way `first_published_at`
  marker, async refresh-on-publish scoped to the exactly-changed cards
  (`dashboard-versioning.ts:484-518`).
- **Draft-aware execution exists and is correct where reachable** —
  `resolveDraftExecCard` is a tagged union that never runs a removed card as
  published and never writes draft results into the shared cache
  (`dashboards.ts:1149-1188,2259-2274`).
- **Per-tile status is the unit of trust.** `resolveTileStatus` +
  four distinct placeholders (`loading`/`errored`/`empty`/`never-run`,
  `dashboard-tile.tsx:74-136`, `tile-status.ts:67-88`) — a blank tile always
  says *why*. Anti-silent-revert render fold keeps a failed tile labelled-stale
  (`tile-phases.ts:55-106`).
- **Shared payload is a field-by-field DTO** — `projectSharedCard` /
  `projectSharedDashboardView` structurally never copy `sql`, connection IDs, or
  owner/org identifiers; `orgId` rides a separate `access` object the route
  can't serialize; wire schema is `.strict()` and the client re-validates
  (`dashboards.ts:996-1074`, `schemas/src/dashboard.ts:504-538`,
  `shared/dashboard/[token]/fetch.ts:87-93`). The 2026-07-04 SQL-leak,
  broken-org-share, silent-public-downgrade, and token-hygiene findings are
  **verified fixed**.
- **Screenshot/export resource discipline** — FIFO semaphore caps concurrent
  headless renders, dead-browser liveness + single-flight relaunch, wall-clock
  export budget, no client-controlled Host (`dashboard-screenshot.ts:306-475`).
- **Bound drawer converged on the shared `AgentTurn` renderer** with real
  conversation continuity and an explicit failed-resume fallback banner
  (`bound-chat-drawer.tsx:249-289,748-749`).
- **Cleanup is fail-soft, retention-gated, blast-radius-safe** — abandoned-draft
  sweep keys on `updated_at` so an actively-edited draft is never swept
  (`dashboard-versioning.ts:924-951`).

**Where the problems live now:** almost entirely at **one seam — the
agent-build → canvas handoff**, plus a scatter of independent bugs. The prior
cycle fixed draft execution *for edits to already-published cards* (where
`getCard` succeeds) but the **primary "build a dashboard by chatting" flow still
can't display the board it just built** (C1 below). Everything else is smaller:
share-dialog and write-path bugs, a shared-snapshot honesty gap, and a set of
genuine elevation gaps (no embed story, bound-editor can't add section headers,
cards never executed at build time).

---

## Ranked findings

### CRITICAL

#### C1 — Agent-built cards are un-loadable on the canvas: every tile is "Never run" and refresh/render 404 · **verified**
`tools/create-dashboard.ts:434-446` · `bound-dashboard.ts:284-306` ·
`dashboard-versioning.ts:1367-1369` · `routes/dashboards.ts:2176-2179,2321-2324`
· `dashboards.ts:752-763` · `dashboard-tile.tsx:126-134`

The direct successor to the prior cycle's C1. The canvas is no longer *blank*
(the draft view renders), but every card the agent builds shows **"Never run —
refresh to load results,"** and **no user action can populate it short of
publishing.** The verified chain:

1. `createDashboard` / bound `addCard` stage net-new cards into the draft
   snapshot **only** — the log line even says "cards staged in user draft"
   (`create-dashboard.ts:448-452`); `dashboard_cards` stays empty.
2. The draft snapshot card type has no cached-data fields, so
   `materializeDraftView` sources `cached_rows`/`cached_at` from the *published*
   card, which is `undefined` for a never-published card → `cached_rows: null`
   (`dashboard-versioning.ts:1367-1369`).
3. The draft-execution path ADR-0029 promised is **unreachable for net-new
   cards**: both `/cards/:cardId/render` and `/cards/:cardId/refresh` call
   `getCard(cardId, id)` **first** and hard-404 if the row isn't in
   `dashboard_cards` (`routes/dashboards.ts:2176-2179,2321-2324`); `getCard`
   reads only the published table (`dashboards.ts:758-762`). So the 404 gate
   fires **before** `resolveDraftExecCard` is ever consulted (lines 2185, 2329).
   Refresh, a parameter change, retry, and KPI-comparison load all return
   `404 "Card not found."`

**What breaks, for whom:** a trial admin builds a dashboard by chatting — the
headline flow — lands on the canvas (`?openChat=true`) and sees a full grid of
"Never run" tiles whose refresh buttons 404. The **only** way to see the data
the agent described is **Publish** — which makes the board org-visible, defeating
the "yours alone until you publish" promise the flow is built on. This is the
single most important thing a second elevation must fix, and it is **entangled
with the draft-model design** (does a draft card carry its own cached data? does
the agent execute each card at build time? is the draft render path reachable
for draft-only cards?) — so it is **doc-only, not filed**: filing it standalone
would pre-decide the design the grill exists to settle. **Fix directions to put
to the grill:** (a) move the `getCard` 404 gate *after* `resolveDraftExecCard`
and seed exec from the draft snapshot when `view=draft`; and/or (b) execute each
card once at build time and persist the result as the initial draft cache; and
(c) trigger a draft render for never-run tiles on canvas mount.

### HIGH

#### H1 — In View mode the canvas shows the empty published copy while the banner insists you have a draft · **verified**
`page.tsx:137-140` · `draft-status-banner.tsx:90,125-141` · `page.tsx:1283-1292`
· vs `CONTEXT.md:310`

The canvas only fetches `?view=draft` when `editing || chatOpen`
(`page.tsx:137`). A trial admin who builds by chat, closes the drawer, then
returns to `/dashboards/{id}` via the switcher or a bookmark (no `?openChat`)
hits `showDraftView === false` → the **published** fetch → **0 cards** for a
never-published agent board. They see the "An empty canvas / Run a query in
chat" prompt **while** the DraftStatusBanner directly above says "Draft —
unpublished changes only you can see" with a Publish button. Two elements on one
screen flatly contradict each other, and the primary agent-build output looks
erased until the user happens to click Edit. This is the same seam as C1 and
diverges from the documented Canvas contract (`CONTEXT.md:310`: canvas "renders
the caller's draft when they have one, the published state otherwise").
**Doc-only** (tied to C1). Fix direction: include `draftStatus?.hasDraft` in
`showDraftView`, or replace the generic empty-canvas copy with a
"Your draft has N tiles — switch to Edit / Publish to make them live" state.

#### H2 — Editing a live share's visibility silently resets its expiry to 7 days · **verified** · **FILED [#4536](https://github.com/AtlasDevHQ/atlas/issues/4536)**
`share-dialog.tsx:54,83-91,120,140,233-241,249`

`fetchShareStatus` syncs `shared`/`expiresAt`/`shareMode` but never
`setExpiresIn`, so the "Link expires" control stays at its `"7d"` default while
the summary line shows the real expiry — they disagree on screen. An admin who
opens the dialog only to flip org → public and clicks **Update settings**
re-sends `expiresIn: "7d"`, silently converting a "Never"/"30 days" link into one
that dies in 7 days. Broken today, fix invariant under the grill → filed.

#### H3 — The bound editor cannot add a section/text card — asymmetric with the tool that builds them
`tools/create-dashboard.ts:98-109,177` (supports `TextCardSchema`, instructs the
agent to structure 4+‑card boards with section headers) vs
`bound-dashboard.ts:237-247` (bound `addCard` **requires** `sql` +
`chartConfig`, no `kind:"text"`/`content`), and `bound-dashboard.ts:363-368`
(`updateCard` rejects a chartConfig change on a text card, yet nothing can create
one).

A business user iterating in the drawer ("add a Cohorts section header before
the last two cards") cannot get one — the structural affordance that makes an
agent board read like Mode/Looker exists only at first creation and can never be
extended incrementally. This is the concrete "what the creation path can do that
the bound agent cannot" gap. **Doc-only** — a capability gap that the grill will
likely fold into a broader bound-tool schema decision (see also M6). Fix
direction: widen bound `addCard` to the same chart-or-text union
`createDashboard` uses.

### MEDIUM

#### M1 — First-publish privacy gate is enforced on reads but not on write/share/delete · **verified** · **FILED [#4537](https://github.com/AtlasDevHQ/atlas/issues/4537)**
`dashboards.ts:220-233` (read gate) vs `:510-517` (delete), `:796-800` (share) —
all write/share paths scope by org only. A same-org non-owner who learns the
UUID of a colleague's never-published dashboard can blind-delete or blind-share
it, orphaning the creator's draft. Bounded (never cross-org) but contradicts the
ADR-0029 privacy promise. Fix invariant (thread `viewerId` +
`firstPublishVisibilityClause`) → filed.

#### M2 — Cards are validated but never executed at build time — 0-row/broken cards are indistinguishable from not-yet-loaded
`tools/create-dashboard.ts:260-269` · `bound-dashboard.ts:256-259`

`createDashboard` and bound `addCard` run `validateSQL` (parse → whitelist →
shape) but **never execute** the query. The description *asks* the agent to run
`executeSQL` first (`create-dashboard.ts:160-164`) but nothing enforces it.
Combined with C1, a card whose SQL validates but returns zero rows — or errors
only at runtime against a stale column the semantic layer no longer reflects — is
staged with no signal. The agent can report "Created a 6-card dashboard" where
several cards are empty or will fail on first execution. **Doc-only** — the
"execute-at-build" fix is one of the candidate resolutions to C1, so it belongs
in the grill, not a standalone filing.

#### M3 — "Refresh" (refresh-all) runs the published SQL even while editing a draft
`page.tsx:352-356` (no `?view=draft`) vs `:343-350` (per-tile refresh appends it
when `editing`) and `:1027-1028` (KPI comparisons honor draft too)

Per-tile refresh, CSV export, and KPI comparisons switch to draft SQL while
editing; the top-bar **Refresh** button does not. A user editing their private
draft who clicks Refresh re-executes and persists the *published* caches — which
may not appear (page shows `?view=draft`), so the button reads as doing nothing,
or worse mutates the org-visible published cache while the user believes they're
private. **Doc-only** — narrowly fix-invariant (thread the same suffix), but it
sits inside the same refresh/draft machinery C1 will reshape; hold for the grill.

#### M4 — Destructive tile controls (Remove / Rename / Duplicate) are live in View mode
`dashboard-tile.tsx:505-590` (action cluster gated only on `!titleEditing`, no
`editing` gate) vs `dashboard-topbar.tsx:184-219` (the View/Edit toggle)

The topbar teaches View = look, Edit = change, but every tile's ⋯ menu —
including **Remove** — is live in View. A business user browsing a shared team
board in View can delete a tile; it's also unclear whether a View-mode
rename/remove lands in the private draft or goes live. **Doc-only** — this is a
design question (should View be strictly read-only?) for the grill.

#### M5 — Shared "frozen" parameter summary drifts from the frozen data for relative dates · **verified** · **FILED [#4538](https://github.com/AtlasDevHQ/atlas/issues/4538)**
`dashboards.ts:952-956` — `formatParameterDisplayValue(param, now)` re-resolves a
relative-date default against a fresh `now` on every view request while
`cachedRows` stay frozen, so a share viewer sees a chip claiming a window the
numbers don't cover. Unauthenticated misleading analytics framing; fix invariant
(resolve against the capture instant) → filed.

#### M6 — Two parallel change mechanisms inside one bound editor
`bound-dashboard.ts:103-145` (safe ops → per-user **draft** via
`maybeApplyToDraft`) vs `:620-624,695-704` (destructive `removeCard` /
`updateCardSql` → a **separate** `dashboard_stage_changes` store via
`stageChange`)

Within one editing session, additions render live from the draft while
removals/SQL-edits render as ghost overlays from the stage tracker — two stores,
two mental models, on an already-private publish-gated draft. The user must
reconcile "committed to my draft" vs "staged, pending my accept" for edits that
are all equally private and reversible. Intra-editor residue of the prior H6
two-model split. **Doc-only** — a model-unification design question for the
grill (and see the open question below about whether publish folds pending
stages).

#### M7 — No embed/iframe story for shared dashboards
`web/next.config.ts:103,119` (global `frame-ancestors 'self'` + `X-Frame-Options:
DENY`) vs `:133` (dedicated framable `/shared/:token/embed` **for
conversations**)

Shared *conversations* get a purpose-built, any-origin-framable embed route; the
dashboard share page falls under the global `DENY`, so it **cannot be iframed**
on a customer's wiki/Notion/portal, and the share dialog produces no embed
snippet. The most-requested "outward face" affordance is absent for the pillar
that most needs it. **Doc-only** — an elevation gap (not a regression); grill
should decide whether the outward face is a link, an embed, or both. Fix
direction: mirror the conversation embed route + add an "Embed" tab.

### LOW

- **L1 — Share dialog copy hardcodes "public" even for org-only shares.**
  `share-dialog.tsx:200-204` — an admin who picks "Organization — requires
  login" is still told "Anyone with the link can view." Make copy
  `shareMode`-aware.
- **L2 — `createDashboard` handoff is hard-coupled to the web `/dashboards`
  route.** `create-dashboard-card.tsx:132-137`; the tool is in `defaultRegistry`
  + `buildRegistry` (`registry.ts:196-200,325-329`) so it's offered to the
  embeddable `@useatlas/react` widget / SDK consumers, which have no
  `/dashboards` route → dead "Continue editing" link and an unreachable draft.
  (MCP is **not** affected — it exposes no `createDashboard`.) Gate registration
  on surfaces that own the route, or make the handoff surface-aware. Doc-only.
- **L3 — `refreshingId` is a single value** — concurrent tile refreshes clobber
  each other's spinner (`page.tsx:154,343-350`). Use a `Set`.
- **L4 — Suggestions accepted/dismissed by array index** — an in-flight Add plus
  a dismiss reindexes the array and can act on the wrong suggestion
  (`page.tsx:610-633,1234`). Key by a stable id.
- **L5 — Generating suggestions / most bound-tool completions trigger a
  full-board refetch** (`page.tsx:594,822-826`,
  `bound-chat-drawer.tsx:309-318` fires on any `output-available`, incl. pure
  reads and failed mutations). Surgical invalidation.
- **L6 — Tile age caption is not live and mishandles future timestamps**
  (`time-ago.ts:10-21`) — "2m ago" persists past 2 minutes; a clock-skewed
  future `cachedAt` reads "just now."
- **L7 — Global single-key `e`/`Escape` handler fires when focus isn't a text
  input** (`page.tsx:327-341`) — tabbing the toolbar or an open `Select` can drop
  a business user into Edit mode. Scope the shortcut / check `role`.
- **L8 — `updateDashboard` PATCH writes parameters even when its orphan-guard
  pre-read failed** · **verified** · **FILED
  [#4539](https://github.com/AtlasDevHQ/atlas/issues/4539)** —
  `routes/dashboards.ts:1729-1731` (guard gated on `existing.ok`) vs
  `:1783-1786` (unconditional write). A transient read failure skips the safety
  check but still overwrites `parameters`, orphaning a placeholder → next render
  400s. Fix invariant → filed. (Ranked LOW-MEDIUM by the backend auditor.)
- **L9 — Org-share SSR cookie-forward assumes same-origin** —
  `shared/dashboard/[token]/fetch.ts:51,61-66` forwards the *web-origin* cookie
  jar; in a cross-origin deploy the Better-Auth session cookie lives on the API
  domain, so org-share likely 403s every viewer again. **Not confirmed** —
  depends on the deployed cookie-domain config; operator should verify. Fix
  direction: resolve org shares client-side with `credentials:"include"` (as the
  share-status fetch already does). Doc-only until verified.
- **L10 — "Captured {date}" reads dashboard creation, not snapshot capture**
  (`view.tsx:20-23,49-54`) — a board created months ago but refreshed today shows
  "Captured Jan 2026." Relabel to "Created" or drop it for the refresh timestamp.
- **L11 — `screenshotDashboard` returns the base64 PNG in the JSON envelope,
  guarded only by a prompt instruction** (`bound-dashboard.ts:521-531,785`).
  Structural strip, not a prompt rule.

---

## Related open issues (cited, not re-filed)

- [#4464](https://github.com/AtlasDevHQ/atlas/issues/4464) — `createDashboard`
  (and other tools) emit no OTel child span; blind segment in the agent trace.
- [#4460](https://github.com/AtlasDevHQ/atlas/issues/4460) — region-migration
  export bundle omits dashboards (and other post-bundle pillars).

## Filed this pass (fix-invariant bugs, Step 4)

- [#4536](https://github.com/AtlasDevHQ/atlas/issues/4536) — share expiry silently
  reset to 7d (H2)
- [#4537](https://github.com/AtlasDevHQ/atlas/issues/4537) — first-publish gate not
  enforced on write/share/delete (M1, security)
- [#4538](https://github.com/AtlasDevHQ/atlas/issues/4538) — shared frozen-param
  summary drifts for relative dates (M5)
- [#4539](https://github.com/AtlasDevHQ/atlas/issues/4539) — updateDashboard writes
  params on failed pre-read (L8)

---

## Grill agenda

The design questions the findings force (questions, not solutions — the grill
walks this list):

1. **What does the canvas render for a user holding a draft of never-published
   cards?** (C1, H1) Today: "Never run" tiles that can't be refreshed. Does a
   draft card carry its *own* cached data, or is there a reachable draft
   *render* path for draft-only cards, or both? This is the load-bearing
   decision of the whole pass.
2. **When does an agent-built card get executed?** (C1, M2) At build time
   (agent runs each card, result seeds the draft cache), lazily on canvas mount
   (draft render), or only at publish? What's the step-budget cost of
   execute-at-build for a 12-card board, and does an atomic `createDashboard`
   risk zero-dashboard on step exhaustion?
3. **Is "View" strictly read-only?** (M4) If yes, which tile actions survive in
   View (Refresh/Fullscreen/CSV) and which move to Edit (Remove/Rename/
   Duplicate)? If no, where do View-mode edits land — draft or live?
4. **One editing mechanism or two?** (M6) Can `removeCard`/`updateCardSql`
   collapse into the per-user draft (retiring `dashboard_stage_changes`), and
   does publishing a draft fold in still-pending stage changes or ignore them?
   (Open question — the two stores are separate; publish-fold behavior is
   **not verified**.)
5. **How expressive is the bound editor vs the creation tool?** (H3) Should
   bound `addCard` reach parity with `createDashboard` (text/section cards,
   layout, the full card union), and is the bound-tool schema the right long-run
   shape at all?
6. **What is the outward face of a dashboard — a link, an embed, or both?** (M7)
   Conversations already have an embed route; dashboards don't. Does the pillar
   that most needs embedding get one, with what frame-ancestors scope and what
   share-dialog affordance?
7. **What does a shared snapshot promise about freshness and framing?** (M5, L10)
   Frozen data with a live-resolving parameter chip is dishonest; what's the
   single "as-of" contract — capture instant on both data and labels?
8. **Where does `createDashboard` belong?** (L2) It's offered to embed/SDK
   surfaces with no dashboards route. Is it a workspace-web-only tool, or does
   the handoff become surface-aware?

## Not verified (carry into the grill)

- **Whether View-mode tile Remove/Rename/Duplicate write to the draft or commit
  live** — routing lives in the backend card routes; severity of "delete-in-
  View" (M4) depends on it.
- **Whether opening the bound drawer forks a draft row** — `chatOpen` flips
  `showDraftView` and fetches `?view=draft` on every open; the web layer asserts
  this GET is non-forking (`page.tsx:119-123`) but it couldn't be confirmed that
  no `dashboard_user_drafts` row is created for a mere inspect.
- **Whether publishing a draft includes still-pending `dashboard_stage_changes`
  rows** (M6) — the draft snapshot and stage tracker are separate stores; the
  publish-fold behavior wasn't traced end-to-end.
- **Cross-origin org-share 403** (L9) — code-consistent but hinges on the
  deployed Better-Auth cookie domain; needs a live cross-origin request or a
  config check.
- **Adjacent, out of scope:** the shared *conversation* surface
  (`shared/lib.ts:48-68`) still uses `revalidate:60` caching (a revoked link
  served up to 60s) and logs the **raw** token — the two anti-patterns the
  dashboard surface fixed under #4317. Flagged for whoever owns conversation
  sharing; not traced end-to-end here.

---

## Grill outcomes (2026-07-10)

The grill ran same-day and resolved the full agenda. Decisions (vocabulary
pinned in `CONTEXT.md` § *Dashboard editing*; the two structural ones recorded
in [ADR-0034](../../docs/adr/0034-dashboard-draft-cache-single-edit-mechanism.md)):

1. **Draft data (Q1)** — both: the draft render/refresh path becomes reachable
   for draft-only cards (the `getCard` 404 gate yields to draft resolution),
   AND draft cards carry their own persisted cached data — the **draft cache**
   (new glossary term). Draft executions never touch published cached data or
   the Query Cache.
2. **Exec timing (Q2)** — tool-side seed + lazy fallback: `createDashboard` /
   bound `addCard` execute each staged card inside the tool call (concurrent,
   wall-clock-budgeted, fail-soft per card), report per-card outcomes to the
   agent, and anything unseeded falls back to a canvas-mount draft render.
   Resolves M2 alongside C1.
3. **View mode (Q3)** — View is strictly read-only for the definition:
   Remove/Rename/Duplicate/drag move to Edit; View keeps refresh, fullscreen,
   CSV, parameters. A browsing gesture must never fork a draft. (Verified
   during the grill: View-mode mutations were already draft-routed —
   `routes/dashboards.ts:2082-2093` — so M4's worst case was UX confusion, not
   data loss.) New glossary term: **View / Edit (canvas modes)**.
4. **Edit model (Q4)** — collapse into the draft; retire the stage tracker
   (`dashboard_stage_changes`, two-phase drop). Destructive bound ops land in
   the draft with inline undo. (Verified during the grill: publish merges the
   draft only — pending stages were silently stranded, resolving this doc's
   open question.) Reverses #2365; rationale in ADR-0034.
5. **Card parity (Q5)** — parity via one shared card union: define the card
   input union (chart | text, + layout) once in `@useatlas/schemas`; both
   `createDashboard` and bound `addCard`/`updateCard` consume it.
6. **Outward face (Q6)** — both link and embed: mirror the conversation embed
   (`/shared/dashboard/:token/embed`, same any-origin frame-ancestors posture,
   same token/DTO/revocation) + an Embed tab in the share dialog.
7. **As-of promise (Q7)** — single as-of contract: all temporal framing on the
   shared view (parameter chips, captions) derives from the shown data's
   capture instant; "Captured {creation date}" retires. (#4538 is the
   fix-invariant piece.)
8. **Tool scoping (Q8)** — `createDashboard` gates by default to surfaces that
   own a dashboards route; embed/SDK hosts opt in by supplying a dashboard-URL
   resolver for the handoff link.
9. **Creation origin (new, raised in-grill)** — the dashboards surface is a
   first-class creation origin: "New dashboard" (switcher, empty state) lands
   on the canvas with the **bound editor open**, and the empty-canvas copy
   invites building there instead of bouncing to main chat
   (`new-dashboard-dialog.tsx:104` routes without `?openChat=true`;
   `page.tsx:1285-1287` points back to main chat). Main-chat `createDashboard`
   stays as the second origin.

H1's direction was already decided by the pinned Canvas contract
(`CONTEXT.md`: the canvas "renders the caller's draft when they have one") —
it's a conform-to-contract fix, not a design question.

**Next: run `/to-prd` from this doc + grill outcomes; `/to-issues` folds in
the four filed fix-invariant issues as sub-issues of the PRD.**
