# 1868 Shared Chat Surface — Critique

Critique of `/shared/[token]` (`packages/web/src/app/shared/[token]/page.tsx`, 175 LOC) and its OG image (`opengraph-image.tsx`). Code-only critique this round — full live screenshots require seed + dev-server + a real share token, which wasn't set up this session. The visual changes below are well-bounded enough to land without screenshot diffs, but a manual Playwright pass before merge is recommended (test plan in the PR body).

Baseline: branch `1868-shared-chat-design-pass` cut from `713d46df`.

## Headline scores (0–10, higher = better)

| Axis | Score | Note |
|---|---|---|
| Visual hierarchy | **3** | Header reads "Atlas · Shared conversation · date" then optional title. Each message is `circle avatar (U/A)` + muted-color role label *above* the content. Hierarchy inverted: the metadata is louder than the content. |
| Information architecture | **3** | Tool calls completely filtered out — viewer sees only user/assistant text. The substance of an Atlas analysis (the SQL the agent ran, the result table) is invisible. No affordance to "view full conversation" surfaces this gap. |
| Brand coherence | **2** | OG image uses an indigo gradient (`#3b82f6 → #6366f1`) — not Atlas teal (`oklch(0.58 0.185 167.71)`). Every share-link Slack/Twitter/Linear preview embeds *blue Atlas* in the public eye. Stale from before the teal retune. |
| External-stakeholder polish | **2** | No "Powered by Atlas" attribution (the embed surface has it; the canonical share doesn't). No conversion CTA — viewer has no path to try Atlas themselves. |
| Print | **0** | No `@media print` rules at all. People print these. Avatars + footer + dark backgrounds will all carry into the PDF. |
| Mobile | **6** | `mx-auto max-w-3xl px-4 py-8` is already responsive-by-default. No specific mobile bugs in code review; needs a Playwright pass to confirm. |
| Read-only cue | **3** | Header says "Shared conversation" but no chip / banner / framing tells the viewer "you can't reply here". |

Overall: **2.7 / 10**. The page is functional but plain — barely a step above a markdown blob, with stale brand colors visible to every external viewer.

## Top P0 / P1 findings

### P0 — OG image renders Atlas in the wrong brand color
`opengraph-image.tsx:37` — the avatar badge uses `linear-gradient(135deg, #3b82f6, #6366f1)` (blue → indigo). Atlas brand is teal. Every Slack / Twitter / LinkedIn / Linear preview that unfurls a share link shows *blue Atlas*. Stale from before `--primary` was retuned to teal in `globals.css`.

**Fix:** swap to teal — `oklch(0.58 0.185 167.71)` ≈ `#0d9488` (Tailwind teal-600) → `#0f766e` (teal-700) for the gradient. Match the rest of the product.

### P0 — No "Powered by Atlas" attribution
`/shared/[token]/embed/page.tsx:55-65` has it. `/shared/[token]/page.tsx` does not. This is the canonical share surface that external stakeholders see — it should have at least the same attribution density as the embed. The omission is also a missed conversion: viewers see an Atlas-rendered analysis and have no link to try Atlas themselves.

**Fix:** add a subtle bottom footer mirroring the embed pattern: "Powered by Atlas" + outbound link to `useatlas.dev`. Pair it with a "Try Atlas free →" CTA so the attribution doubles as conversion.

### P1 — Assistant text renders as `whitespace-pre-wrap`, not markdown
`page.tsx:166` — the agent's responses contain markdown (bullets, code, headings, bold, tables). Right now they all display as raw text — `**bold**` shows literal asterisks, lists render as `- one\n- two` strings, fenced code blocks lose their styling. The codebase already has a battle-tested `<Markdown>` component at `packages/web/src/ui/components/chat/markdown.tsx` that handles GFM + lazy-loaded syntax highlighting.

**Fix:** render assistant messages with `<Markdown>`. Keep user messages as plain text (asterisks the user typed should remain literal).

### P1 — No read-only state cue
The header text "Shared conversation" is metadata, not a state cue. No chip / banner / framing makes it clear the viewer can't reply. Adjacent: a viewer landing here from Slack may not even register it's a *snapshot* and not the live conversation.

**Fix:** add a small "Read-only" chip in the header alongside the date, plus reframe the metadata line to make snapshot semantics obvious ("Snapshot · {date}" or "Captured {date}").

### P1 — No print stylesheet
Issue scope explicitly calls for it. People print analysis snapshots. Today the page would print with whatever ambient theme is active — including potentially dark backgrounds — and would carry the (non-existent yet — see P0) footer / CTA chrome onto the page.

**Fix:** Tailwind `print:` variants — hide footer / CTA in print, force black-on-white via `print:bg-white print:text-black`, `break-inside: avoid` on each message block so a long message doesn't split mid-sentence across pages, drop the page padding to `print:p-0` so the print engine controls margins.

### P1 — Tool calls completely filtered from the public view
`page.tsx:121-123` — `visibleMessages = convo.messages.filter((m) => m.role === "user" || m.role === "assistant")`. The substance of an Atlas analysis is the SQL the agent ran + the result. A shared conversation that included a multi-step exploration with a final chart is reduced to "the agent's plain prose summary." Without a hint that there *was* analysis, the page understates what Atlas does.

**Fix (light, in scope):** count filtered tool/system messages; if any, render a "+ N analysis steps run — view full conversation in Atlas" footnote near the bottom that links to `/c/{conversationId}` (which prompts sign-in if the viewer isn't logged in). Doesn't expose tool detail; just signals depth.

**Fix (deep, OUT of scope):** render tool calls inline. Defer to a follow-up issue if requested.

## P2 / polish

### P2 — Avatar circles "U" / "A" read as placeholder amateur cue
`page.tsx:153-160` — single-letter avatars in colored circles are jarring next to the rest of the product (which uses no avatars in chat surfaces). Worse: the role label appears *below* the avatar in muted color, hierarchy-inverted.

**Fix:** drop avatars entirely. Use a small uppercase eyebrow label ("USER" / "ATLAS") above each message, primary-tinted for ATLAS. Content becomes the hero.

### P2 — Stale `text-zinc-500` / `text-zinc-400` muted colors
Pre-1.2.x palette. Recently we've been bumping to `text-zinc-600` for AA contrast on near-white backgrounds (see PR #1901, PR #1894). `page.tsx:101, 128, 163` use the old palette.

**Fix:** bump to `text-zinc-600 dark:text-zinc-400` where they sit on the page background.

### P2 — Date format fixed to "Apr 26, 2026" — could be relative for recency
`page.tsx:135-141`. For shares opened the same day/week, "Today" / "2 days ago" reads cleaner than the absolute date. Out of essential scope; nice-to-have.

## Out of scope (deferred)

### Workspace branding override
Issue scope mentions "workspace branding override + Atlas attribution". The workspace branding endpoint (`/api/v1/branding`, see `packages/api/src/api/routes/public-branding.ts:70-91`) resolves branding from the *session*, returns null branding for unauthenticated visitors. Public share viewers have no session, so they always get default Atlas branding regardless of what the workspace owner configured.

To support this, the public conversations endpoint (`/api/public/conversations/:token`) would need to return the owning workspace's branding alongside the conversation. That's a backend change, which the issue explicitly puts out of scope for this UI/UX pass.

**Action:** call out as deferred in the PR body. File a follow-up backend issue if the user wants to ship workspace branding on shared chat in a later release.

## Acceptance check vs #1868

- [x] `/critique` run with findings captured (this file)
- [ ] PR with before/after screenshots — partial, see PR body for the manual test plan
- [ ] Lighthouse pass — the page is server-rendered with no agent stream and `react-markdown` is the only client-side cost; Lighthouse Performance ≥ 95 should hold but needs verification post-merge

## Plan applied (next: edits to `page.tsx` and `opengraph-image.tsx`)

1. OG image: indigo → teal (`#0d9488` / `#0f766e`).
2. Header: drop the wordmark/middot/snapshot copy mishmash → reframe as "Shared from Atlas · Read-only · {date}". Add "Try Atlas free →" CTA in header right.
3. Messages: drop circle avatars; uppercase eyebrow label + content. Render assistant text with `<Markdown>`. Bump muted colors. Add `break-inside: avoid` for print.
4. Hidden-tool-runs hint: if tool calls were filtered, show a single "View N analysis steps in Atlas" link below the messages.
5. Footer: "Powered by Atlas" + outbound link to `useatlas.dev`, hidden on print.
6. Print: `print:bg-white print:text-black print:p-0`, hide footer + CTA via `print:hidden`, page-break-avoid on message blocks.
7. Empty / no-text-content: skip rendering empty messages instead of leaving blank flex rows.
