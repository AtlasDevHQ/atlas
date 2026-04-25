# 1867 follow-up — Dashboard Detail Surface — Phase 1 Critique

Baseline screenshots: `.claude/research/1867-followup-detail-critique/before/`. Captured 2026-04-25 against `main` at `2b9bb97e` on branch `1867-followup-detail-critique`. Tracking issue: #1890. Build PR: #1889.

States captured: empty (1440 / 768 / 375), populated view (1440 — bars-collapsed-as-dots, the actual user reality), edit-mode (1440 — same plus "+ Add tile"), edit-mode forced-hover with rendered bars + lines (1440), kebab dropdown open (1440), chart→table view-mode switch (1440), fullscreen tile (1440), populated tablet (768), populated mobile (375 + scrolled).

The dashboard detail page is the codebase's first react-grid-layout (RGL) surface. The build PR pivoted from the original critique-then-build plan into a build-first sprint, which means this is the first design pass on a freeform tile grid that's structurally different from anything else in Atlas (chat / notebook / admin all stack vertically; this one floats). The chrome is dense — eight controls in the topbar at 1440, six per tile head, plus density + view/edit toggles — and most of it has the *register* of the admin revamp (compact pill segments, mono-uppercase chips) without the same disciplined hierarchy.

## Headline scores (0–10, higher = better)

| Axis | Score | Note |
|---|---|---|
| Visual hierarchy | **3** | Tile head packs five zones (drag handle, title, CHART/TABLE chip, three icon buttons) before the user reaches the data. Title is `text-sm font-medium` — the same weight as the body labels. The topbar mixes three different segment registers (View/Edit pill, density icon group, CHART/TABLE chip-on-tile) plus a `4 TILES` count chip plus four outline buttons plus one destructive button. |
| Information architecture | **3** | Edit mode is visually almost indistinguishable from view mode (only the Edit segment highlights and "+ Add tile" appears) — no canvas gridlines, no banner, no background tint. Density toggle disappears below md. Refresh-schedule disappears below lg. Two empty-state implementations live in the codebase (the inline page.tsx one wins; `EmptyCanvas` inside `dashboard-grid.tsx` is unreachable dead code). |
| Emotional resonance | **3** | "An empty canvas" copy lands well — borrows the bucket-2 register. But the icon block above it (`LayoutDashboard` in a zinc-50 rounded square) reads as Bootstrap-era empty-state cliché — same finding as bucket-2 P3, regressing here. The chart palette is a default Recharts royal-blue, not the Atlas teal — the brand flavor never reaches the data. |
| Cognitive load | **2** | View-mode loads with bars/lines collapsed to dots. Tile heads at 3-col-wide get truncated mid-word ("Pipeline by..."). The CHART/TABLE chip uses `font-mono text-[10px] uppercase tracking-wider` — barely legible at default density. Three icon-only buttons in every tile head with no `aria-label` — sighted users get a `title=` tooltip; everyone else gets nothing. |
| Mobile experience | **1** | At 375 the grid renders 4 tiles into the 24-col layout: each tile becomes ~166px wide and ~390-440px tall, with the right-half tiles offscreen until the user scrolls. RGL has zero responsive breakpoints in this config. The topbar wraps to three rows (View/Edit, Refresh+Share, Delete) — Suggest, density, refresh-schedule, and the tile-count chip all hide. The peach avatar floats over content as expected. The page is essentially unusable below `sm`. |

Overall: **2.4 / 10**. Same score as bucket-2. The build is an ambitious feature shipped quickly — RGL works, drag/resize persists, fullscreen exists, AI suggestions wire through. But the design pass that the original tracker (#1867) deferred is exactly what's missing.

## Top P0/P1 findings

### P0 — Charts collapse to dots on initial mount

`before/desktop-1440-populated-view.png`. The bar chart on `Pipeline by stage`, the line chart on `Forecast vs. actual`, and the bar chart on `Win-rate by region` all render as **single dots at the top of each bar's value position** instead of bars or lines. They render correctly only after a layout reflow (toggling edit mode or pressing the chart-type segment forces re-mount). Compare `before/desktop-1440-populated-view.png` (broken) vs `before/desktop-1440-edit-mode-rendered.png` (correct, after reflow).

This is almost certainly a Recharts `<ResponsiveContainer>` × RGL interaction: when `dashboard-tile.tsx:233` renders inside the RGL item, the container's first measured width is 0 (RGL hasn't placed it yet), Recharts decides "no width = no shapes," and the resulting bars/lines never re-render when RGL settles. The `dynamic({ ssr: false })` import at `dashboard-tile.tsx:32` skeleton loads correctly, then mounts into a 0-width container.

**Fix options:**
- Pass an explicit `key={`${card.id}:${tileWidthClass}`}` to `<ResultChart>` so it remounts when the wrapper width changes class buckets.
- Wrap the chart in a `useContainerWidth()`-style observer that suspends the chart until `width > 40` (Recharts' min sane width).
- Pass an explicit `width`/`height` from the parent (DashboardTile knows its own size from RGL — forward it).

The user reality today is "load my dashboard, every chart looks empty" — this dwarfs every other finding here.

### P0 — Tile head icon buttons have no accessible name

`packages/web/src/ui/components/dashboards/dashboard-tile.tsx:181-205`. Refresh, Fullscreen, and the kebab DropdownMenu trigger are `<Button variant="ghost" size="icon">` with only `title="Refresh data"` / `title="Fullscreen"` / `title="More"`. The only label a screen reader gets is `title`, which Safari + JAWS treat inconsistently and which only fires on hover for sighted users.

Same pattern in `dashboard-tile.tsx:132-142` for the title-edit Check/X buttons (Save / Cancel — no aria-label).

**Fix:** add `aria-label="Refresh tile"` / `aria-label="Fullscreen"` / `aria-label="Tile actions"` / `aria-label="Save title"` / `aria-label="Cancel"`. Audit gate (`/audit` + axe) will flag these — fix proactively. Note that `dashboard-topbar.tsx:266` `DensityButton` *does* set `aria-label` correctly — the tile head is the regression.

### P0 — Mobile (≤sm) is functionally broken

`before/mobile-375-populated.png` shows a fullPage screenshot where the entire 4-tile grid is invisible above the fold — tiles 3 and 4 render at `x: 222, y: 638`, completely below the avatar. Tile heads at 375px truncate to `Top...` and `Wi...` because `dashboard-tile.tsx:145` uses `line-clamp-1` on a flex-1 title that's competing with a CHART/TABLE chip + 3 icon buttons.

The root cause: `grid-constants.ts` sets `COLS = 24` and `dashboard-grid.tsx:73-79` passes that fixed value to RGL with `useContainerWidth()`. RGL doesn't have its own breakpoints in this config (no `<ResponsiveGridLayout>`), so a 24-col grid runs the same on a 375px viewport as on a 1440px viewport. Each col becomes ~14px wide, and a `w: 12` tile becomes ~166px — too narrow for any chart label, let alone the title + 5-button head.

**Fix options (pick one):**
- Switch to `<ResponsiveGridLayout>` with breakpoints (e.g., `lg: 24, md: 12, sm: 6, xs: 4`) and per-breakpoint layouts (RGL persists them as a map). Existing layouts get auto-mirrored down via the existing `withAutoLayout` waterfall.
- Below `md`, bypass RGL entirely and render the cards as a stacked single-column list (height = `DEFAULT_TILE_H * ROW_H`). RGL stays for editing on tablet+; mobile becomes read-only single-column. Cheap and correct.

Mobile editing of a freeform grid is a poor UX anyway — touch dragging on a 375px viewport with 4-px drag handles is hostile. Single-column read on mobile is the right call. (The original Claude Design handoff scoped tablet+; the build PR didn't.)

### P1 — Edit mode is visually almost identical to view mode

`before/desktop-1440-populated-view.png` vs `before/desktop-1440-edit-mode.png`. The differences:
- The View/Edit segmented control flips its highlighted half (subtle).
- A green "+ Add tile" button appears at the right of the topbar.
- A 3.5px grip-vertical icon appears at the top-left of each tile head at 60% opacity.

That's it. There's no:
- Canvas tinting (no `bg-zinc-50` body in edit mode vs `bg-white` in view).
- Visible gridlines (despite the build PR mentioning "faint edit-mode grid lines" — `globals.css:151-164` only styles `.react-grid-placeholder` which is only the drop ghost during a drag).
- Banner ("You're editing — drag tiles to rearrange").
- Resize handles (the `e/s/se` handles are CSS-only borders that activate on hover; in `before/desktop-1440-edit-mode.png` no tile has visible handles).

The `Esc` keybind exits edit mode, but there's no copy anywhere telling the user that. The `E` keybind toggles, also undocumented (the empty-state `EmptyCanvas` mentions it, but that empty state is unreachable — see P1 below).

**Fix:** make edit mode unmistakable. Three small things compound:
1. Tint the canvas: `dash-density-*` wraps already exist — add a `body.is-editing .dashboard-app` background of `bg-zinc-50/60` (or `bg-grid-pattern` SVG with 1px dotted lines on the grid intersections).
2. Persistent edit-mode chip somewhere in the topbar reading `Editing • E to exit` (the `font-mono text-[10px]` register from the count chip).
3. Always-visible drag handles (drop the `opacity-60 group-hover/head:opacity-100` and let the `::` grip sit at full opacity in edit mode — costs ~6px of head real estate).

### P1 — Two empty-state implementations exist; the second is dead code

`packages/web/src/app/dashboards/[id]/page.tsx:388-400` renders `<div>...An empty canvas...<Button>Go to chat</Button></div>` when `dashboard.cards.length === 0`. But `packages/web/src/ui/components/dashboards/dashboard-grid.tsx:117-134` *also* defines an `EmptyCanvas` component with **different copy** ("Add to Dashboard" missing the "on the result" suffix) and a different keybind hint (the page.tsx version has no `Press E` hint; the grid.tsx version does, but only in editing mode).

Because page.tsx renders the empty state *before* it conditionally renders `<DashboardGrid>`, the grid-level `EmptyCanvas` is never reached. It's pure dead code.

**Fix:** delete `EmptyCanvas` from `dashboard-grid.tsx:117-134`. Move the `Press E to exit` hint into the `page.tsx` empty state if we want it (we don't — the empty state is reached *before* the user has a chance to press E since there's nothing to drag). Drop the icon block (see P2). Net: simpler component, one source of truth, less confusion when the next person edits the empty state.

### P1 — Tile head packs five zones with no hierarchy

`before/desktop-1440-edit-mode-tile-hover.png`. From left to right inside the tile head:
1. `GripVertical` drag handle (`size-3.5`, `opacity-60`)
2. Title (`text-sm font-medium tracking-tight line-clamp-1`)
3. CHART / TABLE chip pair (`font-mono text-[10px] uppercase tracking-wider`)
4. Refresh icon (`size-3.5`, `size-7` button, `opacity-60`)
5. Fullscreen icon (same)
6. Kebab icon (same, opens Rename / Duplicate / Remove)

The title — the only thing that names what the user is looking at — is the *second* element with default-weight typography, competing with the equally-monochrome chip cluster. At a 3-col wide tile (the minimum, and the size most charts default to), the head squashes title to 1-2 words and the CHART/TABLE chip dominates.

**Fix:** make the title dominant.
- Bump to `text-base font-semibold` (will eat the same row but feel like the answer to "what is this").
- Move CHART/TABLE switch into the kebab menu *or* into the body (a thin `Bar | Pie | …` sub-toolbar already exists at `result-chart.tsx` — duplicating it as a tile-head chip is redundant). Today the tile head shows two switchers: CHART/TABLE (chrome) and Bar/Pie (chart-config). One of them belongs in the head; the other belongs in the body.
- Drop the drag handle when not editing (it already does this via `opacity-0 pointer-events-none`) and treat the entire head row as a drag-handle-on-hover when editing — `cursor-grab` is already there.

### P1 — CHART/TABLE chip uses an illegible micro-mono register

`packages/web/src/ui/components/dashboards/dashboard-tile.tsx:154-176`: `rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider`. At 10px with `tracking-wider` the letters lose their shapes — most users will read it as a colored pill, not as text. The bucket-2 sidebar uses a similar `font-mono text-[11px] uppercase tracking-wider` register for *navigation labels* (sidebar group headings), where the user has time to parse them. A toggle they need to click belongs in a normal text register.

**Fix:** use the same Tabs-like register as the topbar View/Edit (`text-xs font-medium`, no mono, no uppercase). Or: drop the chip entirely if the chart-type switcher inside the body already covers the same intent (it does — `Bar/Pie/Line/Area/Scatter` already includes "switch to non-chart" implicitly: there's no chart-config = render the table).

### P1 — "Bars are blue" — chart palette ignores the brand

`before/desktop-1440-edit-mode-rendered.png`. The bars are royal blue (`#2563eb`-ish), the lines are blue + green-teal. Atlas's primary is teal. There is exactly one teal touch in the dashboard (the `4 TILES` count chip and the active CHART chip selection). The chart palette never picked up.

This is a `result-chart.tsx` decision (shared with chat), so it would land both surfaces. Today's palette feels like the default Vercel template — doesn't say "Atlas." Bucket-1 chat and bucket-2 notebook didn't fix it; bucket-3b is the moment to decide.

**Fix:** plumb a token-based palette through `result-chart.tsx`. Two options:
- Single-series default = `var(--primary)`; multi-series picks from a 5-color teal-anchored sequential ramp.
- Use shadcn/ui Charts color tokens (`--chart-1` … `--chart-5`) defined in `globals.css` and let theme-switching cascade through.

### P1 — Fullscreen tile lets underlying content + chrome bleed through

`before/desktop-1440-fullscreen-tile.png`. The fullscreen wrapper at `globals.css:166-174` uses `inset: 14px` which leaves a 14px gutter showing the underlying canvas. At the bottom of the screenshot you can see the `Negotiation` / `EMEA` / `LATAM` labels of the win-rate chart bleeding through the gutter. The peach avatar and the dev-tools issue toast also float over the fullscreen layer.

**Fix:**
- Either go true `inset: 0` (no gutter; close button needs more contrast) or add an opaque backdrop layer (`fixed inset-0 bg-background z-90`) under the fullscreen wrapper so the underlying tiles stop showing through.
- Trap focus inside the fullscreen tile while it's open. Escape should exit fullscreen first, then exit edit mode (current behavior: Escape exits edit mode; the fullscreen exit is mouse-only on the Minimize2 icon).
- Add a label to the Minimize2 button reading "Exit fullscreen" (currently `title=` only — same a11y issue as P0).

### P1 — Density toggle does almost nothing

`globals.css:176-179` only changes `.dash-tile-head` and `.dash-tile-body` padding (compact: 6-7px; comfortable: defaults; spacious: 12-14px). It does **not** change `ROW_H` or `GAP` in `grid-constants.ts:12-13`. So toggling density tightens the inside of each tile but the canvas itself stays at the same row height + 10px gap. The tiles get marginally less padded, the chart inside gets marginally more room, and that's it.

The user expectation when they click the bottom `StretchHorizontal` (Spacious) icon is that the *grid breathes* — wider gaps between tiles, taller rows. Not "tiles get 4px more padding."

**Fix options:**
- Swap density to a CSS-var-driven `--row-h` and `--gap` that the JS constants subscribe to (requires re-passing to RGL `gridConfig`), so density controls the *grid rhythm* not just tile padding.
- Or: collapse density to a binary "Compact / Comfortable" toggle that *only* affects intra-tile padding (today's behavior with one fewer button) and label it as such. Hiding three buttons that look powerful but only nudge padding is misleading chrome.

I'd take the first option — density that doesn't change the canvas isn't density.

### P1 — Topbar wraps to 3 rows on mobile because every action is a row-level button

`before/mobile-375-empty.png`. Below the title you get: View | Edit (row 1) → Refresh, Share (row 2) → Delete (row 3). Plus an `ALL DASHBOARDS` breadcrumb above. That's 4 horizontal rules of chrome before any tile content.

The bucket-2 toolbar pattern shipped a `<sm` overflow-menu solution (`notebook-cell-toolbar.tsx`) that the dashboard tile head should adopt. Same problem at the topbar level.

**Fix:** below `md`, collapse `Refresh / Suggest / Share / Delete / Add tile` into an overflow `MoreHorizontal` dropdown anchored to the topbar's right side. View/Edit can stay as a segment because it's the primary mode toggle. Today's `flex-wrap` means the user gets the worst of both worlds: same 5 buttons, just stacked vertically.

## P2 / P3 findings

### P2 — Refresh-schedule selector is the only piece of chrome that disappears below `lg`

`packages/web/src/ui/components/dashboards/dashboard-topbar.tsx:208-221`: `<SelectTrigger className="hidden h-8 w-auto gap-1.5 text-xs lg:inline-flex">`. So a tablet (768) user with a dashboard set to auto-refresh has no way to see or change the schedule. Either a busy admin opens it on their laptop and sets it once, or they never know. Discoverability cost > chrome cost — the trigger is `text-xs` and 8 chars wide.

**Fix:** show on `md` too. Mobile only collapses (and rolls into the overflow menu from the prior P1).

### P2 — `4 TILES` count chip uses uppercase tracking on a count that isn't a label

`dashboard-topbar.tsx:129-131`. `4 TILES` in `font-mono text-[10px] uppercase tracking-widest`. Treats a count as if it were a section heading. The bucket-2 sidebar uses this register for *category labels*; using it on a number chips reads as decorative, not informative.

**Fix:** simplify to `text-xs text-zinc-500 tabular-nums` next to the title with the literal text "4 tiles" — drop the chip border and the all-caps. Or drop the chip entirely; the tile count is implicit from the visible grid.

### P2 — Edit-mode "+ Add tile" links to `/` (chat) but is labeled like an in-place add

The button at `dashboard-topbar.tsx:235-242` reads `+ Add tile` and visually it's a primary teal button — the affordance suggests "click here to drop a new tile somewhere." Click it: navigates away from the dashboard to the chat surface entirely. The user has to start a new conversation, get a result, click "Add to Dashboard" → choose this dashboard.

The build PR explicitly defers a tile library drawer, which is fine. But the label and color overstate what happens.

**Fix (microcopy)**: `+ Add tile from chat` (one extra word, sets the right expectation). Or downgrade to `variant="outline"` so it doesn't look like the canonical primary action of the page.

### P2 — Tile footer `4 rows / 1m ago` register conflicts with the CHART/TABLE chip

`dashboard-tile.tsx:247-253`: `font-mono text-[10px]` — same register as the head's CHART/TABLE chip. Three uses of the same micro-mono register in one tile (drag-grip area, head chip, footer count) — none of them carry the same semantic. **Fix:** the footer is metadata; downgrade to `text-[11px] text-zinc-500` (not mono, not uppercase). Reserve the mono register for the chip if we keep it.

### P2 — Suggestions strip doesn't wire to the bucket-1 assistant-turn gutter pattern

`page.tsx:319-386`. The strip uses `border-dashed border-primary/40 bg-primary/5` — visually it's a "draft / preview" register, which works. But each suggestion card stacks vertically with no shared visual unit binding the suggestions to the dashboard they belong to. Bucket-1's `<AssistantTurn>` extraction (#1888) is currently waiting for a third adopter — the suggestions strip is a natural fit (it's literally an assistant proposing additions to your dashboard).

**Fix:** wrap the suggestions strip in the gutter rail. `border-l-2 border-primary/30 pl-4` around the `<div>` at `page.tsx:319-386`. That'd close #1888 in this PR.

### P2 — Save / Cancel buttons during inline title edit have no accessible name

`dashboard-tile.tsx:132-142` and `dashboard-topbar.tsx:112-117`. Same `aria-label` gap as the P0 finding above — call it out separately because it's a different code path and shouldn't slip when the tile-head buttons get fixed.

### P2 — Dashboard description has `line-clamp-1 max-w-[60ch]` but no expand affordance

`dashboard-topbar.tsx:133-137`. A long dashboard description gets clamped at one line. There's no "show more" or hover-reveal — the description is literally truncated forever unless the user opens the dashboard's edit screen. **Fix:** either drop `line-clamp-1` and let it wrap (max 2 lines is fine in the topbar), or add a `title={description}` so hover reveals the rest.

### P3 — Drop-ghost background uses primary teal at 10% opacity

`globals.css:152-157`. On a white canvas, `color-mix(in oklch, var(--primary) 10%, transparent)` is barely visible. The dashed border at 60% does most of the work. **Fix:** bump the fill to 18-22% so the ghost reads as a "you're dropping here" zone, not a faint outline.

### P3 — Drag shadow `oklch(0 0 0 / 0.4)` is heavier than other shadows in the app

`globals.css:159`. Most shadcn shadows use ~0.1 alpha. The drag shadow at 0.4 is pretty dramatic — feels theatrical for what's a small tile move. Compare to `card.tsx` `shadow-sm`. **Fix:** drop to `oklch(0 0 0 / 0.18)` or the existing `--shadow-md` token if defined.

### P3 — Tile body's "No cached data" state shows an inline icon with no label

`dashboard-tile.tsx:241-244`. `Click <RefreshCw> to load results.` — the icon has no aria-label, no surrounding `aria-describedby`. Fine in practice for sighted users; broken for everyone else. **Fix:** add `aria-label="Refresh icon"` *or* (better) replace the inline icon with the literal word "Refresh" so screen readers and sighted users get the same instruction.

### P3 — `4 TILES` chip pluralizes correctly but `0 TILES` reads strangely

`dashboard-topbar.tsx:129-131`. On the empty state the chip renders `0 TILES` which is grammatical but feels accusatory. **Fix:** hide the chip on `cardCount === 0`.

### P3 — Density `aria-pressed` says active but visual state is subtle

`dashboard-topbar.tsx:266-274`. Active density button gets `bg-background text-foreground shadow-sm`. Inactive: `text-zinc-500`. On a white background the "active = white-ish, inactive = white" distinction is the `shadow-sm` doing the differentiation, which is barely visible. **Fix:** add a 1px `ring-1 ring-zinc-300` on the active button or invert the scheme (`bg-zinc-900 text-zinc-50` for active).

## Architectural observations (defer to extraction phase)

- **`<AssistantTurn>` (`#1888`) needs its third adopter.** The suggestions strip in `page.tsx:319-386` is a natural fit — it's the AI's proposal for what to add. Wrapping it in the gutter rail (`border-l-2 border-primary/30 pl-4`) makes the AI->user causality visual. Today the chat surface and the notebook cell output use the gutter; the dashboard suggestions strip is the same shape (an "agent says: here's what I think" zone). Adopt + extract + close #1888.

- **Two empty-state components for the same surface (`page.tsx:388-400` + `dashboard-grid.tsx:117-134`)** — a clear sign the build was iterated under time pressure. The grid-level `EmptyCanvas` should be deleted (P1 above). Worth recording as a "watch out — grid-internal empty state is unreachable" comment in the architecture-wins doc so future buckets don't repeat it.

- **`dashboard-tile.tsx` (256 lines) does six things: title editing, CHART/TABLE switching, refresh, fullscreen, kebab menu, body rendering.** Right at the upper edge of single-component complexity. After Phase 2-4 lands, the title-editing inline mode (`dashboard-tile.tsx:120-148`) is a natural extract — same shape as the topbar's `titleEditing` state at `dashboard-topbar.tsx:99-128`. Two callers + a future "rename anything inline" use case = candidate `<InlineTitleEdit>` primitive (third adopter rule).

- **`auto-layout.ts:withAutoLayout`** treats `card.layout` as authoritative when present, otherwise waterfalls. That works, but the `unplacedInRun` resets to 0 every time it sees a layout-having card (`auto-layout.ts:19`). Ordering effects: a saved-layout card sandwiched between two unplaced cards splits them into different rows. Probably fine for the current usage but worth documenting as a quirk before a downstream feature relies on auto-layout being stable across saves.

- **`grid-constants.ts` + `dashboard-types.ts` mirror each other** — the comment at `grid-constants.ts:1-7` notes the deliberate duplication ("not in `@useatlas/types` because that would require an npm publish + template ref bump"). Right call given the scaffold-CI gotcha (memory note). If a third surface needs grid constants, the right move is a pure-helper module in `@atlas/api/lib/dashboard-types.ts` (already exists) re-exported via `packages/web/src/ui/lib/types.ts` — keep `grid-constants.ts` as the web-side mirror.

- **Density CSS at `globals.css:176-179` is incomplete.** Only changes per-tile padding. If we keep the three-button density, the CSS needs `--row-h` and `--gap` cascading too (P1 above). If we don't, it's a candidate to delete entirely (one fewer toggle, one fewer surface to maintain).

## Skills queue for Phases 2–4

- **Phase 2 `/distill`** — primary targets:
  - Delete dead `EmptyCanvas` in `dashboard-grid.tsx:117-134` (P1).
  - Drop the empty-state icon block in `page.tsx:390-392` (P3 echoing bucket-2 fix).
  - Drop the `0 TILES` chip rendering on cardCount === 0 (P3).
  - Collapse density to either a Compact/Comfortable binary OR fully wire it to grid rhythm (P1).
  - Decide CHART/TABLE chip vs Bar/Pie body chip — keep one (P1).

- **Phase 3 `/arrange`** — primary targets:
  - Topbar overflow-menu below `md` (P1).
  - Edit-mode canvas tinting + persistent edit chip + always-visible drag handles (P1).
  - Mobile responsive layout — `<ResponsiveGridLayout>` or single-column read-only (P0 mobile).
  - Fullscreen tile inset → 0 + opaque backdrop + focus trap (P1).
  - Suggestions strip wrapped in `<AssistantTurn>` gutter rail (P2 + closes #1888).

- **Phase 3 `/typeset`** — primary targets:
  - Tile title bump to `text-base font-semibold` (P1).
  - CHART/TABLE chip → normal `text-xs font-medium` register if we keep it (P1).
  - Tile footer downgrade from `font-mono text-[10px]` to `text-[11px] text-zinc-500` (P2).
  - Tile-count chip → `text-xs tabular-nums "4 tiles"` (P2).

- **Phase 4 `/colorize`** — primary targets:
  - Plumb teal palette through `result-chart.tsx` (P1).
  - Drop ghost fill 10% → 22% (P3).
  - Drag shadow 0.4 → 0.18 (P3).
  - Active density button — visible distinction (P3).

- **Phase 4 `/polish`** — primary targets:
  - All icon-only buttons get `aria-label` (P0 a11y, P2 echoes).
  - Drop description `line-clamp-1` or add `title=` reveal (P2).
  - "No cached data" — use word `Refresh` not inline icon (P3).

- **Phase 4 `/clarify`** — primary targets:
  - "+ Add tile" → "+ Add from chat" (P2).
  - "Press E" hint baked into edit-mode canvas tint or chip (P1).
  - Fullscreen exit: keyboard hint somewhere ("Esc to exit fullscreen") (P1).
  - Dashboard description clamp message ("show all" or hover reveal) (P2).

## Bugs to file (incidental — not in this PR's scope)

1. **Recharts collapse-to-dots inside RGL ResponsiveContainer (P0 above).** Affects every chart tile on initial load. File as `bug, area: web, area: dashboards`.
2. **Mobile dashboard detail is unreadable below `sm` (P0 above).** Will likely fix in this PR's Phase 3, but file as the underlying mobile-surface gap so any other RGL surface (future report editor?) doesn't re-hit it.
3. **`/dashboards/[id]` keyboard shortcuts (`E`, `Esc`) have no UI surface — discoverability is zero.** Filed alongside the edit-mode-distinct fix.
4. **`EmptyCanvas` in `dashboard-grid.tsx` is dead code.** Pure code-cleanup; rolls into this PR's Phase 2.
5. **`Open Next.js Dev Tools` floating issue toast appears on baseline — likely the Forecast chart's `actual` series sometimes producing NaN width on first render** (or the Recharts dots-only bug above is related to the toast). Not in scope; capture in dev-tools issue when reproducing.

(No 1867-specific bugs to file beyond these. The bulk of the work is layout / register / a11y simplification.)
