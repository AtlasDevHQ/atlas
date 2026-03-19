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

### Quality

- [ ] Notebook test coverage — keyboard nav, components, edge cases (#610)
- [ ] Notebook UX polish — keybindings, dead code, dialog dedup (#611)

### Features

- [ ] Notebook Phase 2 — fork + reorder (#604)
- [ ] Notebook Phase 3 — export + text cells (#605)

---

## 0.9.0 — SaaS Infrastructure

**The milestone that makes Atlas a hosted product.** Everything before this is "software that works well." This milestone is "software you can sell."

### Tenant Provisioning

- [ ] Self-serve signup flow — email/OAuth signup → workspace creation → connect database wizard. No CLI, no `atlas init`, no YAML editing. The web equivalent of `bun create atlas-agent` but for non-developers
- [ ] Workspace lifecycle — create, suspend, delete. Cascading cleanup of connections, conversations, semantic layers, cached results
- [ ] Guided semantic layer setup wizard — web UI replacement for `atlas init`. Profile database, review generated entities, edit descriptions, preview agent behavior. The design doc exists at `.claude/research/design/semantic-layer-editor.md`

### Usage Metering & Billing

- [ ] Usage tracking — per-workspace query count, token consumption, storage, active users. Extend existing token tracking to workspace-scoped metering
- [ ] Billing integration — Stripe or similar. Free tier, usage-based tiers, enterprise custom. Meter → invoice → enforce limits
- [ ] Usage dashboard — customer-facing view of consumption, limits, and billing history
- [ ] Overage handling — graceful degradation (rate limit, then block) when workspace exceeds plan limits

### Enterprise Features (`/ee`)

Source-available under separate commercial license. Core AGPL functionality stays free — `/ee` is governance, compliance, and scale features that enterprises pay for.

#### Auth & Access Control

- [ ] `/ee` directory structure — source-available enterprise features under separate commercial license
- [ ] Enterprise SSO via `@better-auth/sso` plugin — per-organization SAML and OIDC provider registration, domain-based auto-provisioning
- [ ] SCIM directory sync — automated user provisioning from enterprise IdPs
- [ ] SSO enforcement — require SAML/OIDC for workspace, no password fallback
- [ ] IP allowlisting — restrict API and UI access by CIDR range per workspace
- [ ] Custom role definitions — beyond admin/user (e.g., "analyst: query but no raw data," "manager: approve actions but no config")
- [ ] Approval workflows — require sign-off for queries touching specific tables or exceeding cost thresholds

#### Compliance & Audit

- [ ] Audit log retention policies — configurable retention (30d/90d/1yr/custom), auto-purge, compliance export formats (SOC2-ready)
- [ ] PII detection and column masking — context plugin for profiling tags + `afterQuery` hook for role-based masking. Benefits from semantic layer indexing (0.7). The detection engine lives in `/ee`; the plugin hook interface stays in core
- [ ] Compliance reporting dashboard — SOC2/HIPAA audit trail summaries, data access reports by user/role/time period

#### Multi-Tenant Enterprise

- [ ] Data residency controls — route tenant data to region-specific storage (EU customers need EU data)
- [ ] Custom domains — `data.customer.com` pointing at their Atlas workspace
- [ ] Tenant-level model routing — enterprise customers bring their own LLM API key or use a specific model per workspace

#### Branding

- [ ] White-labeling — remove Atlas branding from UI, custom logo/colors/favicon beyond standard theming

### Platform Operations

- [ ] SLA monitoring and alerting — per-tenant uptime, query latency p50/p95/p99, error rates. Internal dashboards for platform operators
- [ ] Abuse prevention — beyond rate limiting: anomaly detection on query patterns, connection abuse, resource exhaustion. Auto-suspend on sustained abuse
- [ ] Platform admin console — cross-tenant view for Atlas operators (not customer admins). Workspace health, noisy neighbors, capacity planning
- [ ] Automated backups and disaster recovery for internal DB and tenant metadata

### Onboarding

- [ ] Interactive demo mode — try Atlas against a sample database without connecting your own. The cybersec demo dataset, hosted, zero-config
- [ ] Onboarding email sequence — welcome, connect database, first query, invite team, explore features
- [ ] In-app guided tour — highlight key features for new workspace members

---

## 1.0.0 — SaaS Launch

**app.useatlas.dev goes live.** The hosted product where teams sign up, connect their database, and have a production-ready AI data analyst without deploying anything.

- [ ] Public pricing page on useatlas.dev — free tier, team tier, enterprise tier
- [ ] SLA commitments — uptime guarantee, query latency targets, support response times
- [ ] Terms of service, privacy policy, DPA for enterprise
- [ ] Launch content — blog post, Show HN (if not done earlier), comparison pages updated
- [ ] Migration tooling — path from self-hosted Atlas to hosted (export/import conversations, semantic layers, settings)
- [ ] Documentation for hosted users — separate onboarding flow from self-hosted docs
- [ ] Status page — public incident communication

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
