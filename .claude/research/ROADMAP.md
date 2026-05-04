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

## Shipped Milestones (0.6.0 → 1.2.3)

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

---

## Active: 1.4.0 — MCP & Agent-First DX

Tracker: [milestone #40](https://github.com/AtlasDevHQ/atlas/milestones/40). Lead Atlas with the MCP story (`bunx` installer, hosted endpoint, typed tools) and the YAML-first semantic-layer narrative.

- [x] One-command MCP installer — `bunx @useatlas/mcp init --local` writes a paste-ready config or merges into the detected client (#2018, PR #2032)
- [x] Typed semantic-layer MCP tools + version sync — `listEntities` / `describeEntity` / `listMetrics` / `runMetric` exposed; server version tracks `package.json` (#2019 + #2020, PR #2031)
- [x] Scaffolder rename — `bun create atlas-agent` / `bun create atlas-plugin` reads as English; old `@useatlas/create*` deprecated with redirect (PR #2033)
- [ ] Hosted MCP endpoint at `mcp.useatlas.dev` with SaaS auth (#2024, #2028)
- [x] OTel coverage for MCP tool calls — activation + tool-call counters (#2029, PR #2035)
- [x] Structured error envelope for typed MCP tools so agents can recover gracefully (#2030, PR #2034)
- [ ] List Atlas in MCP registries (mcp.so + others) before close (#2027)
- [x] Lead README, docs homepage, and landing with MCP + the YAML-first story (#2026, PR #2040) — moat sentence verbatim across README, docs homepage, www landing; new `/semantic-layer` docs section; NovaMart canonical 5 questions consistent across surfaces.
- [x] Canonical-question eval harness for the demo dataset (#2025, PR #2041) — 20-question curated set under `eval/canonical-questions/`, deterministic by default (calls typed semantic-layer reads + executes the resolved SQL directly, mirroring the typed MCP `runMetric`), `--llm` mode for the full agent loop. CI gate at `.github/workflows/eval.yml` is informational on PRs and blocking on release tags.
- [x] Consolidate canonical demo dataset across landing, docs, scaffolder (#2021, PR #2036) — three seeds collapsed to one canonical NovaMart ecommerce seed; multi-seed picker reverted; canonical question set locked for #2025/#2026.
- [x] Streaming chat CORS fix (PR #2037) — surfaced by the post-#2021 demo smoke; same latent bug existed for cross-origin embedders of `@useatlas/react`.
- [x] CI un-stuck — partial `mock.module(@atlas/api/lib/config)` in @atlas/mcp tests was breaking `bun test`'s in-process runner across files (PR #2038).
- [x] Publish `@useatlas/mcp` to npm — vendor + dynamic-import detangle resolves the workspace dep; the lead install command now runs against the published artifact (#2042, PRs #2048/#2049/#2050).
- [x] Retarget `concepts.mdx` from cybersec to NovaMart — final stale-reference cleanup from #2021's seed consolidation (#2043, PR #2045).
- [x] `Question` discriminated-union refactor — drops every `?? ""` fallback in the eval harness; loader rejects mode/expect mismatches at compile time (#2044, PR #2046).
- [x] NovaMart seed `order_items → products` join fix — the canonical-question harness surfaced two metrics returning 0 rows; replaced denormalized name-string join with a `product_id` FK (#2039, PR #2051).

Backlog (not committed for 1.4.0): `/agent-mode` view (#2022), `runbooks-context` plugin (#2023).

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
