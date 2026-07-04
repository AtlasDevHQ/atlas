# Dashboard surface — full audit (2026-07-04)

Prep for a `/grill-with-docs` session on how to **elevate the dashboard**, in the
same spirit as the chat turn-presentation pass (PRD #4292). Four parallel deep
audits — frontend viewer/editor UX, backend/data model, agent-driven building,
and sharing/screenshots/drafts — collated here, deduped, and ranked. File:line
anchors throughout. The three anchor findings (C1, H1, H2) were spot-verified by
hand.

## Verdict: strong engine, unfinished cockpit

The **backbone is genuinely good** and should be preserved wholesale:

- **One execution pipeline.** Every card path (preview, render, refresh, bulk
  refresh, CSV export, KPI comparison, scheduler) funnels through
  `runUserQueryPipeline` — the *same* guard as the agent's `executeSQL`
  (SELECT-only → AST → whitelist → auto-LIMIT → timeout → RLS → approval →
  audit → masking). No card path bypasses it (ADR-0027 reach parity).
- **Parameter binding is airtight** — comment/literal-aware placeholder scanner,
  strict per-type coercion, fail-closed on undeclared placeholders, non-PG/MySQL
  dialects rejected rather than silently interpolated.
- **Pure-core versioning** — `applyChangeToDraft` / `publishDraftMerge` /
  `rebaseDraftSnapshot` are snapshot-in/snapshot-out; publish computes the merge
  before `BEGIN`, re-checks under `FOR UPDATE`, 409s on conflict (never silent).
- **Careful stale-response sequencing** in the viewer (`paramReqSeq` /
  `comparisonReqSeq`) genuinely prevents a slow batch clobbering a newer one.
- **KPI math, migration hygiene, cross-org probing defence** all solid.

The problems are almost all **at the seams** — where these good pieces meet the
user. The draft/publish model is only half-wired to the canvas; the agent-build
loop doesn't show its own output; sharing leaks internals and org-share is
outright broken; and errors hide in page-level banners instead of on the tile
that failed. So: the machine computes the right answer, but the surface around it
doesn't yet earn a trial admin's trust.

---

## Critical

### C1 — Agent-built dashboards render as an empty canvas
`tools/create-dashboard.ts:363-447`, `dashboards/[id]/page.tsx:97-99`,
`bound-chat-drawer.tsx:55-62` · **verified**

Since drafts default ON (#2521), `createDashboard` commits a **published**
dashboard row with **zero cards** and stages every card into the user's
`dashboard_user_drafts`. But the dashboard page fetches `/dashboards/{id}` with
**no `?view=draft`**, so it renders published cards — nothing. The agent says
"Continue editing →", the link opens `/dashboards/{id}?openChat=true`, and the
user lands on a **visually empty board** with a chat drawer. The 6 cards it just
built exist only inside the Publish diff modal. Asking the drawer to add another
card mutates the draft and refetches *published* (still empty) → canvas still
blank.

Worse, it's **internally inconsistent**: destructive ops (`removeCard` /
`updateCardSql`) *do* render live ghost overlays because the grid separately
reads `/dashboards/{id}/stage`. So deletions show strikethroughs but additions
show nothing — the two halves of "editing" behave oppositely. This is the single
most important thing an elevation must fix: the primary "build a dashboard by
talking to Atlas" flow currently produces an empty screen.

---

## High

### H1 — Public share leaks raw SQL + internal identifiers to anonymous viewers
`routes/dashboards.ts:2850` (returns full `result.data`, strips only
`shareToken`) · `types.ts:8` (`SharedCard.sql`) · **info leak**

The public endpoint ships the entire `DashboardWithCards`. The React page renders
only titles + cached data, but a `curl` / devtools read of
`/api/public/dashboards/<token>` exposes, for a **no-auth** share: every tile's
raw `sql` (tenant filters, PII column names, hardcoded thresholds), per-card
`connectionGroupId`, the dashboard `ownerId` + `orgId`, `refreshSchedule` cron,
`nextRefreshAt`, `shareExpiresAt`, and all `parameters` definitions. Fix: project
a minimal public DTO (title/description + per-card title/kind/chartConfig/
annotations/cachedColumns/cachedRows/cachedAt/layout) and drop `sql`,
connection/owner/org IDs, cron, and parameters. Remove `sql` from `SharedCard` to
enforce it at the type layer.

### H2 — Org-scoped shares are completely broken (cookieless SSR fetch → 403 for everyone)
`shared/dashboard/[token]/page.tsx:18-22` · **verified** · feature non-functional

The shared page fetches from a **React Server Component** with a bare `fetch(...,
{cache:"no-store"})` — no cookie forwarding. For an `org` share the API runs
`authenticateRequest` against that cookieless request, finds no session, and
returns 403. A logged-in teammate opening an "Organization — requires login"
link sees "Authentication required"; clicking Log in loops back to the same
failure. Fails closed (no leak) but org-share mode is unusable end to end. Fix:
forward `(await headers()).get("cookie")`, or resolve org shares client-side with
`credentials:"include"`.

### H3 — Share route silently downgrades an org share to PUBLIC on any body-validation error
`routes/dashboards.ts:2252-2266` · **verified** · security silent-fallback

`ShareSchema.parse(body)` runs inside a `try`; on **any** throw the catch logs at
`debug` and falls through, so `shareMode` defaults to `"public"` (:2265). A
client intending `shareMode:"org"` but sending a malformed `expiresIn` (or any
invalid field) creates a **public** link instead. Violates CLAUDE.md "prefer
errors over silent fallbacks / no false-negative security fallbacks" — should 400
on invalid body, never default to the *less* restrictive mode.

### H4 — A partially-failed parameter / cross-filter render silently mixes filtered and stale tiles
`dashboards/[id]/page.tsx:742-757` (only `ok` entries written; whole map
replaced), `:652-660` (failed cards fall back to unfiltered `cachedRows`),
`:761` (faint amber aggregate line) · silently-wrong analytics

Apply a date filter; if 3 of 8 cards error, the 5 successes show filtered data
and the 3 failures silently revert to their **old unfiltered** numbers, with the
only signal one faint "3 cards couldn't be updated" line. A reader sees a board
that mixes two time windows with no per-tile indication which tiles are stale.

### H5 — Tile-level errors are never surfaced on the tile
`dashboard-tile.tsx:412-416` · error-handling

`ChartTile` has two body states: data, or muted "No cached data — refresh to load
results." There is no error state, no stale/failed badge, and **zero rows** →
same "No cached data" copy (which is also just wrong — an empty result isn't
missing data). Every failure is hoisted to page-level aggregate banners
(`paramError`, `mutationError`, `exportError`, `suggestError`). For a grid, errors
belong on the tile that failed.

### H6 — Two contradictory mutation models with no user-facing reconciliation
`dashboards/[id]/page.tsx` (drag/rename/duplicate/delete/schedule all bare
PATCH/POST/DELETE, commit immediately) vs `bound-chat-drawer.tsx:19-23` (chat
edits → per-user draft → publish) · conceptual

Direct manipulation commits **live to the whole org instantly**; chat edits go to
a **private draft** requiring publish. Nothing tells the user which is which. A
user trained by the chat drawer to expect drafts drags 6 tiles and deletes 2 in
Edit mode believing it's private — but those went live immediately. The Edit-mode
hint mentions only drag/resize, never publishing. Resolving this split is
foundational to any elevation.

---

## Medium

**Draft / publish correctness**
- **M1 — Draft has no execution path; render/refresh always run the PUBLISHED
  card SQL.** `routes/dashboards.ts:1829,1941` (`getCard` reads published),
  `dashboard-versioning.ts:1152-1153` (`?view=draft` overlays draft SQL *text*
  but forwards published `cachedRows`). Accept an `edit_sql` stage, open
  `?view=draft`, and the parameter bar renders the *old published* SQL/rows — the
  draft's edited query is un-runnable until publish. A drafts elevation needs a
  draft-aware execution endpoint.
- **M2 — Same-second lost update in publish.** `dashboards.ts:121-122`
  (`String(r.updated_at)` truncates a JS `Date` to whole seconds),
  `dashboard-versioning.ts:850,889`. The stale-baseline guard compares timestamp
  *strings* at 1s granularity; two publishes in the same second pass the
  `FOR UPDATE` re-check and B silently overwrites A. Fix: compare at full
  precision (`::text`/epoch) or a monotonic version column.
- **M3 — Publish-diff preview ≠ server merge.** Client `dashboard-diff.ts:117`
  diffs only `chartConfig.type` and never `position`; server
  `dashboard-versioning.ts:476-493` compares the *whole* `chartConfig` and
  `position`. So editing only thresholds/colors/valueColumns (type unchanged), or
  a pure reorder, shows "no change" → Publish button disabled (empty-gated) and
  the user *cannot publish a real change*; or, amid other edits, the change is
  applied but never shown — violating "review what will be published." Fix: share
  one `cardEquals`/field list across client and server.
- **M4 — Publish never refreshes card caches.** `dashboard-versioning.ts:909,941`
  write `sql`/`title`/`chart_config` but not `cached_rows`/`cached_at`. Edit a
  tile "7 days → 30 days" and publish → the shared link shows the **new title over
  old 7-day data** (new cards show "No data" until a scheduled refresh), and the
  "Last refreshed" chip post-dates the SQL change, implying false freshness.

**Agent-driven building**
- **M5 — Divergent, pre-#4292 renderer.** The bound drawer hand-rolls
  `BoundChatMessage` (`bound-chat-drawer.tsx:531-582`) on low-level primitives;
  none of the #4292 working-phase → receipt → promoted-artifact model reaches it.
  The six building tools (`addCard`, `updateCard`, `getDashboardState`,
  `updateLayout`, …) have no renderer case and fall to `tool-part.tsx:68-78`'s
  gray "Tool: addCard" box. `TypingIndicator` vanishes once tool calls start
  (`:285-289`) → dead air. Parsed `<suggestions>` chips are thrown away
  (`:570-573`, "polish pass" never shipped).
- **M6 — Conversation continuity is broken.** Three surfaces promise "the same
  conversation resumes in bound mode" (`create-dashboard.ts:166`,
  `create-dashboard-card.tsx:11-16`, registry), but the drawer resets the
  conversation on every open (`bound-chat-drawer.tsx:116-123`) and is passed no
  conversation id. The chat that built the dashboard is abandoned; the bound
  session starts with zero memory of the SQL it just wrote.
- **M7 — `addCard` hardcodes `connectionGroupId: null`.**
  `bound-dashboard.ts:288` vs `create-dashboard.ts:238,406` (which scopes to the
  conversation group). Add a card via the drawer to an EU-prod dashboard and it
  silently resolves against the **default** datasource → wrong/empty data, no
  error.
- **M8 — History transcript renders live, interactive stage controls.**
  `bound-chat-drawer.tsx:544-577` applies `readOnly` only to the user bubble; a
  past session's `removeCard`/`updateCardSql` renders live Accept/Discard buttons
  that POST against a long-resolved stage id, inside a panel labelled "Read-only
  transcript."
- **M9 — Orphan empty published dashboards + anonymous draft-privacy bypass.**
  `createDashboard` always commits a published 0-card shell (org-visible before
  publish, `create-dashboard.ts:363-368`); if never published it litters the org
  list. And an anonymous bound `addCard`/`updateCard` writes **straight to
  published** even with drafts ON (`bound-dashboard.ts:105-106`), defeating the
  "yours alone until you publish" promise.

**Loading / responsiveness / availability**
- **M10 — Blank screens + heavy layout shift on load.** `dashboards/loading.tsx`
  and index `page.tsx:79` return `null` (multi-second white void, no skeleton);
  the grid is client-only and renders nothing until measured
  (`dashboard-grid.tsx:187`); the `[id]` loading skeleton (a 2-col stack) doesn't
  match the real 24-col freeform grid; and up to 7 async banner rows mount
  independently between topbar and grid, each shoving the grid down (the draft
  banner arrives a beat late on a separate poll).
- **M11 — Mobile Edit is a dead no-op.** `dashboard-grid.tsx:168` hard-codes
  `editing={false}` on mobile and only desktop mounts the draggable layout, yet
  the topbar still shows the Edit toggle + "drag tiles to rearrange" hint. Tapping
  Edit on a phone does nothing, unexplained. Mobile tile heights are also frozen
  to desktop row math.
- **M12 — Public rate-limit mis-bucketed.** `dashboards.ts:2791` keys on client
  IP, but the SSR fetch originates from the web server's IP → all viewers share
  one 30-rpm (or 10-rpm anon) bucket → 16 concurrent viewers self-DoS the feature,
  while a real attacker hitting the API directly is under-limited. Plus a **double
  fetch** per view (`generateMetadata` + body, both `no-store`) halves the
  headroom.

**Screenshots / export**
- **M13 — No concurrency cap on one shared `--no-sandbox` Chromium.**
  `dashboard-screenshot.ts:247-250` launches a single long-lived browser; every
  export (up to 180s) spins a fresh context with no semaphore. N concurrent
  exports (or the bound agent looping) → unbounded contexts → OOM; a crash takes
  down all screenshot+export capacity.
- **M14 — Dead-browser reuse.** `getBrowser` returns `cachedBrowser` whenever
  truthy (`:230-231`) with no liveness check; if the process crashes, every
  subsequent export throws `render_failed` until the API restarts.

**Wire contract / API**
- **M15 — Text cards & SQL edits aren't creatable via REST card routes.**
  `AddCardSchema`/`UpdateCardSchema` (`dashboards.ts:107-130`) have no
  `content`/`kind`, and `UpdateCardSchema` has no `sql`. Text cards can be
  authored only via draft/publish or the bound editor; a card's SQL can be edited
  only via the `edit_sql` stage. The REST and draft surfaces expose different card
  capabilities — reconcile them.
- **M16 — `render` 500s on a body-less request.** `dashboards.ts:1933`
  destructures `c.req.valid("json")` with no body → throws generic 500. The
  `export` route handles the same case with `?? {}` (:2681). A legitimate
  "render with all defaults" 500s.

**Validation / error-handling**
- **M17 — Parameter bar has no validation or feedback.**
  `dashboard-parameter-bar.tsx:128-186`: no required indicator, no per-control
  error; `Number("1.2.3")` → `NaN` → serialized to `null` → typo silently becomes
  "no override"; strict `YYYY-MM-DD` parsing renders a blank DatePicker while the
  chip shows a value (control and chip disagree).
- **M18 — Discard-draft dialog closes before the request resolves.**
  `draft-status-banner.tsx:182-189` (no `preventDefault`) → Radix dismisses the
  dialog on click, so the `disabled`/"Discarding…" states never render and a
  failed discard surfaces behind a closed modal. Publish gets this right;
  discard doesn't.
- **M19 — 500s without `requestId` on the public surface.**
  `dashboards.ts:261-262` (`sharedDashboardFailResponse`) omits `requestId` from
  the body (logged server-side but not echoed). CLAUDE.md requires requestId on
  all 500s.
- **M20 — `preview-card` trusts a client `connectionId` with no org check.**
  `dashboards.ts:687-690,1789-1808` — the one card-execution surface that never
  verifies its execution target belongs to the caller's org (contrast `addCard`
  at :1655-1671). Confirm `resolveExecutionTarget` rejects cross-org connIds; if
  not, it's an authorization gap.

---

## Low (batch — worth a cleanup slice, not individually blocking)

- **Drilldown/cross-filter has no keyboard path** (mouse-click only,
  `dashboard-tile.tsx:167-186`) — AT users can't cross-filter at all.
- **Fullscreen tile is not a real dialog** (`dashboard-grid.tsx:214`) — no
  `role="dialog"`, no focus trap/return, no backdrop.
- **"Selected-but-not-yet-filtered" flash** — chip + highlight update from the URL
  synchronously while tile data lags the render batch.
- **`incompatibleCardIds` scans only `card.sql`** (`cross-filter.ts:112-116`) — a
  KPI card referencing the param only in `comparisonSql` is falsely "Not filtered."
- **`refreshingId` is a single value** (`[id]/page.tsx:113`) — concurrent card
  refreshes clobber each other's spinner.
- **Optimistic layout snap-back is unexplained** on PATCH failure — tile
  teleports with only a generic banner.
- **Density & edit-mode not persisted** (reset every reload); `chatOpen` uses raw
  `router.replace` instead of nuqs like the rest of the page.
- **Greedy global `e`/`Escape` handler** (`[id]/page.tsx:226-240`) fires under
  open Radix popovers (role listbox/menu aren't inputs).
- **Share dialog can't edit an existing link** — must Revoke + re-create, which
  **silently rotates the token** and kills every distributed URL, no warning
  (`share-dialog.tsx:198-238`, `dashboards.ts:742`).
- **Raw share token logged in cleartext** on the web surface
  (`shared/.../page.tsx:27,32,38`) while the API carefully logs only the hash.
- **`no_db` surfaced as 404 "not found"** to public viewers (`:2787`) — an outage
  reads as a dead link; should be 503.
- **Suggestions keyed by array index** (`:1052`, accept/dismiss by index) — races
  act on the wrong item.
- **`suggestCards` uses the shared `mutate` with `invalidates:refetch`**
  (`:488`) → full dashboard refetch just to generate suggestions.
- **`onDashboardMutated` fires on every tool `output-available`**
  (`bound-chat-drawer.tsx:213-222`) including pure reads & failed mutations →
  wasted refetch + card-reshuffle churn.
- **`timeAgo` isn't live** (freezes until next render, no absolute-time tooltip,
  future timestamps → "just now").
- **Text tiles can't be duplicated** (`dashboard-tile.tsx:499-503`);
  **KPI zero-row** shows generic "No cached data" instead of its own `—`
  placeholder (`:412`).
- **Persisted card SQL is never validated at write time** (execution-only) — the
  DB accumulates un-runnable cards.
- **`loadGroupSnapshot` N+1** — one `workspace_plugins` query per card in every
  bulk refresh even when all cards share a group.
- **Client-supplied `cachedRows` trusted & served unvalidated**; response bodies
  are effectively untyped (`z.record(z.unknown())`); `dashboardChartConfigSchema`
  isn't `.strict()`.
- **`dashboard_stage_changes` CHECK-constraint name drift** between migration 0083
  (inline, auto-named) and `schema.ts:2091-2093` (named) — confirm
  `check-schema-drift.sh` normalizes.
- **`screenshotDashboard` returns base64 PNG in the JSON envelope** (`_base64`)
  relying only on a prompt instruction not to echo it — no structural guard.

---

## Structural themes for the grill (where the weight is)

These recur across the four audits and are the real subject of "elevate the
dashboard":

1. **The draft/publish model is half-built.** It's per-user working copies, not
   content-mode visibility gating — dashboards themselves have no draft/published
   `status`, a created dashboard is instantly org-live, and the draft has no
   canvas rendering (C1), no execution path (M1), a diff that disagrees with the
   server (M3), and coexists with an immediate-commit direct-manipulation model
   nobody reconciled for the user (H6). Decide what "draft" *means* here.

2. **The agent-build loop doesn't show its own work.** The natural
   "answer-bearing artifact" — the canvas reflecting the cards just built —
   is exactly what's broken (C1), and the drawer is a divergent pre-#4292
   renderer (M5) with broken conversation continuity (M6). This is where the
   dashboard should converge on the chat turn-presentation model, not fork from
   it.

3. **Errors and freshness hide instead of surfacing on the object.** Tile
   failures, stale param renders, and publish-without-refresh all hide at page
   level or not at all (H4, H5, M4). A dashboard is a grid of independent objects;
   status belongs on each object.

4. **Sharing is the trial-admin's outward face and it's the weakest link.** It
   leaks internals (H1), org-mode is broken (H2), can silently go public (H3),
   rotates tokens without warning, and rate-limits itself into a DoS (M12).

5. **First-impression polish is unfinished** — blank loads, layout churn, mobile
   dead-ends (M10, M11) — the same class of concern that animated the chat PRD,
   now for a surface with far more moving parts.

## What to preserve (do not regress)
Single execution pipeline / reach parity · airtight parameter binding · pure-core
versioning + 409-on-conflict · stale-response sequencing · KPI math · cross-org
probing defence · migration hygiene · the "Not filtered" cross-filter
affordance · single-URL-key (`dparams`) shareable filter state.
