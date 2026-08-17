---
name: Atlas Product Surface
description: The admin console, chat, and dashboards — warm paper ground, forest accent, dark code panes.
colors:
  validator-green: "oklch(0.4 0.115 158)"
  validator-green-hover: "oklch(0.45 0.12 158)"
  validator-green-foreground: "oklch(0.965 0.016 88)"
  validator-green-dark-mode: "oklch(0.62 0.12 158)"
  terminal-spark: "oklch(0.759 0.148 167.71)"
  terminal-spark-hover: "oklch(0.82 0.148 167.71)"
  warm-paper: "oklch(0.955 0.017 83)"
  warm-paper-raised: "oklch(0.923 0.019 83)"
  warm-paper-sunken: "oklch(0.892 0.021 83)"
  forest-ink: "oklch(0.245 0.026 158)"
  forest-ink-muted: "oklch(0.435 0.026 158)"
  surface-light: "oklch(0.995 0.004 83)"
  surface-dark: "oklch(0.165 0.012 158)"
  card-light: "oklch(1 0 0)"
  card-dark: "oklch(0.205 0.014 158)"
  border-light: "oklch(0.91 0.006 83)"
  destructive: "oklch(0.577 0.245 27.325)"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "18px"
spacing:
  tile-compact: "7px 10px 6px"
  tile-spacious: "14px 16px 11px"
components:
  button-primary:
    backgroundColor: "{colors.validator-green}"
    textColor: "{colors.validator-green-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
    typography: "{typography.label}"
  button-outline:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
---

# Design System: Atlas Product Surface

## Overview

**Creative North Star: "The Lit Terminal"**

A warm paper ground with dark code windows floating on it. The inversion is the whole
idea: where a dev tool reflexively goes dark-everything, Atlas puts the *page* on warm
paper and reserves darkness for the thing that earns it — the SQL, the YAML, the agent's
reply. Code is the hero asset, lit like an object on a desk rather than camouflaged
against a black chrome.

Forest green carries every act of confirmation. The product's one thesis is *trust the
answer*, and the accent exists to say a thing was checked: the whitelist passed, the
statement parsed, the query is one SELECT. That is why the primary is a deep, unshowy
green and never the bright teal — the teal is a spark, and a spark that appears everywhere
stops meaning anything.

This is an Operate surface. Dense tables, long sessions, charts, filters, pagination.
Scanability and consistency outrank expression, and the brand lives in precise details
rather than in chrome: the radius ladder, the forest focus ring, the warmth of a ground
that is not quite white.

**Key Characteristics:**
- Warm paper ground — never pure white, never neutral gray
- Forest as the only primary, in both modes; teal never promoted
- Flat at rest; depth from tonal layering, not shadow
- shadcn primitives left close to stock — precise and unshowy
- Dark code panes as the signature object

## Colors

A two-pole palette: a warm neutral family (hue 83) for ground and paper, and a forest
family (hue 158) for ink, accent, and the dark mode's tint. Nothing here is neutral gray,
and that is deliberate.

### Primary
- **Validator Green** (`oklch(0.4 0.115 158)`): every act of confirmation — primary
  buttons, active nav, focus rings, the sidebar's active item. In dark mode it lightens to
  `oklch(0.62 0.12 158)` to hold contrast, keeping the hue so the dark app reads as a
  sibling of the cream landing rather than a different product.

### Secondary
- **Terminal Spark** (`oklch(0.759 0.148 167.71)`): a rare bright mint-teal, allowed only
  on dark or green surfaces — code highlights, an active dot, an accent inside a drenched
  band. It is never a primary and never appears on paper.

### Neutral
- **Warm Paper** (`oklch(0.955 0.017 83)`) with **raised** (`0.923`) and **sunken**
  (`0.892`) steps: the marketing cream family. On the product surface the ground is pulled
  further toward white — `oklch(0.995 0.004 83)` — as "paper-lite", low enough in chroma
  that dense tables and charts stay calm over a long session while staying recognisably
  warm.
- **Forest Ink** (`oklch(0.245 0.026 158)`) and **muted** (`0.435 0.026 158`): text and
  secondary text. The near-black carries a trace of the brand hue rather than being
  neutral — the reason the whole system feels of a piece rather than assembled.
- **Dark ground** (`oklch(0.165 0.012 158)`): faintly forest-tinted, not pure gray.

### Named Rules

**The One Primary Rule.** Forest is the primary in *both* modes. Dark mode lightens it; it
never flips to teal. The moment the accent goes teal-on-black, this is the dev-tool lane
the brand deliberately left.

**The Spark Confinement Rule.** Terminal Spark appears only on dark or green surfaces.
Never on paper, never as a button fill, never as the primary of anything.

**The No-Neutral-Gray Rule.** Grounds and text carry hue — 83 warm on light, 158 forest on
dark. `zinc`, `slate`, `gray` and `#fff` are all wrong answers here, however convenient.

## Typography

**Body Font:** the platform sans stack (`ui-sans-serif, system-ui`).
**Code Font:** the platform monospace stack (`ui-monospace, SFMono-Regular, Menlo`).

⚠️ **This is a gap, recorded honestly rather than papered over.** PRODUCT.md Principle 4
commits to one font pair — **Sora + JetBrains Mono** — and this application loads
*neither*. There is no `next/font` import anywhere in `packages/web/src`, so the surface
renders in whatever Tailwind's default stack resolves to on the visitor's OS. The pairing
is a real brand commitment; it is simply not implemented on this surface yet, and a
DESIGN.md that asserted Sora here would be describing the marketing site.

### Hierarchy

Type scale is Tailwind's default, applied through shadcn primitives rather than a bespoke
ramp. The roles that are actually load-bearing:

- **Body** (400, `0.875rem`): table cells, chat text, form values — the default register.
- **Label** (500, `0.875rem`): buttons, nav items, column headers, anything actionable.
- **Code** (400, `0.75rem`): SQL, YAML, agent replies. Always monospace, always smaller
  than body.

## Layout

A persistent sidebar against a dense content column. The sidebar carries its own ground
(`oklch(0.975 0.006 83)` light, `oklch(0.185 0.013 158)` dark) one step from the page, so
the split reads without a border doing the work.

Dashboards are a `react-grid-layout` canvas with two density modes that change only
padding: **compact** (`7px 10px 6px` head, `6px 10px 8px` body) and **spacious**
(`14px 16px 11px` / `12px 16px 14px`). Edit mode tints the canvas with a 14px radial dot
grid so it can never be mistaken for view mode — a state you can see without reading a
label.

Print (`/shared/[token]`) forces `color-scheme: light`, A4, 1.5cm × 2cm margins.

## Elevation & Depth

**Flat by default.** Depth comes from tonal layering — paper / raised / sunken, sidebar
against background, card against ground — not from shadow. The entire stylesheet contains
exactly one resting-to-active shadow.

### Shadow Vocabulary
- **Drag lift** (`box-shadow: 0 14px 32px oklch(0 0 0 / 0.18)`): a dashboard tile being
  dragged, and nothing else.
- **Control hairline** (`shadow-xs`, from the shadcn outline button): the faintest possible
  separation on an outlined control.

### Named Rules

**The Flat-At-Rest Rule.** A surface gets a shadow only as a response to state — drag,
and currently nothing else. If a card needs a resting shadow to read, the tonal step
underneath it is wrong; fix the ground, not the elevation.

## Shapes

One radius ladder derived from a single `--radius: 0.625rem` (10px): **sm** 6px, **md**
8px, **lg** 10px, **xl** 14px, **2xl** 18px, up to 26px. Controls sit at **md** (8px);
the dashboard drag placeholder at 12px is the one hand-set value.

Borders are hairline and low-contrast (`oklch(0.91 0.006 83)` light; `oklch(1 0 0 / 10%)`
dark) — present to organise, not to draw.

## Components

### Buttons
- **Shape:** gently rounded (`rounded-md`, 8px), 36px tall at default size, `8px 16px`.
- **Primary:** Validator Green fill with cream foreground; hover drops to 90% opacity.
- **Outline:** transparent over the page ground with a hairline border and `shadow-xs`;
  hover fills with `accent`.
- **Focus:** a 3px ring at 50% of the forest ring color, plus a border shift. Never
  removed, never replaced with an outline-none.

### Cards / Containers
- **Corner:** `rounded-lg` (10px). **Background:** pure white in light mode
  (`oklch(1 0 0)`) against the warm ground — the one place white is correct, because it
  reads as paper *on* paper. **Shadow:** none at rest. **Border:** hairline.

### Inputs
- Hairline border on the page ground, `rounded-md`, same 3px forest focus ring as buttons.
  Invalid state shifts the border and ring to destructive.

### Navigation
- Sidebar items in Label type; the active item takes Validator Green as its ground with
  cream foreground. Scrolling is a Radix ScrollArea with a custom thumb — the native
  scrollbar gutter is suppressed on command lists only (`[data-slot="command-list"]`).

### SQL / Code Pane (signature — currently off-brand)
- **What it should be:** a dark terminal window floating on the paper ground, identical in
  both modes. That is the North Star and PRODUCT.md Principle 5's "code surface".
- **What it is:** `bg-zinc-100 dark:bg-zinc-800`, `rounded-lg`, `p-3`, `text-xs`
  (`ui/components/chat/sql-block.tsx:46`) — a light *grey* pane in light mode, and neutral
  gray in dark. The `--code-*` tokens exist only in `apps/www`; this package has none.
- Documented as the gap it is. See "Don't" below.

## Do's and Don'ts

### Do:
- **Do** drive every color through a CSS variable — `bg-background`, `text-foreground`,
  `bg-primary` — so a surface is one edit. `brand.css` is the source of truth and
  `globals.css` is only an adapter onto shadcn's names.
- **Do** compose from shadcn primitives before inventing a component; the radius, focus
  ring, and dark-mode behavior come free and stay consistent.
- **Do** keep the forest accent scarce enough to mean something. It marks confirmation and
  action, not decoration.
- **Do** state depth with a tonal step first, and reach for shadow only when a surface is
  genuinely in motion.

### Don't:
- **Don't** hardcode a color utility on a themed surface. `bg-white`, `text-zinc-900`,
  `bg-zinc-950`, `bg-zinc-100` all bypass the token system and break the warm ground and
  the forest-tinted dark. ⚠️ **The root `layout.tsx:61` currently does exactly this**
  (`bg-white text-zinc-900 … dark:bg-zinc-950 dark:text-zinc-100`), overriding the
  tokenized `body` rule in `globals.css` — while the skip-link on the *next line* uses
  `focus:bg-background` correctly.
- **Don't** promote Terminal Spark to a primary, or place it on a paper ground.
- **Don't** let dark mode drift to neutral gray. The dark ground carries hue 158 on
  purpose; `zinc-950` is not a substitute.
- **Don't** add a resting shadow to a card. Flat at rest is the rule, and the tonal ramp
  exists to make it work.
- **Don't** assume Sora or JetBrains Mono are available here. They are a brand commitment
  this package does not yet load.
