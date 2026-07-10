# Elevate

Run the audit phase of a **feature elevation cycle**: a shipped surface works, but it's beneath its potential. Audit it in parallel dimensions, collate a ranked findings doc into `.claude/research/`, and hand off to a `/grill-with-docs` session. This command produces a **briefing, not a plan** — the grill, PRD, and issue slicing happen downstream with the user in the loop.

**Argument:** a product surface — `dashboards`, `chat`, `notebook`, `onboarding`, `semantic-layer`, … Not a single page (that's `/revamp` granularity) and not a one-issue-sized finding (that's `/investigate`).

**Lineage (the worked examples this extracts):**
- The chat turn-presentation cycle — full chat-page audit → CONTEXT.md § *Chat turn presentation* glossary → PRD #4292 → milestone `v0.0.43 — The Analyst Voice`.
- The dashboard elevation — `.claude/research/dashboard-audit-2026-07-04.md` ("prep for a `/grill-with-docs` session") → CONTEXT.md § *Dashboard editing* vocabulary.

**Where it sits:** Phase 1 ("Notice") of `docs/agents/workflow.md`, feeding `/grill-with-docs` → `/to-prd` → `/to-issues` → milestone. `/elevate` never writes the PRD itself.

---

## Step 0 — Borrow the audit-family mechanics

Read `docs/agents/audits.md` and apply these conventions (borrowed — `/elevate` is **not** a member of the `-audit` family and not part of the pre-tag battery; its job is elevation, not verification):

- **Step-0 self-verify** — check every repo path this command file references before trusting it; fix drift in the same session.
- **Discover, don't enumerate** — every list below (dimensions, surfaces, file paths) is illustrative; the discovery command or the codebase is authoritative.
- **State snapshots decay** — verify issue numbers and "currently X" claims against present reality before repeating them in the findings doc.
- **Cite, don't re-file** — a finding an open issue already tracks gets the issue link inline, never a duplicate.

## Step 1 — Derive the audit dimensions

Pick **3–5 dimensions**, derived from the surface's actual architecture. Two are always seeded:

1. **End-user UX of the surface** — what a trial admin or business user experiences.
2. **The agent/AI path through it** — if the surface has one (agent-built dashboards, chat turns, semantic generation). Elevation-grade problems concentrate at this seam.

Derive the rest from what the surface *is*: data model & persistence, draft/publish or other lifecycle, sharing/permissions, editorial voice, integration seams. The dashboard run's four — frontend viewer/editor UX, backend/data model, agent-driven building, sharing/screenshots/drafts — are a worked example, **not** a template; "sharing/drafts" existed because dashboards have that lifecycle. A `/elevate onboarding` slices differently.

Before spawning, sweep open issues for the surface (`gh issue list -R AtlasDevHQ/atlas --state open --search "<surface>"`) so agents can cite instead of rediscover.

## Step 2 — Run the parallel audits

One sub-agent per dimension, in parallel. Evidence discipline for every agent:

- **Baseline is code-reading with `file:line` anchors.** Every finding names the file and line range it stands on. No anchor, no finding.
- **The UX dimension drives the live product when feasible** — dev server + Playwright, screenshots saved into the research folder (`.claude/research/<surface>-audit-<date>/`). If the environment can't run the app, the doc says so explicitly rather than silently degrading to code-only.
- Findings state **what breaks for whom** (trial admin, business user, operator), not just what the code does.
- Agents return structured findings: severity, title, anchors, the failure scenario, and (where obvious) a fix direction.

## Step 3 — Collate, dedup, rank, verify

Merge all dimensions into one document:

- **Dedup across dimensions** — seam findings surface in multiple audits; merge them, keeping all anchors.
- **Severity ladder** from `audits.md`: CRITICAL > HIGH > MEDIUM > LOW.
- **Spot-verify the anchor findings by hand** — the CRITICALs and top HIGHs get re-read at the cited lines (or reproduced) before the doc claims them; mark these `verified`. An elevation grill built on an unverified anchor finding wastes the user's session.

## Step 4 — File the fix-invariant bugs only

Most findings stay in the doc. File a GitHub issue immediately **only** when BOTH hold:

1. The behavior is **broken or unsafe today** — not merely beneath its potential.
2. The correct fix is **identical no matter what the elevation decides** — no design decision pending on it.

Worked boundary (from the dashboard audit): a cookieless SSR fetch 403-ing every org-share viewer, or a validation error silently downgrading an org share to public — **file** (the fix is the fix, grill or no grill). Agent-built dashboards rendering an empty canvas — **doc only**: plainly broken, but the fix is entangled with the draft-model design the grill exists to settle; filing it standalone would pre-decide the design.

File per `/investigate` conventions (type + area labels, milestone, Atlas body format), and list the filed issues in the findings doc — a dedicated **"Filed this run"** list in the header, each with issue number, link, and the finding it came from — so the grill still sees the complete picture **and** the downstream `/to-issues` pass can fold them in: when the elevation's PRD is sliced, every issue filed here gets attached as a **sub-issue of the PRD** alongside the slices (they're part of the elevation's delivery even though their fixes proceed independently, and any slice that assumes one merged first names it in "Blocked by"). Fix nothing — `/elevate` mutates no product code.

## Step 5 — Write the findings doc

`.claude/research/<surface>-audit-<YYYY-MM-DD>.md`, structured as:

1. **Header** — what this is: "Prep for a `/grill-with-docs` session on elevating <surface>", which dimensions ran, whether the UX dimension had a live product, which anchor findings were hand-verified.
2. **Verdict** — the "strong engine, unfinished cockpit" move: first what is genuinely good and should be **preserved wholesale** (named, with anchors — this constrains the grill as much as the problems do), then a one-paragraph statement of where the problems live (typically: at the seams).
3. **Ranked findings** — CRITICAL → LOW, each with anchors, failure scenario, `verified` markers, issue links for anything filed in Step 4 or already tracked.
4. **Grill agenda** — the design questions the findings force, phrased as questions ("what does the canvas render for a user holding a draft?"), not solutions. This is the doc's real output: the grill walks this list.
5. **Handoff** — `Next: run /grill-with-docs with this doc.` If — and only if — the findings turned out purely presentational and page-scoped, hand off to `/revamp <page>` instead and say the grill is unnecessary.

## Step 6 — Report

Summarize to the user: verdict in one line, finding counts by severity, issues filed (with links), the grill agenda, and the handoff. Do **not** start the grill, write a PRD, or create a milestone — those are the user's moves, made through `/grill-with-docs` → `/to-prd` → `/to-issues` per `docs/agents/workflow.md`.

---

## What NOT to do

- Don't fix findings (beyond Step 4's filing) — this is a read-only briefing pass.
- Don't pre-slice findings into issues; `/to-issues` will cut different slices than the audit found.
- Don't pin new domain vocabulary in `CONTEXT.md` from here — vocabulary gets pinned *in the grill*, where the user is present.
- Don't run `/elevate` on a surface with an active elevation PRD in flight — read the PRD and `/investigate` gaps against it instead.
- Don't inflate the doc: a finding without an anchor, or a severity without a failure scenario, gets cut in Step 3.
