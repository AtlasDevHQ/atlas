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

**Visual tone:** Clean technical SaaS. Dark-leaning but with a polished light mode for the hosted app. Not flashy, not playful — functional and honest.

**Theme:** Dark mode is the default personality (landing page, docs, developer surfaces). Light mode is equally maintained for the SaaS app where broader audiences expect it.

**What Atlas looks like:**
- Quiet confidence — generous whitespace, clear hierarchy, no visual noise
- Technical precision — monospace where it matters (code, SQL, data), clean sans-serif everywhere else
- Teal accent (`#23CE9E`) used sparingly for emphasis, not decoration

**What Atlas does NOT look like:**
- Not cluttered like Jira — no information overload, no nested panels fighting for attention
- Not playful/whimsical — no illustrations, mascots, or bouncy animations
- Not enterprise-gray — the teal brand color and dark surfaces give it energy without being loud

**References:** None specified. The current direction (modern dev-tool aesthetic, similar to Linear/Vercel in restraint) is the target.

## Design Principles

### 1. shadcn/ui is the design system
Every UI element uses shadcn/ui primitives. Never hand-roll a button, dialog, dropdown, input, card, or table when shadcn/ui has one. This is the single source of standardization — consistent spacing, radii, focus rings, and dark mode come free. When a pattern doesn't exist in shadcn/ui, compose from its primitives before inventing something new.

### 2. Show, don't decorate
UI exists to surface data and controls, not to look impressive. Every element earns its pixels — if it doesn't help the user understand or act, remove it. Prefer progressive disclosure over showing everything at once.

### 3. Transparency builds trust
The agent's power comes from the semantic layer, and the UI should make that visible. Show what table was queried, what validation passed, what the SQL looks like. "What you see is what you get" — no magic black boxes.

### 4. One way to do things
Standardize on single patterns: one font pair (Sora + JetBrains Mono), one icon set (Lucide), one component library (shadcn/ui), one state pattern per context (nuqs for URL state, useState for transient). Consistency reduces cognitive load for both users and the solo developer maintaining it.

### 5. Dark-first, light-ready
Design in dark mode first (it's the brand personality), but every surface must work in light mode too. Use CSS variables and oklch tokens — never hardcode color values. Test both themes.

## Design Tokens

### Colors
- **Brand primary:** `#23CE9E` (oklch `0.759 0.148 167.71`)
- **Brand dark:** `#1A9B76` (oklch `0.82 0.148 167.71`)
- **Dark background:** `#0C0C10`
- **Light background:** `#F6F6F8`
- **Color space:** oklch throughout — perceptually uniform, better for accessible contrast ratios

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
