# Page Revamp

Revamp a cluttered admin or SaaS page using the `.impeccable.md` toolkit — the same workflow that turned `/admin/integrations` from a wall of ten open forms into a clean progressive-disclosure surface.

**Use this when:** a page feels like wall-of-cards, wall-of-forms, or is otherwise visually monotonous / overwhelming in its empty state.

**Argument:** path or URL of the page to revamp (e.g. `/admin/integrations`, `packages/web/src/app/admin/billing/page.tsx`).

---

## Step 1 — Baseline

Read context and take a before-snapshot so we can compare.

1. Read `.impeccable.md` (project root) for design principles, brand tokens, voice.
2. Read `CLAUDE.md` for the "Always use shadcn/ui primitives" rule, the nuqs / useState split, and any area-specific constraints.
3. Locate the target source file:
   ```
   Glob: packages/web/src/**/{page,layout}.tsx matching the URL
   ```
4. Start the dev server if it isn't running (`bun run dev`), then navigate Playwright to the target page (log in as **admin@useatlas.dev / atlas-dev** if it's behind admin auth — if that password has drifted, reseed via `Bun.password.hash` + `UPDATE "account" SET password = ...`).
5. Take `page-before-top.png` and `page-before-bottom.png` full-viewport screenshots at **1440×900**.

## Step 2 — Critique

Run `/critique` on the rendered page. Capture:
- Nielsen's 10 heuristic scores (target total: note the baseline so you can measure improvement)
- P0/P1 issues
- AI-slop verdict
- Whether the empty state dominates (this was the killer on `/admin/integrations` — score 1/4 on Aesthetic heuristic)

## Step 3 — /distill — progressive disclosure

This is the signature move. Most admin pages over-commit to showing *every* control by default. Collapse what the user hasn't asked to see.

For each repeated "card" on the page, introduce two rendering modes:

**CompactRow** (collapsed default for disconnected / empty / inactive items):
- Icon tile (`size-8`, `rounded-lg border`, subtle `bg-background/40`)
- Title (`text-sm font-semibold tracking-tight`) + one-line description (`text-xs text-muted-foreground`, truncated)
- Small `StatusDot` (`size-1.5 rounded-full`, teal + pulse when live, muted when idle, dashed outline when unavailable)
- Right-aligned action button — `variant="outline"`, label is precise and concrete (`+ Add token`, `+ Add provider`, not generic `Connect`)

**FullShell** (expanded when connected, or when user clicked the compact row's action):
- Existing card shape, refined: icon tile in header, title + `Live` badge + (when disconnected-but-expanded) a close-X
- Body holds the form or the `DetailList` (label / value spec-sheet, monospace for IDs)
- Footer with destructive/secondary actions, bordered top, `bg-muted/20`

Wire it with per-card `useState` (transient UI state — nuqs is for URL state per CLAUDE.md):
```tsx
const [expanded, setExpanded] = useState(false);
const showFull = status === "connected" || expanded;
if (!showFull) return <CompactRow ... />;
return <IntegrationShell onCollapse={!item.connected ? () => setExpanded(false) : undefined} ... />;
```

Also ruthlessly cut:
- Any "overview strip" / chip row at the top that duplicates per-card state. Fold the total count into the hero (`00 / 10 live` in mono, `tabular-nums`).
- Per-section counts when the hero already carries the total.
- Status text when status is the default ("Not connected" on every disconnected row is tinnitus — the muted dot says it).
- Hints / explanatory blocks that only fire in unavailable states — put the reason inline in the CompactRow description instead.

Layout: single-column vertical stack within each section (`space-y-2`), page constrained to `max-w-3xl mx-auto`. Linear flow beats messy grids once cards vary in height.

## Step 4 — /colorize — if the brand accent is pale

On white SaaS admin surfaces, the canonical Atlas mint `oklch(0.759 0.148 167.71)` reads pastel for filled buttons, status dots, and active accents. Brand principle is "teal used sparingly for emphasis" — emphasis requires punch.

**Don't change `packages/web/brand.css`.** The canonical `--atlas-brand` token is the mint essence used by `www`, `docs`, and the sidebar logo.

Instead, override `--primary` and `--ring` directly in `packages/web/src/app/globals.css`:
- Light `:root`: `--primary: oklch(0.58 0.185 167.71)` + `--primary-foreground: oklch(1 0 0)` (white text)
- Dark `.dark`: `--primary: oklch(0.78 0.175 167.71)` (chroma bumped for glow on dark surfaces) + keep dark foreground

Verify the change took effect:
```javascript
browser_evaluate: getComputedStyle(document.documentElement).getPropertyValue('--primary')
```

Skip this step entirely if the page already has prominent teal buttons/accents that land with confidence.

## Step 5 — Verify

1. `bun x eslint <changed files>` → exit 0
2. `bun run type` → filter out pre-existing `bun:test` noise, confirm no new errors
3. Re-navigate the Playwright tab (or close + reopen — the browser session can go stale across long iterations)
4. Take `page-after-top.png` and `page-after-bottom.png`
5. Click one action button per section to verify expansion works; screenshot the expanded state
6. Optionally re-run `/critique` to quantify the jump (empty-state heuristic should move from ~1/4 to ~3/4)

## Step 6 — Ship

Branch, commit, push, PR — per `feedback_always_branch` and `feedback_pr_before_merge`. Don't merge without review.

```bash
git checkout -b <user>/revamp-<page-slug>
git add <changed files only — never the screenshot PNGs>
git commit -m "$(cat <<'EOF'
refactor(web/admin): redesign <page> with compact rows + deeper teal

Why: <one-sentence problem — wall of open forms, etc.>

What:
- Progressive disclosure — <summary>
- Page shell — <summary>
- Colorize — <summary if applicable>

The <N> child form/sub-components and all mutations are untouched.
EOF
)"
git push -u origin HEAD
gh pr create -R AtlasDevHQ/atlas --title "refactor(web/admin): redesign <page> with compact rows + deeper teal" --body "..."
```

PR body should include a **Test plan** with one checkbox per interactive behavior (expand each kind of card, verify connected state, verify unavailable state, toggle dark mode).

---

## Primitives cheat sheet

These are the reusable components the first revamp introduced. If you're revamping a page in the same surface, lift them rather than re-creating:

```tsx
type StatusKind = "connected" | "disconnected" | "unavailable";
function StatusDot({ kind, className }) { /* size-1.5 dot + pulse when connected */ }
function CompactRow({ icon, title, description, status, action }) { /* thin row */ }
function IntegrationShell({ icon, title, description, status, statusText, children, actions, onCollapse }) { /* full card */ }
function DetailList({ children }) { /* bordered label/value list */ }
function DetailRow({ label, value, mono, truncate }) { /* one row */ }
function InlineError({ children }) { /* bordered destructive block */ }
function SectionHeading({ title, description }) { /* eyebrow + subtext */ }
```

If the patterns recur on a third page, extract them into `packages/web/src/ui/components/admin/` so the fourth page is a one-import lift.

## What NOT to do

- Don't revamp logic. Forms, mutations, and hooks stay untouched — this is a presentational pass only.
- Don't introduce a new font, icon set, or component library. Sora + JetBrains Mono + Lucide + shadcn/ui per `.impeccable.md`.
- Don't hardcode color values. Go through `--primary`, `--muted-foreground`, etc.
- Don't leave Playwright screenshot PNGs committed. They're artifacts.
- Don't merge on green CI without a reviewer pass — per `feedback_pr_before_merge`.
