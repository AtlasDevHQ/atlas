# Architecture review — 2026-06-09

Output of an `improve-codebase-architecture` run (the 89th+ candidate batch; prior completed wins live in `architecture-wins.md`). Three Explore sweeps: datasource/agent-tools spine, integrations/install pipeline, web/CLI/scheduler/EE surfaces. Candidates below are **not yet done** — move an entry to `architecture-wins.md` when it ships.

Vocabulary per the skill: module / interface / seam / deep / shallow / locality / leverage. Strength: Strong > Worth exploring > Speculative.

---

## 1. One semantic-membership validator behind three query dialects — **Strong** ← *in progress (this branch)*

**Files:**
- `packages/api/src/lib/semantic/whitelist.ts`
- `packages/api/src/lib/tools/sql.ts` (~528–554, table membership)
- `plugins/elasticsearch/src/dsl.ts` — `validateIndexAccess` (~289–366)
- `plugins/salesforce/src/validation.ts` — `validateSOQL` (~140–203)
- `packages/plugin-sdk/src/types.ts` — `connections.tables()` accessor

**Problem:** #3312 made three Datasource dialects (SQL, ES Query DSL, SOQL) enforce the same invariant — only semantic-layer entities are queryable — with three implementations of membership checking, case-insensitivity, and the empty-whitelist structural-only fallback. A fix to one copy doesn't reach the other two, on a surface CLAUDE.md classes as security. Both plugins also duplicate an 11-line try/catch around the throwing whitelist accessor (#3313).

**Solution:** Each dialect keeps its own name extractor (AST for SQL, index parsing for ES, FROM-clause regex for SOQL); membership semantics move behind one validator module with one canonical test set. Follow-up (publish-sequenced, since plugin-sdk is published): accessor returns a `degraded` flag instead of throwing.

**Wins:** locality — whitelist bugs land in one module; leverage — one interface, three dialects (a fourth dialect gets validation free); fail-closed semantics stated once, continuing the #3232/#3243 arc.

**Scope decision (implementation, this branch):** reading the code narrowed the deep module. The dialect validators' structural rails genuinely differ (ES interleaves membership with its wildcard-pattern rule; SQL adds schema qualification, CTE exclusion, org-scoped hot-reload) — extracting a "membership checker" out of them would be a pass-through (~5 lines reappear per dialect; fails the deletion test). The real duplication is the **load policy**: both plugin tools copied the #3243/#3313 fail-closed try/catch (~20 ln each) and both `initialize()`s copied the structural-only/scan-failed registration warning (~15 ln each), with the security contract living in comments. Shipped as `packages/plugin-sdk/src/semantic-whitelist.ts` — `gateOnSemanticWhitelist` + `warnIfStructuralOnly` + a per-dialect `SemanticWhitelistSubject` vocabulary, with the canonical test set in plugin-sdk. The core SQL path stays as-is: `@atlas/api` doesn't depend on plugin-sdk, and coupling scaffold-bound source to the plugin-sdk publish train isn't worth absorbing five lines. **Publish sequencing:** plugin-sdk 0.0.7 → 0.0.8 bumped here; ES/SF plugin peer ranges moved to `>=0.0.8`; publish plugin-sdk before publishing either plugin (template refs untouched per the publish-then-bump rule).

---

## 2. Collapse the Form-install persistence spine — **Strong**

**Files:** `packages/api/src/lib/integrations/install/{email,webhook,obsidian,linear-apikey,github-pat}-form-handler.ts`

**Problem:** Every Form install handler repeats the same spine: Zod parse → SaaS keyset gate → `encryptSecretFields` → `workspace_plugins` upsert → returned-id invariant check (~80 lines × 5 ≈ 400 duplicated lines; email/webhook are 95% identical). The Workspace Install write path has five places to be wrong.

**Solution:** One `persistFormInstall` module owns the spine (keyset gate, encrypt, upsert, id invariant, optional post-persist hook for Email's lazy-evict). Handlers shrink to parse-and-validate + one call.

**Wins:** upsert invariant lives once; ~320 lines deleted; one spine test; a sixth Form install is parse + one call.

---

## 3. Static-bot install orchestrator over five Chat Platform bridges — **Worth exploring**

**Files:** `packages/api/src/lib/integrations/install/{telegram,discord,teams,whatsapp,gchat}-static-bot-handler.ts` (3,341 lines total)

**Problem:** Five Static-bot handlers share one skeleton — routing-id validation, cross-Workspace ownership pre-check (five near-identical SQL queries differing only in the config field name), Platform reachability probe, cap gate, persist — while the genuinely Platform-specific ~20% (API endpoints, error classes) is buried in 500–900-line files.

**Solution:** An orchestrator module owns the skeleton; each Chat Platform supplies a small bridge adapter (validate routing-id, check ownership, probe reachability, shape extras). Builds on the #3140 spine and #3167 DB-enforced uniqueness — both stay behind the same seam.

**Wins:** ownership check stated once; 6th Platform = one bridge adapter; skeleton tested once, bridges tested small. Five real adapters justify the seam today.

---

## 4. Deepen admin config pages behind `useConfigForm` — **Shipped** → wins #89

Shipped as `packages/web/src/ui/hooks/use-config-form.ts` + migrations of proactive-chat and both audit retention panels. Implementation survey narrowed the candidate sharply: the original "16 pages" count conflated the hand-wired config-form loop with CRUD-of-many dialogs, action pages, and react-hook-form surfaces. Remainder notes for future passes:

- **email-provider** (`admin/email-provider/page.tsx`) — has the loop, but its reset key is deliberately *narrower* than data identity (`provider|fromAddress|installedAt` — secrets are never echoed back, so values intentionally don't mirror server state), and the reset also clears page-level test/error state. Fitting it would need a `resetKey` override + post-reset callback on the hook — add those options only when a second consumer wants them.
- **branding** (`admin/branding/page.tsx`), **model-config** (`ui/components/admin/model-provider-section.tsx`) — already delegate dirty/reset to react-hook-form (zod per-field validation, `FormField` context). Converting RHF → `useConfigForm` is a rewrite, not a deepening; revisit only if RHF gets retired.
- **sandbox** (`admin/sandbox/page.tsx`, self-hosted view) — dirty flag exists but the save conditionally fans out to *two* settings endpoints (`ATLAS_SANDBOX_BACKEND`, `ATLAS_SANDBOX_URL`) or a reset call; multi-endpoint saves are out of the hook's scope by design.
- **sso enforcement, residency, custom-domain, cache, scheduler** — action/confirm flows without a form-state copy; **approval, compliance, connections, semantic, settings, scim, ip-allowlist, oauth-clients, roles, prompts** — CRUD-of-many via dialogs (dialog reset-on-open is a different loop). Candidate 5 (`usePaginatedTable`) covers the list halves of these.

---

## 5. Deepen admin list pages behind `usePaginatedTable` — **Worth exploring**

**Files:** `packages/web/src/app/admin/{audit,usage,learned-patterns,sessions,prompts,scheduled-tasks}/page.tsx`

**Problem:** Six list pages each re-implement query-string building, fetch cancellation (`cancelled` flag), and pagination state wiring (~60 lines each). The interface each page wants — rows, total, loading, page — is tiny; every page carries the whole implementation.

**Solution:** A `usePaginatedTable<T>` hook owns the loop, composing with the existing nuqs `search-params.ts` convention. Pairs naturally with candidate 4.

**Wins:** cancellation bugs fixed once; ~360 lines deleted.

---

## 6. One shaped result behind three scheduled-delivery renderers — **Worth exploring**

**Files:** `packages/api/src/lib/scheduler/format-email.ts` (103 ln), `format-slack.ts` (36 ln), `format-webhook.ts` (38 ln)

**Problem:** Three delivery formatters each re-derive section ordering and metadata from `(task, result)`; row truncation (`MAX_DATA_ROWS = 50`) exists only in the email copy, so Slack and webhook recipients get unbounded tables — the rule lives in the wrong module.

**Solution:** A shaping module produces one `FormattedResult` (truncation, ordering, metadata decided once); the three renderers become thin adapters to HTML / Block Kit / JSON.

**Wins:** truncation rule stated once; three adapters prove the seam is real; shape testable without rendering.

---

## 7. One module for Conversation-scope state in the web client — **Worth exploring**

**Files:** `packages/web/src/ui/components/chat/env-picker.tsx` (~2,000 effective ln), `packages/web/src/lib/stores/chat-routing-preference-store.ts`, `packages/web/src/ui/hooks/use-conversations.ts` (129–150)

**Problem:** Conversation scope (per CONTEXT.md / ADR-0011: authoritative on the conversations row, seeded by the sticky preference) is maintained by three modules with no single interface — picker component state, the zustand preference store, and the conversation-row write. Reconciliation paths between them (optimistic update vs. in-flight turn; exclude-set round-trip) are untested. CONTEXT.md flags the naming drift ("env picker" vs. canonical *scope picker*) as a symptom.

**Solution:** A `useConversationScope` module owns seed → select → optimistic write → row reconcile as one interface; picker becomes a renderer, the store an implementation detail. Rename to scope-picker while touching it.

**Caution:** Recently reworked (#3044 #3066 #3067) — lock the seams while the model is fresh, but verify the dust has settled.

---

## Top recommendation

**Candidate 1** — it sits on the security spine (whitelist enforcement is a CLAUDE.md core rule), the duplication is days old so consolidation is cheapest now, and it completes the arc wins #87–#88 started: one resolver, one fail-closed signal, one membership semantic. Candidate 2 is the best second: equally mechanical, ~320 lines back immediately.

## Explicitly not surfaced (explored, judged not worth a card)

- Chat adapter-registry 5-branch `else if` registration — low payoff until 3+ new Chat Platforms.
- Boot-time install-handler coverage validation — a feature, not a deepening; revisit for SaaS hardening.
- Platform token-prefixes hardcoded in `plugins/chat/src/bridge.ts` error scrubber — defensive only.
- ES auth/engine resolution (`plugins/elasticsearch/src/connection.ts`, 1,327 ln) — complexity earned, not friction; minor Zod-schema mirroring not worth the churn.
- Per-page `search-params.ts` boilerplate — organization clarity beats ~15 saved lines/page.
- Approval-rule save-time validation against execution surfaces — real but it's invariant-adding, not consolidation; needs its own design pass.
