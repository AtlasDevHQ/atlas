# Atlas Design Context

## Users

**Primary:** Developers integrating text-to-SQL into their apps — they want a drop-in agent that understands their schema and writes correct queries without handholding.

**Secondary:** Data analysts and BI teams who interact with the chat UI directly to explore data.

**Context of use:** Users are in the middle of building or querying — they need answers fast, with high confidence that results are grounded in the semantic layer. The interface should never make them second-guess whether a response is trustworthy.

**Job to be done:** Ask a question in plain English, get a validated SQL query and result back — no copy-pasting from ChatGPT, no manual schema lookup.

## Brand Personality

**Three words:** Smart, technical, scrappy.

**Voice:** Direct and confident without being arrogant. Speaks like a sharp engineer — concise, precise, no fluff. The kind of tool a solo dev builds because the alternatives are bloated or overpriced.

**Emotional goal:** Confidence. Users should trust that the agent's response is grounded in their actual schema (semantic layer), not hallucinated. The UI reinforces this by being transparent — what you see is what you get.

## Aesthetic Direction

**Direction (set 2026-06-23):** the brand surface is moving from dark-teal-on-black to a **warm cream paper base with a deep forest green** as the committed brand color. The point is to sell the product's one thesis, *trust the answer*, harder: deep green reads as validation / correctness ("7 validators passed"), and going light deliberately breaks the saturated dark-dev-tool reflex (Vercel / Linear / Supabase) for real differentiation. Dialed-in prototype: `apps/www/src/app/proto-light/` (branch `www/proto-dark-ramp`). **The production landing migration is pending — until it lands, the live landing is still dark. Treat cream + forest as the target, not the current state.**

**Visual tone:** Clean, technical, considered. Warm and honest, not flashy or playful. Premium without being precious.

**Theme: light-first, warm cream + deep forest.** A warm tan paper ground with deep forest green carrying headlines, CTAs, and accents. **Code stays dark:** the YAML / SQL / agent-reply panes are dark "terminal windows" floating on the cream — high-contrast, technical, the page's hero asset (the Stripe-docs move). One deep-green-drenched band per page (the closing CTA) for punch, where the bright brand teal appears as a spark that only shows up on dark / green surfaces.

**What Atlas looks like:**
- Quiet confidence — warm cream, generous whitespace, clear hierarchy, no visual noise
- Technical precision — dark code windows on light paper; monospace where it matters (code, SQL, data), clean sans-serif everywhere else
- Deep forest green (`#1F5C45`) as the committed brand color; bright teal (`#23CE9E`) reserved as a spark on dark / green surfaces

**What Atlas does NOT look like:**
- Not the dark-dev-tool reflex (neon teal on black) — that's the lane we're deliberately leaving
- Not the generic SaaS-light page (near-white + a timid accent) — we commit to the green, we don't hedge
- Not the earthy-cream-wellness cliché — the deep forest green, dark code windows, and the type keep it technical, not organic
- Not cluttered like Jira; not playful/whimsical (no illustrations, mascots, bouncy motion)

**References:** dark code panes on warm paper (Stripe docs); restraint and hierarchy in the Linear / Vercel tradition, but light and committed to a color rather than monochrome.

## Design Principles

### 1. shadcn/ui is the design system
Every UI element uses shadcn/ui primitives. Never hand-roll a button, dialog, dropdown, input, card, or table when shadcn/ui has one. This is the single source of standardization — consistent spacing, radii, focus rings, and dark mode come free. When a pattern doesn't exist in shadcn/ui, compose from its primitives before inventing something new.

### 2. Show, don't decorate
UI exists to surface data and controls, not to look impressive. Every element earns its pixels — if it doesn't help the user understand or act, remove it. Prefer progressive disclosure over showing everything at once.

### 3. Transparency builds trust
The agent's power comes from the semantic layer, and the UI should make that visible. Show what table was queried, what validation passed, what the SQL looks like. "What you see is what you get" — no magic black boxes.

### 4. One way to do things
Standardize on single patterns: one font pair (Sora + JetBrains Mono), one icon set (Lucide), one component library (shadcn/ui), one state pattern per context (nuqs for URL state, useState for transient). Consistency reduces cognitive load for both users and the solo developer maintaining it.

### 5. Light-first (cream + forest), code stays dark
Build the brand surface light-first: warm cream paper, deep forest green. Code panes (YAML / SQL / agent replies) stay dark in every theme — they're terminal windows on paper, not themed surfaces. Drive all color through CSS-variable tokens (`--bg`, `--fg`, `--accent`, `--code-*`), never hardcoded values, so the theme is one edit. The product app (admin / dashboard) remains its own light-ready shadcn surface, separate from the brand surface.

## Design Tokens

### Colors
- **Brand green (primary):** deep forest `#1F5C45` (oklch `0.40 0.115 158`) — headlines, CTAs, accents on the light brand surface
- **Brand teal (spark):** `#23CE9E` (oklch `0.759 0.148 167.71`) — reserved for dark / green surfaces (code panes, the drenched CTA band)
- **Paper base:** warm cream oklch `0.955 0.017 83` (raised sections `0.923 0.019 83`)
- **Ink:** near-black, faint forest oklch `0.245 0.026 158`
- **Code windows (fixed in every theme):** bg oklch `0.14 0.006 167`, chrome `0.185`, well `0.10`
- **Color space:** oklch throughout — perceptually uniform, better for accessible contrast ratios
- **Token source of truth:** `apps/www/src/app/proto-light/theme.css` (until migrated into the production landing)

### Typography
- **UI font:** Sora (Google Fonts) — clean geometric sans-serif
- **Code font:** JetBrains Mono (Google Fonts) — excellent for SQL, data, terminals
- **Rendering:** antialiased on all platforms

### Spacing & Radii
- **Border radius base:** `0.625rem` (10px), scaled via CSS custom properties
- **Spacing:** Tailwind default scale (4px increments)

### Components
- **Library:** shadcn/ui v2, new-york style, neutral base
- **Icons:** Lucide React
- **Variants:** CVA (Class Variance Authority)
- **Class merging:** `cn()` = clsx + tailwind-merge

## Component Guidelines

### Always use shadcn/ui for:
- Buttons, inputs, selects, checkboxes, switches, sliders
- Cards, dialogs, sheets, popovers, dropdowns
- Tables, badges, separators, scroll areas
- Forms (via react-hook-form + shadcn Form)
- Command palette (cmdk)

### Install new components with:
```bash
bun x shadcn@latest add <component>
```
Run from `packages/web/`.

### Compose, don't invent:
If you need a component shadcn/ui doesn't have, build it from shadcn/ui primitives (Card + Button + Badge, etc.) before creating something from scratch. Match existing spacing, radii, and color tokens.

### Admin pages:
- Use `useAdminFetch` / `useAdminMutation` hooks — never hand-roll fetch logic
- Use `AdminContentWrapper` for layout
- Use shared state components: `empty-state`, `loading-state`, `error-banner`
