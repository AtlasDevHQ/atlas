# 1864 Chat Surface — Phase 1 Critique

Baseline screenshots: `.claude/research/1864-chat-design-pass/before/`. Captured 2026-04-25 against `main` at 84f7bfba + new branch `1864-chat-design-pass`.

States captured: empty (1440 / 768 / 375), schema explorer open (1440), prompt library open (1440), streaming-with-tool-calls (1440), in-flight conversation (1440 full-page / 768 / 375).

## Headline scores (0–10, higher = better)

| Axis | Score | Note |
|---|---|---|
| Visual hierarchy | **3** | Empty state stacks 3 competing cold-start messages. Conversation view has no rhythm — every assistant artifact is a same-weight pill. |
| Information architecture | **4** | Sidebar / chat / panels are three separate visual languages. Schema-explorer + prompt-library overlay the chat with a backdrop that dims a still-active surface. |
| Emotional resonance | **2** | Cold-start reads as bureaucratic ("we'll learn from your team's queries and surface their best starters here"), not inviting. The Niko-Niko peach avatar in the bottom-right is jarring against an otherwise muted surface and reads as a placeholder. |
| Cognitive load | **3** | Tool-call wall: the agent runs 15+ shell commands as 15+ identically-styled cards, plus 4 duplicate "Query failed" banners interleaved. Nothing collapses, nothing groups. |
| Mobile experience | **2** | At 375px the message input is half-clipped behind the avatar, conversation tool-call cards overflow the right edge, and the back-to-sidebar hamburger sits in dead space without any "Atlas" wordmark. |

Overall: **2.8 / 10**. The chat surface has features but no design. This pass is high-leverage precisely because the gap is so wide.

## Top P0/P1 findings

### P0 — Avatar collides with chat input on mobile

`before/mobile-375-empty.png` and `before/mobile-375-result.png`. The peach-island avatar in the bottom-right (Niko-Niko or onboarding tour anchor?) overlaps the right edge of the chat input textarea AND the send button at 375px. Half the input placeholder ("...a question about your data...") is hidden by the avatar. **Fix:** the avatar must not float above the input on small viewports, or the input needs right-padding equal to avatar width + 12px on `<sm`.

### P0 — "Query failed" banners spam between tool calls

`before/desktop-1440-result.png`. Four distinct identical banners appear interleaved with explore tool calls. Generic copy ("Query failed. Check the query and try again.") gives no information about which query failed or what to try. **Fix:** dedupe consecutive identical errors into one collapsed banner ("3 failed queries" + expand). Include the failing tool name + first 200 chars of the error in dev mode. Move from a wide red bar to an inline tool-call status — failed `executeSQL` should style its own card red, not insert a separate banner row. *Also:* file as a bug — the duplicate banners may be a render bug where every retry re-pushes a banner without tearing down the previous one.

### P1 — Empty state stacks three competing messages

`before/desktop-1440-empty.png`:
1. "What would you like to know?" (h2)
2. "Ask a question about your data to get started" (subtitle)
3. "Ask your first question below — we'll learn from your team's queries and surface their best starters here." (paragraph)

Plus the sidebar's *fourth*: "No conversations yet / Ask a question to get started." That's four ways of saying the same thing on one screen. The 1.2.1 adaptive starter-prompt grid should appear here in cold-start mode but does not — verify the cold-start path is actually wired to render starter prompts when none exist yet. **Fix:** drop to one cold-start headline + the starter-prompt grid (and confirm grid renders for fresh accounts). Remove the third paragraph — it's defensive marketing copy that disappears the moment any starter prompts exist.

### P1 — Tool-call cards lack hierarchy or grouping

`before/desktop-1440-result.png`. Each `$ ls`, `$ cat`, `$ grep` is its own full-width card. 15+ stacked. No way to collapse "exploration phase" into a single fold-down. **Fix:** group consecutive same-tool calls under one expandable "Explored 6 files" line. The agent typically does a discovery burst; users care about the result, not each grep flag. Bring in the 1.1.0 notebook fork-gutter pattern — vertical rail on the left margin marking the run's phase boundaries.

### P1 — Schema explorer + prompt library both overlay the chat without keyboard-trap awareness

`before/desktop-1440-schema-explorer-open.png` + `desktop-1440-prompt-library-open.png`. Both panels open as a right-side dialog with a backdrop dimming the chat. But the chat input remains visible and (presumably) focusable underneath. Need to verify focus-trap and Esc-to-close behavior — likely an accessibility violation. **Fix:** either make these proper modal dialogs with focus trap and aria-modal, or make them a side-rail that pushes the chat content rather than overlaying it (likely the better UX — schema reference should be glanceable while typing).

### P1 — Tool-call cards clip on tablet and mobile

`before/tablet-768-result.png` + `before/mobile-375-result.png`. At 768 the right edges of `$ grep -ri 'connection|source|schema|database' entities/*.yml` are cut off; at 375 the same cards bleed past the viewport entirely. **Fix:** tool-call code blocks need horizontal scroll within the card, not card overflow. Add `overflow-x-auto` + sticky chevron so the user knows there's more.

### P2 — Persistent peach avatar reads as placeholder

`before/desktop-1440-empty.png`. The avatar lives in the bottom-right corner across every state (empty, streaming, result, overlay). It's circular, peach/coral, and shows what looks like a tropical island. No one has explained what it is, but it's positioned where help-widgets and chat-bubbles usually sit — implying interactivity. Click target appears unlabeled. **Fix:** if this is the GuidedTour anchor, label it "Help & tour" with a proper icon (life ring / question mark). If it's just decoration, remove it — it's adding visual noise without conveying purpose.

### P2 — Top-bar wordmark is a single letter "A" in a square + the word "Atlas"

`before/desktop-1440-empty.png`. The "A" icon is teal but with the wordmark next to it, the letter is redundant. Either is fine alone; together they look like the brand mark forgot to render. **Fix:** drop the letter mark when the wordmark is shown; reserve the letter mark for collapsed nav / mobile.

### P2 — Mobile nav lacks any branding

`before/mobile-375-empty.png`. The 375px header shows just an icon strip and the same "A | Atlas | (?)" cluster on the right. The hamburger is on the *left*. The chat icon button is to the right of the hamburger. There's no clear "you are here" cue for which surface you're on. **Fix:** put the Atlas wordmark or breadcrumb ("Atlas / Chat") in the mobile header, drop the redundant chat icon since the user is already there.

### P3 — Sidebar "All" / "Saved" tabs use radio styling

`before/desktop-1440-empty.png`. They render as two buttons in a segmented group but their behavior is single-select tab switching. Radios suggest "pick one filter to apply" rather than "switch view." **Fix:** use proper Tabs primitive; align to existing admin-revamp `CompactRow`/queue tab patterns where applicable.

### P3 — User message bubble is a teal pill at top-right

`before/desktop-1440-result.png`. After the agent responds, the user message scrolls up and out of view. **Fix:** option A — sticky-pin the active question while streaming; option B — put a "you asked: …" caption above each agent answer block; option C — anchor the question above the answer with a thin connector line. The 1.1.0 notebook treats this elegantly with the gutter — borrow it.

### P3 — "Share" button only appears mid-conversation, has no icon affordance for what it shares

`before/desktop-1440-streaming.png`. The Share button materializes once a conversation exists but its icon is a generic "broadcast" symbol. **Fix:** distinguish "share this conversation" from "add to dashboard" (which is a separate icon button next to it but visually identical). Probably needs a dropdown.

## Architectural observations (defer to extraction phase)

- **`packages/web/src/ui/components/chat/result-card-base.tsx`** — already exists as a primitive (101 lines). Audit whether sql-result-card / python-result-card / explore-card actually use it consistently, or whether each invented its own padding.
- **`tool-part.tsx` (64 lines)** is doing the dispatch from AI-SDK tool-call parts to the right card. It's the natural seat for the "group consecutive same-tool calls" logic.
- **`error-banner.tsx` (139 lines)** is unusually large for what it shows — that's where the dedup + actionability fix should land.
- **`conversation-sidebar.tsx` (142 lines)** + `conversation-list` + `conversation-item` is structured like the admin queue components. May share primitive opportunities with `packages/web/src/ui/components/admin/queue/`.

## Skills queue for Phase 2–4

- Phase 2 `/distill` — primary targets: empty state copy stack, error banner duplication, redundant icon-mark + wordmark in nav, the peach avatar.
- Phase 3 `/arrange` — tool-call grouping rail, sticky user message during streaming, three-column rhythm. `/typeset` — unify code/SQL register vs assistant-text register vs tool-label register.
- Phase 4 `/colorize` — keep teal for primary actions, but tool-call cards should desaturate (currently green-on-white feels celebratory for what's just exploration). `/polish` — focus rings on the panel close buttons, schema-explorer typography. `/clarify` — error banner microcopy, empty-state headline, share button label.

## Bugs to file (incidental — not in this PR's scope)

1. **Duplicate "Query failed" banners** — likely a render bug where consecutive failures push without dedup. *(Will file separately.)*
2. **Mobile avatar overlaps chat input** — covered above, file as area: web bug.
3. **Cold-start starter-prompt grid (1.2.1) doesn't render in empty state** — verify whether the cold-start path is wired. *(Already noted in P1 above; file separately if confirmed.)*

(Plus the already-filed #1882 — dev seed `emailVerified=false` blocks login, discovered during Phase 0 setup.)
