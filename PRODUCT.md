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

**Direction (set 2026-06-23):** the brand surface is moving from dark-teal-on-black to a **warm cream paper base with a deep forest green** as the committed brand color. The point is to sell the product's one thesis, *trust the answer*, harder: deep green reads as validation / correctness ("7 validators passed"), and going light deliberately breaks the saturated dark-dev-tool reflex (Vercel / Linear / Supabase) for real differentiation. The landing shipped light on 2026-06-24 (#3913, #3917): cream + forest is now the **live** default — the prior dark theme and its `.theme-light` opt-in were retired once every landing page migrated. The remaining surfaces — **docs** (#3915) and the **product app + demo** (#3916) — adopt the same brand system next; Principle 5 defines how each one follows it.

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

### 5. One brand, light-first — three surfaces, one forest accent
There is **one** brand, expressed light-first as warm cream paper + deep forest green. The **light identity is the brand on every surface**, and the forest accent (`--atlas-brand`, `#1F5C45`) is the through-line in every surface *and mode*. Three surfaces express it (decided 2026-06-24, #3915 / #3916):

- **Brand surface** — the landing, and **docs**: full marketing cream + forest. The landing is **light-only**; **docs** additionally keeps a dark mode (developers read it at night) that is *on-brand dark*, not a separate theme.
- **Product surface** — the **app / admin** and the **demo** (which renders the product chat, so it inherits app theming): **light + dark**. Light mode *follows the brand* as a warm, desaturated **paper-lite** — the same cream family as the landing, pulled toward white and lower chroma so dense tables, charts, and long sessions stay calm and AA-legible. Dark mode is its own working surface — a faintly forest-tinted dark, not pure gray — still on-brand because the **primary stays forest (lightened for contrast), never teal**. A real dark mode the marketing surface doesn't need.
- **Code surface** — the YAML / SQL / agent-reply panes: always-dark terminal windows (`--code-*`), identical on every surface and mode.

**Teal (`--atlas-spark`, `#23CE9E`) is never a primary** — it is a rare spark on dark / green surfaces only (focus rings, active dots, the drenched-CTA accent, code highlights). Keeping forest as the primary even in dark mode is deliberate: it keeps the dark app a sibling of the cream landing instead of falling back into the neon-teal-on-black dev-tool lane we are leaving.

Drive all color through CSS-variable tokens, never hardcoded values, so each surface is one edit. The shared **`brand.css`** (symlinked into all three apps) is the single source of truth for the brand color, the spark, and the cream ramp; each app's `globals.css` is a thin adapter onto its framework tokens (Tailwind utilities / Fumadocs `--fd-*` / shadcn `--primary`, sidebar-*). Full rationale + rejected alternatives: [ADR-0023](docs/adr/0023-brand-color-system.md).

## Design Tokens

### Colors
Token names live in the shared `brand.css`; the prose name and the token are the same word, so "brand" means one thing in the doc and in the code.
- **`--atlas-brand` — deep forest `#1F5C45`** (oklch `0.40 0.115 158`): the committed brand color and the **primary accent on every surface and mode** (headlines, CTAs, links, buttons, active states). Lightened for contrast in dark mode, **never replaced by teal**.
- **`--atlas-spark` — bright teal `#23CE9E`** (oklch `0.759 0.148 167.71`): a **spark**, never a primary. Dark / green surfaces only — focus rings, active dots, the drenched-CTA band, code-pane highlights.
- **`--atlas-paper` — warm cream ramp:** oklch `0.955 0.017 83` (raised `0.923 0.019 83`, sunken `0.892 0.021 83`). The brand ground. Marketing surfaces (landing, docs) use it directly; the working app desaturates toward white (**paper-lite**) for dense data.
- **`--atlas-ink` — near-black, faint forest:** oklch `0.245 0.026 158`.
- **Code windows (fixed on every surface):** bg oklch `0.14 0.006 167`, chrome `0.185`, well `0.10`.
- **Color space:** oklch throughout — perceptually uniform, better for accessible contrast ratios.
- **Token source of truth:** the shared **`brand.css`** (symlinked into `apps/www`, `apps/docs`, `packages/web`); each app's `globals.css` adapts it onto framework tokens. Supersedes the `proto-light/theme.css` prototype now that the landing has shipped.

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
