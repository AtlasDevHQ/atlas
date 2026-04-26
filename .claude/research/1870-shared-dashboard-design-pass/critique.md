# /critique — `/shared/dashboard/[token]` (1.3.0 Bucket 4)

Surface: public read-only dashboard view at `/shared/dashboard/[token]`.
Method: Playwright at desktop 1440 + mobile 375 + injected-print + Lighthouse desktop. Three seeded tokens cover empty / single-tile / many-tile (six tiles, mixed chart types). Plus the not-found error path.

Files in scope:
- `packages/web/src/app/shared/dashboard/[token]/page.tsx`
- `packages/web/src/app/shared/dashboard/[token]/view.tsx`
- (no existing `opengraph-image.tsx` — gap)

Reference: `packages/web/src/app/shared/[token]/page.tsx` already shipped this treatment for shared chat (#1902 + #1903). The dashboard surface is the exact analogue; the same chrome should apply.

## Axis scores (1–5)

| Axis                | Before | Notes |
|---------------------|--------|-------|
| Brand coherence     | 2 | No "Powered by Atlas" footer. No "Try Atlas free →" CTA. No OG image at all (chat has one). Chart series default Recharts blue, not Atlas teal. |
| Information density | 3 | Single 4xl column wastes ≥40% of a 1440 desktop. Saved tile layouts (`w=12,h=3` halves) are ignored — every tile renders full-width regardless. |
| Hierarchy           | 2 | `text-xl` title is the same scale as a card heading. No "last refreshed" indicator at the dashboard level. Header line `Atlas · Shared dashboard · 6 cards` reads neutral, no read-only cue. |
| Mobile              | 3 | Single column already, so it doesn't break — but tile cards lack a print-friendly fallback and tables overflow horizontally on 375 with no visible scroll affordance. |
| Print               | 1 | Zero `print:*` classes. Identical to screen. Tiles split mid-canvas. CTA/attribution print too. |
| Refresh affordance  | 2 | Per-tile "X mins ago" exists but the dashboard has no aggregate freshness signal. Aggregate `lastRefreshAt` is on the wire but unused by the view. |
| Empty state         | 1 | Single line of zinc-400 text saying "This dashboard has no cards yet." No icon, no explanation, no CTA. |
| Accessibility       | 2 | Lighthouse 0.91. `text-zinc-400` on the timestamp fails contrast. Skip-link target missing (`#main` href, no `id="main"` element) — same regression class as #1868 / PR #1903. |

## Lighthouse before (dev mode)

| Metric                | Score |
|-----------------------|-------|
| Performance           | 0.41  |
| Accessibility         | 0.91  |
| color-contrast        | 0 (fail × ~6 — every "X mins ago" `<span>`) |
| skip-link             | 0 (skip link not focusable; `#main` target absent) |
| Best Practices        | 1.00  |
| SEO                   | 0.82  |

Performance is dev-mode (unminified, source maps). The accessibility number is the action item.

## Findings

### P0 — accessibility

**P0-1. Timestamp contrast fails AA.** `text-zinc-400 dark:text-zinc-500` on near-white = ~3.0:1, fails 4.5:1 for normal-weight 12px text. Six instances on the many-tile dashboard, one per card. Swap to `text-zinc-600 dark:text-zinc-400` (matches the chat surface from #1903, AA-pass).

**P0-2. Skip-link target absent.** Global skip link is `<a href="#main">`. The page has no `<main>` element with `id="main"` — keyboard / SR users hitting Skip-to-content land nowhere. Same bug as #1868 (PR #1903). Wrap content in `<main id="main" tabIndex={-1} className="... focus:outline-none">`.

### P1 — surface chrome

**P1-1. No "Powered by Atlas" footer.** Every other public surface (shared chat, embed) has it. External viewers — the whole point of the surface — get zero brand reinforcement at the bottom. Mirror the chat footer verbatim.

**P1-2. No "Try Atlas free →" CTA.** Same logic as chat (#1902): every viewer of a shared dashboard is a candidate signup. Header-right CTA, `print:hidden`, `text-teal-700 dark:text-teal-300`.

**P1-3. No OG image.** Chat has one (`packages/web/src/app/shared/[token]/opengraph-image.tsx`); dashboard doesn't. Slack / LinkedIn / Twitter unfurls embed default OG instead of a branded card. Add the same teal-A-badge pattern with "Shared Dashboard" subtitle.

**P1-4. No "Read-only" chip.** External viewer needs immediate clarity that this is a snapshot, not the live working dashboard. Header chip + "Captured {date}" matches chat.

### P1 — print

**P1-5. Zero print stylesheet.** People print dashboards. Today the printout includes the CTA, footer, hover affordances, and tiles split mid-chart. Apply:
- `print:bg-white print:text-black` on shell
- `print:hidden` on header CTA, "Powered by" footer
- `print:p-0` to drop the page chrome
- `print:break-inside-avoid` per tile so a chart doesn't split across pages
- `print:border-zinc-300` for visible-on-paper borders

### P1 — empty / single / many coherence

**P1-6. Empty state is one zinc-400 line.** "This dashboard has no cards yet." with no surrounding context is borderline broken. Should be a centered card-empty pattern: small icon, heading, one-line explanation, secondary "Powered by Atlas" footer to confirm the page actually loaded. Add a "Try Atlas free →" link as the only action.

**P1-7. Single-tile dashboard wastes space.** A single tile in a `max-w-4xl` column on a 1440 desktop has ~700px of empty grey on either side. Either widen the shell to `max-w-5xl` or `max-w-6xl`, or center the lone tile in a narrower wrapper. Choosing the former; it's a single rule and benefits the many-tile case too.

**P1-8. Many-tile dashboard ignores saved layout.** Cards have `layout.w` saved as 12 / 8 / 24 (out of 24-col grid) but the shared view renders every card full-width via `<div className="space-y-4">`. At desktop ≥`md`, render two-column when `layout.w <= 12`, full-width when `layout.w > 12` (or no layout). Mobile <640 stays single-column per the project's RGL feedback memory.

### P1 — freshness

**P1-9. No dashboard-level freshness.** Wire-format includes `updatedAt`/`createdAt` plus per-card `cachedAt`. Surface a single chip near the header: "Last refreshed 38 minutes ago" using `max(card.cachedAt)`. That's the recency signal that matters to a viewer; per-tile timestamps stay as secondary cues.

### P1 — chart color drift (note, deferred)

**P1-10. Recharts default blue, not Atlas teal.** Chart series use `result-chart`'s default palette which doesn't pick up `--primary`. This affects every Atlas surface (notebook, dashboard, shared); fixing it here means a one-off override that drifts. Noted; deferring to a separate cross-surface chart-palette issue rather than patching this one route.

### P2 — polish

**P2-1. Header chrome line uses zinc-500 with non-semantic chars.** The `·` separators are fine but the line is small (`text-sm`) and doesn't communicate the "snapshot" state. Reframe per chat surface: `Atlas · [Read-only chip] · Captured {date} · {N} cards`.

**P2-2. Card-count separator on mobile** wraps badly at 375. Solved by making the chip-row a flex-wrap.

**P2-3. Pie chart config renders as bar.** `chartConfig.type === "pie"` falls through to the chart renderer's default. Likely a Recharts feature gap, not a shared-surface problem. File as an issue, don't fix inline.

**P2-4. Error states have no chrome.** The "Dashboard not found" / "Connection failed" pages drop into a blank centered layout with no Atlas attribution. Add the same footer so even error pages reinforce brand.

## Plan (in order)

1. **Distill** — drop `<Card>` per-tile padding cruft, drop the redundant "Shared dashboard" word from the chrome line; promote the title.
2. **Colorize** — Atlas-teal accents on read-only chip, CTA, footer; teal `--primary` is fine for pie/bar but charts themselves stay deferred.
3. **Polish** — fix all P0s (skip-link, contrast), add header chrome + footer + print styles + OG image, responsive grid, freshness chip, real empty state.
4. **Clarify** — empty state copy, error-state CTA copy, "Captured {date} · last refreshed {ago}" wording.

## Out of scope (per #1870)

- Workspace branding override — `/api/v1/branding` is session-scoped and public viewers have no session. Same constraint as #1868 / PR #1902. Documented in PR body as deferred.
- Chart palette unification across surfaces (P1-10).
- Pie chart renderer fix (P2-3).
