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

## Shipped Milestones (0.6.0 → 1.5.0)

Full detail archived in [`ROADMAP-archive.md`](./ROADMAP-archive.md). Issues + PR bodies remain the source of truth; one-liners below are hooks, not commitments.

- [x] **0.6.0 — Governance & Operational Hardening** (#7, 44 issues) — action timeout + rollback, configurable step/import limits, RLS multi-column/array/OR, session management, audit CSV + search + classification, typed plugin peer deps, tool hooks, custom SQL validation, semantic diff UI, Teams + webhook + email-digest plugins.
- [x] **0.7.0 — Performance & Multi-Tenancy** (#8, 27 issues) — Better Auth org plugin, tenant-scoped connection pooling, query result caching, semantic layer indexing, streaming Python, `atlas learn` CLI.
- [x] **0.7.x Refinement Arc** (#15–#19) — five point releases across cleanup, type safety, error handling, test hardening, docs completeness.
- [x] **0.8.0 — Intelligence & Learning** (#9, 12 issues) — dynamic learning (proposals + injection + admin UI), self-hosted models, auth refactor, prompt library, query suggestions, notebook UI phase 1.
- [x] **0.8.1 — Notebook Refinement** (#20, 36 issues) — fork/branch + DnD reorder + markdown cells + Markdown/HTML export, keyboard nav tests, error-code docs.
- [x] **0.9.0 — SaaS Infrastructure** (#21, 86 issues) — tenant provisioning, billing, enterprise auth (SSO/SCIM/IP/custom roles/approval), compliance (audit retention/PII/reporting), 8-platform Chat SDK, platform ops (SLA/abuse/backups/residency), onboarding.
- [x] **0.9.1 — Docs & Polish** (#22, 94 issues) — docs for every SaaS feature, OpenAPI auto-gen (4,300 → 230 lines), enterprise hardening, 8 architecture refactors, react-hook-form + `useAdminMutation` across all 26 admin pages.
- [x] **0.9.2 — Docs Persona Audit** (#23, 8 issues) — classified all 354 docs pages by persona; reframed deployment + enterprise guides.
- [x] **0.9.3 — Architecture Deepening** (#25, 6 + 2 superseded) — 13 architecture-wins entries: auth error dedup, `extractFetchError`, `AdminContentWrapper` (-302 lines), route error wrapper (-852 lines), `ResultCardBase`, OpenAPI schema factories, conversation fetch client.
- [x] **0.9.4 — Effect.ts Migration** (#26, 23 issues) — every backend service became a `Context.Tag`, `@effect/ai` + `@effect/sql` adopted across the API server, all route handlers migrated from `c.get()` to Effect Context.
- [x] **0.9.5 — Post-Effect Validation** (#27, 7 + 1 deferred) — no regressions: 250 unit + 434 EE + 44 browser tests green; 3 env-isolation PRs.
- [x] **0.9.6 — SaaS Customer Experience** (#28, 24 issues) — org-context enforcement on every route, workspace-level settings overrides, API key management UI, integrations hub, custom domain, billing, per-workspace sandbox + residency, Drizzle Kit migrations.
- [x] **0.9.7 — SaaS-First Admin Experience** (#29, 53 issues) — deploy mode flag, hot-reloadable settings, OAuth-first connect flows for 7 platforms, plugin marketplace, semantic layer web editor, BYOT dual-mode, deploy validation CI, sandbox BYOC library.
- [x] **0.9.8 — Docs & Polish** (#30, 27 issues) — docs for 0.9.7, integration type safety, data residency (signup + migration phases 1–2), periodic settings refresh, deploy-validation CI fixes, npm publishing fixes.
- [x] **1.0.0 — SaaS Launch** (#24, 40 issues) — 3 regions live (US/EU/APAC), cross-region migration, pre-launch smoke test, competitive refresh, legal pages, SLA, OpenStatus, hosted docs.
- [x] **1.1.0 — Notebook Evolution** (#33, 11 issues) — chat-to-notebook, dashboard bridge, report route, execution metadata, fork UX ("What if?" button + gutter indicators), `transformMessages` extraction.
- [x] **1.2.0 — Developer/Published Mode** (#34, 31 issues) — draft/published content model, mode middleware, overlay queries, atomic publish endpoint, agent isolation, connect redesign, `__demo__` onboarding identity.
- [x] **1.2.1 — Adaptive Starter Prompts** (#35, 15 issues) — adaptive starter surface end-to-end with favorites + popular + library + cold-start, admin moderation, `atlas learn` CLI, widget + SDK + notebook surfaces, mode participation.
- [x] **1.2.2 — Admin Console Polish & Schema Consolidation** (#36, 70+ issues) — admin final-pass buckets 1+2+4, `@useatlas/schemas` wire consolidation (`admin-schemas.ts` 542 → 241 lines), `@useatlas/types` 0.0.11 → 0.0.14 with `Percentage` / `Ratio` branded types + 4 discriminated-union migrations, `MutationErrorSurface` + branded `FeatureName` registry across ~40 admin pages.
- [x] **1.2.3 — Security Sweep** (#37, 7 phases, 90+ findings, 23 PRs) — 7-phase audit-and-fix across auth/middleware (F-01..F-07), org-scoping + ContentMode (F-08..F-16), SQL validator fuzz (F-17..F-21), audit-log coverage on 201 write routes (F-22..F-36), secret/error surfaces + plugin credentials (F-41..F-52), rate limiting + timeouts + DoS (F-73..F-92), EE governance bypasses (F-53..F-72). Headline ships: plaintext-column drop on all 10 integration tables (#1832), `ATLAS_ENCRYPTION_KEYS` versioned keyset rotation (F-47), webhook replay + per-channel rate limit (F-75/F-76), atomic per-conversation step budget (F-77), residue audit script with `ATLAS_STRICT_PLUGIN_SECRETS` opt-in (#1835). Remediation tail closed in **1.2.4 — Security Cleanup Tail**: F-53 (custom-role route-layer enforcement, #1849), F-56 + F-59 (SSO bypass on `byot` + test debt, #1852), MCP actor binding (#1858), and F-57 (SCIM provenance gate on admin user mutations, #1853). Findings + step-by-step shipped notes in `.claude/research/security-audit-1-2-3.md`.
- [x] **1.3.0 — End-User UI Design Pass** (#38, 28 issues + tracker #1719) — critique → distill → colorize → polish across 8 buckets covering chat, notebook, dashboards, public views (shared/embed/report), onboarding (login/signup/create-org/wizard), demo, landing page, and apps/www legal. Shared primitives extracted: `<OnboardingShell>` + `<StepTrack>` for onboarding chrome, `<AssistantTurn>` (#1888) for the chat-and-notebook gutter rail, `LegalSection` for legal pages. Post-bucket public-page audit caught license/region/retention/MFA drift and shipped TOTP MFA (#1925) + 365-day audit retention default (#1927).
- [x] **1.3.1 — Post-Launch Production Audit** — `/prod-audit` + `/www-audit` + `/docs-audit` passes shipped ~30 fixes: SaaS boot-guard family covering 9 misconfigs (#1978/#1983/#1988), OTel coverage on scheduler+plugin+abuse (#1979), security headers across api/web/www (#1984), chat Retry-After + degradation warning frames (#1980 + #2005), sub-processor change feed via Atom + signed webhooks (#1924), Lighthouse CI budget for marketing surfaces (#2009), legal/sitemap/docs refresh. Architecture wins #45–#47.
- [x] **1.4.0 — MCP & Agent-First DX** (#40, 21 issues) — closed the agent-first install/discovery surface end-to-end. `bunx @useatlas/mcp init` (zero-config local + `--hosted` OAuth 2.1 loopback) #2018, hosted MCP endpoint per-region (us/eu/apac) with DCR + PKCE + RFC 9728 protected-resource metadata + `421 Misdirected Request` residency enforcement #2024 (PRs #2054/#2056/#2057/#2059/#2062), admin Settings → OAuth Clients revocation surface, typed semantic-layer MCP tools (`listEntities`/`describeEntity`/`searchGlossary`/`runMetric`) #2020 with structured `AtlasMcpToolError` envelope #2030, OTel coverage for MCP tool calls #2029, eval harness with 20 canonical questions #2025, NovaMart canonical seed (three seeds collapsed to one) #2021, README/docs/landing leading with the moat sentence + YAML-first story #2026, `@useatlas/mcp` published to npm #2042, listed on `registry.modelcontextprotocol.io` as `io.github.AtlasDevHQ/atlas` (auto-published via OIDC on every `mcp-v*` tag) #2027, path-A standalone-serve decision (hosted-only) #2052, scaffolder rename to `bun create atlas-agent`/`bun create atlas-plugin`. Backlog deferred: `/agent-mode` view (#2022), `runbooks-context` plugin (#2023). Architecture debt tracked separately: `/ee` decoupling (#2017).
- [x] **1.4.1 — MCP: Bringing It All Together** (#41, 34 issues) — closed the post-1.4.0 follow-up themes end-to-end across workspace-native UX, brand + production hygiene, governance, eval + tool quality, distribution + extensibility, and a 9-item Theme F closeout sweep. Headline ships: Settings → AI Agents per-user MCP wizard (#2065/#2066/#2067), `mcp.useatlas.dev` brand-first hostname (#2068), measured perf profile + 100-session cap validation (#2070), per-OAuth-client rate limiting (#2071), surface-scoped approval rules (#2072), cross-workspace agent identity (#2073), MCP-path eval + tool description rubric + canonical-prompt exposure (#2074/#2119/#2075/#2076/#2179), Claude Desktop catalog in-repo deliverables (#2077), `AtlasPlugin.mcpTools()` extension point (#2078), `@useatlas/sdk/mcp` programmatic onboarding (#2079), CI-driven manual MCP load-test workflow (#2129/#2235), shared OAuth 2.1 helper extraction (#2203), live MCP usage chip (#2216). Spawned to backlog: durable session store (#2109, trigger-gated), explore tool refactor (#2123, post-multi-source), Claude Desktop catalog form submission (#2200, operator-side).
- [x] **1.4.2 — End-user shakeout** (#42, 42 issues) — admin chrome lift to top-level `/platform/*` (#2305/#2307), chat-first front door for non-admins (#2022) + per-user default landing (#2325), BYOT direct-provider discovery on Anthropic / OpenAI / Bedrock with Postgres L2 cache + graceful unknown-model handling (#2174 rolling up #2271–#2275), Vercel AI Gateway model catalog picker (#2173), `__demo__` collapsed to one global row (#2304), `/settings/profile` self-serve page (#2255), shared primitives extracted (`<MfaPanel>` #2257 / `AdminBreadcrumb` discriminated union #2258 / canonical DatePicker #2171), dev-mode discoverability via `PendingChangesPill` (#2177), persistent admin top bar (#2176), and a long platform-admin / bug pass. Closed 2026-05-12.
- [x] **1.4.3 — Agent-first front door + BYOT polish** (#44, 12 issues) — closed the post-#2174 BYOT review tail: typed `WorkspaceCredentials` union + parameterized `ByotAdapter<Cred>` (#2282), scheduler-driven catalog refresh (#2284), `encryptUrl`→`encryptSecret` rename (#2285) with branded `URLSecret`/`OpaqueSecret` return types (#2370), L1↔L2 wiring test (#2287), Bedrock IAM + direct-provider picker docs (#2286/#2351); SDK 0.0.14 multi-workspace MCP shape (#2196); `useSession()` widening (#2334). Architecture-wins #54–#57. Closed 2026-05-12.
- [x] **1.4.4 — Multi-environment semantic layer** (#45, 64 issues — biggest schema shift since 1.0, closed 2026-05-17) — connection groups foundation + group-scoped semantic/PII/dashboards/scheduled-tasks/approvals + group-aware chat routing + admin merge-into-group wizard + Phase 4 archive cascade + `/admin/semantic` drift drawer (retires `/admin/schema-diff`) + Group-by [Type|Env] toggle + SaaS trial onboarding (PRD #2464). Legacy `connection_id` dropped; `@useatlas/types` → 0.1.x. 17-finding closeout audit (#2407) + three rounds of 2026-05-16 dogfood verification fixes. Arch-wins #58–#60.
- [x] **1.4.5 — Cross-environment querying** (#47, 6 issues, closed 2026-05-17) — Agent-routed Auto/Pin/All-envs scope on `executeSQL`; `conversations.routing_mode`; `query_audit.parent_audit_id` rollup; `envContributions` wire type; `atlas.routing_mode` OTel attr. Deep modules `environment-routing` + `multi-env-result-merger` (arch-wins #61/#62). PRD #2515.
- [x] **1.4.6 — Chat as dashboard editor** (#46, 9 issues, closed 2026-05-17) — Bound chat editor + per-user drafts + atomic three-way-merge Publish + stage tracker + `screenshotDashboard` vision tool + History tab. `ATLAS_DASHBOARD_DRAFTS_ENABLED` default-ON. Deep modules `dashboard-versioning` / `stage-tracker` / `boundChatContext` (arch-wins #63/#64 + stage-tracker + screenshot pipeline entries). PRD #2362.
- [x] **1.5.0 — Proactive Chat** (#43, 11 issues, closed 2026-05-17) — `/ee`-gated, Slack-first. Reaction-first tracer → answer pull on tap; three-layer kill switch (`@atlas pause` / admin toggle / DM `unsubscribe`); meter + audit + monthly quota cap. Awaiting design-partner adoption to hit <5% misfire / ≥70% acceptance before promoting beyond Slack. Opens "1.5.x = Atlas Everywhere". PRD #2291.
- [x] **1.5.1 — Architecture Deepening** (#48, 11 slices + 8-PR cleanup trail, closed 2026-05-18) — Inverted `core → ee` per #2017: every enterprise subsystem now sits behind a `Context.Tag` with a fail-closed no-op default; `lib/effect/enterprise-layer.ts` is the single allowed `@atlas/ee` import in core (locked by `check-ee-imports.sh` + `ee-stub-build` job). Detail in archive.

---

## Active

- **1.5.2 — Multi-Adapter SaaS Readiness** ([milestone #50](https://github.com/AtlasDevHQ/atlas/milestone/50), 13 issues + [PRD #2649](https://github.com/AtlasDevHQ/atlas/issues/2649)) — establish operator/customer seam for chat Platforms + integration plugins. Slack end-to-end (slices 1–7 + Disconnect #2695), form-based install + Email (#2697), Webhook + Obsidian (#2699), Salesforce + `integration_credentials` table + [ADR-0005](../../docs/adr/0005-integration-credentials-table.md) (#2700), Jira lazy OAuth (#2707, ~54% fewer files than #2700 — pattern proven), Slack proactive UX threading + conversational mode + disclosure buttons (#2709) shipped; remaining: entitlement UX polish (#2701–#2703). See [`docs/prd/multi-adapter-saas-readiness.md`](../../docs/prd/multi-adapter-saas-readiness.md).

## Planned

_None queued. See `/next` for candidates._

## Parked

- **SaaS Trust & Compliance** — clustered candidate ([#1928](https://github.com/AtlasDevHQ/atlas/issues/1928) SOC 2 + ISO 27001 + pen test + IR drills, [#1922](https://github.com/AtlasDevHQ/atlas/issues/1922) DPA PDF, [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936) OpenStatus Starter). Not milestoned yet — promote when enterprise pipeline signals adoption pressure.

---

## Closed parallel tracks

- [x] **Multi-method MFA hardening** (6 issues #2082/#2090/#2091/#2092/#2093/#2094) — WebAuthn passkeys + TOTP + trusted-device 30d shipped end-to-end across enrollment, sign-in, governance, telemetry, and recovery. Full detail in `ROADMAP-archive.md`.
- [x] **Post-1.4.2 security + polish hygiene** (PRs #2353–#2358) — npm supply-chain worm hardening (#2353), CodeQL ReDoS/sanitization/URL/shell sweep (#2355 + #2357 + #2358), rail collapse-trigger + hover scoping (#2354), dashboards-rail remount flash (#2356).
- [x] **SaaS sandbox = Vercel Sandbox exclusive** (#2382, #2383, #2387, #2389) — `deploy/api/atlas.config.ts` pins `["vercel-sandbox"]`; sidecar fallback removed so a Vercel outage hard-fails the explore tool rather than degrading isolation. Hardening tail (#2389) brands the Vercel token as `OpaqueSecret`, surfaces a SaaS hard-fail error when sandbox.priority backends all fail, and adds detector + credential-handoff tests — closes #2384/#2385/#2386.
- [x] **Post-1.4.3 bug pass** (PRs #2388, #2390) — semantic-layer whitelist now accepts dialect-quoted reserved-keyword tables (`"user"`, `` `events` ``, `[Order]`); SaaS abuse-detector escalation ladder gated by per-step dwell time (`ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS`, default 60s) and short-circuited entirely on self-hosted (operator IS the user).
- [x] **Post-1.4.4 multi-env tracer + page guard** (#2441, PR #2445) — real-API e2e against three local Postgres on 5433/5434/5435 with divergent seeds (10/100/1000 customers, prod-only `vip_tier`), shared `e2e/browser/lib/{totp,admin-auth}.ts` helpers, MFA-aware seed script, and an `Array.isArray()` defensive guard on `/admin/connections` for the prod render crash tracked at #2444 (root cause still open).
- [x] **Post-1.5.0 marketing-pass + dogfood** (PRs #2553, #2560, #2561, #2562) — marketing-pass sweep bundled all 9 docs/landing issues into one PR (#2114, #2550–#2559). Dogfood caught two routing bugs: chat env picker defaulted to alphabetical-first instead of group primary (#2560), and admin semantic listed 46 entities (DB + disk dupes) instead of 23 (#2561 — boot reconciliation now GCs orphan YAMLs).
- [x] **Post-1.5.0 proactive listener wiring** (parent #2607, 11 PRs + 11 follow-up PRs, closed 2026-05-19) — `@useatlas/chat` listener wired into SaaS deploy + Slack `@mention`/thread migrated off `slack.ts`; dogfood-verified in `#sandbox-atlas`. Same-day follow-ups: #2622/#2624/#2633/#2634/#2635/#2637/#2638/#2641 shipped + #2623 all 6 items (item 1 became milestone 1.5.2 slice 1 via #2663); arch-win #66 banked + #2634/#2641/#2663 candidates open.
- [x] **Post-1.5.2 slice 6 dogfood hotfix** (#2676/#2678, closed 2026-05-20) — `#sandbox-atlas` proactive stopped firing after a Slack OAuth re-install; two-stage cause: (1) `SLACK_ENCRYPTION_KEY` unset on api/api-eu/api-apac left the chat-adapter uninstantiated, (2) `@chat-adapter/slack:setInstallation` overwrote the `chat_cache` row and dropped Atlas's `orgId` extension. `pg-adapter.set()` now JSONB-merges for `slack:installation:*` keys so the chat-adapter's overwrite preserves host-extension fields. Follow-ups: #2672 (SaaS boot guard for `SLACK_ENCRYPTION_KEY`), #2673 (AdapterRegistry log severity), #2677 (Atlas-extension contract audit — 3rd instance of "chat-plugin migration ported happy path but dropped an extension contract" after #2628/#2630).
- [x] **Post-1.5.2 reaction-back hotfix** (#2680, closed 2026-05-20) — proactive reaction-back silently skipped since #2607: `pending` recorded under bare `channelId`, looked up under encoded `threadId`. `ThreadId`/`ChannelId` brands in `@useatlas/types@0.1.5` make the divergence compile-uncheckable; 4th instance of the #2677 chat-plugin extension-contract audit pattern.
- [x] **Global Cmd+K palette + admin nav consolidation** (#2706, closed 2026-05-23) — extracted reusable `palette/` primitives (palette-items, settings-palette-items, global-command-palette); collapsed admin/action-log, admin/token-usage, admin/settings/mcp pages into tab modules; tightened admin nav + deploy-mode hook. Foundation for keyboard-first admin nav.

---

## Ideas / Backlog

_Untracked ideas. Create issues when committing to work._

### Expand Reach (build when demand signals appear)
- ~~Python SDK~~ — **closed** (#1181). No demand signal. Reopen when a Python user asks
- ~~MongoDB + GraphQL datasource plugins~~ — **closed** (#1182). Non-SQL needs major architecture work. No demand signal
- ~~Multi-seed selection in `create-atlas`~~ — **shipped** (#1188), then **reverted** in 1.4.0 (#2021). Atlas now ships a single canonical demo seed (NovaMart e-commerce); the `--seed` flag was removed and `--demo cybersec` / `--demo simple` error with a migration message. The cybersec and simple seed files are gone — git history preserves them if demand resurfaces

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
