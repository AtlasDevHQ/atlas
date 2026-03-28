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

- [x] Self-serve signup flow (#644, PR #674) — email/OAuth signup → workspace creation → connect database wizard. No CLI, no `atlas init`, no YAML editing. The web equivalent of `bun create atlas-agent` but for non-developers
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
- [ ] SDK, MCP, and widget integration — external integration points (#952) — deferred

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
- [x] Isolate corrupted-DuckDB test in subprocess to fix flaky segfault (#992, PR #1018)

---

## 0.9.7 — SaaS-First Admin Experience

**Make app.useatlas.dev feel like a real SaaS product, not a self-hosted deployment.** Remove operator-facing UX (env var names, "Requires restart", "configure DATABASE_URL") from the workspace admin experience. Make plugins, integrations, sandbox, and settings self-serve for paying SaaS customers. Keep self-hosted persona fully functional.

### Foundation (P0)

- [x] Add explicit deploy mode flag — `ATLAS_DEPLOY_MODE=saas|self-hosted|auto` (#1020, PR #1031)
- [x] Hide "Requires restart" and env var names from SaaS workspace admins (#1021)
- [x] Filter settings page to workspace-relevant settings in SaaS mode (#1022, PR #1035)

### Self-Service Features (P1)

- [ ] Make restart-required settings hot-reloadable in SaaS mode (#1023)
- [ ] OAuth-first integration connect flows for SaaS workspaces (#1024)
- [ ] Plugin marketplace — browse, install, configure per workspace (#1025)
- [ ] Product-focused sandbox selection UX for SaaS users (#1026)
- [ ] Product-focused data residency UX for SaaS users (#1027)

### Finishing Touches (P2)

- [ ] Email integration connect flow in Integrations hub (#1028)
- [ ] Self-hosted deploy validation via GH Actions for template repos (#1029)

---

## 1.0.0 — SaaS Launch

**app.useatlas.dev goes live.** The hosted product where teams sign up, connect their database, and have a production-ready AI data analyst without deploying anything.

- [x] Public pricing page on useatlas.dev (#871, PR #922)
- [ ] SLA commitments — uptime guarantee, query latency targets, support response times (#872)
- [ ] Terms of service, privacy policy, DPA for enterprise (#873)
- [x] Launch content — blog post, Show HN, comparison pages updated (#874, PR #924)
- [ ] Launch content follow-up — social media assets and demo video (#954)
- [ ] Migration tooling — self-hosted to hosted (export/import conversations, semantic layers, settings) (#875)
- [ ] Documentation for hosted users — separate onboarding flow from self-hosted docs (#876)
- [x] Status page — public health dashboard (#877, PR #921)
- [ ] Status page follow-up — incident management, subscriptions, maintenance (#953)

---

## Ideas / Backlog

_Untracked ideas. Create issues when committing to work._

### Expand Reach (build when demand signals appear)
- Python SDK — `pip install useatlas`, thin HTTP wrapper around Atlas API. Build when a Python user asks for it, not before
- MongoDB datasource plugin — `@useatlas/mongodb`. Uses aggregation pipeline instead of SQL. Requires custom validation hook (0.6.0)
- GraphQL datasource plugin — needs custom validation like MongoDB
- Multi-seed selection in `create-atlas` (choose demo type: cybersec, ecommerce, devops)

### Competitive Positioning
- Benchmark participation — publish Spider/BIRD results for credibility. Better after `atlas learn` exists (0.7.0)
- "Powered by Atlas" badge on embedded widgets (opt-out) — viral distribution mechanic. Value scales with brand recognition
- OSI (Open Semantic Interchange) compatibility — align YAML format with emerging standard (dbt + Cube + Snowflake + ThoughtSpot)

### Product Extensions
- Dashboard persistence — save chart layouts, build lightweight dashboards from query results
- Voice input / natural language voice queries — wait for Web Speech API maturity
- Multi-agent collaboration — specialist agents per domain with coordinator routing
- `atlas migrate` — semantic layer versioning and migration tracking
- A/B testing for agent prompts — compare system prompt variants on identical queries

### MCP Enhancements
- WebSocket transport — enables real-time bidirectional communication
- Prompt templates — expose curated patterns via MCP `prompts/list`
- Resource subscriptions — notify connected clients when semantic layer changes

### Plugin Ecosystem
- Agent error recovery hooks — plugin hook for custom fallback behavior when tools fail
- Streaming action approval — SDK method for real-time action approval workflows
