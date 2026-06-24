# ADR-0023: Forest is the brand, teal is the spark — one brand expressed light-first, with on-brand dark for working surfaces

**Status:** Accepted
**Date:** 2026-06-24
**Milestone:** — (brand direction set in PRODUCT.md 2026-06-23; landing migration #3913/#3917 shipped; remaining surfaces #3915/#3916)
**Issues:** [#3913](https://github.com/AtlasDevHQ/atlas/issues/3913), [#3917](https://github.com/AtlasDevHQ/atlas/pull/3917) (landing, shipped), [#3915](https://github.com/AtlasDevHQ/atlas/issues/3915) (docs), [#3916](https://github.com/AtlasDevHQ/atlas/issues/3916) (app + demo)
**See also:** [PRODUCT.md](../../PRODUCT.md) › Aesthetic Direction, Principle 5, Design Tokens

## Context

Atlas's brand surface moved off dark-teal-on-black to a **warm cream paper + deep forest green** direction (PRODUCT.md, 2026-06-23). The landing shipped light on 2026-06-24 (#3913, #3917): cream + forest is now the live default and the prior dark theme + `.theme-light` opt-in were retired.

That left the brand system half-stated, in two ways a future reader would trip over:

1. **The token vocabulary contradicted the design doc.** The shared `brand.css` (one real file, symlinked into all three frontends) declared `--atlas-brand` = **teal** `#23CE9E` and called it *"Brand green / single source of truth."* But PRODUCT.md had already named **forest** `#1F5C45` the committed brand color and demoted teal to a "spark." Worse, the landing's *actual* forest accent was hardcoded **locally** in `apps/www/globals.css` as `--accent` and never went into the shared token — so `brand.css` was neither the source of truth nor green, while `docs` (`--fd-primary`) and the `app` (sidebar tokens) both literally consumed the teal `--atlas-brand`.
2. **The reach of cream + forest across the other surfaces was undecided.** #3915 (docs) and #3916 (app + demo) were both blocked `ready-for-human` on a single missing decision: does each surface follow the brand, and how far? Flipping the landing while docs/app diverge is split-brain.

Resolved in a brand-system grilling session (2026-06-24). The crux: the token rename is **load-bearing, not cosmetic** — making `--atlas-brand` mean forest auto-shifts every consumer, so what the token *means* had to be settled before, and together with, the surface migrations.

## Decision

Five sub-decisions, all confirmed in the 2026-06-24 grill.

### 1. Forest is the committed brand color; teal is a spark

`--atlas-brand` is **deep forest green `#1F5C45`** (oklch `0.40 0.115 158`) — the committed brand color and the **primary accent on every surface and every mode**. Teal `#23CE9E` (oklch `0.759 0.148 167.71`) becomes `--atlas-spark`: a **rare highlight on dark / green surfaces only** (focus rings, active dots, the drenched-CTA band, code-pane highlights) and **never a primary**. The prose name and the token are now the same word, so "brand" means one thing in the design doc and in the code.

### 2. One brand, expressed light-first — the light identity *is* the brand

There is **one** brand, not a marketing palette plus an unrelated product palette. Its light expression (cream + forest) is the identity on every surface. The forest accent is the through-line in every surface *and mode*; the only thing that varies by surface is whether a surface additionally earns a *dark* mode.

### 3. Three surfaces, distinguished by whether they get a working dark mode

- **Brand surface** — the landing, and **docs**: full marketing cream + forest. The landing is **light-only** (a marketing page needs no dark mode). **Docs** additionally keeps a dark mode — developers read docs at night next to a dark IDE — rendered *on-brand dark*, not a separate theme; the toggle stays.
- **Product surface** — the **app / admin** and the **demo**. The demo renders the product chat, so it **inherits app theming**; the two #3916 questions collapse into one surface. Keeps **light + dark** (people live in the app for hours).
- **Code surface** — the YAML / SQL / agent-reply panes: always-dark terminal windows (`--code-*`), identical on every surface and mode.

### 4. The product surface's light follows the brand as *paper-lite*; its dark keeps forest as primary

- **Light mode** follows the brand as a warm, **desaturated paper-lite** — the same cream family as the landing, pulled toward white and lower chroma so dense tables, charts, and long sessions stay calm and AA-legible. **Not** the literal saturated marketing cream. `--primary` = forest.
- **Dark mode** is its own working surface — a **faintly forest-tinted dark** (borrowing the code panes' hue), not pure gray — and **the primary stays forest, lightened for contrast, never teal**. This keeps the dark app a sibling of the cream landing rather than the neon-teal-on-black dev-tool look we are deliberately leaving.

### 5. `brand.css` is the real single source of truth; apps are thin adapters

The shared `brand.css` carries the **brand color (forest), the spark (teal), and the warm cream ramp** (`--atlas-paper*` / `--atlas-ink*`). Each app's `globals.css` is a thin adapter mapping those onto its framework tokens: Tailwind utilities + brand-surface vars (`apps/www`), Fumadocs `--fd-primary`/`--fd-ring` (`apps/docs`), shadcn `--primary`/`--ring`/`sidebar-*` (`packages/web`). "The theme is one edit" becomes literally true across all three.

## Consequences

- **The `--atlas-brand` flip ripples — and it is not a pure CSS edit.** `docs` (`--fd-primary`/`--fd-ring`) and the `app` (`--sidebar-primary`/`--sidebar-ring`) already consume `var(--atlas-brand)`, so flipping it teal→forest changes their rendering immediately. Crucially, **in the app `--atlas-brand` is also the default for the white-label `ATLAS_BRAND_COLOR` setting**: workspace admins override it at runtime (`use-dark-mode.ts` injects it via `style.setProperty("--atlas-brand", …)`, seeded from the `brandColor` API setting), and it carries a documented **three-file lockstep** — `brand.css` `:root --atlas-brand`, `use-dark-mode.ts` `DEFAULT_BRAND_COLOR`, and `settings.ts` `ATLAS_BRAND_COLOR.default`. Flipping the brand to forest therefore also **moves the app's default workspace brand** teal→forest and **must move all three together** (per-workspace white-label overrides keep flowing through `--atlas-brand`). That makes the flip part of **#3916** — a deliberate default change, with a thought for already-provisioned workspaces — not a net-zero precursor.
- **Teal's spark role is already wired on the landing.** `text-brand` (`--color-brand` → `--atlas-brand`) is used on the landing's **dark code panes** (hero, deploy terminal, how-it-works) — i.e. as the teal spark, exactly `--atlas-spark`'s role. When the tokens split, the www adapter maps its `brand` utility to `--atlas-spark`, *not* the forest brand.
- **Sequencing.** The shared `brand.css` restructure — add `--atlas-spark` + the cream ramp (purely additive, net-zero), then flip `--atlas-brand`→forest **with** the three-file white-label lockstep — is the first step, landed together with the first consuming surface while the others are pinned to explicit teal until their own migration: **brand.css + lockstep → #3915 docs → #3916 app/demo.** No surface ships half-forest/half-teal.
- **`packages/react` is independent.** The embeddable `@useatlas/react` widget defines its own `--atlas-brand` (teal) in `styles.css` and does **not** import the shared `brand.css`; its default is a published-package change handled with the demo/app under #3916, not by this restructure.
- **The landing adapter is net-zero.** `apps/www` stops hardcoding `--accent` and points it at `var(--atlas-brand)` — same forest value, no visual change; just makes the SSOT real.
- **The app's hand-tuned teal `--primary` (`oklch(0.58 0.185 167.71)`) is replaced** by forest in light mode and lightened-forest in dark; teal survives only as `--atlas-spark` for sparks.
- **No `.theme-light` / no dark wrappers on the brand surface.** The landing's light values are `:root` defaults (already shipped, #3914); docs and app express dark via their framework's `.dark` mechanism, not a brand-surface toggle.
- **Two cream "weights" exist by design** — full marketing cream (landing, docs prose) and paper-lite (app/dense data). They are one family, not two palettes; the difference is saturation/lightness for ergonomics, not hue.

## Alternatives considered

- **One unified theme reaching every surface (no product/brand distinction).** Rejected: the app is dense (tables, charts, hours of use) and needs a real dark mode and calmer, lower-chroma grounds than a marketing page; forcing literal cream onto it muddies chart colors and fatigues. PRODUCT.md Principle 5's "the app is its own surface" intuition was right — we kept it as *its light mode follows the brand, its dark mode is its own on-brand dark* rather than collapsing the two.
- **Two walled-off palettes (brand vs product) with no shared color.** Rejected: loses the through-line. The forest accent present in every surface and mode is exactly what makes the dark app read as a sibling of the cream landing.
- **Keep teal as the brand, or make teal the dark-mode primary.** Rejected: the entire point of the rebrand is to leave the saturated neon-teal-on-black dev-tool lane (Vercel / Linear / Supabase). Teal-forward dark surfaces land right back in it. Forest-as-primary-even-in-dark keeps the accent identity constant; teal stays a rare spark, as PRODUCT.md states.
- **Literal marketing cream in the app.** Rejected: saturated warm cream behind dense data is warm-heavy and reads muddy; shadcn's neutrals were tuned for near-white. Paper-lite keeps the brand family while staying a comfortable working ground.
- **Docs light-only (pure brand surface).** Rejected: it would delete Fumadocs' dark mode, an affordance the core developer audience expects. Docs gets the brand in light mode (where marketing-driven first visits land) without taking dark mode from the developers who live in it.
