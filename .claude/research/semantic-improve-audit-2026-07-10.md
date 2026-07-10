# Semantic-Improve Elevation Audit — 2026-07-10

**Prep for a `/grill-with-docs` session on elevating the admin semantic-improve surface** (`/admin/semantic/improve` — the AI "Semantic Layer Improvement" console — plus the expert agent, amendment queue, and apply path behind it).

- **Dimensions run (5, parallel):** end-user UX · agent/AI path · session & persistence lifecycle · apply path & data integrity · integration seams & product wiring.
- **Live product:** NOT available for this run (no Docker in the audit environment) — the UX dimension is code-reading only, no screenshots. Every finding stands on `file:line` anchors instead.
- **Hand-verified:** the CRITICAL and all HIGH anchor findings were re-read at the cited lines by the orchestrator before this doc claims them; those carry `verified`. Findings below HIGH carry their auditing agent's anchors, spot-checked where they feed the grill agenda.
- **Issues filed (fix-invariant only):** #4484, #4485, #4486, #4487, #4488, #4489 — listed inline below.

---

## Verdict

**Sound periphery, severed spine.** The parts of this surface that are usually flimsy in a young feature are genuinely good and should be preserved wholesale:

- **The evidence tools are elevation-grade.** `profileTable` / `checkDataDistribution` enforce the table whitelist + content-mode gate and ride the unified profiler capability across plugin dbTypes (`packages/api/src/lib/tools/profile-table.ts:83-102`, `check-distribution.ts:41-69`); `validateProposal` runs its test query through the full `runUserQueryPipeline` (#3338 fix, `validate-proposal.ts:159-190`).
- **The apply discipline is real.** Group-scope write-back (#3284) resolves the row via persisted group scope and writes back to the resolved row's own group (`expert/apply.ts:63-100`); `upsertByIdentity` makes `add_*` re-applies converge instead of duplicate (`apply.ts:250-280`); every apply snapshots a version and a rollback endpoint exists (`apply.ts:106-115`, `admin-semantic.ts:959-1050`); the whitelist blast radius is structurally contained — no amendment type can touch `table:` or add an entity, so AI amendments cannot expand the queryable table set (`apply.ts:238-243, 300-342`, `whitelist.ts:143-153`).
- **The governance seams exist and are tested.** Billing gate before any LLM spend with #3437's admin-not-exempt rationale (`admin-semantic-improve.ts:401-422`), `requirePermission("admin:semantic")` (`:377`), an intent-based audit vocabulary (`lib/audit/actions.ts:298-301`), org-scoped `WHERE status='pending'` review guards (`db/internal.ts:1708-1717`), and settings-registry knobs (not raw env) for scheduler/auto-approve (`lib/settings.ts:581-633`).
- **The admin-shell wiring is unusually complete.** Sidebar entry with a live pending-count badge (`admin-sidebar.tsx:52-78,125`), hub-page entry + health widget (`admin/semantic/page.tsx:855, 896`), command-palette parity, and the DiffViewer/proposal-card presentation (`improve/page.tsx:79-105, 124-181`) is dark-mode-correct and well-shaped.

The problems live at the seams — and one seam is severed outright. The surface has **two parallel identities for "a proposal"**: an in-memory, index-keyed session store the review routes read, and a DB-backed amendment queue the `proposeAmendment` tool writes. The UI straddles both and prefers the one that was never finished: the session's proposal array is **never populated in the web path**, so every approve/reject of a chat-streamed proposal 404s, while the working DB path is hidden whenever a chat is active. Around that break, the same seam-blindness recurs in milder forms: the diff shown is computed by a different implementation, from a different document, than the apply; the agent never learns what the admin decided; auto-approve stamps rows applied-in-name-only; the expert persona is smuggled into the prompt as a "Warnings" bullet. The engine (tools, apply, gates) deserves a cockpit that actually connects to it.

---

## Ranked findings

### CRITICAL

#### C1 — Chat-proposal review is structurally dead: every approve/reject of a streamed proposal 404s `verified` → **filed #4484**
All four code dimensions independently converged here.
- **Anchors:** `admin-semantic-improve.ts:474` (`createSession([])`); `expert/session.ts:40-49` (`proposals` readonly, no mutator; only populator in repo is CLI `packages/cli/lib/improve/interactive.ts:221`); `admin-semantic-improve.ts:331,343` (`state.proposals[index]` → `undefined` → 404); `improve/page.tsx:244-286` (`extractProposals` reads `diff`/`testResult` from the tool result but drops `proposalId`); `:395-404` (no-`dbId` proposals route to `/proposals/{index}/approve`); `propose-amendment.ts:251-259` (the tool already returns the DB `proposalId`).
- **Failure scenario:** trial admin runs the flagship "Run Analysis" flow; every Approve/Reject click errors with "Proposal not found. Start an improvement session first." while a session is visibly running. The UI hides the DB pending list (the only working path) whenever chat proposals exist (`page.tsx:356`), so mid-session there is **no working approval path at all** — the admin must reload and lose the chat. `ADMIN_ACTIONS.semantic.improveAccept` can never fire in production; the OpenAPI `/proposals/{id}/approve` contract is unfulfillable. Tests pin only the 404/400 branches.
- The **minimal fix** (thread `proposalId` → `dbId`, review via `/amendments/{id}/review`) is filed as #4484; the **design decision** — one proposal identity, and whether the session store/`/sessions` routes survive at all — is grill agenda Q1.

### HIGH

#### H1 — Dual proposal identity: in-memory index-keyed sessions vs DB amendment rows, with the UI straddling both `verified` (doc-only — the grill's centerpiece)
- **Anchors:** `propose-amendment.ts:242-252` (DB insert per proposal) vs `admin-semantic-improve.ts:47` (module-level `sessions` Map) · `improve/page.tsx:356` (source swap) · `:384-405` (two divergent review paths keyed on `dbId` presence).
- **Consequences today:** every chat proposal leaves a pending DB row regardless of in-chat outcome, so `/pending-count` inflates and reloads re-present "decided" proposals (decisions live only in a client-side Map, `page.tsx:295-297`). If C1 were fixed *naively* by populating session state, the two paths become double-approvable: chat approve applies YAML but never flips the DB row; a later DB-path reject then stamps a live, already-applied change "rejected" — the audit trail lies.
- **Sub-findings folded in:**
  - **Durability:** the Map is per-process, wiped on every deploy/restart; the client's `sessionIdRef` dangles and the server silently mints a fresh session for unknown ids (`admin-semantic-improve.ts:388,469-479`; `page.tsx:300-316`). All three SaaS regions pin `numReplicas: 1` (`deploy/api*/railway.json`) — this Map is a *second* hard coupling to that pin alongside the MCP session map (precedent: #2109, ADR-0020).
  - **No eviction:** `sessions.set` is the only mutation; no TTL/cap anywhere (`admin-semantic-improve.ts:478`); `GET /sessions` iterates the whole Map per request (`:539`).
  - **Cross-admin cross-talk:** review routes never pass a `sessionId`, so `findSessionForProposal` falls back to "most recent session for the org" (`:336-345`) — two admins reviewing concurrently would mutate each other's sessions, and an index can silently resolve to a *different* proposal than the card clicked.
  - **Forced-skip semantics:** `advanceAndRecord` (`:352-368`) silently marks everything below the approved index `skipped`, then 409s later reviews of cards the user never touched; the UI models cards as independently decidable and has no skip affordance (`page.tsx:184-214`).
  - **Dead API surface, documented:** `/sessions` + `/sessions/{id}` have zero consumers (web/SDK/CLI) and can only ever return `total: 0, proposals: []`, yet ship in `apps/docs/openapi.json:62822,62927` and generated API-reference pages.
- **Failure scenario:** every path an admin can take through a multi-turn review session ends in confusion, data mismatch, or a lying audit row.

#### H2 — `proposeAmendment` executes its test query raw and persists unmasked rows `verified` → **filed #4485** (security)
- **Anchors:** `propose-amendment.ts:195-208` (`db.query(testQuery, 30000)` after `validateSQL` — no `runUserQueryPipeline`, so no RLS, masking, auto-LIMIT, approval gating, or audit row); `:205-249` (5 raw `sampleRows` persisted into `learned_patterns.amendment_payload`); contrast the #3338-fixed sibling `validate-proposal.ts:159-190`.
- **Failure scenario:** RLS bypass + unbounded scan on an LLM-authored query; raw tenant data at rest in the internal DB, served to the UI via `/pending` (`admin-semantic-improve.ts:861-875`).

#### H3 — Auto-approved interactive amendments are stamped approved but never applied (ghost approvals) `verified` → **filed #4486**
- **Anchors:** `db/internal.ts` status resolution (`meetsThreshold && typeEligible → "approved"`, ~:1585); `propose-amendment.ts:242-256` (reports `auto_approved`, never applies); only the scheduler applies on approved (`scheduler.ts:136-152`); `approved` is invisible to the pending queue (`internal.ts:1670-1679`).
- **Failure scenario:** with auto-approve enabled, every eligible interactive amendment silently vanishes — DB says approved, layer unchanged, the diff the agent showed was fiction.

#### H4 — Approve-what-you-saw is not guaranteed: diff computed by a different implementation, from a different document, at a different time than the apply `verified` → **filed #4488** (the fix-invariant slice)
- **Anchors:** `propose-amendment.ts:133-137` (baseline read from flat `getSemanticRoot()/entities/<name>.yml`; org entities live in DB + `.orgs/<orgId>/entities/` mirror, `context-loader.ts:224`; groups per ADR-0012) · `propose-amendment.ts:25-85` vs `expert/apply.ts:283-345` (divergent `applyAmendment` twins: blind-push/silent-skip vs upsert-by-identity/throw) · no base-content hash: the stored diff is never recomputed and apply detects no drift between propose and approve.
- **Failure scenario:** on SaaS the propose step errors "Entity file not found" for DB-only tenant entities — the flagship flow breaks *before* C1's break — or the admin approves a diff describing a change other than what apply writes.
- #4488 covers the baseline read + implementation consolidation; whether propose/diff/apply should collapse into one seam with a staleness check is grill agenda Q4.

#### H5 — NULL-org amendments are visible and reviewable by every workspace on SaaS `verified` → **filed #4487** (security)
- **Anchors:** `(org_id = $1 OR org_id IS NULL)` in count/list/review (`internal.ts:1633-1638, 1670-1679, 1708-1717`); scheduler inserts `orgId: null` unconditionally (`scheduler.ts:123`); fiber registers gated only by a setting, no deploy-mode guard (`lib/effect/layers.ts:1819-1852`).
- **Failure scenario:** flip `ATLAS_EXPERT_SCHEDULER_ENABLED` on a SaaS region and every tenant sees (and any tenant admin can consume) global amendment rows — including `testResult.sampleRows` row data. Latent (default off) but fail-open.

#### H6 — The expert agent is a "Warnings" bullet, not a mode: prompt smuggled, context impoverished, analyzer dead in the chat path `verified` (doc-only — design)
- **Anchors:** route builds a 25-line persona and passes it as `warnings: [expertSystemPrefix]` (`admin-semantic-improve.ts:434-464`); `agent.ts:758` renders it as `"## Warnings\n\n- You are the Atlas Semantic Expert Agent…"` — one giant bullet appended *after* the full standard analyst persona (two conflicting identities; the variable says "prefix", it lands as a suffix). The agent gets no health score, no audit-pattern summary, no analyzer output up front — `analyzer.ts`/`scoring.ts`/`categories.ts`/`profile-cache.ts` run only in the scheduler tick and CLI (`packages/cli/src/commands/improve.ts:265-267`); the health endpoint itself calls `computeSemanticHealth` with `profiles: []`/`auditPatterns: []` (`admin-semantic-improve.ts:983-989`). `maxSteps: 15` is hardcoded (`:463`), bypassing `getAgentMaxSteps()`/workspace tuning — the canned "Run Analysis" sweep buys ~2-3 findings before silently stopping.
- **Failure scenario:** the agent rediscovers deterministic facts through LLM tool calls, stops mid-analysis, and behaves as an analyst-with-a-warning rather than an expert-with-a-briefing.

#### H7 — The agent never learns decisions; "rejected won't be re-suggested" is false for the chat path `verified in mechanism` (doc-only — design)
- **Anchors:** the prompt instructs "Wait for the user to approve or reject" (`admin-semantic-improve.ts:441`) but panel decisions inject nothing into the chat; the working DB review path never touches session state; `rejectedKeys` only fills via `recordDecision` (`session.ts:71-75`), which never fires on the web; the DB-backed `loadRejectedKeys` (30-day window, `context-loader.ts:491-533`) is consumed only by scheduler + CLI; `proposeAmendment` does no rejected-key check before insert and `pattern_sql` is uniquified with `Date.now()` (`internal.ts:1605`) so nothing dedups.
- **Failure scenario:** admin rejects an amendment; the agent re-proposes it next session, minting a fresh pending row each time; the route docstring's promise (`:255`) is unbacked.

### MEDIUM

#### M1 — `/amendments/{id}/review` approve is non-atomic: peek → apply YAML → flip status (doc-only)
- **Anchors:** `admin-semantic-improve.ts:894-927`. Races: concurrent approves both pass the peek; the loser gets 404 "not found or already reviewed" *after the YAML applied* — response contradicts reality, audit `improve_apply` skipped for a real mutation. Approve racing reject → applied change recorded "rejected". Crash between apply and flip → applied-but-pending row. Mitigated to MEDIUM by idempotent re-apply (`upsertByIdentity`). Fix direction: claim-then-apply (`UPDATE … WHERE status='pending' RETURNING`), compensate on apply failure.
- Also: `if (payload)` skips the apply entirely for a null/corrupt payload and still stamps approved (`:903-923`) — a silent no-op approval bypassing the guard `applyAmendmentFromPayload` exists to enforce (`apply.ts:194-198`).

#### M2 — Approved amendments bypass the content-mode draft→publish pipeline (doc-only — needs a recorded decision)
- **Anchors:** `apply.ts:100` → `upsertEntityForGroup` hard-codes `status='published'` (`entities.ts:288-297`); `semantic_entities` IS in `CONTENT_MODE_TABLES` (`content-mode/tables.ts:60-91`); CLAUDE.md says promotion happens only via `/api/v1/admin/publish`, carve-outs need recorded rationale — none exists.
- **Failure scenario:** admin holds a draft edit of `orders`; approves an amendment to `orders`; amendment lands on the published row only; the next atomic publish promotes the draft **over** it — silently reverting an approved change.

#### M3 — Approving an `add_glossary_term` amendment is a silent no-op (doc-only — implement-or-remove is a product decision)
- **Anchors:** analyzer generates the type (`categories.ts:305-330`); both apply implementations no-op it (`apply.ts:337-338` "don't modify entity files"; `propose-amendment.ts:79-81` claims "handled separately" — no separate handler exists). Approval still re-dumps the unchanged entity and records a junk version snapshot (`apply.ts:97-114`).
- **Failure scenario:** admin believes a glossary term was added; the glossary — which drives ambiguity clarification — never changes.

#### M4 — No EntityShape/SQL validation before an LLM-authored amendment lands in the published layer (doc-only — the validation-bar question is grill scope)
- **Anchors:** `apply.ts:88-100` (mutate → dump → upsert, no `EntityShape` parse); `update_dimension` is `Object.assign(target, amendment)` (`apply.ts:328`) — can overwrite `name`/`sql`/`type` or inject junk keys; measure/pattern SQL is never parse-validated at apply time (`validateProposal` is an optional tool the LLM may skip, not a gate; nothing programmatic consumes its verdict — `validate-proposal.ts`, no status write-back). Backstop is real (executeSQL re-validates at query time; no whitelist escape) but a poisoned amendment corrupts the "authoritative" context every SQL generation reads until rollback.

#### M5 — `AmbiguousEntityError` 409 is a dead end the admin cannot resolve from the UI (doc-only)
- **Anchors:** contract deliberately preserves `groups` on 409 (`entities.ts:1029-1039`, `admin-semantic-improve.ts:597-606`) but the review body accepts only `{ decision }` (`:757-764`) and the frontend renders a generic `MutationErrorSurface` (`page.tsx:561`) — no group picker. An amendment on a cross-group-ambiguous entity is permanently unapprovable; only reject succeeds.

#### M6 — Presentation batch: the chat pane is a downgrade from the main chat surface (doc-only — `/revamp`-grade slice inside the elevation)
- **Anchors:** raw `<p>` for agent prose — no markdown while every other surface uses `chat/markdown.tsx` (`page.tsx:468-470`); reasoning parts dropped (`:489`); tool spinner gates on AI SDK v4's `state === "call"` — v5/v6 use `input-streaming`/`input-available`/`output-available`, so it never spins, and `output-error` renders identically to pending (`:480-485` vs `ui/lib/helpers.ts:16-19`); billing/permission errors render as raw JSON with no upgrade CTA or Retry-After countdown, unlike `chat/error-banner.tsx` (`page.tsx:505-512`); failed/auto-approved proposals render as approvable cards with fabricated default `0.5` impact/score the tool schema doesn't even accept (`page.tsx:256-281`, `propose-amendment.ts:94-121`); "Run Analysis" vanishes permanently after any message, including a failed first attempt (`:426`).

#### M7 — `/health` status discriminator computed but consumed nowhere; absent from the OpenAPI schema (doc-only)
- **Anchors:** route returns `{ …score, status, parseFailures, totalRows }` with a comment promising "the widget can distinguish" corrupt vs empty (#2503) (`admin-semantic-improve.ts:991-1009`); the widget's interface omits all three (`semantic-health-widget.tsx:10-20`); response schema omits them (`:800-812`); `no_entities` is unreachable since the hub renders the widget only when entities exist (`semantic/page.tsx:896`). A fully-corrupt workspace still sees an unexplained 0%.

#### M8 — Improve chat is invisible to origin-scoped approval rules; its registry guard is vacuous (doc-only — governance)
- **Anchors:** `agent-surface-registry.test.ts:79-85` — the `bindingProof` regex matches the `runAgent` invocation itself, so the F-54/F-55 assertion can never fail for this file; the route never stamps `agentOrigin` and is absent from `KNOWN_ORIGIN_STAMPERS` (`:111-129`). Origin-scoped approval rules (#2072) silently no-op for the expert agent.

#### M9 — Cross-origin deploys silently lose the session: `x-session-id` is not CORS-exposed (doc-only; moot if the session store is deleted)
- **Anchors:** `lib/cors.ts:79` exposes `x-conversation-id`/`x-run-id` but not `x-session-id`; `page.tsx:313` reads it. Cross-origin admin: new server session per turn, `resumed: false` audit rows, Map grows per message.

#### M10 — `validateProposal` residue (doc-only; partially superseded by #4485's pipeline consolidation)
- **Anchors:** fetches `learned_patterns` by raw id with **no org filter** (`validate-proposal.ts:43-50`) — cross-org read (and test-query execution against this org's connection) if an id leaks; stage-1 "YAML validation" parses concatenated `+` lines across hunks as YAML (`:96-113`) — false negatives on multi-hunk diffs; verdict persists nowhere and gates nothing.

#### M11 — Wizard enrich: unmetered, ungated LLM spend `verified` → **filed #4489**
- **Anchors:** `wizard.ts` `/enrich` (`:373+`) → `enrichEntityYaml`; `semantic/enrich/index.ts:216,341,438` `generateText` with zero billing references — vs the improve chat's `checkAgentBillingGate` (#3437: admin surfaces not exempt). Adjacent surface, found at the seam comparison; distinct from #4465.

### LOW

- **L1 — Docs drift on `apps/docs/content/docs/guides/semantic-expert.mdx`:** claims sessions persist across navigation (false — ref + per-process Map, `:250-252`); documents the dead `/sessions` + broken `/proposals/:id/approve` while omitting the actually-used `/pending` + `/amendments/{id}/review` (`:258-264`); threshold-disable copy contradicts the settings registry (`:110` vs `lib/settings.ts:619`).
- **L2 — Sidebar pending-count polls every 60s for every admin regardless of `admin:semantic` permission** — silent 403s in logs (`admin-sidebar.tsx:56-75`).
- **L3 — Layout nits:** page height assumes 4rem chrome vs actual 3.5rem top bar (`page.tsx:408` vs `admin-top-bar.tsx:26`); no narrow-viewport stack for the always-horizontal `ResizablePanelGroup` (`page.tsx:436-546`, the repo's only consumer of the primitive).
- **L4 — `searchAuditLog`:** interpolates `HAVING COUNT(*) >= ${threshold}` (z.number()-bounded, but non-finite → SQL syntax error) and silently scans un-org-scoped when org pooling is off (`search-audit-log.ts:50-52, 93`).
- **L5 — Version-snapshot and disk-mirror-sync failures are warn-only** with no signal in the approve response — a failed snapshot silently removes that change's rollback target (`apply.ts:116-138`).

---

## Grill agenda

The design questions the findings force — walk this list in the `/grill-with-docs` session:

1. **What *is* a proposal?** One identity (the `learned_patterns` row the tool already creates) or two? Do the in-memory session store, `/sessions` endpoints, and `/proposals/{index}/*` routes survive in any form — durable (ADR-0020 precedent), or deleted? (C1, H1)
2. **What does the admin hold while reviewing** — a live stream artifact or a durable queue item? Should the proposals panel unify live-session and pending-queue items into one list instead of silently swapping sources? What happens to "(N pending)" when both exist? (H1, M6)
3. **When an admin decides, what does the agent learn — and how?** Synthetic chat message, regenerated session context, DB-backed rejected keys threaded into the system prompt, a dedup check at insert? What backs the "will not re-suggest" promise? (H7)
4. **What guarantees approve-what-you-saw?** One shared mutation implementation for diff and apply, a base-content hash rejecting stale approvals, recomputing the diff at review time — which, and where does the diff get computed (org/group scope)? (H4, M1)
5. **Is the expert agent a *mode* of `runAgent` or a Warnings bullet?** What deterministic context gets front-loaded (health score, audit patterns, analyzer output, prior decisions) vs tool-discovered? Does the analyzer pipeline serve the chat path at all, and should `maxSteps` follow the workspace knob? (H6)
6. **What is the scheduler's SaaS story?** Per-org autonomous ticks against DB entities, or self-hosted-only forever (deploy-mode boot guard)? Who gets notified when autonomous amendments queue — is the passive 60s badge enough? (H5, seams)
7. **Do amendment applies enter the content-mode draft pipeline** (land on the draft row, surface in `/mode` draftCounts, promote via `/admin/publish`) **or get a recorded carve-out** per the content-mode doc's rules? What prevents the draft-clobber revert? (M2)
8. **Glossary amendments: implement or remove?** If implemented — where does a group-scoped glossary write live? (M3)
9. **What is the validation bar before an LLM-authored amendment lands in the published layer?** EntityShape parse of the post-apply document, `validateSQL` on embedded SQL, `validateProposal` promoted from advisory tool to persisted gate the review UI surfaces? (M4, M10)
10. **What does the review UI owe the failure cases?** A group picker on `AmbiguousEntityError` 409, distinct rendering for auto-approved/failed/stale proposals, parity with the main chat surface (markdown, tool states, billing errors)? (M5, M6)

## Handoff

**Next: run `/grill-with-docs` with this doc.** The findings are architectural (identity model, prompt seam, lifecycle, governance), not merely presentational — `/revamp` would be the wrong tool; only M6/L3 would fit it, and they should ride the elevation instead.

Filed this run: #4484 (dead review path), #4485 (test-query pipeline bypass, security), #4486 (ghost auto-approvals), #4487 (NULL-org cross-tenant scoping, security), #4488 (flat-root diff baseline), #4489 (wizard billing gate). Cited, not re-filed: #2109, #3338, #3437, #4465, #2072, ADR-0012, ADR-0020.

**Audit-command drift (Step 0):** none — every path `/elevate` references exists (`docs/agents/audits.md`, `docs/agents/workflow.md`, `.claude/research/`, `dashboard-audit-2026-07-04.md`).
