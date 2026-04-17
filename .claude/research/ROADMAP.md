# Atlas Roadmap

> Public repo: [AtlasDevHQ/atlas](https://github.com/AtlasDevHQ/atlas). Tracking lives in [GitHub Issues](https://github.com/AtlasDevHQ/atlas/issues) and [Milestones](https://github.com/AtlasDevHQ/atlas/milestones).
>
> Previous internal milestones (v0.1–v1.3) archived in `ROADMAP-archive.md`.
>
> **Versioning**: Public semver starts at 0.0.x. Internal milestones (v0.1–v1.3) were pre-public. The numbers below are public semver. 1.0.0 is the hosted SaaS launch at app.useatlas.dev.
>
> **License**: AGPL-3.0. The hosted SaaS is the primary commercial offering. Commercial embedding requires a separate license.

---

## North Star: 1.0.0 — SaaS Launch

Atlas 1.0.0 = hosted SaaS at **app.useatlas.dev**. Target: later 2026. Every milestone below is a stepping stone toward a production multi-tenant SaaS that teams sign up for, connect their database, and start querying — no deploy step.

The AGPL license makes the SaaS the natural path for commercial users. Self-hosted remains free and fully functional. The hosted product adds managed infrastructure, onboarding, monitoring, and support.

---

## Shipped

<details>
<summary>Work completed since public repo launch (click to expand)</summary>

### Public Launch (#1–#10)
- [x] Initial public release
- [x] Admin user management + default password enforcement (#1)
- [x] Vercel deploy button with Neon + AI Gateway (#2, #3)
- [x] `@useatlas` packages published to npm (0.0.2)
- [x] CI: template drift check (#9, #10)
- [x] CI: automate starter repo sync (#7, #8, #34, #35)

### Adapter Plugin Refactor (#11–#32)
- [x] Plugin SDK: `parserDialect` and `forbiddenPatterns` on datasource plugins (#14, #23)
- [x] `validateSQL` and `ConnectionRegistry` made plugin-aware (#15, #25)
- [x] Agent dialect system made plugin-driven (#16, #24)
- [x] ClickHouse, Snowflake, DuckDB, Salesforce plugins created (#17–#20, #26–#28, #31)
- [x] Adapter code stripped from core — plugins own their adapters (#21, #32)
- [x] Adapter tests moved to plugins (#22)
- [x] Fix: anchor forbidden patterns to avoid false positives (#29, #30)

### Starter Automation (#33–#38)
- [x] Platform-specific READMEs with deploy buttons (#12, #33)
- [x] Sync starters post adapter strip (#36, #37, #38)

### Python Data Science Sandbox (#39–#51)
- [x] `executePython` tool with import guard (#43, #46)
- [x] Sidecar Python backend (#40, #47)
- [x] Chart rendering in chat UI (#41, #48)
- [x] Agent prompt tuning for Python tool usage (#44, #49)
- [x] nsjail Python sandbox backend (#42, #50)
- [x] Vercel sandbox Python backend (#45, #51)

### Infra & Cleanup (#52–#55)
- [x] Fix missing deps and files in starter templates (#52)
- [x] Drop Render as deploy target (#53, #54)
- [x] Sandbox architecture design doc (#55)

### 0.1.0 — Documentation & Developer Experience
- [x] Docs site (docs.useatlas.dev) — Fumadocs, API reference from OpenAPI, 24+ pages
- [x] DX polish — `atlas doctor`, `atlas validate`, shell completions, better first-run errors
- [x] Test coverage — web UI, SDK integration, E2E expansion
- [x] Project hygiene — CHANGELOG, CONTRIBUTING, issue/PR templates, brand unification

### 0.2.0 — Plugin Ecosystem
- [x] Plugin SDK stable — `definePlugin`, Zod config schemas, multi-type plugins, testing utilities
- [x] 18 npm packages published under `@useatlas/*` scope
- [x] Plugin scaffold (`bun create @useatlas/plugin`), cookbook, composition docs, health checks

### 0.3.0 — Admin Console & Operations
- [x] Admin phase 2 — connections, users, plugins, settings with live runtime wiring
- [x] Observability — query analytics, token usage, OpenTelemetry traces, health dashboard
- [x] Scheduled tasks v2 — create/edit UI, history, delivery channels

### 0.4.0 — Chat Experience
- [x] Chat polish — theming, follow-ups, Excel export, mobile-responsive, saved queries
- [x] Discovery — visual schema explorer, area/stacked bar/scatter charts

### 0.5.0 — Launch
- [x] Embeddable widget — `@useatlas/react`, widget host, script tag loader, programmatic JS API
- [x] Distribution — BigQuery plugin, conversation sharing with OG tags and embed mode
- [x] SDK streaming — `streamQuery()` async iterator with abort support
- [x] Launch prep — onboarding hardening, README overhaul, landing page refresh, launch content
- [x] Quality — `@useatlas/types` extraction, error handling hardening, CLI test fixes

### 0.5.1 — Agent-Friendly Docs
- [x] Frances Liu docs framework — tutorials, how-to guides, reference, explanation pages
- [x] 119 MDX pages audited for agent optimization, llms.txt

### 0.5.2 — Onboarding & CLI Polish
- [x] Pattern-matched errors, progress indicators, CLI help, first-run detection
- [x] Pool exhaustion handling, schema suggestions, transient vs permanent error hints

### 0.5.3 — UI & Accessibility Polish
- [x] ARIA, Lighthouse audit, keyboard navigation, error boundaries
- [x] Loading states, empty states, mobile polish, chart responsiveness
- [x] Widget types, error states, CSS customization docs

### 0.5.4 — SDK & Integration Polish
- [x] SDK `listTables()`, error code catalog, streaming docs
- [x] Integration tests (widget, SDK, MCP), docs cross-cuts, Obsidian plugin

</details>

---

## 0.6.0 — Governance & Operational Hardening

**SaaS prerequisite: operators must trust Atlas with real workloads before it can be a hosted product.** Close half-built gaps, add governance primitives, and harden for multi-user production environments.

### Finish Half-Built Infrastructure

These are already partially implemented in the codebase — reserve status, DB schema, or env var parsing exists, but enforcement doesn't.

- [x] Action timeout enforcement (#448, PR #468) — enforce `ATLAS_ACTION_TIMEOUT` in action executor, transition to `timed_out` status after expiry
- [x] Rollback API for actions (#451, PR #476) — `POST /api/v1/actions/:id/rollback` endpoint, `rolled_back` status, admin UI rollback button, SDK `rollbackAction()`
- [x] Configurable agent step limit (#449, PR #467) — `ATLAS_AGENT_MAX_STEPS` env var (default 25, range 1–100)
- [x] Configurable Python blocked imports (#452, PR #472) — `python.blockedModules` and `python.allowModules` config arrays with critical module protection
- [x] Configurable explore backend priority (#453, PR #474) — `sandbox.priority` config array overrides hardcoded backend selection order

### Access Control

- [x] RLS improvements (#456, PR #488) — multi-column policies, array claim support, OR-logic between policies
- [x] Session management (#457, PR #501) — admin + user session listing, revoke individual/all, idle and absolute timeout policies, admin UI page
- [x] Social provider setup guide (#463, PR #486) — Google, GitHub, Microsoft

### Audit & Compliance

- [x] Audit log improvements (#458, PR #487, #493) — CSV export, full-text search, connection/table filtering
- [x] Data classification tags on query audit trails (#460, PR #498) — `tables_accessed` and `columns_accessed` arrays extracted from validated AST, stored with audit entries, filterable in admin UI

### Plugin Ecosystem

- [x] Replace `unknown` escape hatches with typed optional peer deps (#454, PR #473) — `@useatlas/plugin-sdk/ai` and `@useatlas/plugin-sdk/hono` type re-exports with optional peer deps
- [x] Plugin hooks: `beforeToolCall` / `afterToolCall` (#450, PR #469) — allow plugins to intercept agent tool decisions. Enables compliance gates, cost controls, and custom routing
- [x] Custom query validation hook on `PluginDBConnection` (#455, PR #475) — async `validate?(query: string)` for non-SQL datasources. Replaces `validateSQL` when present

### SDK Surface

- [x] `validateSQL(sql)` (#461, PR #485) — `POST /api/v1/validate-sql` endpoint + SDK method. Validates without executing
- [x] `getAuditLog()` (#462, PR #485) — SDK method wrapping admin audit endpoint with filters

### Collaboration

- [x] Semantic layer diff in UI (#464, PR #503) — `GET /api/v1/admin/semantic/diff` endpoint, admin UI page with color-coded diff (new/removed/changed tables and columns), multi-connection support

### Integrations

- [x] Microsoft Teams interaction plugin (#465, PR #499) — `@useatlas/teams` with Bot Framework messaging, Adaptive Cards, JWT verification, @mention handling
- [x] Webhook interaction plugin (#459, PR #500) — `@useatlas/webhook` with API key + HMAC auth, sync and async modes, structured JSON responses
- [x] Email digest plugin (#466, PR #502) — `@useatlas/email-digest` with subscription CRUD, daily/weekly scheduling, multi-metric aggregation, HTML email templates

---

## 0.7.0 — Performance & Multi-Tenancy

**SaaS prerequisite: a hosted product needs to serve multiple customers efficiently on shared infrastructure.** No backwards compatibility needed — zero external users, rip and replace freely. Better Auth organization plugin provides the tenant boundary; everything scopes to `activeOrganizationId`.

### Organization Foundation (P0 — do first, everything depends on this)

- [x] Better Auth organization plugin (#514, PR #517) — `organization()` plugin with `activeOrganizationId` on session, org CRUD + member management + invitations, RBAC (owner/admin/member), org switcher UI, first-run org creation flow, all data endpoints scoped to active org

### Caching

- [x] Query result caching (#504, PR #521) — LRU cache with SHA-256 keys (SQL + orgId + connectionId + claims), configurable TTL, admin flush endpoint, plugin hook for external backends (Redis), cache hit/miss headers
- [x] Cache admin UI (#505, PR #527) — admin page with hit rate, entry count, max size, TTL, and flush button with confirmation dialog

### Semantic Layer Indexing

- [x] Pre-computed semantic index at boot (#506, PR #515) — keyword extraction from entities, inverted index, relevant subset injected into agent system prompt based on question keywords
- [x] `atlas index` CLI command (#507, PR #533) — rebuild semantic index on demand with summary stats, `--stats` flag for read-only info

### Multi-Tenancy (all depend on #514)

- [x] Org-scoped semantic layers (#508, PR #524) — DB-backed `semantic_entities` table keyed by orgId, admin CRUD API, file YAML import as seed, org-scoped table whitelist in SQL validation
- [x] Org-scoped explore tool (#522, PR #525) — DB-backed filesystem with dual-write sync layer, atomic file writes, per-org backend caching in explore tool, sidecar cwd support, boot reconciliation
- [x] `atlas init` dual-write + import (#523, PR #526) — disk→DB import endpoint, `atlas import` CLI command, org-scoped `atlas init` with auto-import, first-boot auto-import from disk
- [x] Org-scoped connection pooling (#509, PR #529) — per-org pool isolation keyed by orgId + connectionId, lazy creation, configurable limits, health-based drain, per-org metrics via admin API
- [x] Org isolation validation (#510, PR #528) — 27 tests proving SQL whitelist, semantic index, cache keys, explore root, conversations, and audit never cross org boundaries
- [x] Pool capacity guard bug (#530, PR #534) — capacity check now includes org pool slots, config validation warns on overcapacity
- [x] Tenant pool integration tests (#531, PR #534) — org routing tests in sql.test.ts, admin pool endpoint tests, config validation tests
- [x] Pool misconfiguration health check (#536, PR #537) — surface capacity warnings in admin health endpoint
- [x] Shared connection mock factory (#535, PR #538) — reduce test maintenance burden across 20+ test files
- [x] Fix hooks-integration and custom-validation tests (#532) — already fixed by shared mock factory (PR #538)

### Infrastructure

- [x] Connection pooling improvements (#511, PR #516) — warmup at startup, health-based drain on error threshold, pool metrics (active/idle/waiting) exposed via admin API and health dashboard
- [x] Streaming Python execution output (#512) — progressive stdout chunks and chart renders via sidecar SSE protocol

### Learning (Phase 1)

- [x] `atlas learn` CLI (#513, PR #540) — offline batch process that reviews audit log, proposes YAML amendments (new `query_patterns`, join discoveries, glossary refinements). Human reviews the diff, commits what's useful. Zero runtime overhead, no DB dependency

---

## 0.7.x Refinement Arc

**Quality pass after a 27-issue sprint.** Systematic review of everything shipped in 0.7.0 — code smells, docs, type safety, error handling, test gaps. Same pattern as 0.5.x (4 point releases of polish).

### 0.7.1 — Immediate Cleanup

- [x] Fix 5 lint warnings (#542, PR #545) — unused `CacheEntry` export, unused `_err` var, unused `TData`/`TValue` type params
- [x] Clean up chat.ts stack trace logging (#543, PR #545) — stack trace moved to debug level
- [x] Docs gaps (#541, PR #546) — `atlas index` CLI reference, streaming Python in Python guide, cache admin UI in admin console guide
- [x] Code review of new 0.7.0 modules (#544, PR #549) — learn module, python-sidecar streaming, org-scoped code. Filed #547 (shared Python wrapper) and #548 (input mutation) for 0.7.2

### 0.7.2 — Type Safety & Code Smells

- [x] Non-null assertion (`!`) audit (#550, PR #556) — find and eliminate unnecessary `!` operators across all packages
- [x] `any` type usage audit (#551, PR #559) — replace explicit `any` with proper types or `unknown` where possible
- [x] Unused exports audit (#552, PR #560) — dead code elimination across packages
- [x] Function complexity (#553, PR #558) — identify and refactor functions over ~50 lines or deeply nested logic
- [x] Extract shared Python wrapper code (#547, PR #557) — deduplicate between streaming and non-streaming handlers
- [x] Eliminate input parameter mutation in generateProposals (#548, PR #555) — pure function refactor

### 0.7.3 — Error Handling & Resilience

- [x] Catch block audit (#561, PR #567) — eliminate ~35 silent catches, standardize error type narrowing across all packages
- [x] Error message quality (#562, PR #565) — replace 12 generic error messages with actionable guidance, add request IDs to all 500 responses
- [x] Fallback behavior review (#563, PR #566) — audit ~96 fallback patterns, add logging for suspicious silent degradation
- [x] Error boundary coverage (#564, PR #566) — wrap org context, streaming Python, and shared conversations with error boundaries
- [x] Fix remaining silent catch blocks in admin.ts (#569) — already addressed by PRs #565, #566, #567
- [x] Fix password-status endpoint swallowing DB errors (#568, f15424c) — return 500 instead of false on DB failure

### 0.7.4 — Test Hardening

- [x] Password endpoint test coverage (#571, PR #577) — add tests for /me/password-status and /me/password endpoints
- [x] Cache edge case tests (#572, PR #577) — TTL boundaries, concurrent access, oversized entries, LRU eviction
- [x] Streaming Python timeout/error path tests (#573, PR #578) — SSE protocol, mid-stream failures, timeout boundaries
- [x] `atlas learn` edge case tests (#574, PR #576) — malformed entries, conflicting proposals, full pipeline integration
- [x] Mock factory migration (#575, PR #576) — migrate remaining inline connection mocks to shared `createConnectionMock`
- [x] Fix empty catch blocks in atlas learn analyze (#579, 3a30a47) — add debug logging to 5 silent catches

### 0.7.5 — Docs Completeness

- [x] Feature-to-docs mapping (#580, PR #585) — audited all 0.1.0–0.7.4 features, created caching guide, expanded Python guide, verified CLI/pool/classification/hooks coverage
- [x] Stale reference cleanup + config/env var audit (#581, PR #585) — fixed dead link in MCP plugin docs, added pool.perOrg to config.mdx, added ATLAS_ORG_ID to env vars, added cache/pool to config summary table
- [x] Landing page refresh (#582, PR #584) — updated useatlas.dev feature grid for 0.7.0 (multi-tenancy, caching, learning)
- [x] Multi-tenancy / organization setup guide (#554, PR #583) — dedicated guide for Better Auth org plugin, org-scoped semantic layers, connections, and pooling

---

## 0.8.0 — Intelligence & Learning

**SaaS differentiator: the "gets smarter over time" story.** Dynamic learning is Atlas's answer to Vanna's RAG — auditable YAML diffs vs opaque embeddings. PII detection and compliance features live in `/ee` (0.9.0).

### Learning (Phase 2 — Dynamic Layer)

- [x] `learned_patterns` DB schema and CRUD API (#586, PR #595)
- [x] Agent proposes learned patterns after successful queries (#587, PR #599)
- [x] Inject approved learned patterns into agent context (#588, PR #600)
- [x] Admin UI for reviewing and managing learned patterns (#589, PR #598)

### Cleanup

- [x] Extract shared adminAuthPreamble to avoid 3-file duplication (#596, PR #597)

### Knowledge

- [x] Prompt library — curated per-industry question collections (#590, PR #602)
- [x] Query suggestion engine — learn from past successful queries (#591, PR #603)

### Advanced

- [x] Self-hosted model improvements — test matrix and benchmarks (#592, PR #594)
- [x] Notebook-style interface — cell-based exploratory analysis UI (#593, PR #606)

---

## 0.8.1 — Notebook Refinement

**Polish and extend notebook UI.** Harden Phase 1, add fork/reorder (Phase 2) and export/text cells (Phase 3).

### Hardening (P0 — do first)

- [x] Extract shared `useAtlasTransport` hook from chat and notebook (#608)
- [x] Add ErrorBoundary to notebook cells and fix generic error messages (#609)

### Bug Fixes

- [x] Error propagation in use-conversations — callers can't distinguish failure reasons (#622, PR #626)
- [x] useKeyboardNav fires callbacks with invalid index when cellCount is 0 (#623, PR #625)
- [x] Notebook error feedback + catch annotations (#616, #617, #618, PR #619)
- [x] Align @useatlas/react useConversations with throw-on-failure pattern (#628, 970d441)

### Quality

- [x] Notebook test coverage — keyboard nav, components, edge cases (#610, PR #621)
- [x] Notebook UX polish — keybindings, dead code, dialog dedup (#611, PR #620)
- [x] useNotebook hook-level tests with renderHook (#624, PR #627)

### Docs

- [x] Add missing error codes to CHAT_ERROR_CODES (#629, PR #634)
- [x] Fill docs reference gaps — learn config, CLI flags, .env.example (#630, #631, #633, PR #635)
- [x] Update OpenAPI spec — add 50+ missing endpoints via codegen pipeline (#632, PR #637)

### Features

- [x] Notebook Phase 2 — fork + reorder (#604)
- [x] Notebook Phase 3 — export + text cells (#605)

---

## 0.9.0 — SaaS Infrastructure

**The milestone that makes Atlas a hosted product.** Everything before this is "software that works well." This milestone is "software you can sell."

### Tenant Provisioning

- [x] Self-serve signup flow (#644, PR #674) — email/OAuth signup → workspace creation → connect database wizard. No CLI, no `atlas init`, no YAML editing. The web equivalent of `bun create @useatlas` but for non-developers
- [x] Workspace lifecycle (#645, PR #673) — create, suspend, delete. Cascading cleanup of connections, conversations, semantic layers, cached results
- [x] Guided semantic layer setup wizard (#649, PR #681) — web UI replacement for `atlas init`. Profile database, review generated entities, edit descriptions, preview agent behavior. Shared profiler library extracted from CLI

### Usage Metering & Billing

- [x] Usage tracking (#650, PR #675) — per-workspace query count, token consumption, storage, active users. Extend existing token tracking to workspace-scoped metering
- [x] Billing integration (#651, PR #682) — Stripe via Better Auth plugin. Free/trial/team/enterprise tiers, BYOT support, plan enforcement on queries, Customer Portal
- [x] Usage dashboard (#652, PR #687) — customer-facing view of consumption, limits, and billing history
- [x] Overage handling (#653, PR #690) — graceful degradation (rate limit, then block) when workspace exceeds plan limits

### Enterprise Features (`/ee`)

Source-available under separate commercial license. Core AGPL functionality stays free — `/ee` is governance, compliance, and scale features that enterprises pay for.

#### Auth & Access Control

- [x] `/ee` directory structure (#646, PR #672) — source-available enterprise features under separate commercial license
- [x] Enterprise SSO (#654, PR #676) — per-organization SAML and OIDC provider registration, domain-based auto-provisioning via Better Auth hooks
- [x] SCIM directory sync (#658, PR #754) — automated user provisioning from enterprise IdPs via SCIM 2.0 endpoints
- [x] SSO enforcement (#659, PR #729) — require SAML/OIDC for workspace, no password fallback
- [x] IP allowlisting (#655, PR #728) — restrict API and UI access by CIDR range per workspace
- [x] Custom role definitions (#656, PR #736) — granular permission-based RBAC with 8 flags, built-in roles (admin/analyst/viewer), admin CRUD API + UI, fail-closed resolution, ipaddr.js for IP parsing (PR #738)
- [x] Approval workflows (#660, PR #756) — require sign-off for queries touching sensitive tables or exceeding cost thresholds, admin approval UI with approve/deny actions

#### Compliance & Audit

- [x] Audit log retention policies (#657, PR #746) — configurable retention (30d/90d/1yr/custom), soft-delete + hard-delete auto-purge, CSV/JSON compliance export, admin UI "Retention" tab, enterprise-gated
- [x] PII detection and column masking (#661, PR #776) — regex+heuristic PII detector in `/ee`, afterQuery masking hook with role-based strategies (full/partial/hash/redact), admin UI for reviewing classifications, guide page. Enterprise-gated
- [x] Compliance reporting dashboard (#662, PR #778) — data access and user activity reports with date/user/role/table filters, CSV/JSON export, summary stats, admin UI "Reports" tab. Enterprise-gated

#### Multi-Tenant Enterprise

- [x] Data residency controls (#663, PR #809) — route tenant data to region-specific storage (EU customers need EU data)
- [x] Custom domains (#664, PR #814) — `data.customer.com` pointing at their Atlas workspace, powered by Railway GraphQL API for domain provisioning + TLS
- [x] Tenant-level model routing (#665, PR #747) — per-workspace BYOK LLM provider config, encrypted API keys, Anthropic/OpenAI/Azure/custom support, admin UI with test connection, enterprise-gated

#### Branding

- [x] White-labeling (#666, PR #777) — per-workspace branding (logo, colors, favicon, hide Atlas branding), admin UI, public branding endpoint for widget embeds, `useBranding()` hook, conditional sidebar rendering. Enterprise-gated

### Platform Operations

- [x] SLA monitoring and alerting (#667, PR #795) — per-workspace latency p50/p95/p99, error rate, uptime tracking with configurable alert thresholds. Platform admin dashboard with charts, alert management (fire/resolve/acknowledge), webhook delivery. Enterprise-gated via `/ee/sla/`
- [x] Abuse prevention (#668, PR #788) — anomaly detection on query patterns, graduated response (warn → throttle → suspend), admin UI for flagged workspaces, configurable thresholds, audit trail integration
- [x] Platform admin console (#669, PR #775) — cross-tenant dashboard for platform operators via Better Auth `platform_admin` role, workspace management (suspend/delete/plan change), noisy neighbor detection, aggregate stats, guide page
- [x] Automated backups and disaster recovery (#647, PR #802) — pg_dump-based with gzip compression, configurable schedule/retention, backup verification, restore with safety checks, platform admin dashboard, enterprise-gated via `/ee/backups/`

### Chat SDK — Unified Interaction Layer

Parent: #757. Replace per-platform interaction plugins with a single `@useatlas/chat` plugin built on vercel/chat.

#### Foundation
- [x] Core bridge plugin (#758, PR #774) — `@useatlas/chat` plugin bridging Chat SDK → Atlas plugin lifecycle, Slack adapter as proof-of-concept, in-memory state adapter, integration tests
- [x] State adapter integration with Atlas internal DB (#772, PR #779) — PG adapter with `chat_` prefixed tables, memory adapter, Redis stub, distributed locking, thread subscription persistence, configurable via plugin config

#### Platform Migrations
- [x] Migrate Slack interaction to Chat SDK adapter (#759, PR #784) — existing `@useatlas/slack` plugin migrated to Chat SDK bridge, slash commands, threaded conversations, Block Kit cards, approval buttons, OAuth multi-workspace, rate limiting all preserved via `@chat-adapter/slack`
- [x] Migrate Teams interaction to Chat SDK adapter (#760, PR #787) — Bot Framework routing through Chat SDK dispatch, Adaptive Cards preserved, tenant restriction + rate limiting retained, `@useatlas/teams` deprecated

#### New Platforms
- [x] Discord interaction (#761, PR #794) — `@chat-adapter/discord` via Chat SDK bridge, Ed25519 webhook verification, Embed cards, @mention and slash command handling, threaded conversations
- [x] Google Chat interaction (#762, PR #804) — `@chat-adapter/gchat` via Chat SDK bridge, service account + ADC auth, Google Chat Cards, Pub/Sub topic support, domain-wide delegation
- [x] Telegram interaction (#763, PR #807)
- [x] GitHub bot interaction (#764, PR #813)
- [x] Linear bot interaction (#765, PR #850)
- [x] WhatsApp interaction (#766, PR #853)

#### Cross-Platform Features
- [x] AI streaming responses across platforms (#767, PR #808)
- [x] Unified JSX cards for query results (#768, PR #803) — QueryResultCard, ErrorCard, ApprovalCard, DataTableCard via Chat SDK JSX runtime. Auto-compiles to Block Kit (Slack), Adaptive Cards (Teams), Discord Embeds, Google Chat Cards with markdown fallback
- [x] Modals, slash commands, and action buttons (#769, PR #812)
- [x] File upload support — CSV export (#770, PR #854)
- [x] Ephemeral messages and proactive DMs (#771, PR #861)
- [x] Cross-platform emoji and reactions (#773, PR #860)

### Auth & Routing

- [x] Auth route protection via Next.js 16 proxy (PR #810) — optimistic session cookie check, redirect unauthenticated users to /signup, dedicated /login page with social providers, managed auth mode only

### Follow-ups

- [x] CLI atlas init shared profiler (#686, PR #741) — replaced ~600 lines of duplicated profiling code with imports from `@atlas/api/lib/profiler`
- [x] Wizard types to @useatlas/types (#683, PR #740) — canonical wire-format types, Zod validation on save endpoint, immutable `analyzeTableProfiles`

### Onboarding

- [x] Interactive demo mode (#648, PR #677) — try Atlas against a sample database without connecting your own. The cybersec demo dataset, hosted, zero-config, email-gated lead capture
- [x] Onboarding email sequence (#670, PR #783) — automated drip campaign with milestone-triggered + time-based fallback emails, SMTP/webhook delivery, workspace branding, unsubscribe, admin management API
- [x] In-app guided tour (#671, PR #745) — tooltip-based walkthrough of chat, notebook, admin, semantic layer. Tour completion tracked per user, re-triggerable from help menu, lazy-loaded

---

## 0.9.1 — Docs & Polish

**Ongoing companion to 0.9.0.** Docs and hardening pass after each batch of SaaS features ships. Grows as 0.9.0 progresses.

- [x] Guide pages for first SaaS batch (#679, PR #680) — self-serve signup, demo mode, enterprise SSO, usage metering guides. Admin console docs updated with workspace management. React reference updated with AtlasChat component props. Onboarding endpoints added to OpenAPI spec
- [x] Semantic layer wizard guide (#691, PR #695) — step-by-step walkthrough, wizard vs CLI comparison, troubleshooting
- [x] Billing and plans guide (#692, PR #696) — plan tiers, Stripe setup, overage handling, usage dashboard, BYOT, Customer Portal
- [x] Fix useAdminFetch error body loss (#689, PR #694) — extract message + requestId from JSON error responses
- [x] RequestId consistency in API error responses (#697, #698, #699, PR #700) — global onError, adminAuthPreamble 401/403, wizard comment fix
- [x] OpenAPI spec gaps (#693, PR #704) — demo, billing, usage, wizard endpoints added to spec, codegen run
- [x] Wizard test coverage (#685, PR #706) — save endpoint, resolveConnectionUrl, profiler edge cases (461 + 470 lines)
- [x] Wizard generate schema type mismatch (#707) — incidental fix during OpenAPI work
- [x] Admin-tokens test mock fix (#701, e2a2c1b) — partial mock missing createAtlasUser
- [x] Billing/workspace error codes reference (#708, PR #709) — error code docs for plan_limit_exceeded, workspace_suspended, etc.
- [x] RequestId in remaining auth error responses (#705, #713, #714, PR #710) — conversations, sessions, billing, suggestions auth + operational 500s
- [x] Retryable billing/workspace error flags (#711, #712) — correct retryable field and status codes for billing errors
- [x] Wizard error handling and MySQL escaping (#684, PR #688) — harden resolveConnectionUrl, MySQL identifier quoting
- [x] OpenAPI auto-gen Phase 1 — foundation (#703, PR #715) — OpenAPIHono on index.ts + semantic.ts, /api/v1/openapi-auto.json endpoint
- [x] OpenAPI auto-gen Phase 2a — admin routes (#716, PR #718) — all 7 admin route files converted to OpenAPIHono + createRoute
- [x] OpenAPI auto-gen Phase 2b — public API routes (#717, PR #721) — 7 public route files (query, prompts, sessions, suggestions, onboarding, actions, scheduled-tasks) converted
- [x] @hono/zod-openapi dependency fix (#720, cf1b62e) — missing from packages/api/package.json
- [x] OpenAPI auto-gen cleanup — shared schemas, remove unnecessary as-never casts (PR #722)
- [x] OpenAPI auto-gen Phase 2c-i — conversations, billing, wizard (#723, PR #725)
- [x] OpenAPI auto-gen Phase 2c-ii — chat, demo, slack (#724, PR #726)
- [x] OpenAPI auto-gen Phase 3 — single merged spec endpoint, delete openapi-auto.json (PR #727). openapi.ts: 4,334 → 230 lines
- [x] IP allowlisting + SSO enforcement docs (#730, #731, PR #735) — guide pages for both enterprise auth features
- [x] SDK reference fixes (#733, PR #737) — HTTP status codes, phantom types, missing error codes, ConnectionDetail
- [x] RLS conditions field docs (#734, PR #737) — conditions array documented, required markers corrected
- [x] Validation hook (#719, PR #737) — context-aware error messages (query/param/body), 422 status, applied to all 23 sub-routers
- [x] IP parsing refactor (PR #738) — replace hand-rolled bigint math with ipaddr.js, fix IPv4-mapped IPv6 + duplicate detection + plain IP support
- [x] Custom roles guide (PR #736 included docs)
- [x] OpenAPI spec regeneration (#732, PR #739) — regenerated docs spec with all 150 routes (was missing 45+ after Phase 3 migration)
- [x] Trailing-slash path dedup (#742, 159d085) — 7 duplicate `/foo/` paths removed from spec, dedup added to extract script
- [x] Fix CLI analyzeTableProfiles return value (#743, dc78f2d) — 3 call sites + 1 test discarded immutable return, breaking FK inference
- [x] Fix WizardTableFlags type mismatch (#744, dc78f2d) — snake_case `TableFlags` replaced with camelCase `WizardTableFlags` matching wire format
- [x] `@atlas/ee` workspace package refactor (#752) — path alias replaces deep relative imports, workspace dependency setup
- [x] CI fix: add ipaddr.js to @atlas/ee dependencies (6331937) — missing explicit dep caused type-check failure
- [x] Docs for enterprise auth features — SCIM guide (scim.mdx, 227 lines), approval workflows guide (approval-workflows.mdx, 149 lines)
- [x] Platform admin console guide (platform-admin.mdx, included in PR #775)
- [x] PII compliance guide (pii-masking.mdx, included in PR #776)
- [x] Missing env var docs (#780, PR #781) — ATLAS_SEMANTIC_ROOT, SEMANTIC_DIR, SIDECAR_AUTH_TOKEN added to reference page and .env.example
- [x] Fix semantic-sync.ts ignoring ATLAS_SEMANTIC_ROOT (#782, PR #786) — replaced hardcoded path with shared `getSemanticRoot()` from semantic-files.ts
- [x] Extract useAdminMutation hook (#789, PR #791) — shared mutation hook for admin pages (POST/PUT/PATCH/DELETE) with auto-invalidation
- [x] Eliminate `as never` casts from OpenAPI route handlers (#790, PR #792) — type-safe OpenAPI middleware replaces manual cast workarounds
- [x] Add @useatlas/chat plugin guide page (#785, PR #793) — complete guide covering adapters (Slack, Teams, Discord), state config (memory/PG/Redis), migration from deprecated plugins, error scrubbing, env vars
- [x] Chat plugin hardening (#796-#801, cc7d75d) — requestId on webhook 500s, init error logging, Discord publicKey hex validation, docs: state sub-options, scrubbing patterns, link verification
- [x] SLA monitoring guide (sla-monitoring.mdx, included in PR #795)
- [x] JSX card error consistency (#805) — error cards for all bridge error paths
- [x] Card docs fix (#806) — correct section header and docs for card-based flow
- [x] Google Chat guide page (gchat.mdx, included in PR #804)
- [x] Backups guide page (backups.mdx, included in PR #802)
- [x] Telegram guide page (telegram.mdx, included in PR #807)
- [x] Chat plugin guide updated with streaming config and Telegram adapter (included in PRs #807, #808)
- [x] Data residency guide page (data-residency.mdx, included in PR #809)
- [x] Fix residency admin page type errors (6d52454) — FeatureGate missing feature prop, LoadingState wrong prop name, StatCard icon as JSX elements
- [x] Fix ConversationCallbacks.addMessage return type (7bedcbd) — `void` → `Promise<void> | void` to match async usage
- [x] GitHub bot guide page (github.mdx, included in PR #813) — GitHub App setup, PAT auth, webhook config
- [x] Chat plugin guide updated with interactive components, configurable slash commands, GitHub adapter (included in PRs #812, #813)
- [x] Custom domains guide page (custom-domains.mdx, included in PR #814) — Railway integration, DNS verification, CNAME setup
- [x] Enterprise error detection fixes (#817, #818, #826, PRs #827, #831) — `instanceof EnterpriseError` replacing fragile string matching across all admin route handlers, `no_internal_db` returns 503 instead of misleading 404
- [x] rowTo* runtime validation (#816, PR #824) — add runtime type checking at DB boundary layer instead of unsafe `as` casts
- [x] requestId in webhook logs + DuckDB segfault skip (#815, PR #825) — correlation IDs in webhook `waitUntil` error logs, skip DuckDB segfault test in Bun 1.3.10
- [x] ConversationCallbacks.addMessage return type fix (7bedcbd) — `void` → `Promise<void> | void` to match async usage in @useatlas/react
- [x] Fix approval.ts governance bypass (#828, PR #834) — `checkApprovalRequired`, `expireStaleRequests`, `getPendingCount` now re-throw unexpected errors instead of returning false-negative fallbacks. Only `EnterpriseError` returns safe fallback
- [x] instanceof error detection + test mock fixes (#829, #830, #832, PR #833) — `DomainError`/`ResidencyError` detection via `instanceof` in platform routes, 8 EE test files corrected to throw `EnterpriseError` with re-exported class
- [x] OpenAPI regen + env vars + error codes + dead links (#820, #821, #822, #823, PR #840) — 6 route groups (29 endpoints) added to OpenAPI spec with SaaS-only framing, 12 env vars added to reference, `workspace_throttled` error code added, onboarding-emails guide created, dead link fixed
- [x] Extract shared enterprise admin route middleware (#835, PR #852) — `throwIfEEError()` replaces 9 local `throwIf*Error` functions across admin routes
- [x] Create shared EE test mock factory (#836, PR #849) — createInternalDBMock following createConnectionMock pattern, fixes #829/#832
- [x] Reframe enterprise guides as SaaS-only (#819, c0d816b) — 14 /ee guides updated with SaaS-only framing, not self-deployable
- [x] Move operator guides to Platform Operations docs section (0c28f36)
- [x] Fix workspace_throttled emission (#843, PR #844) — return 429 with Retry-After instead of silent delay
- [x] Fix hasApprovedRequest enterprise gate + reject invalid rule_type (#841, #842, PR #845)
- [x] Fix approval request status cast (#846, PR #848) — validate status against known values instead of unchecked `as` cast
- [x] Consolidate semantic layer into semantic/ directory (#837, PR #855) — 5 top-level files → barrel export, move db/semantic-entities.ts
- [x] Extract shared pagination parser and ID validator (#838, PR #851) — `parsePagination()` + `isValidId()` + `PaginationQuerySchema` replace 24 inline implementations
- [x] Extract shared sandbox backends for explore/python (#839, PR #859) — 6 parallel backend files → 3 shared, SandboxBackend interface
- [x] Adopt react-hook-form + shadcn Form for admin dialogs (#856, PRs #862, #863, #864, #865) — FormDialog component with Zod 4 validation, all 26 admin pages migrated across 4 batches. z.ZodType<T,T> generic pattern for proper zodResolver overload matching
- [x] Extract AdminContentWrapper for admin page rendering (#857) — shared FeatureGate/ErrorBanner/LoadingState/EmptyState chain, 8 admin pages migrated
- [x] Extract createAdminRouter factory + requireOrgContext middleware (#858) — `createAdminRouter()`, `createPlatformRouter()`, `requireOrgContext()` replace 4-line router setup boilerplate × 22 files and ~8-line org-context extraction × 85 handlers

---

## 0.9.2 — Docs Persona Audit

**Systematic audit of all docs pages for persona clarity.** Every page should have a clear audience (end user, workspace admin, or platform operator) with appropriate framing, callouts, and sidebar placement.

### Phase 1 — Audit & Classification

- [x] Classify all 354 docs pages by persona (#847, PR #885) — audit table in `docs/research/persona-audit.md`, sub-issues filed for rewriting work

### Phase 2 — Structural Reorganization & Content Rewriting

- [x] Reframe deployment/config pages for SaaS vs self-hosted audiences (#878)
- [x] Reframe enterprise feature guides from customer perspective (#880)
- [x] Add persona sections to security reference pages (#881)
- [x] Relocate misplaced operator/developer guides to correct sections (#882)
- [x] Add persona sections to mixed-audience pages (#883)
- [x] Improve plugin interaction pages — chat SDK split, email digest sections (#884)

---

## 0.9.3 — Architecture Deepening

**Module-deepening refactors** from systematic codebase exploration. Reduce duplication, improve testability, and make the codebase more navigable before the 1.0.0 launch.

- ~Extract plugin initialization factory in plugin SDK (#890)~ — superseded by #908 (P5: Effect Layer composition)
- [x] Complete AdminContentWrapper adoption across all admin pages (#891, PR #899)
- [x] Extract route handler error wrapper for consistent 500 responses (#892, PR #902)
- [x] Extract OpenAPI schema factories for admin routes (#893, PR #916)
- [x] Deduplicate auth error classification between admin-auth and middleware (#894, PR #898)
- [x] Extract shared fetch error utility for admin hooks (PR #898) — quick win: deduped error parsing from `useAdminFetch` + `useAdminMutation` into `extractFetchError()`
- ~Extract plugin SDK utilities — health check, lazy loading, route helpers (#895)~ — superseded by #908 (P5: Effect Layer composition)
- [x] Extract conversation fetch client from use-conversations hook (#896, PR #915)
- [x] Extract shared ResultCardBase for SQL and Python result cards (#897, PR #899)

---

## 0.9.4 — Effect.ts Migration

**Incremental adoption of Effect.ts** across `packages/api/`. Typed errors, dependency injection via Layers, scoped resource lifecycle, structured concurrency. Backend only — frontend stays React/Zod.

### Foundation
- [x] P0: Effect.ts foundation — install, tagged errors, Hono bridge (#903, PR #918)

### Infrastructure Primitives (P1–P4)
- [x] P1: SQL validation & query execution → Effect.gen with tagged errors (#904, PR #920)
- [x] P2: Rate limiting → Effect Semaphore and Ref (#905, PR #920)
- [x] P3: Scheduler and delivery → Effect Schedule, Semaphore, retry (#906, PR #919)
- [x] P4: ConnectionRegistry → Effect Layer/Service with scoped resources (#907, PR #923)

### Service Architecture (P5–P8)
- [x] P5: Plugin lifecycle → Effect Layer composition (#908, PR #926)
- [x] P6: Server startup → Effect Layer DAG (#909, PR #928)
- [x] P7: Route handlers → Effect boundaries with typed error mapping (#910, PR #925)
- [x] P8: Auth and request context → Effect Context replacing AsyncLocalStorage (#911, PR #930)

### AI (P10) — Agent Loop → @effect/ai
- [x] P10a: Install @effect/ai, define provider Layers — bridge to existing providers.ts (#933, PR #938)
- [x] P10b: Define Atlas tools (explore, executeSQL) as AiToolkit (#934, PR #939)
- [x] P10c: Rewrite agent loop with AiLanguageModel.streamText (#935, PR #941)

### Database (P11) — Native Effect SQL
- [x] P11a: Install @effect/sql, define SqlClient Layer bridge (#936, PR #940)
- [x] P11b: Replace raw pg/mysql2 with @effect/sql native clients (#937, PR #942)

### Follow-ups
- [x] Migrate platform-residency and platform-domains inner error handling to domainErrors (#927)
- [x] Full audit — type safety, consistency, docs (PR #943)
- [x] Migrate route handlers from c.get() to Effect Context — incremental (#931, PR #944)

### Test Infrastructure
- [x] P9: Test infrastructure → Effect Layer-based test setup (#912)

---

## 0.9.5 — Post-Effect Validation

**Comprehensive end-to-end validation** after the 0.9.4 Effect.ts migration (23 issues, ~15 PRs, every route handler and backend service rewritten). Dev, CI, production, agent loop, enterprise features, browser tests, and external integrations.

### Dev & CI
- [x] Dev workflow smoke test — install, dev, build end-to-end (#945). Filed #955 (Better Auth migration bug, pre-existing)
- [x] CI test audit — 250/250 tests pass, no skipped tests, Effect layers healthy (#946). Filed #992 (flaky DuckDB segfault)

### Production
- [x] Production deploy validation — all 5 Railway services healthy, health endpoint green (#947)

### Effect Architecture
- [x] Effect service lifecycle — 131+ tests across 11 files cover startup, shutdown, error mapping, context propagation (#948)

### Agent & Features
- [x] Agent loop e2e — env isolation fix (PR #993), 272+ tool/agent tests pass (#949)
- [x] Enterprise feature smoke — env isolation fix (PR #994), 434 EE tests pass (#950). Filed #995 (axe violation)

### Integration
- [x] Browser e2e — tour dismissal fix (PR #996), 44/47 fast tests pass (#951). Filed #995 (axe violation)
- [x] SDK, MCP, and widget integration — external integration points (#952, PR #1138)

### Follow-ups (bugs found during validation)
- [x] Better Auth platform_admin role missing from roles config (#955, PR #956)
- [x] Notebook empty state after agent completes — user message not in conversation data (#958, f72689c)
- [x] Notebook text cells leak across conversations, chat broken in notebook view (#959, f72689c)
- [x] Demo dataset picker in onboarding — choose cybersec/ecommerce during first-run (PR #961)
- [x] Next.js proxy can't read NEXT_PUBLIC env vars from repo root .env (#957, PR #990)
- [x] Onboarding test mock — 5 tests failing, mock missing resolveDatasourceUrl + IP allowlist leak (#960, PR #989)
- [x] Admin learned-patterns test — 8 tests failing, IP allowlist query interference (#977, PR #989)
- [x] Seed-demo.ts skips seeding on fresh demo-data DB — Atlas tables leak into datasource (#962, PR #991)

---

## 0.9.6 — SaaS Customer Experience

**Pre-launch prerequisite: make the admin console work for paying SaaS workspace admins.** Scope settings/routes to workspaces, hide platform internals, add self-service for API keys, integrations, billing, sandbox, and custom domains. Keep self-hosted persona fully functional.

### Security & Scoping Fixes (P0)

- [x] Add requireOrgContext to learned-patterns, suggestions, and prompts routes (#963)
- [x] Add adminAuth middleware to scheduled-tasks routes (#964)
- [x] Scope Users admin page to active org members in SaaS mode (#965)
- [x] Hide Organizations page from non-platform-admin (#966)

### Settings Architecture (P0)

- [x] Activate org_id scoping on settings table for workspace-level overrides (#967, PR #999)
- [x] Split Settings page into workspace and platform tiers (#968, PR #1003)
- [x] Hide platform-only admin pages from workspace admins (#969)

### Self-Service Features

- [x] API key management UI for workspace admins (#970, PR #998)
- [x] Integrations hub page for workspace admins (#971, PR #1008)
- [x] Self-serve Slack disconnect/reconnect (#972, PR #1008)
- [x] Self-serve custom domain configuration (#973, PR #1007)
- [x] Self-serve sandbox backend selection per workspace (#974, PR #1015)
- [x] Workspace billing page — plan, usage vs limits, portal link (#975, PR #1006)
- [x] Self-serve data residency selection for workspace admins (#976, PR #1016, fix PR #1017)

### Infrastructure
- [x] Adopt versioned migration framework for internal DB (#978, PR #1019)

### Follow-ups
- [x] Org-scope admin write operations — role change, ban, delete (#983, PR #988)
- [x] Fix axe-core button-name violations on admin connections/audit pages (#995, PR #1000)
- [x] cascadeWorkspaceDelete does not clean up org-scoped settings rows (#1002, PR #1005)
- [x] Consolidate duplicated formatDate helpers across admin pages (#1001, PR #1004)
- [x] Billing routes used standardAuth instead of adminAuth (#1010, PR #1013)
- [x] formatNumber cross-page coupling — moved to shared @/lib/format (#1012, PR #1013)
- [x] Custom-domain page used inline toLocaleDateString instead of shared formatDate (#1009, PR #1013)
- [x] Regenerate API reference docs with flat filenames and operationIds (PR #987)
- [x] Consolidate formatNumber in token-usage pages to shared @/lib/format (#1014, PR #1015)
- [x] Fix type errors and runtime crash from #976 residency PR (PR #1017)
- [x] Slack events handler responds to url_verification before signature check (#1011, PR #1008)
- [x] Isolate corrupted-DuckDB test in subprocess to fix flaky segfault (#992, PR #1018)

---

## 0.9.7 — SaaS-First Admin Experience

**Make app.useatlas.dev feel like a real SaaS product, not a self-hosted deployment.** Remove operator-facing UX (env var names, "Requires restart", "configure DATABASE_URL") from the workspace admin experience. Make plugins, integrations, sandbox, and settings self-serve for paying SaaS customers. Keep self-hosted persona fully functional.

### Foundation (P0)

- [x] Add explicit deploy mode flag — `ATLAS_DEPLOY_MODE=saas|self-hosted|auto` (#1020, PR #1031)
- [x] Hide "Requires restart" and env var names from SaaS workspace admins (#1021, commit 59063af)
- [x] Fix demo dataset onboarding — missing connectionId + swallowed errors (#1032, PR #1034)
- [x] Filter settings page to workspace-relevant settings in SaaS mode (#1022, PR #1035)

### Self-Service Features (P1)

- [x] Make restart-required settings hot-reloadable in SaaS mode (#1023, PR #1087)
- [x] OAuth-first integration connect flows for SaaS workspaces (#1024)
  - [x] Connect flow framework + Microsoft Teams (#1040, PR #1039)
  - [x] Discord (#1041, PR #1053)
  - [x] Telegram (#1042, PR #1053)
  - [x] Google Chat (#1043, PR #1081)
  - [x] GitHub (#1044, PR #1081)
  - [x] Linear (#1045, PR #1083)
  - [x] WhatsApp (#1046, PR #1083)
- [x] Plugin marketplace — browse, install, configure per workspace (#1025)
  - [x] Phase 1: catalog + workspace installations backend (#1127, PR #1132)
  - [x] Phase 2: browse + install UI (#1129, PR #1134)
  - [x] Phase 3: platform admin catalog management (#1130, PR #1137)
- [x] Sandbox integration library — BYOC execution environments (#1026, PR #1054)
- [x] Product-focused data residency UX for SaaS users (#1027, PR #1065)
- [x] Missing p-6 padding on sandbox and residency admin pages (PR #1064)

### SaaS Management

- [x] SaaS-native semantic layer management — web editor + version control (#1033)
  - [x] Phase 1: entity CRUD editor (#1124, PR #1133)
  - [x] Phase 2: schema-aware autocomplete (#1125, PR #1135)
  - [x] Phase 3: version history + rollback (#1126, PR #1140)

### Docs

- [x] Add guide pages for undocumented 0.9.6 admin pages (#1038) — PR #1052
- [x] Regenerate OpenAPI spec — stale after 0.9.6/0.9.7 changes (#1037) — PR #1052

### Finishing Touches (P2)

- [x] Email integration connect flow in Integrations hub (#1028, PR #1086)
- [x] Self-hosted deploy validation via GH Actions for template repos (#1029, PR #1114)
- [x] Create platform OAuth apps for Slack/Teams/Discord on Railway (#1063)

### Dual-Mode Integrations (BYOT)

- [x] Slack BYOT — bot token form when OAuth not configured (#1060, PR #1070)
- [x] Teams BYOT — app credentials form when OAuth not configured (#1061, PR #1070)
- [x] Discord BYOT — bot credentials form when OAuth not configured (#1062, PR #1070)

### Follow-ups

- [x] Telegram connect sends empty POST body — botToken not wrapped in body (#1057, PR #1058)
- [x] Update docs guides for sandbox BYOC + Discord/Telegram (PR #1056)
- [x] In-memory OAuth state map not viable for multi-instance deployments (#1055, PR #1071)
- [x] syncpack picks up .next/standalone build artifacts (#1068)
- [x] Slack route still uses in-memory OAuth state map (#1076, PR #1078)
- [x] Slack store saveInstallation lacks org hijack protection (#1074, PR #1078)
- [x] Wire cleanExpiredOAuthState into scheduler (#1077, PR #1082)
- [x] useDeployMode silently defaults to self-hosted on settings fetch error (#1072, PR #1078)
- [x] Add BYOT route tests for Slack, Teams, Discord (#1075, PR #1082)
- [x] Replace xlsx (SheetJS) with exceljs — 3 Dependabot security alerts (#1079, PR #1080)
- [x] Google Chat + GitHub connect flows (#1043, #1044, PR #1081)
- [x] Linear + WhatsApp connect flows (#1045, #1046, PR #1083)
- [x] OAuth cleanup scheduler + BYOT tests (#1077, #1075, PR #1082)
- [x] useAdminFetch type safety — Zod schema validation replaces blind `as T` casts (#1073, PR #1088)

---

## 0.9.8 — Docs & Polish

**Documentation, reference pages, guide coverage, and follow-up fixes for 0.9.7 features.**

### Docs

- [x] Add Discord + Teams integration env vars to docs, .env.example, and OpenAPI extract (#1102, PR #1106)
- [x] Update admin console guide for SaaS hot-reload settings (#1103, PR #1107)
- [x] Update SDK + React reference — missing exports and stale types (#1104, PR #1108)
- [x] Add per-action timeout to config reference + fix learn --suggestions CLI help (#1105, PR #1109)

### Follow-ups from 0.9.7

- [x] Hot-reload settings — comment accuracy + test coverage gaps (#1089, PR #1112)
- [x] Migrate remaining useAdminFetch calls to Zod schema validation (#1090, PR #1111)
- [x] useAdminFetch does not clear stale data on HTTP error during refetch (#1091, PR #1111)
- [x] Periodic settings refresh for multi-instance SaaS (#1092, PR #1113)
- [x] Deduplicate provider switch in getModelForConfig (#1093, PR #1110)

### Refactors

- [x] Split integration installation types into secret/public variants (#1084, PR #1110)
- [x] Extract shared BaseInstallation type for integration stores (#1085, PR #1110)

### Data Residency

- [x] Region selection during workspace signup flow (#1066, PR #1115)
- [x] Data residency region migration flow Phase 1 (#1067, PR #1120)
- [x] Automated region migration orchestration — Phase 2: snapshot, replicate, cutover (#1118, PR #1128)

### Follow-ups

- [x] Atomic cache swap in loadSettings to prevent brief stale reads (#1116, PR #1119)
- [x] Deploy-validation CI missing bun install for create-atlas deps (#1117, PR #1119)
- [x] Scaffold template missing @useatlas/types + @useatlas/react deps (#1121, PR #1122)
- [x] Deploy-validation CI — scaffold build + standalone build fixes (#1123)

---

## 1.0.0 — SaaS Launch

**app.useatlas.dev goes live.** The hosted product where teams sign up, connect their database, and have a production-ready AI data analyst without deploying anything.

- [x] Public pricing page on useatlas.dev (#871, PR #922)
- [x] SLA commitments — uptime guarantee, query latency targets, support response times (#872, PR #1147)
- [x] Terms of service, privacy policy, DPA for enterprise (#873, PR #1148)
- [x] Launch content — blog post, Show HN, comparison pages updated (#874, PR #924)
- [x] Launch content follow-up — social media assets and demo video (#954, PR #1158)
- [x] Migration tooling — self-hosted to hosted (export/import conversations, semantic layers, settings) (#875, PR #1143)
- [x] Documentation for hosted users — separate onboarding flow from self-hosted docs (#876, PR #1146)
- [x] Status page — public health dashboard (#877, PR #921)
- [x] Status page follow-up — OpenStatus integration for incident management (#953, PR #1144)
- [x] Regional API deployment for tier-2 data residency compliance (#1069)
  - [x] Region API URL config — apiUrl in RegionConfigSchema + settings response (#1149, PR #1155)
  - [x] Region-aware ConnectionRegistry (#1151, PR #1156)
  - [x] Dynamic frontend API URL — runtime resolution from regionApiUrl (#1150, PR #1157)
  - [x] Multi-region Railway deployment — 3 regions live: api (us-west), api-eu (europe-west4), api-apac (asia-southeast1) (#1152)
  - [x] Cross-region request misrouting detection (#1153, PR #1159)
  - [x] Region migration — cross-region data movement with export/import bundle (#1154, PR #1168)
- [x] Docs — semantic editor, plugin marketplace, platform plugin catalog guides (#1141, PR #1142)
- [x] Fix flaky DuckDB ingest test — timeout bump (#1145, 71246b7c)
- [x] Pre-launch SaaS smoke test — health endpoints, admin review, signup flow, regional tests (#1161, PR #1166). Filed #1163, #1164, #1165 (fixed in PR #1169)
- [x] Competitive landscape + comparison pages refresh for 1.0 launch (#1162, PR #1167)

---

## Post-Launch Cleanup

**Hardening pass after 1.0.0 launch.** Org-scoping gaps, error handling bugs, and test coverage from admin route extraction.

### Security — Admin Org Scoping

- [x] Scope admin sessions page to active organization (#1190, PR #1190)
- [x] Scope admin audit log to active organization (#1192, PR #1192)
- [x] Scope admin token usage to active organization (#1193, PR #1193)
- [x] Scope remaining admin handlers (connections, cache, plugins, semantic) to active organization (#1194, PR #1194)
- [x] Migrate remaining admin.ts handlers to createAdminRouter + requireOrgContext (#1191, PR #1194)

### Bug Fixes

- [x] getConnectionRoute silently degrades to 200 on DB failure (#1197, PR #1202)
- [x] Connection update rollback failure message lacks recovery guidance (#1198, PR #1202)
- [x] Completions test out of sync — expects 13 commands, registry has 15 (#1200, PR #1204)
- [x] setWorkspaceRegion export missing from db/internal mock (#1201, PR #1203)

### Test Coverage

- [x] Connection CRUD org-scoping tests (#1195, PR #1204)
- [x] Cache endpoint tests (#1196, PR #1203)

### Architecture

- [x] Wrap all admin-connections routes in runHandler (#1205)
- [x] Unified API test mock factory — eliminate ~1,200 lines of duplicated mock setup (#1206, PR #1226)
- [x] Extract shared semantic entity scanner — eliminate 3x directory traversal duplication (#1207, PR #1211)
- [x] CLI command extraction Phase 1 — 6 handlers + shared connection testing (#1208, PR #1225)
- [x] CLI command extraction Phase 2 — profilers, plugin, init, migrate, help (#1227, PR #1228)
- [x] Consolidate useBranding into useAdminFetch (#1209)
- [x] Extract shared EEError base class — replace 14 identical error class definitions (#1231, PR #1234)
- [x] Extract shared hasInternalDB guard helpers — replace 75 inline checks across 18 EE files (#1232, PR #1233)
- [x] Type-safe exhaustive DomainErrorMapping via `domainError()` helper — branded type, 5xx sanitization, 13 routes migrated (#1235, PR #1236)

### Follow-ups
- [x] Add test coverage for ee/src/backups/ and ee/src/sla/ modules (#1237, PR #1238) — ~900 lines of Effect code with zero tests

---

## Dashboard Persistence

**Save and share query result layouts.** 6-phase feature (#1246): DB schema, add from chat, list/view pages, sharing, auto-refresh, AI suggestions.

- [x] Phase 1: DB schema + 14 CRUD API endpoints (#1247, PR #1253)
- [x] Phase 2: "Add to dashboard" button on SQL result cards in chat (#1248, PR #1254)
- [x] Phase 3: `/dashboards` list page + `/dashboards/:id` view page with DnD card reorder (#1249, PR #1255)
- [x] Phase 4: Share dialog + `/shared/dashboard/[token]` public page with OG tags (#1250, PR #1256)
- [x] Phase 5: Auto-refresh via scheduler — cron-based, hooks into existing scheduler tick engine (#1251, PR #1257)
- [x] Phase 6: AI-driven card suggestions — LLM analyzes existing cards, proposes complementary metrics grounded in semantic layer (#1252, PR #1258)
- [x] Docs: dashboard user guide (#1261, PR #1264)

---

## TanStack Query Migration

**Frontend data fetching migrated to TanStack Query** across both `packages/web` and `packages/react`. Automatic request deduplication, stale-while-revalidate, window-focus refetch, and cache-aware mutations.

- [x] Foundation — install, QueryProvider, query key factory, shared utils (#1213, #1214, PR #1239)
- [x] Core hooks — useAdminFetch → useQuery, useAdminMutation → useMutation (#1215, #1216, PR #1240)
- [x] IncidentBanner refetchInterval + password-status dedup via usePasswordStatus (#1221, #1219, PR #1241)
- [x] SchemaExplorer, PromptLibrary, EntityEditor → useQuery (#1220, PR #1242)
- [x] useConversations (web) — list fetch, optimistic star, cache-aware delete (#1217, PR #1243)
- [x] @useatlas/react — full adoption: useHealthQuery, conversations, AtlasChat QueryProvider (#1218, PR #1244)
- [x] Polish — health recovery clearing, stable fetchList ref (PR #1245)
- [x] Cleanup — deduplicate health checks, remove legacy hooks, verify dedup wins (#1222, #1223, #1224)

---

## Follow-ups

- [x] Docs: org management guide (#1263, PR #1264)
- [x] Docs: add missing env vars to .env.example — auth mode, scheduler, RLS, deploy mode (#1262, PR #1264)
- [x] Fix: standalone example build — QueryClientProvider + AtlasChat SSR (#1260)
- [x] Chore: publish @useatlas/types 0.0.6 + bump refs (#1259)

---

## 1.0.1 — Effect.ts Completion

**Complete Effect.ts adoption across `packages/api/`.** Eliminate all bridge layers and imperative patterns. Native `@effect/sql` for DB, Effect `Schedule`/`Cron` for timers, `Data.TaggedError` for errors, `Effect.all` for concurrency.

### Native DB Clients (P0 — eliminate bridge layers)

- [x] Migrate internal DB to native `@effect/sql-pg` `PgClient.layer()` (#1281, PR #1286)
- [x] Migrate analytics connection pools to native `@effect/sql-pg` (#1282, PR #1289) — PostgreSQL fully native via `PgClient.layerFromPool()`. MySQL stays on bridge (no `layerFromPool` upstream). Follow-up: #1290

### Timer Leaks (P0 — resource leaks on Railway restarts)

- [x] Migrate OAuth state cleanup setInterval to Effect Layer with finalizer (#1273, PR #1285)
- [x] Migrate auth middleware rate-limit cleanup setInterval to Effect Layer (#1274, PR #1285)
- [x] Migrate settings refresh timer to Effect Layer (#1275, PR #1285)
- [x] Migrate email scheduler to Effect Layer (#1276, PR #1285)
- [x] Replace all setInterval scheduling with Effect Schedule fibers (#1283, PR #1291) — 5 remaining timers migrated to SchedulerLayer

### Concurrency (P1 — unbounded DB calls under load)

- [x] Replace unbounded Promise.all with Effect.all/forEach + concurrency limits (#1277, PR #1287)

### Error Types (P2 — code quality)

- [x] Convert plain Error subclasses to Data.TaggedError (#1278, PR #1284)
- [x] Extract profiler utility functions to break circular dep (#1280, PR #1284)

### Sandbox (P2 — code quality)

- [x] Convert python-sandbox try/catch chains to Effect.tryPromise with retry (#1279, PR #1288)

### NOT migrating (bridge layers are correct)

- **Vercel AI SDK** — `AtlasAiModel` bridge stays. Frontend depends on AI SDK's data stream protocol and `useChat` hook. `@effect/ai` native would break the streaming pipeline.
- **Zod** — Powers `@hono/zod-openapi` for 150-route OpenAPI spec auto-generation. `effect/Schema` would require rewriting every route.
- **`@effect/platform` HTTP** — Hono handles all HTTP serving. No value in adding another HTTP layer.

---

## Follow-ups (post-1.0.1)

- [x] Smarter semantic layer profiling — probabilistic cardinality, FK inference, join candidate scoring (#1272, PR #1272)
- [x] Powered by Atlas badge on embedded widgets (PR #1265)
- [x] Semantic expert agent design doc (#1180, PR #1270)
- [x] Docs: chatEndpoint default `/api/chat` → `/api/v1/chat` (#1271)
- [x] Consolidate AtlasUIProvider + AtlasProvider into single AtlasProvider, shared auth types to @useatlas/types (PR #1298)
- [x] Fix AtlasContext in AtlasChat — useHealthQuery crash on app.useatlas.dev (f158a4cc)
- [x] Publish @useatlas/types 0.0.7 — SEMANTIC_TYPES + profiler exports
- [x] Fix Effect/Turbopack serverExternalPackages conflict in templates
- [x] Docs: fix stale AtlasUIProvider references in react.mdx (#1292, #1293)
- [x] Publish @useatlas/types 0.0.8 + @useatlas/react 0.0.6 — auth types in types, AtlasProvider consolidation in react (#1302)
- [x] Fix: cast user.role in dashboard pages — CI type-check regression from #1298 (#1300)
- [x] Migrate MySQL connections to native `@effect/sql-mysql2` (#1290)

---

## Semantic Layer Versioning

**`atlas migrate` CLI** — snapshot, diff, log, rollback for the semantic layer. Auto-snapshots on `atlas improve` and `atlas init`.

- [x] Snapshot library (`packages/cli/lib/migrate/snapshot.ts`) — capture, restore, diff semantic layer state (#1185, PR #1303)
- [x] CLI commands: `atlas migrate status`, `snapshot`, `diff`, `log`, `rollback` (#1185, PR #1303)
- [x] Auto-snapshot integration with `atlas improve` and `atlas init`
- [x] 626-line test suite for snapshot operations
- [x] Docs updated — CLI reference + semantic expert guide

---

## Multi-Seed Selection

**`create-atlas` seed picker** — choose demo dataset (simple/cybersec/ecommerce) during scaffolding.

- [x] Seed data restructured into `packages/cli/data/seeds/<name>/` (#1188, PR #1304)
- [x] Interactive seed picker + `--seed` flag for non-interactive mode
- [x] Ecommerce seed dataset with 14 entities and semantic layer
- [x] `pruneSeedData()` removes unselected seeds from scaffolded project
- [x] Backward-compat symlinks for Docker image paths
- [x] 316-line test suite for seed selection
- [x] Onboarding route updated for new seed path layout

---

## Semantic Expert Agent

**Autonomous analysis engine** that examines the semantic layer and database, identifies improvement opportunities, and proposes validated YAML amendments.

### Phase 1: Autonomous Analysis Engine
- [x] Analysis engine — 9 analysis categories (coverage, descriptions, types, measures, joins, glossary, sample values, query patterns, virtual dimensions) (#1266, PR #1297)
- [x] 5 new tools — profileTable, checkDataDistribution, searchAuditLog, proposeAmendment, validateProposal
- [x] `atlas improve` CLI command — batch mode with ranked proposals
- [x] DB migration — learned_patterns extended with `type` and `amendment_payload` columns
- [x] Admin UI — semantic_amendment filter + diff view on learned patterns page
- [x] Docs — semantic expert guide page + CLI reference update

### Phase 2: Interactive CLI Mode
- [x] `atlas improve -i` interactive session — multi-turn conversation in terminal (#1267, PR #1301)
- [x] Conversation state management (`packages/api/src/lib/semantic/expert/session.ts`)
- [x] YAML amendment apply/reject/edit flow with colorized unified diffs
- [x] Session summary at exit (accepted/rejected/skipped counts)
- [x] Docs updated — interactive mode section in semantic-expert.mdx + CLI reference

### Phase 3: Web Interactive Mode
- [x] Streaming API route (`/api/v1/admin/semantic-improve/chat`) with expert agent tools (#1268)
- [x] Session management endpoints (list, get, approve, reject proposals)
- [x] Split-view admin page (`/admin/semantic/improve`) — chat panel + proposals panel
- [x] Proposal cards with amendment preview, confidence score, approve/reject buttons
- [x] "Run Analysis" autonomous mode trigger from web UI
- [x] Applied changes recorded in semantic editor version history
- [x] "Improve" button in semantic editor page + sidebar navigation link
- [x] Apply module (`packages/api/src/lib/semantic/expert/apply.ts`) — amendment application with version history
- [x] Route tests for session and proposal endpoints
- [x] Docs updated — web UI section in semantic-expert.mdx

### Phase 4: Scheduled Improvements
- [x] Effect fiber in SchedulerLayer — periodic expert analysis tick (#1269, PR #1306)
- [x] Auto-approval policy via `ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD` setting
- [x] 3 new workspace-scoped settings in Intelligence section
- [x] Context loader (`context-loader.ts`) — disk-based semantic layer reading for scheduled mode
- [x] Health score computation (`health.ts`) — coverage, descriptions, measures, joins sub-scores
- [x] `GET /pending-count` and `GET /health` API endpoints
- [x] Notification badge on admin sidebar "Improve Layer" item (60s polling)
- [x] SemanticHealthWidget on semantic editor page with progress bars
- [x] 16 new tests (7 health + 9 scheduler)
- [x] Docs updated — scheduled mode section in semantic-expert.mdx + .env.example

### Follow-ups
- [x] Restrict auto-approval to low-risk amendment types — `ATLAS_EXPERT_AUTO_APPROVE_TYPES` setting (#1308, PR #1310)
- [x] Cache profiler output for scheduled expert ticks — `profile-cache.ts`, CLI writes cache after profiling (#1307, PR #1309)

---

## MCP Prompt Templates

- [x] Prompt templates via `prompts/list` and `prompts/get` protocol (PR #1296)
- [x] 5 built-in analytical patterns + semantic layer query_patterns + prompt library items
- [x] Docs updated (mcp.mdx)

---

## Per-Seat Pricing & Billing Hardening

**Transition from flat-rate to per-seat pricing model.** 4 tiers (Starter/Pro/Business/Enterprise) with model-aware token budgets, overage handling, and Stripe webhook hardening.

### Pricing Model
- [x] Per-seat pricing with model-aware token budgets (#1327, PR #1327)
- [x] Update pricing page to per-seat model with 4 tiers (#1325)
- [x] Billing admin page for per-seat pricing (#1326, PR #1329)

### Billing Hardening
- [x] Enforce member and connection limits per plan tier (#1314, PR #1320)
- [x] Add missing Stripe webhook handlers — payment failures + plan changes (#1312, #1313, PR #1322)
- [x] Rate limit Stripe portal session endpoint (#1317, PR #1321)
- [x] Use cached workspace data for suspension check (#1315, PR #1319)
- [x] Emit login events for active user tracking (#1316, PR #1318)

### Infrastructure
- [x] Platform email provider — first-class Resend integration with admin UI (#1324)
- [x] Fix: dashboard route require crashes server startup (#1311, PR e3894e2b)
- [x] Fix: org-scope connections table — composite PK (id, org_id) (#1330) — onboarding 409 for all orgs after first

### Bug Fixes
- [x] SSO auto-provisioning bypasses member limit check (#1323, PR #1339)
- [x] Fix admin-layout test — cannot resolve @/components/ui/sidebar (#1328, 54bcd46f)

### SaaS Infrastructure
- [x] Add `atlas.config.ts` for SaaS deployment — dogfood own config (144a2bf1)
- [x] Retry migration with backoff for serverless Postgres cold starts (1b541ff9)
- [x] Migration 0020 — add baseline org columns before tier rename (f027b02e)
- [x] Platform residency page — show not-configured state instead of error (65291d28)
- [x] Simplify region IDs — `us`/`eu`/`apac` (fcab8ac5)
- [x] Remove compliance badges — no security audits completed yet (43ad78c6)

---

## SSO Provider Management UI

**Self-serve SAML/OIDC configuration for SaaS workspace admins.** PRD: #1331. DNS domain verification (shared infra with custom domains), test connection, provider CRUD UI.

### Backend (complete)
- [x] Domain verification backend — migration 0022, DNS TXT lookup, domain-check endpoint (#1332, PR #1340)
- [x] Test connection endpoint — OIDC discovery + SAML cert validation (#1333, PR #1338)
- [x] Fix: grandfather existing enabled providers in migration, DNS timeout (72f662e0)

### Frontend (complete)
- [x] Provider list UI — cards, status badges, SP metadata, enable/disable (#1334, PR #1349)
- [x] Create provider dialog — SAML/OIDC forms, domain check, cert upload (#1335, PR #1349)
- [x] Edit provider dialog — pre-filled forms, secret masking, domain reset (#1336, PR #1349)
- [x] Delete provider — domain confirmation, enforcement warning (#1337, PR #1349)

### Refactors
- [x] Extract shared DNS domain verification utility (`ee/src/lib/domain-verification.ts`) (#1341, PR #1346)

### Docs
- [x] Billing docs — per-seat pricing, model-aware token budgets, overage handling (#1342, PR #1347)
- [x] OpenAPI spec regen — 3 new SSO endpoints + many new API groups (#1343, PR #1347)
- [x] SSO docs — domain verification flow, test connection, updated creation examples (#1344, PR #1347)

### Follow-ups
- [x] Custom domains could adopt DNS TXT verification for domain ownership (#1345, PR #1354)
- [x] Docker template data/.gitkeep missing (#1348)

---

## SaaS Hardening & Compliance

**Post-launch hardening.** GDPR compliance, settings architecture, error typing, billing fixes, package publishes.

### Features
- [x] GDPR workspace purge — hard delete all org data (#1359, PR #1360)
- [x] Split Settings into workspace and platform pages (PR #1358)
- [x] DNS TXT domain ownership verification for custom domains (PR #1354)

### Refactors
- [x] Migrate EE errors to Data.TaggedError (#1353, PR #1355)
- [x] Extract shared DNS domain verification utility (#1341, PR #1346)
- [x] Redact verification token from custom domain API responses (#1356, PR #1357)

### Billing & Pricing
- [x] Flat overage rate + Stripe plan fixes (PR #1362)
- [x] Fix plan name consistency across www pages (PR #1361)

### Packages
- [x] Publish @useatlas/types 0.0.9 — domain verification exports
- [x] Publish @useatlas/react 0.0.7 — consistent send button, no hardcoded colors

### Docs
- [x] Settings split + GDPR workspace purge docs (PR #1371)
- [x] Billing per-seat pricing, SSO domain verification & test connection docs (PR #1347)

### Follow-ups
- [x] Health check findings — PG readonly, sidecar healthchecks, whitelist warning (PR #1374)
- [x] Docs audit — critical/high findings across docs site (PR #1379)
- [x] Docs audit — OpenAPI params, SDK docs, plugin directory (PR #1380)
- [x] CORS on streaming responses, Bun idle timeout, PG read-only (PR #1381)
- [x] Docs accuracy audit — fix 12 findings across docs site (PR #1420)

---

## Admin Action Audit

**Persistent audit log for all admin mutations.** Track who changed what, when, and why across both platform and workspace admin operations. Parent: #1363.

- [x] Tracer bullet — schema + logger + first mutation + platform list + UI (#1364, PR #1373)
- [x] Workspace admin read surface (#1365, PR #1384)
- [x] Instrument all platform admin mutations (#1367, PR #1383)
- [x] Instrument all workspace admin mutations (#1368, PR #1385)
- [x] Filtering + CSV export (#1366, PR #1387)

---

## Native SaaS Chat Page

**Replace embeddable widget with first-class SaaS experience.** The dashboard (`/`) now uses native hooks instead of the `@useatlas/react` embed, giving URL state, prompt library, sharing, and full control. (#1389)

- [x] Native chat page with `?id=` URL state (PR #1388)
- [x] Lift `AtlasProvider` to root `AuthGuard` — remove 4 per-layout wrappers
- [x] Eliminate `DarkModeContext` and `ActionAuthProvider` — dead code after provider lift
- [x] Template overrides for standalone deployments (`create-atlas/overrides/page.tsx`)

---

## Bug Fixes (post-1.0.0)

- [x] Loaded conversations don't render tool results — SQL cards, charts, dashboard button (#1390, PR #1391)
- [x] Demo route does not persist tool results in conversations (#1392, PR #1394)
- [x] Extract `persistAssistantSteps` shared helper — deduplicate chat.ts/demo.ts persistence (PR #1394)
- [x] Semantic improve page shows badge count but no pending amendments (#1395)
- [x] Sidebar double-highlight on Semantic Layer + Improve Layer (PR #1395)
- [x] CORS test explore mock missing exports (#1386, PR #1382)
- [x] `api-test-mocks` missing `hardDeleteWorkspace` export (#1372)
- [x] `ErrorBanner` crashes on `FetchError` — extract `.message` before rendering
- [x] Semantic improve diff viewer: full-file rewrite diffs + monochrome display (PR #1403)
- [x] Admin-actions page missing p-6 padding (PR #1408)
- [x] Semantic improve page: independent scroll areas + text wrapping (PR #1407)
- [x] Semantic improve page: anchor height to viewport for panel scrolling (PR #1410)
- [x] Typing indicator: replace bounce easing with smooth pulse (PR #1412)
- [x] Chat UI: replace hardcoded blue with brand primary (PR #1413)
- [x] Report cells: `toolInvocationId` → `toolCallId` for AI SDK compat
- [x] SQL result card: narrow `executionMs` type before arithmetic

---

## 1.1.0 — Notebook Evolution

**Make the notebook surface earn its place** by bridging exploratory chat and persistent dashboards. PRD: #1396. Milestone: #33.

### Phase 1 (core flow)
- [x] Execution metadata on tool results — timing + row count (#1397, PR #1404)
- [x] Convert chat to notebook — API + UI (#1398, PR #1405)
- [x] Dashboard bridge from notebook cells (#1399, PR #1406)

### Phase 2 (sharing + polish)
- [x] Report route — shareable notebook view (#1400, PR #1409)
- [x] Fork UX — "What if?" affordance + gutter indicators (#1401, PR #1419)
- [x] Execution metadata — rerun comparison (#1402, PR #1411)
- [x] Notebook guide docs update for all 1.1.0 features (#1414, PR #1415)

### Follow-ups
- [x] Extract shared `transformMessages` to `@useatlas/types/conversation` (#1393, PR #1417)
- [x] Fix report-view test: `toolInvocationId` → `toolCallId` (#1416, #1418)
- [x] Publish `@useatlas/types` 0.0.10 — conversation entrypoint

---

## 1.2.0 — Developer/Published Mode

**Stripe-style dual-mode experience with draft/published content model.** Admins configure in developer mode (drafts), publish atomically to users. Demo data is the initial published content for new signups. PRD: #1421. Milestone: #34.

### Foundation
- [x] Schema migration — add `status` column to connections, semantic_entities, prompt_collections (#1423, PR #1443)
- [x] Mode resolution middleware + RequestContext propagation (#1424, PR #1442)
- [x] Onboarding — save demo as `__demo__` connection with `demo_industry` setting (#1425, PR #1446)

### Query Layer
- [x] Published mode query filtering across connections, entities, prompts (#1426, PR #1447)
- [x] Developer mode overlay queries — entity CTE + union queries (#1427, PR #1451)
- [x] Write path mode-awareness — draft creation, draft edits, tombstones (#1428, PR #1461)

### Publishing
- [x] Atomic publish endpoint with `archiveConnections` parameter (#1429, PR #1464)
- [x] Archive/restore connection endpoints with entity cascade (#1437, PR #1469)

### Agent & Data
- [x] Agent isolation — mode-aware connection + whitelist in tool execution (#1430, PR #1460)
- [x] Semantic diff scoping — filter `getDBSchema` to whitelist (#1431, PR #1462)
- [x] Prompt library mode scoping — demo industry filtering + draft visibility (#1438, PR #1465)
- [x] `GET /api/v1/mode` endpoint (#1439, PR #1453)

### Frontend
- [x] Connect page redesign — two equal-weight paths (#1432, PRs #1449, #1456)
- [x] Developer mode banner + cookie-based toggle (#1433, PR #1445)
- [x] Non-admin demo indicator chip (#1434, PR #1459)
- [x] Admin surface — draft/demo badges, read-only published, pending changes summary (#1435, PR #1463)
- [x] Empty states in developer mode (#1436, PR #1467)

### Bug Fixes
- [x] Bundle cybersec + ecommerce semantic directories in Docker image (#1422, PR #1441)
- [x] Docker COPY for demo-semantic and SQL seed symlinks (#1440, PR #1441)
- [x] Partial unique indexes on semantic_entities are NULL-unsafe for connection_id (#1444, PR #1447)
- [x] Scaffold template layout override — strip ModeBanner for standalone deploys (commit 079f8996)
- [x] Scaffold types.ts — `ADMIN_ROLES`/`ATLAS_MODES` missing from published `@useatlas/types` (PRs #1457, #1458 — bumped to `0.0.11`, consumer refs updated; #1448 closed as superseded)
- [x] `admin-publish` reads `demo_industry` setting with wrong key — Phase 4b skips demo-prompt archive (#1466, PR #1486)
- [x] `readDemoIndustry` silent fallback drops prompt cascade on read failure (#1470, PR #1486 — extracted to `lib/demo-industry.ts` with discriminated `{ ok, value | err }` result)
- [x] `client.release()` after ROLLBACK failure may return poisoned connection to pool (#1471, PR #1486 — four sites: admin-archive, admin-publish, migrate, internal.cascadeWorkspaceDelete)
- [x] Organization SaaS columns skipped on first-boot migrations — blocks `checkResourceLimit` (#1472, PR #1484 — reordered Better Auth before Atlas migrations, added `0027_organization_saas_columns.sql`, `skip` list for non-managed deploys)

### Follow-ups
- [x] Rollback poisoning: `hardDeleteWorkspace` and naked ROLLBACK in internal.ts (#1485, PR #1490 — tracks `rollbackErr` at both sites, passes to `client.release(err)`)
- [x] Semantic entity unique index missing `entity_type` — us/apac internal DB `INTERNAL_DB_UNREACHABLE` live incident (#1489 — migration 0028, applied directly to prod + shipped as durable fix)
- [x] Signup-connect error-isolation tests double-counting Next.js dev-tools alert (#1488, PR #1489 — scoped queries to `<main>`)
- [x] Obsidian plugin doc — stale `/api/chat` → `/api/v1/chat` (#1491, surfaced by docs audit)
- [x] Migrate `internalQuery` call sites from `Effect.promise` to `Effect.tryPromise` (#1468, PR #1493 — 37 sites across 15 routes; extracted `queryEffect<T>()` helper in `@atlas/api/lib/effect` with normalized catch; `makeQueryEffectMock` test helper; found during #1465 silent-failure review)
- [ ] Pre-existing flaky middleware test `mode 'managed' with valid session returns authenticated` (#1483 — not a 1.2.0 blocker; milestone stripped, tracked standalone)

---

## 1.2.1 — Adaptive Starter Prompts

**Replace hardcoded starter prompt grid with an adaptive surface.** Composes per-user favorites, admin-moderated popular queries, and industry-filtered fallback. Participates in the 1.2.0 draft/published mode system so admins control what their team sees. PRD: #1473. Milestone: #35.

### Foundation
- [x] Resolver + `/api/v1/starter-prompts` endpoint + cold-start empty state (#1474, PR #1492 — `StarterPromptResolver` with 4-tier compose order, library + cold-start live; favorites/popular stubbed for later slices; shared types in `@useatlas/types/starter-prompt`; id namespacing; chat empty state wired)

### Personal surface
- [ ] Per-user favorites (pin/unpin + resolver integration + pin-on-hover UX) (#1475)

### Admin moderation
- [x] Schema migration + auto-promote + read-only admin queue (#1476)
- [ ] Admin moderation UX — approve/hide/unhide + author form (#1477)
- [ ] 1.2.0 mode participation + CLAUDE.md Content Mode System rule (#1478)

### Other surfaces
- [ ] Widget empty state + `starterPrompts` prop override (#1479)
- [ ] Notebook new-cell empty state (#1480)
- [ ] SDK `atlas.getStarterPrompts()` method (#1481)

### CLI
- [ ] `atlas learn` populates pending approval queue (#1482)

---

## Ideas / Backlog

_Untracked ideas. Create issues when committing to work._

### Expand Reach (build when demand signals appear)
- ~~Python SDK~~ — **closed** (#1181). No demand signal. Reopen when a Python user asks
- ~~MongoDB + GraphQL datasource plugins~~ — **closed** (#1182). Non-SQL needs major architecture work. No demand signal
- ~~Multi-seed selection in `create-atlas`~~ — **shipped** (#1188). Interactive seed picker (simple/cybersec/ecommerce), `--seed` flag, seed data restructured into `seeds/<name>/`

### Competitive Positioning
- ~~Benchmark participation~~ — **closed** (#1183). Lower priority post-launch. Revisit if needed for credibility
- ~~"Powered by Atlas" badge on embedded widgets~~ — **shipped** (PR #1265). Opt-out badge on @useatlas/react and script tag widget
- ~~OSI (Open Semantic Interchange) compatibility~~ — **closed** (#1184). Standard isn't stable yet. Adopt when it solidifies

### Product Extensions
- ~~Dashboard persistence~~ — **shipped** (#1246, PRs #1253–#1258). DB schema + CRUD API, add-to-dashboard from chat, list/view pages with DnD reorder, sharing + public view, auto-refresh via scheduler, AI-driven card suggestions
- Voice input / natural language voice queries — wait for Web Speech API maturity
- Multi-agent collaboration — specialist agents per domain with coordinator routing (#1178, deferred)
- ~~`atlas migrate`~~ — **shipped** (#1185, PR #1303). Snapshot, diff, log, rollback, auto-snapshot on `atlas improve` and `atlas init`
- ~~A/B testing for agent prompts~~ — **closed** (#1186). Needs replay infra, eval metrics, comparison UI. No demand signal

### MCP Enhancements
- WebSocket transport — enables real-time bidirectional communication
- ~~Prompt templates~~ — **shipped** (PR #1296). 5 built-in patterns + semantic layer query_patterns + prompt library
- Resource subscriptions — notify connected clients when semantic layer changes

### Plugin Ecosystem
- ~~Agent error recovery hooks~~ — **closed** (#1187). Speculative. Build when plugin authors request specific hooks
- ~~Streaming action approval~~ — **closed** (#1187). Same — build on demand
