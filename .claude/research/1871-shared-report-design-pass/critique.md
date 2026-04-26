# /report/[token] — design critique (1.3.0 Bucket 4)

Rendered on `bun run dev` against three seed reports — short / standard / long.
Findings against:

- before/desktop-{short,standard,long}.png
- before/mobile-standard.png
- before/print-{standard,long}.png
- before/desktop-notfound.png

Comparing against the two prior Bucket 4 surfaces — `/shared/[token]` (PRs #1902, #1903) and `/shared/dashboard/[token]` (PR #1904) — which set the treatment pattern.

## Axis scores (1–5, before)

| Axis | Score | Notes |
|---|---|---|
| Brand coherence | 2 | No Read-only chip, no Try-Atlas-free CTA, "Generated with Atlas" footer (no outbound link), no OG image. The report looks like a different product than `/shared` and `/shared/dashboard`. |
| Information density | 3 | Title bumped, cell numbers visible, narrative + query interleave. Sparse cell numbers ([2], [3], [5]) read as a bug. |
| Hierarchy | 2 | Title h1 conditional — null title yields no h1, only h2 query cells (Lighthouse `heading-order` will flag). Query-cell h2 (`text-base`) is *smaller* than narrative h2s in `prose`, inverting the hierarchy. |
| Print readiness | 4 | `@media print` rules already exist and work; `.report-cell { break-inside: avoid }` handles tile splits. Footer link missing; chrome already hides correctly. |
| Accessibility | 1 | No `<main id="main" tabIndex={-1}>` skip-link target. Title h1 conditional (heading-order). Error pages lack chrome + skip-link entirely. `text-zinc-400` footer + empty-state text below 4.5:1. |
| Public-viewer reachability | 0 | `proxy.ts` `publicPrefixes` is missing `/report` — every anonymous viewer in managed-auth mode (SaaS production) is bounced to `/login`. Report is unreachable for its intended audience. |

Overall: 12/30. The page works, but it looks like the only public-share surface that didn't get the chat/dashboard treatment — and in production the surface is *unreachable* anyway.

---

## P0 — must fix

**P0-1 — Anonymous viewers are 307'd to /login** (proxy bug)
`packages/web/src/proxy.ts` `publicPrefixes = ["/demo", "/shared", "/api", "/_next"]` — `/report` is missing, so the surface is broken for its actual audience under managed auth. One-line fix: add `/report` to the array. Already addressed inline since without it, no `before` screenshots could be captured anonymously.

**P0-2 — No skip-link target**
The project's global skip link (`/app/layout.tsx`) is `<a href="#main">`. The report shell has no `<main>` element with `id="main"`, so keyboard / screen-reader users hitting the skip link land nowhere. Lessons baked in from #1903.
**Fix:** wrap the report-view content in `<main id="main" tabIndex={-1} className="… focus:outline-none">`. Apply to the error-state shell as well.

**P0-3 — Title h1 is conditional**
`{conversation.title && (<h1>…)}` — when title is null, the page has no h1, only query-cell h2s. Lighthouse `heading-order` flags any document whose first heading is not h1. **Fix:** always render an h1 with a sensible fallback (first user message text, or "Atlas Report").

**P0-4 — Brand-coherence drift**
- No "Read-only" chip in the header. Viewers don't know the snapshot is frozen.
- No "Try Atlas free →" CTA in the header. Each viewer is a candidate signup; chat + dashboard both have it.
- Footer reads "Generated with Atlas" as plain text — chat + dashboard both link out to `useatlas.dev` with "Powered by Atlas".

**P0-5 — Error pages lack chrome**
`Report not found` / `Connection failed` / `Unable to load report` render without the surrounding shell — no `<main id="main">`, no Try-Atlas-free CTA, no Powered-by footer. Skip-link broken on every error path. Same pattern #1904 fixed for dashboards.

## P1 — should fix

**P1-1 — Sparse cell numbers ([2], [3], [5], [6], [8], [9])**
Text cells consume sequence indices in `report-cells.ts` (`return ordered.map((cell, i) => ({ ...cell, number: i + 1 }))`) but don't render them. So a notebook with `cellOrder = ['text-intro', 'cell-1', 'text-mid', 'cell-2']` renders query cells as `[2]` and `[4]`. The visible numbering looks broken. **Fix:** number only query cells (their position among query cells, not the merged sequence), or drop the cell number entirely. Dropping is simpler and matches how external readers actually scan a report — they don't index into "cell 2", they read top-to-bottom.

**P1-2 — Inverted heading hierarchy**
Query-cell question h2s (`text-base font-semibold`) are smaller than narrative-cell h2s rendered through `prose` (whose `prose-h2` defaults are larger). Reader sees the *commentary* h2 as more prominent than the *question being answered*. **Fix:** bump query-cell question to `text-lg font-semibold`, or apply `prose-h2:text-base` to narrative cells so they match. (Bumping query cells is more honest — the question is the structural unit of the report.)

**P1-3 — `Save as PDF` button hidden on mobile**
`className="hidden gap-1.5 print:hidden sm:flex"` — mobile viewers can't trigger print. Mobile readers ARE a real audience for reports (link forwarded over Slack on a phone). **Fix:** drop the `hidden sm:flex` gate so it appears on mobile too. Pair with a "Copy link" affordance.

**P1-4 — Add OG image**
`/shared/[token]` and `/shared/dashboard/[token]` both ship `opengraph-image.tsx`. Reports unfurl as plain text. **Fix:** add `packages/web/src/app/report/[token]/opengraph-image.tsx` mirroring the dashboard pattern (teal A badge + "Shared Report" subtitle).

## P2 — polish

**P2-1 — Header chrome metadata enrichment**
Current: `Atlas · Report · {date}`. Match dashboard: `Atlas · [Read-only chip] · Captured {date}`. The "Captured" framing tells the viewer this is a frozen snapshot.

**P2-2 — Title typography**
Current title is `text-xl font-semibold sm:text-2xl`. Dashboard title is `text-2xl tracking-tight`. Match the dashboard for cross-surface consistency.

**P2-3 — Empty-state contrast**
`text-zinc-400` on `<p className="text-xs italic text-zinc-400">No output</p>` and `text-zinc-400 dark:text-zinc-500` on the footer ("Generated with Atlas"). Both fail 4.5:1 against the page background. **Fix:** bump to `text-zinc-600 dark:text-zinc-400`.

**P2-4 — Inline-injected print stylesheet**
The print stylesheet works. Slightly tightening: `.dark *` is broad — narrowing to specific selectors avoids potential cascade surprises. Out of scope for this pass (works correctly today). Leave alone unless a follow-up surfaces.

---

## Plan (treatment pattern)

`/distill` — drop the cell number column entirely and let cells flow as sequential blocks; the `[N]` chip is engineering surface, not reader value. Drop "Save as PDF" copy in favor of an icon-only Print button + "Copy link" pair.

`/colorize` — accent `Try Atlas free →` and "Powered by Atlas" with `text-teal-700 dark:text-teal-300` (passes AA per #1903 lessons). Read-only chip uses `bg-zinc-100/dark:bg-zinc-800` neutral.

`/polish` — bump empty-state + footer text to AA (`text-zinc-600 dark:text-zinc-400`). Match dashboard's `max-w-5xl` shell so 1440 desktops don't waste space, but tighten prose to readable line length via Tailwind's `prose-base`. Match title typography. Ensure h1 always renders.

`/clarify` — error states get the same shell. "Read-only" chip framing. Footer outbound text changed to "Powered by Atlas".

**Architecture** — split `view.tsx` into a server-only render and a `report-actions.tsx` `"use client"` component for the print/copy button. Keep `report-cells.ts` pure (extend/keep tests). Add `helpers.ts` only if there's something to extract — for the report surface, cell numbering rules are the candidate.

**Tests** — extend `report-view.test.ts` with cases for: (a) heading h1 always rendered, (b) cell numbers either absent or matching their position in the *query-cell-only* sequence.

**Server-only contract** — `view.tsx` renders inside an RSC; `Date.now()` runs once on server (createdAt is rendered as locale date). No hydration risk introduced. Apply the same `// server-only` banner the dashboard view has.

**Closes #1871.**
