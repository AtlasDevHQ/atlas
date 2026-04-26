# `/shared/[token]/embed` — design critique (issue #1869)

Run inside Atlas dev stack against `demo-share-token-1868` (a 5-message chat, 3 visible after tool-message filtering). Captured at `before/desktop-bare.png`, `before/mobile-bare.png`, `before/desktop-iframe-light.png`, `before/desktop-iframe-dark.png`, `before/mobile-iframe-light.png`. Lighthouse JSON in `before/lighthouse.json`.

## Axis scores (1–5; 5 = ship)

| Axis | Score | Notes |
|---|---|---|
| Brand coherence | 1 | Pale-teal `bg-primary/15` avatars, raw `**markdown**`, no Atlas wordmark in header — embed reads as "third-party widget" not "Atlas" |
| Information density | 2 | Markdown not rendered: tables, headings, bold, lists all as raw text — kills the entire value prop of an embedded analysis |
| Hierarchy | 1 | Zero headings on the page (no h1 ever rendered, even when `convo.title` is set) — Lighthouse `heading-order` is N/A; AT users get no landmark |
| Accessibility | 2 | 4 contrast violations (zinc-400 labels + footer); no `<main id="main">` skip-link target; no `aria-label` on message turns |
| Embed-context fit | 3 | Already does the right things: no header CTA, no Try-Atlas-free pushiness, no hard-coded theme — but the host's dark theme isn't respected (iframe stays white inside dark Acme partner shell) |
| Read-only state cue | 1 | No "Read-only" indication — viewer of an embedded chat can't tell whether it's a snapshot or interactive |
| Mobile (375 inside iframe) | 3 | Single-column, no horizontal scroll, but the U/A avatar + role label + content create three columns of width drain; markdown failure compounds the readability loss |
| Print | 0 | Zero print stylesheet — partner page that prints with the embed visible surfaces all the embed chrome (footer, role bubbles), no paper-friendly fallback |

## P0 — must fix

1. **Markdown renders as raw text.** `whitespace-pre-wrap` shows `## Top 10 customers`, `**Acme Corp**`, and full table syntax verbatim. The chat surface fixed this in #1902 by routing assistant content through `<Markdown>` from `@/ui/components/chat/markdown`. The embed must do the same.
2. **No h1, ever.** Even when `convo.title` is set the page never renders one. Heading order is broken at the root. Match the chat-surface pattern: render h1 with fallback (title → first-user-message → "Atlas Conversation"), `sr-only` on it so the embed visual is still chrome-light but AT can land.
3. **`<main id="main" tabIndex={-1} focus:outline-none>`** for the global skip link target (lesson from #1903). Without this, the project's `<a href="#main">` skip link lands nowhere when the embed is the focused frame.
4. **Color-contrast: 4 violations.** Three `text-zinc-400 dark:text-zinc-500` role labels (3.4:1 light) + one `text-zinc-400` "Powered by Atlas" footer link (3.4:1 light). Swap to `text-zinc-600 dark:text-zinc-400` (5.74:1 light / 7.78:1 dark).

## P1 — should fix

5. **Read-only chip.** Tiny `Read-only` pill in the header so a viewer scrolling through an embedded chat knows it's a snapshot (matches chat / dashboard / report). Embed contract still rules out "Try Atlas free" or noisy chrome — keep the chip muted: `text-[10px]` zinc-100 bg, paired with the Atlas wordmark.
6. **Atlas wordmark in header instead of avatar bubbles.** The current `U` / `A` colored avatar approach is unique to embed (chat / dashboard / report all dropped them in their respective passes for the eyebrow-label pattern). Same eyebrow `User` / `Atlas` (uppercase, tracking-wider) + `text-teal-700 dark:text-teal-300` accent on Atlas. Header gets a subtle "Atlas" wordmark + dot + Read-only chip — minimal, attributable, not pushy.
7. **No Try-Atlas-free CTA inside the iframe.** Confirmed correct: embed is rendering inside someone else's product (Acme Analytics in our harness). A pushy CTA in the partner UX is a contract break. Keep the bare-URL fallback (when someone pastes the embed URL directly) clean too; minimal "Powered by Atlas" wordmark in the footer is enough — viewers who want Atlas can click through.
8. **Mobile 375 mid-scroll cut-off.** Mobile capture above shows the user message scrolled off the top — the `ScrollAnchor` jumps to the end on mount, so a small iframe height immediately hides the question. For an embed at 640px height, this means a viewer arrives at the end of a long answer without seeing the question. Smarter: scroll to top of the *first message* (or no scroll at all) so the conversation starts at the beginning — the partner's iframe sizing should already give the viewer the right initial scroll. Drop the auto-scroll-to-end.
9. **Print stylesheet (defensive).** A partner page that prints with the embed visible inherits its layout. Drop `print:hidden` on the avatar role bubbles (already gone post-eyebrow-pattern) and the footer wordmark; `print:bg-white print:text-black` on the shell.
10. **Theme inheritance.** The dark host wrapper still framed a white embed — the embed page hardcodes `bg-white` semantics via Tailwind defaults. Tailwind's `dark:` modifier reads from a `<html class="dark">` ancestor, but inside an iframe the `<html>` is the embed's own. Expose a `?theme=dark` query param so partners can pass through their theme; default to `light`. Out of scope to add full system-preference auto-detect this round.

## P2 — nice to have

11. **Theme tokens for partners (deferred).** A `?theme=dark|light` switch covers 90% of cases. Auto-detect via `prefers-color-scheme` inside the iframe is unreliable — many partner shells override system preference. Hold off.
12. **Inter-frame sizing (deferred).** Auto-resize via `postMessage` is referenced in #1869's scope but is risky cross-origin and adds postMessage attack surface. The current "fits within whatever height the partner sets" behavior is fine; a vertical scrollbar inside the iframe is acceptable. The widget host (separate package) handles auto-resize for its own consumers.
13. **OG image — not applicable.** Embeds aren't shared as social cards directly. Skip.

## Plan (in distill / colorize / polish / clarify order)

### Distill — strip what doesn't belong
- Remove U / A avatar bubbles — replace with eyebrow-label pattern from the chat surface
- Drop the auto-scroll-to-end on mount; conversation starts at the top
- Remove the `<ScrollAnchor>` client island entirely (no longer needed) — saves the JS payload too

### Colorize — minimal teal accent
- Atlas wordmark in header `text-zinc-900 dark:text-zinc-100` (just the brand name; no logo)
- Atlas eyebrow `text-teal-700 dark:text-teal-300` on assistant turns
- User eyebrow stays `text-zinc-500 dark:text-zinc-400`
- Read-only chip: `bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300` — same pattern as chat surface but smaller (`text-[10px]`)

### Polish — reduce visible chrome
- Header: `Atlas · Read-only` only, no date inside the iframe (partner already provides context). Captured-date stays in the bare-URL fallback.
- Body: `text-zinc-900 dark:text-zinc-100` for content text; `<Markdown>` for assistant turns.
- Footer: `Powered by Atlas →` links to `useatlas.dev` (small, zinc-600/400, opens in new tab). One line, not a button.
- Server-only banner on `page.tsx` (`// server-only` comment) so the file remains an RSC.

### Clarify — labels, ARIA, structure
- `<main id="main" tabIndex={-1} focus:outline-none>` wraps content
- h1 always rendered, `sr-only` so the visual chrome stays minimal but AT users get the landmark; falls back: `convo.title` → first-user-message → "Atlas Conversation"
- `<article aria-label="User message" | "Atlas response">` per message turn
- `<time dateTime={...}>` on the captured date in bare-URL fallback only
- Theme query param: `?theme=dark` adds `dark` class to the embed root

## Tests to add / update
- Existing `shared-embed.test.ts` covers `lib.ts` utilities only — no rendering tests on the embed page itself. Add page-level tests in `shared-embed.test.ts` (or a sibling `shared-embed-page.test.tsx`):
  - h1 always rendered (sr-only) with title fallback chain
  - `<main id="main">` present
  - Markdown content rendered for assistant turns
  - No "Try Atlas free" CTA on the page (contract: no pushy CTA inside iframe)
  - "Powered by Atlas" wordmark present in footer
  - Theme query param: `?theme=dark` adds `dark` class
- Tests for the message-rendering branch live in the page component, so they need `react-dom/server` `renderToString`. Match the convention used by report-view tests if those exist.
