# `/wizard` design critique — 1.3.0 Bucket 5

**Issue:** #1875
**Page:** `/wizard` — self-host onboarding setup wizard
**Scope:** datasource → tables → review → preview → done, plus error states and demo branch
**Baseline screenshots:** `.design/wizard-before/`

---

## Wizard at a glance

Five-step linear flow:

| # | Step           | Purpose                                                      |
|---|----------------|--------------------------------------------------------------|
| 1 | Datasource     | Pick a saved connection from `/admin/connections`            |
| 2 | Tables         | List all tables/views, multi-select to include in the layer  |
| 3 | Review         | Generated entity YAMLs in expandable rows; YAML editable     |
| 4 | Preview        | Optional sandbox — type a question, get the agent's context  |
| 5 | Done           | Empty success card with two flat CTAs                        |

State lives in component `useState` plus a couple of nuqs-backed URL params (`step`, `connectionId`). Tables/entities/save errors are local-only.

---

## Universal issues (apply to every step)

### Visual chrome — out of step with /signup

The wizard predates the 1.3.0 design pass. It was last touched ~6 weeks ago and never got the chrome that `/signup`, `/signup/workspace`, `/signup/region`, `/signup/connect`, `/signup/success` all share now (PR #1943, signup-shell.tsx).

What's missing vs signup:
- **No Atlas mark or app bar.** The page just opens with `Setup Wizard` as an `<h1>`. Signup has a thin top bar with the Atlas mark + step indicator that anchors the user — wizard has nothing.
- **No back-to-home affordance.** A user who lands here and wants out has no escape hatch. Browser back is the only way.
- **Step indicator is a different shape.** Signup uses numbered circles + labels with a connector line; wizard uses pill-shaped icon+label badges. Two onboarding flows, two visual languages — this is exactly the inconsistency the bucket plan is meant to fix.
- **Mobile step indicator is icon-only.** At 390px, the labels (`Datasource`, `Tables`, …) drop with `hidden sm:inline`. Result: five colored dots with no text. Users can't tell where they are without counting. Signup solved this with a `Step X of Y · Label` pill + progress bar.
- **Mobile shell has no horizontal padding container around the indicator.** The `flex … gap-2` track is wider than the viewport, so the page horizontally scrolls — visible scrollbar at the bottom of every mobile screenshot.

### Copy — "Setup Wizard" is generic

Signup says "Welcome to Atlas / Create your account." Wizard's title is a label for the page itself, not a goal for the user. "Configure your semantic layer in a few steps" is closer, but the title is what a user reads first.

Better: "Set up your semantic layer" or "Connect Atlas to your data."

### Skip / defer affordance is missing

The issue's scope explicitly calls out "skip / defer affordances." Today, the only way out is browser back or hard-navigating away — and once you do, your in-progress entity edits are lost (component state, no persistence). A user who realizes they want to come back later has no signal that this is OK. Wizard should either:
- Surface a small "I'll do this later" link in the header, OR
- Offer "Save draft" on the review step, OR
- At minimum, tell users in the intro that they can leave and the connections persist in admin even if they don't finish.

### Demo-data branch is invisible

`__demo__` is a real seeded connection (1.2.0 work) intended to let users explore Atlas before connecting their own data. But the wizard treats it as a regular row in the dropdown (`__demo__` rendered as `<span class="font-mono">__demo__</span> postgres`). There's no explanation that this is the demo dataset, no CTA framing, no separation. A first-time user has no reason to pick the row with the underscore-wrapped name over `default` — and nothing tells them what either is.

This is the one place the wizard could *help* a brand-new self-host user, and right now it does nothing.

---

## Step-by-step findings

### Step 1 — Datasource

**Before (desktop):** `.design/wizard-before/01-datasource-desktop.png`
**Before (mobile):** `.design/wizard-before/01-datasource-mobile.png`

- Uses a shadcn `<Select>` for connection picking. Fine UI, wrong shape — picking 1 of 2-3 saved connections is a list-of-cards problem (you want to *see* them all and the connection's identity), not a pulldown problem.
- `__demo__` displayed verbatim with no human label. The connection list API returns a `description` field (`"Sentinel Security (Cybersecurity SaaS) — demo postgres datasource"` for `__demo__`) and the picker doesn't use it.
- `dbType` (postgres / mysql / etc.) is the only secondary information shown; no health, no description, no row count, no "this is the demo dataset" callout.
- "Next" button is in the bottom-right with a chevron, but is the only action — should be the primary visual focus, full-width on mobile maybe, and label can be more directive ("Continue with default").
- Empty state ("No connections configured") is a fine empty-state pattern but the link is a bare `<a className="underline">`. Should be a button-shaped affordance pointing at `/admin/connections` since that's the next step the user must take.

### Step 2 — Tables

**Before (desktop):** `.design/wizard-before/02-tables-desktop.png`
**Before (mobile):** `.design/wizard-before/02-tables-mobile.png`

- Header copy: "Choose which tables and views to include in your semantic layer. Found 3 objects in the database." The "Found N objects" is shown after the picker has loaded — fine — but `objects` is jargon (means tables + views + materialized views). For a self-host user who just wants to pick tables, "tables" is enough.
- "3 selected" `Badge` next to the filter input is barely legible — small, secondary-colored, easily missed.
- Table rows have a `Type` column with a `Badge` (`table` / `view` / `matview`). For Postgres demos with only base tables, the column is dead weight on every row. Show only when types vary.
- Mobile (390px): table fits but the row has tiny click targets — the entire row should be clickable to toggle, not just the checkbox cell. There's a visible page-level horizontal scrollbar (caused by the desktop step indicator).
- "Generate Entities" — verb + capitalization. We don't say "Click me" elsewhere in Atlas; "Continue" or "Profile tables" reads more naturally.
- No **time estimate** on the action button. Profiling 198 rows × 3 tables takes several seconds on a real DB. The user clicks Generate Entities and gets a `<Progress value={33} />` (literally hardcoded to 33%) with copy "Profiling N tables and generating entities..." — better than nothing, but a fake progress bar is worse than honest "this can take 10-30 seconds depending on table size."

### Step 3 — Review

**Before, collapsed:** `.design/wizard-before/03-review-collapsed-desktop.png`
**Before, expanded:** `.design/wizard-before/03-review-expanded-desktop.png`
**Before, mobile:** `.design/wizard-before/03-review-mobile.png`

This is the **densest, most over-built step** in the wizard.

- Each entity row collapses to a button-row with `tableName | rowCount | columnCount | flag-badges` and a chevron. That part is OK — but expand the row and you get **a column table, an FK list, an FK-inferred list, AND a 12-row monospace YAML textarea, all stacked**. It's an admin-page disclosure rendered inside an onboarding step.
- The YAML textarea is the central editing surface and it sits at the bottom — far below the user's eye. Most users will leave it untouched.
- Notes (yellow badge) sit *below* the YAML — easy to miss for the typical user who scrolls and clicks Preview without reading.
- Column table at expanded level uses `[10px]` text and `text-xs` everywhere. Hierarchy is muddled — everything looks equally small.
- "Click to expand and edit YAML, descriptions, column types, and sample values" is a mini onboarding sentence that tries to do four things. Most users want to verify counts and continue. Editing belongs in the admin semantic editor — that's a 0.9.7 product.
- Loading state shows `<Progress value={33} />` — hardcoded fake progress. Don't ship fake progress bars.
- **`useEffect` runs on mount with `[]` deps but reads `entities`, `connectionId`, `selectedTables`** — eslint-react-hooks rule would normally flag, but the `cancelled` pattern saves it. Still, this is a code-smell to clean up while we're here.

### Step 4 — Preview

**Before:** `.design/wizard-before/04-preview-desktop.png` + `.design/wizard-before/04-preview-mobile.png`

- "Preview Agent Behavior" — the title is technical-speak for "try it out." Better: "Try a question."
- "Try asking a question to see how the agent will use your semantic layer. This step is optional." — bury the optional bit and it reads as another required step. Either lead with "Optional — try asking …" or remove the optionality language entirely (the user can always click Save & Finish).
- The "Your semantic layer includes:" panel at top is a recap from step 3, but the user just clicked through step 3 — they don't need to be reminded.
- Input + sparkle button: good shape. Placeholder ("How many orders by status?") doesn't match the demo dataset (cybersecurity SaaS — accounts, companies, people). Generic placeholders are fine but a contextual one would be better.
- "Save & Finish" — *finishing* what? The user came here to set up; the action is "Save and start chatting" or "Save."

### Step 5 — Done

**Before:** `.design/wizard-before/05-done-desktop.png` + `.design/wizard-before/05-done-mobile.png`

- A single centered card with a check icon, headline, paragraph, and two buttons. Visually identical pattern to `/signup/success` *before* PR #1943 — and signup-success was rebuilt as a starter-prompt list because flat CTA pairs convert worse than something the user can immediately *do*.
- Wizard's two CTAs are "View Entities" (admin destination) and "Start Chatting" (homepage). Most users want to *use* the agent — Start Chatting should be primary (and is) but the secondary "View Entities" sends the user into admin. A more useful secondary action is "Try a sample question" or a starter-prompt list, mirroring signup-success.
- Headline "Semantic Layer Ready" is fine. Body copy "Atlas can now understand and query your data" is good. But "You can refine the semantic layer anytime from the admin console" is a footer concern, not a primary message.

### Error states

**Connection not found (real, captured):** `.design/wizard-before/06-error-connection-not-found-desktop.png`
**Save failure (real, captured):** `.design/wizard-before/04-save-error-desktop.png`

- Errors are flat red `bg-destructive/10` strips with raw API messages: `Connection "__demo__" not found.`, `Failed to save entities: EACCES: permission denied, mkdir '/home/msywu/oss/atlas/3/semantic/.orgs'`. **The save error leaks an absolute filesystem path to the user.** That's a security finding plus a copy finding.
- No retry button on errors. The user has to click Back manually.
- No actionable guidance. "Connection not found" — what should the user do? (Answer: reload the page, the dropdown will refresh.)
- No request ID surfaced even though the wizard endpoints emit them on 5xx responses. The user has nothing to give support if something goes wrong.

The connection-not-found result also reveals a real bug: `__demo__` is in the listed connections but `/api/v1/wizard/profile` rejects it with "Connection not found." That's a backend issue, not a UI issue — file-and-leave.

### Loading states

- Datasource: spinner-only (`<Loader2 />` centered in a card). No skeleton, no copy.
- Tables: spinner + "Discovering tables..." copy. Better, but `Discovering` is jargon for "fetching."
- Review/generation: spinner + copy + fake progress bar (hardcoded 33%). The progress bar lies and should go.
- Save: a full-screen modal-style backdrop with `Loader2` + "Saving semantic layer...". This is heavy — it blocks the whole page for what is usually a sub-second write. A toast or inline button-state ("Saving…" inside the button) would be lighter and match the rest of Atlas (admin pages use button-state, not full-screen blockers).

---

## Engineering issues found while critiquing

These are NOT design — flagging here so they don't get lost during the design pass. Inline-fix where they touch lines I'm already editing; otherwise leave for follow-up issues per the bug-pass rule.

1. `<Progress value={33} />` is hardcoded fake progress in two places (review loading, save loading). Either remove the bar entirely or wire it to real progress (which the API doesn't expose, so: remove).
2. `Failed to save entities: EACCES…` leaks a filesystem path. **CLAUDE.md "No secrets in responses" violation in spirit** — the path itself is internal infra. Wizard frontend should map common errors to user copy and stash the raw message in a console.warn or details disclosure. (Server should also avoid surfacing the raw `err.message` for filesystem errors — separate issue, file-and-leave.)
3. `useEffect(() => { … }, [])` with cross-render closures over `entities`, `connectionId`, `selectedTables`. The `cancelled` flag is correct but the empty-deps array hides intent. Switch to standard guards (`if (entities.length > 0) return;` is already in place — keep, but document or refactor to a hook).
4. The wizard's connection picker shows `__demo__` and `draft_test` — internal/demo connections leak into a user-facing onboarding flow. The picker should filter or label them. (Demo branch is part of the issue scope; draft_test is real test cruft I shouldn't ship into the demo-friendly redesign.)
5. The `StepDone` component's `entityCount` reads from React state (`entities.length`). Direct nav to `?step=5` shows "0 entities have been saved" — silly but harmless. The step indicator goes to "Done" without any of the other steps being highlighted as complete. Either redirect to `/admin/semantic` if state is empty, or render the success state idempotently.

---

## Direction for the design pass

1. **Generalize the signup primitive into a shared `OnboardingShell` + `StepIndicator`.** Move `signup-shell.tsx` and `step-indicator.tsx` to `@/ui/components/onboarding/` and parameterize over a `steps` array prop. Both signup and wizard adopt it. (Or, keep signup primitives in place and add a thin wizard equivalent that visually matches — less invasive, more duplication. I'll lean on the parameterized approach since the visual contract is identical.)
2. **Drop step 4 (Preview).** It's optional, the placeholder copy doesn't match the demo dataset, and "try the agent" is what step 5 → "Start Chatting" already does. Compact to four steps: Datasource → Tables → Review → Done. Keep "Try a sample question" as a CTA on Done instead.
3. **Restructure step 1 as a card list with clear demo branding.** Two equal-weight options: "Use the demo dataset" (with the connection's `description`) and "Use your data" (collapsed picker for saved connections, link to /admin/connections if none).
4. **Soften step 3 expansion.** Default-collapsed entity rows show row count + column count + flags. Expanding shows a *summary* — first 5 columns, FKs as a list, a "View YAML" disclosure that's collapsed by default. Editing remains possible but isn't the lead.
5. **Replace fake progress with honest copy.** "Profiling tables… this can take 10-30 seconds for larger schemas."
6. **Replace raw API errors with user-facing copy.** Map known statuses (404 connection not found, 403 auth, 500 server) to actionable copy. Leak no filesystem paths. Keep the raw error in `console.warn` for support and surface a `requestId` if the API gives one.
7. **Replace step 5's "View Entities" CTA with a sample-question list,** mirroring `/signup/success`. Same 3 starter prompts, deep-link to chat with the prompt prefilled.
8. **Add a "Skip for now" link in the shell header,** routing back to `/`. Wizard is meant to be optional/repeatable.
9. **Mobile fix-up.** Wizard horizontally scrolls at 390px because the desktop step track exceeds viewport. The shared `StepIndicator` already solves this via the `Step X of Y · Label` pill — adopt it.
10. **Title pass.** Page title → "Set up your semantic layer." Step titles → goal-oriented ("Pick a datasource", "Choose tables", "Review", "Done"). Buttons → goal-oriented ("Continue", "Profile tables", "Save", "Open Atlas").
