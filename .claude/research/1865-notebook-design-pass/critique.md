# 1865 Notebook Surface — Phase 1 Critique

Baseline screenshots: `.claude/research/1865-notebook-design-pass/before/`. Captured 2026-04-25 against `main` at 60b456a1 + new branch `1865-notebook-design-pass`.

States captured: empty (1440 / 768 / 375), single-cell w/ failure repetition (1440), cell with toolbar + cell-row hover state (1440), cell editing (1440), cell collapsed (1440), text cell editing + rendered (1440), fork branch view (1440), root w/ fork-gutter dot (1440), tablet cells (768), mobile cells (375).

The notebook borrows heavily from the chat surface — it imports `ToolPart`, `Markdown`, `TypingIndicator`, and renders the same `SQLResultCard` / `ExploreCard`. So most of the 1864 chat findings replay here, with two notebook-specific overlays: cell chrome (per-cell toolbar, drag handle, number badge) and the fork machinery (gutter dot + branch selector).

## Headline scores (0–10, higher = better)

| Axis | Score | Note |
|---|---|---|
| Visual hierarchy | **3** | Cell head packs five things into one row (drag handle, number badge, question, chevron, 6-button toolbar) — the question (the actual content) is the *fourth* most prominent item. Output area is undifferentiated from the head. |
| Information architecture | **3** | Notebook borrows chat-surface output verbatim, so the same SQL-failure repetition lands here uncollapsed. Sidebar duplicates branches as siblings of their root, telling a different story than the in-page branch selector. The empty-state copy stack is identical to chat (3 redundant messages). |
| Emotional resonance | **2** | The starter-prompt grid is missing on a fresh notebook (cold-start fallback shows). Generic NotebookPen icon in a gray rounded square reads as a placeholder. The peach avatar from chat persists here too — same purpose unclear, same overlap on mobile. |
| Cognitive load | **2** | A single cell with a discovery burst stacks 12+ tool-call rows + 5 identical "companies not in allowed list" failure cards. `notebook-cell-output.tsx` calls `ToolPart` without the `repeatedCount` it already accepts, so the dedup we shipped for chat is silently absent. |
| Mobile experience | **2** | Cell question wraps to four lines at 375 because the 6-button toolbar dominates the right side of the cell head. Tool-call cards overflow horizontally — the page itself gets a horizontal scrollbar. Avatar overlaps the input. |

Overall: **2.4 / 10**. Lower than chat (2.8). The notebook adds cell chrome on top of an already-busy assistant output, then strips back the dedup that made chat tolerable.

## Top P0/P1 findings

### P0 — SQL-failure dedup is not wired into the notebook

`before/desktop-1440-single-cell.png`. Five identical "Count the total number of distinct companies… Table 'companies' is not in the allowed list." cards stack in Cell 1, with verbatim SQL each time. The fix from 1864 lives at `packages/web/src/ui/lib/sql-failure-dedup.ts:22` (`computeSqlFailureDedup`). `ToolPart` (`packages/web/src/ui/components/chat/tool-part.tsx:24`) already accepts `repeatedCount` and `SQLResultCard` already renders the badge.

What's missing: `packages/web/src/ui/components/notebook/notebook-cell-output.tsx:48-57` walks `assistantMessage.parts` and calls `<ToolPart key={i} part={part} previousExecution={previousExecution} />` without computing the dedup map. **Fix:** call `computeSqlFailureDedup(assistantMessage.parts)` once at the top of the component, skip rendering `failureRuns` indices in `skipFailureIndex`, forward `failureRuns.get(i)` to `ToolPart` as `repeatedCount`. Pure reuse — no new component, no new state. Drops the 5-card pile to a single card with a "Tried 5 times" badge.

### P0 — Tool-call cards overflow horizontally on mobile and tablet

`before/mobile-375-cells.png` shows a horizontal scrollbar at the document level (the entire page scrolls) because `$ grep -ri 'connection|source|schema|database' entities/*.yml` doesn't truncate or wrap inside its `ExploreCard`. `before/tablet-768-cells.png` clips the same line. **Fix:** `ExploreCard` (and any other tool-call card with raw shell text) needs `overflow-x-auto` on its code container so horizontal scroll stays inside the card. Ideally same fix as the chat-surface version — and if `ExploreCard` is shared between chat and notebook (it is), the fix lands once and helps both surfaces.

### P0 — Question wraps to 4 lines at 375 because the cell toolbar sits inline

`before/mobile-375-cells.png`. The cell head is `flex items-start gap-3` with drag handle + number badge + question (`min-w-0 flex-1`) + chevron + 6 toolbar buttons. The question gets ~120px of horizontal space ("How / many / companies / are there?"). **Fix:** at `<sm`, drop the always-visible toolbar buttons into an overflow menu (kebab) so the question gets the full row width. The toolbar already has `opacity-0 group-hover` desktop behavior — on touch devices there's no hover anyway, so the kebab is also better UX than buttons that never reveal.

### P0 — Persistent peach avatar overlaps the input on mobile (same as chat — file as bug)

`before/mobile-375-cells.png` and `mobile-375-empty.png`. The avatar floats bottom-right and at 375 it covers ~half the right side of the input area + half the help text. Same root issue as the chat-surface bug noted in 1864 — should already be filed; if not, file. The notebook hits it just as hard. **Fix:** lives in the GuidedTour avatar component, not in the notebook — but the notebook PR can adopt the chat-side fix once it lands, or note it as a shared follow-up.

### P1 — Empty state stacks three competing cold-start messages (same as chat)

`before/desktop-1440-empty.png`:
1. "Start your analysis" (h2)
2. "Pick a starter prompt or type a question below to create your first cell." (subtitle)
3. "Ask your first question below — we'll learn from your team's queries and surface their best starters here." (cold-start cold-cold-start)

`notebook-empty-state.tsx:42-72` builds this stack; the third message is hard-coded as `coldStartMessage` to `<StarterPromptList>`. **Fix:** drop the subtitle entirely — the h2 already says it. Surface the starter-prompt grid when prompts exist; reduce the cold-start message to one terse line ("No starters yet — your first question seeds the suggestion list."). Same playbook as the 1864 chat fix.

### P1 — Cell head crams 5 zones into one row, none with hierarchy

`before/desktop-1440-cell-toolbar-visible.png`. From left to right: drag handle (`::`) → number badge (`1`) → question text → chevron → pencil → play → copy → "What if?" → trash. That's 9 interactive elements in the cell head plus the question itself. Three problems:
- The question — the entire reason a reader is here — is the **third** zone with **default** typography weight (`text-sm font-medium text-zinc-900`), competing with a same-size monospace number badge.
- "What if?" gets the *only* labeled button on the row (every other action is icon-only). It earns an entire word in the toolbar despite being one of seven actions, because forking is the 1.1.0 hero feature.
- The hover-only toolbar means new users have no way to discover the actions until they accidentally hover the right area.

**Fix:** the question should be the dominant element in the row — bump to `text-base font-semibold` and let it claim the available width by collapsing the toolbar to a kebab on viewports < lg, keeping only "Run" and "What if?" in the row at lg+. The number badge stays but moves to a quieter style (left-margin label, not a chip). The drag handle becomes margin-only (no chip background) and reveals on cell hover, not on row enter.

### P1 — Text cells are visually too quiet

`before/desktop-1440-text-cell-rendered.png`. The text cell uses a `border-dashed` border and `bg-zinc-50/50` to distinguish itself from a query cell. Once a text cell is full of rendered markdown, the dashed border looks like a "this cell is unfinished" indicator rather than "this is documentation." The cell head also has a `T` icon + the literal word "Text" — both telling the same story.

**Fix:** drop the border entirely on rendered text cells (only show the dashed border in *editing* mode as the focused-edit signal). Drop the `T` icon **or** the "Text" label — keep one. Once edited, a text cell should read as paragraph content embedded in the notebook flow, not as a faint placeholder rectangle.

### P1 — "What if?" labeled, "Edit / Run / Copy / Delete" iconic — inconsistent toolbar register

`before/desktop-1440-cell-toolbar-visible.png` — the toolbar reads as 4 icon buttons → 1 wide labeled button → 1 icon button. The labeled "What if?" is distinctive (it's the headline 1.1.0 feature) but its visual treatment in the toolbar conflicts with the iconic register of every other action. Two bad outcomes: it pulls disproportionate attention, and it crowds the question text on smaller viewports.

**Fix:** keep the prominence — fork branching is the headline 1.1.0 feature and deserves to be discoverable — but solve the inconsistency. Two options:
- (A) Match register: "What if?" becomes a `GitBranch` icon-only button with the existing tooltip already in place.
- (B) Promote: pull "What if?" out of the toolbar entirely into a single visible pill below the question, only after the cell has output (today's `hasOutput` gate). Lets it stay labeled and discoverable without crowding.

I'd take (B) — fork is *the* 1.1.0 hero, the cell-toolbar shouldn't bury it among CRUD actions.

### P1 — Branch selector + sidebar tell incompatible stories about forks

`before/desktop-1440-fork-branch.png` shows the in-page branch selector ("Fork from cell 1 (2 total)"). `before/desktop-1440-fork-gutter.png` shows the root with a tiny gutter dot at the cell margin, and the sidebar shows TWO entries: "How many companies are there?" (root) and "How many companies are there? (for…" (truncated, presumably "(forked)"). Same content, two list rows, no visual pairing.

**Fix:** keep the branch selector as the in-conversation source of truth. Stop showing fork branches as siblings in the sidebar — either nest them under the root (collapsible) or hide them entirely from the sidebar, since the branch selector already exposes them. Today's behavior is the worst case: duplicate work to keep mental track of, with truncation that hides the disambiguator.

### P2 — Notebook toolbar (Text Cell / Share / Export) only renders when cells exist

`before/desktop-1440-empty.png` has no toolbar; `before/desktop-1440-cell-with-toolbar.png` has it. Reasonable in principle, but it means a fresh notebook gives no visual hint that text cells, exports, or sharing exist. **Fix:** show a minimal toolbar even on empty state with the buttons disabled and tooltips ("Add cells to enable export"). Or: fold "Text Cell" into the empty-state copy as a CTA so it's discoverable on day one.

### P2 — Branch selector pill takes a full row above the cell toolbar

`before/desktop-1440-fork-gutter.png`. Layout stack (top → bottom): error banners → branch selector → notebook toolbar (Text Cell / Share / Export) → cells. Three thin horizontal pills competing for the same 80px of header space. **Fix:** merge the branch selector into the notebook toolbar row — left side: "Main (2 total) ▾  +Text Cell"; right side: "Share / Export". One row instead of two.

### P2 — Sidebar branch label truncates the disambiguator

`before/desktop-1440-fork-branch.png`. "How many companies are there? (for…" — the user can't tell if this is "(forked)", "(for cell 1)", or some other label without hovering. Same problem as the queue-row pattern from bucket 1: tooltip-only disambiguators fail on touch and on a glance. **Fix:** if branches stay in the sidebar, the second line of the row (the "1h ago / just now") should carry the branch label or the fork-point cell number — never put the disambiguator in the truncated first line.

### P3 — Code-cell head uses `border-b border-zinc-100`; output region has none

The cell-head/output divider is a thin gray rule but there's no equivalent rule between consecutive cells of a different type. `space-y-4` on the parent gives breathing room but no rhythm. **Fix:** consider letting `space-y-2` between same-type runs (tighter) and `space-y-6` between query-after-text or text-after-query runs (looser). Cells of different types should *feel* like a section change.

### P3 — Empty state's NotebookPen icon competes with the h2

The 64×64 zinc-100 box with a `NotebookPen` glyph sits above "Start your analysis." It adds nothing — the h2 alone says it. The icon would help if it visually anchored the brand or if it was illustrative; instead it reads as Bootstrap-era empty-state cliché.

**Fix:** drop the icon block entirely, or turn it into a subtle teal-tinted accent (`bg-primary/10`, primary-tinted glyph) so it feels like a brand cue rather than a placeholder.

### P3 — `previousExecution` and execution metadata never visibly appear in baseline

`packages/web/src/ui/components/notebook/notebook-cell-output.tsx:18` accepts `previousExecution: { executionMs?: number; rowCount?: number }` and forwards it to `ToolPart` → `SQLResultCard` for "compare against last run" badges. None of the baseline shots surface this — meaning either it's a transient signal that disappears too fast (30s auto-clear per `types.ts:25`) or it's not styled distinctively. Worth re-running with a successful query to verify the styling is legible. Filed under P3 because we couldn't observe it; if the styling is invisible, this gets a P1 follow-up.

## Architectural observations (defer to extraction phase)

- **Chat assistant-turn gutter rail (`border-l-2 border-primary/30 pl-4`)** at `packages/web/src/app/page.tsx:436` — the natural visual unit in the notebook is **a query cell's output region** (one Q + one A). Today it's a flat space-y-2 stack; the chat-side gutter rail visually anchors the answer to the question. Adopting it inside `<NotebookCellOutput>` would be the **third adopter** (chat surface = first, possibly tool-call grouping = second after the bucket-1 follow-up). That triggers the 3-adopters rule — extract to `packages/web/src/ui/components/chat/assistant-turn.tsx` or similar.

- **`computeSqlFailureDedup` from `packages/web/src/ui/lib/sql-failure-dedup.ts`** — pure helper, already shipped. Notebook is the second consumer.

- **`SQLResultCard` `repeatedCount` prop** — same. Already wired through `ToolPart`. Notebook just stops short of computing the dedup map.

- **`notebook-shell.tsx` (357 lines)** — at the upper edge of single-component complexity. Notebook toolbar (Share / Export / Text Cell) is a candidate to extract once the branch-selector-merge from P2 lands, since the merged row will pull in branch-selector logic too.

- **`notebook-cell-toolbar.tsx`** — keeps 6 buttons in a flex row with no overflow strategy. After the kebab fix from P0-mobile, this becomes a `Toolbar` + `OverflowMenu` primitive — re-usable elsewhere (e.g. the queue-row patterns from `packages/web/src/ui/components/admin/queue/`).

## Skills queue for Phase 2–4

- **Phase 2 `/distill`** — primary targets: empty-state copy stack (drop subtitle, slim cold-start), text-cell border + redundant `T` icon + "Text" label, cell-head register (number badge + drag handle simplification), notebook-toolbar / branch-selector row merge.
- **Phase 3 `/arrange`** — chat assistant-turn gutter rail in `NotebookCellOutput`, kebab toolbar at `<sm`, single-row branch + toolbar layout. **`/typeset`** — bump the cell question to `text-base font-semibold` so it dominates the head, normalize labels (one wordmark for cell-type, not two).
- **Phase 4 `/colorize`** — keep teal for `Run` and the `<sm>+Plus button` and "What if?" promotion (B). Failed-state cards stay red but should soften when they're the *deduped* card (one-time per failure) rather than every individual occurrence. **`/polish`** — cell hover/focus rings, branch-selector dropdown alignment, sidebar branch-label disambiguator. **`/clarify`** — empty-state cold-start copy, "What if?" tooltip → "Branch from this cell to explore an alternative direction" (already this — keep it terse).

## Bugs to file (incidental — not in this PR's scope)

1. **Sidebar shows root + fork as flat siblings** — duplicate-label rows hide branch relationship; truncation cuts the disambiguator. Likely a `conversation-sidebar` issue, not notebook-specific.
2. **Tool-call card horizontal overflow** — leaks page-level horizontal scroll on mobile/tablet. Lives in `ExploreCard` (`packages/web/src/ui/components/chat/`), shared with chat — fix once, both surfaces benefit.
3. **Peach avatar overlaps input on mobile** — same as 1864. If not already filed, file once and reference from both PRs.
4. **`previousExecution` rerun-comparison badge** may be invisible — couldn't reproduce in baseline. Verify in Phase 5; file separately if styling makes it unreadable.

(No 1865-specific bugs to file beyond these — the bulk of the work here is reuse + chrome simplification, not bug-finding.)
