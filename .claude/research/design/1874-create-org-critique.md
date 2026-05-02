# `/create-org` design critique — 1.3.0 Bucket 5 (#1874)

**Branch:** `1874-create-org-design-pass`
**Source:** `packages/web/src/app/create-org/page.tsx` (137 LOC, single file)
**Sibling treatments to mirror:** `/login` (#1872 → PR #1941), `/signup/*` (#1873).
**Companion docs reference:** `apps/docs/content/docs/guides/organizations.mdx` calls out the route by name. No screen­shots in docs to invalidate.

---

## What this page is

`/create-org` is the **multi-org creation surface** for a *signed-in* user — distinct
from `/signup/workspace`, which is part of the new-user signup flow. A user lands here
when they want to spin up an *additional* workspace (e.g. consulting client, side
project, sub-org). The mutation is `authClient.organization.create()` (Better Auth
org plugin) followed by `setActive()` and a redirect to `/`.

Backend-wise the route exposes only **two fields**: `name` + `slug`. Region selection
is **not exposed** at this surface today — that lives at `/signup/region`, gated by
F-31 availability detection. Plan / billing implications also aren't surfaced
(create-org doesn't trigger a Stripe customer; org-level billing happens later in
`/admin/billing`). The issue's scope mentions both but they're "if exposed" — for
this pass I'll leave them out and call it out in the PR body, otherwise we're adding
features which the brief explicitly forbids.

---

## Findings

### 1. Visual hierarchy — generic centered card, no chrome

- The whole page is a `<Card max-w-md>` floated in the center of an empty
  `bg-background` viewport. No header bar, no breadcrumb, no link back to the
  current workspace. A user who came here by mistake has nowhere to go but the
  browser back button.
- The icon-in-pill + title + description pattern is fine — it matches the
  `/signup/workspace` and `/login` aesthetic — but the card itself is what
  *contains* the icon, so the whole composition feels like one undifferentiated
  block. Compare to login (#1941): hero (icon + title + supporting copy) lifted
  *outside* the card; the card holds only the form. Result: clearer hierarchy and
  a more confident page rhythm.
- Background is flat. Login and the signup flow now use a soft radial-gradient
  backdrop in `--primary` (defined in the login layout) to add warmth without
  visual aggression. Create-org has none.

### 2. Information architecture — "where am I and how do I get back?"

- This is the **only** authenticated form route in the app that has *no* shell
  chrome (no top bar, no org switcher, nothing). Every other authenticated route
  goes through the app shell.
- A user who clicks the org-switcher's "+ Create organization" gets dropped into a
  page that gives no signal that they're still signed in or which org they were
  just looking at. A simple back-link ("← Cancel and return to {currentOrg}") fixes
  this without adding any feature.
- Title "Create your **organization**" / description "Set up your **workspace**"
  uses two terms for the same thing. Pick one. The signup flow standardized on
  *workspace* in #1873. Stay consistent.

### 3. Cognitive load — slug field is doing too much, silently

- Slug auto-generates from name and silently truncates at 48 chars; user has no
  sense the limit exists until they hit it manually. The signup-flow workspace
  page (`packages/web/src/app/signup/workspace/page.tsx:30-42`) already uses
  Zod + RHF with regex `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$` and surfaces the
  rule in `<FormDescription>`. Create-org is plain `useState` + custom slugify.
  Inconsistent UX *and* duplicated logic.
- No live preview of where the slug actually shows up. The current copy says
  "Used in URLs and API calls" — abstract. A monospace preview (`app.useatlas.dev/<slug>`)
  makes the consequence concrete.
- "Lowercase letters, numbers, and hyphens only" is the *rule*, not the
  *consequence*. The signup workspace page uses the same wording so we shouldn't
  diverge on this — but we *can* add an inline preview to clarify.

### 4. Error states — single-string `text-destructive`, no role/icon/structure

- Error rendering is `<p className="text-sm text-destructive">{error}</p>`. No
  `role="alert"`, no `aria-live`, no icon, no structured title/body. Slug
  collision ("slug already exists"), permission errors, billing errors all render
  identically as thin red text.
- The login page (#1941) introduced a categorized error parser
  (`parse-sign-in-error.ts`) with discriminated-union `kind` and a styled
  `<SignInErrorAlert>` box. We need the same shape here. Categories that matter
  for create-org:
  - **slug_taken** — most common, deserves dedicated copy ("That URL is already
    in use. Try a different one.")
  - **permission_denied** — Better Auth returns `code: "FORBIDDEN"` / 403 if the
    user is org-creation-restricted (enterprise can disable this).
  - **billing_required** — SaaS paid plans may gate creating additional orgs;
    surface a link to billing.
  - **network** — `TypeError` (login pattern) → "Can't reach the server".
  - **unknown** — fallback.
- Better Auth's create() returns `{ error: { message } }`. We need to inspect
  message contents to bucket — same approach as `parse-sign-in-error.ts`.

### 5. Submit affordance — text-only, no spinner

- Button shows `"Creating..."` text only. Login pulled in `<Loader2>` for visual
  parity. Cheap fix.
- No `disabled` on the inputs while loading, so the user can keep typing into a
  field that's about to be sent. Login disables all inputs during submit.

### 6. Success path — silent failure on `setActive`

- Lines 63-71 of the source: if `organization.create` succeeds but
  `organization.setActive` throws, we `console.error` and silently push to `/`
  anyway. The user lands in their *previous* org with no signal that the new one
  was created (it'll appear in the org switcher, but that's not obvious). The
  signup workspace page (lines 92-100) already does it correctly: surface the
  partial-failure state and ask the user to reload.
- This is a CLAUDE.md "Never silently swallow errors" violation. Mirror the
  signup-flow pattern: show the partial-failure error and don't redirect.

### 7. Plan / billing framing — out of scope but worth a note

- Issue scope mentions "Plan / billing implication framing". For self-hosted and
  SaaS-free, there's no billing implication to creating a workspace. For SaaS
  paid plans on a per-seat / per-workspace model, there *is* a cost.
- Today the page surfaces nothing about this. Long-term that's a real gap —
  user creates a workspace, gets surprise-billed at month end. But: surfacing
  plan implications requires reading workspace + plan state, which is a feature
  addition, not a UI revamp. **Recommendation:** out of scope for this pass —
  file a follow-up to surface the implication once the underlying state is
  available.

### 8. A11y / form semantics

- Form is unstructured `<div className="space-y-2">` blocks with `<Label htmlFor>`
  — works but isn't using the shadcn `<Form>` primitives that signup-workspace
  uses (FormField/FormItem/FormControl/FormMessage). RHF + Zod gives us inline
  validation hints next to each field for free.
- No `noValidate` on the form — native browser tooltips will fight the styled
  alerts.
- `autoFocus` on name is good. Slug field has no `autoComplete="off"` so password
  managers occasionally fill it.

### 9. Mobile

- The `<Card max-w-md>` works fine at 390px. No specific issues on mobile other
  than inheriting all the desktop findings. The signup flow's `<SignupShell>` is
  not appropriate here — it has step indicators which would be misleading
  (create-org is a single-step action, not a flow). We want the *visual* tone
  but not the chrome. **Decision:** don't reuse `<SignupShell>` directly; mirror
  the **`/login`** layout pattern (`layout.tsx` with a soft radial backdrop, no
  step indicator), since both are single-screen surfaces.

---

## Plan for the revamp

1. **Layout file** — add `packages/web/src/app/create-org/layout.tsx` mirroring
   `login/layout.tsx`: `min-h-dvh`, soft radial-gradient backdrop in `--primary`,
   centered max-w-md container.
2. **Hero out of card** — icon + title + supporting copy above the card; card
   contains only the form.
3. **Term consolidation** — "workspace" everywhere (consistent with signup,
   org-switcher).
4. **RHF + Zod + shadcn Form** — match `signup/workspace/page.tsx`. Reuse the
   slug regex and slugify helper.
5. **Slug preview** — small monospaced "app.useatlas.dev/<slug>" beneath the
   slug field, updates live. (Use `window.location.host` so self-hosted shows
   the real host.)
6. **Categorized errors** — extract a `parse-create-org-error.ts` with a
   discriminated union (slug_taken, permission_denied, billing_required, network,
   partial_activation, unknown). Render with the same styled alert box pattern
   from login.
7. **Spinner + disabled inputs** — `<Loader2>` on submit, disable inputs during
   loading.
8. **Surface partial-activation failure** — don't silently swallow setActive
   errors.
9. **Cancel / back affordance** — small "← Cancel" link above the card pointing
   to `/`. No router.back() — that's brittle when entered via direct URL.

## Out of scope — call out in PR body

- Plan / billing implication framing — needs backend signals not yet wired.
- Region selection — only exposed in `/signup/region` flow; not surfaced here.
- Org-creation-restricted UI gate — separate F-* item.

## Files to add / change

- `packages/web/src/app/create-org/layout.tsx` — NEW (mirrors login/layout.tsx)
- `packages/web/src/app/create-org/page.tsx` — REWRITE
- `packages/web/src/app/create-org/parse-create-org-error.ts` — NEW
- `packages/web/src/app/create-org/parse-create-org-error.test.ts` — NEW (mirrors
  parse-sign-in-error.test.ts shape — categorization + ordering invariants)
- `.design/create-org/before-*` + `after-*` screenshots
