# Atlas Roadmap

> Public repo: [AtlasDevHQ/atlas](https://github.com/AtlasDevHQ/atlas). Tracking lives in [GitHub Issues](https://github.com/AtlasDevHQ/atlas/issues) and [Project Board](https://github.com/orgs/AtlasDevHQ/projects/2).
>
> Previous internal milestones (v0.1–v1.3) archived in `ROADMAP-archive.md`.
>
> **Versioning**: Public semver starts at 0.0.x. Internal milestones (v0.1–v1.3) were pre-public. The numbers below are public semver.

---

## Shipped

Work completed since public repo launch.

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

---

## 0.1.0 — Documentation & Developer Experience ✅

**COMPLETE.** The #1 barrier to adoption is discoverability. You can't grow what you can't find.

### Docs Site (docs.useatlas.dev)
- [x] Scaffold and deploy docs site with Fumadocs (#56, #72)
- [x] Docs site content — reference pages, integrations, operations guides (#73, #76, #78, #79, #87–#92, #95)
- [x] Generate API reference from OpenAPI spec (#86, #98, #99, #100, #101, #102)

### DX Polish
- [x] `atlas doctor` — validate env, check connectivity, report config issues (#57, #68)
- [x] Better first-run error messages (#58, #69)
- [x] Shell completions for CLI — bash, zsh, fish (#59, #94)
- [x] `atlas validate` — check config and semantic layer (#60, #71)

### Test Coverage Gaps
- [x] Web UI tests — chat components, admin console, auth flows (#61, #77, #96)
- [x] SDK integration tests against running server (#62, #70)
- [x] Expand E2E test coverage beyond smoke tests (#63, #97)

### Project Hygiene
- [x] CHANGELOG.md — retroactive from git history (#64, #67)
- [x] CONTRIBUTING.md — dev setup, PR conventions, testing guide (#65, #67)
- [x] Issue and PR templates (#66, #67)
- [x] Brand color unification across web, www, docs (#74, #75)

---

## 0.2.0 — Plugin Ecosystem ✅

**COMPLETE.** Atlas plugins follow Better Auth's pattern: factory functions with `satisfies AtlasPlugin`, Zod config schemas, `$InferServerPlugin` for client type inference, `plugins: [myPlugin({ ... })]` registration. The SDK (`createPlugin`, `definePlugin`) is stable.

### Foundation
- [x] fix: add "sandbox" to VALID_PLUGIN_TYPES in config.ts (#103, #118)
- [x] Rename plugin packages from `@atlas/plugin-*` to `@useatlas/*` — service-level names, no type suffix (#104, #120)
- [x] Publish official plugins to npm under `@useatlas/*` scope (#105, PR #129)
- [x] Plugin testing utilities in SDK — `createMockContext()`, `createMockConnection()`, `createMockExploreBackend()` (#106, #119)
- [x] Support multi-type plugins — single plugin providing datasource + interaction + action (#117, PR #122)

### Distribution & Docs
- [x] Per-plugin docs pages on docs site — individual pages at `/plugins/clickhouse`, `/plugins/slack`, etc. (#107, PR #123)
- [x] Plugin listing page on docs site — filterable directory with badges (#108, PR #126)
- [x] Verify end-to-end plugin install flow: `bun add` + `atlas.config.ts` (#109, PR #134)

### SDK DX
- [x] Plugin scaffold: `bun create @useatlas/plugin my-plugin` (#110, PR #140)
- [x] Plugin cookbook in docs — caching, error handling, credentials, hooks recipes (#111, PR #127)

### Completeness
- [x] Add missing Salesforce plugin README (#112, #118)
- [x] Standardize plugin health check implementations (#113, PR #133)
- [x] Plugin composition docs — multiple plugins, ordering, priority (#114, PR #132)
- [x] Add `wireSandboxPlugins` to wiring.ts for consistency (#115, PR #138)
- [x] Plugin schema migrations for internal database (#116, PR #141)

---

## 0.3.0 — Admin Console & Operations ✅

**COMPLETE** (2026-03-10). All items shipped except semantic layer editor (deferred by design).

### Admin Console Phase 2
- [x] Action approval UI — bulk ops, context links, polish (#150, #165)
- [ ] Semantic layer editor — deferred (needs design for disk-vs-Postgres tension; read-only viewer exists)
- [x] Connection management — add/test/remove datasource connections (#142, #156)
- [x] Encrypt connection URLs at rest (#157, #161)
- [x] Deduplicate connection wire types across backend, SDK, frontend (#158, #166)
- [x] User management — invite flow (#146, #168; role assignment + ban/unban already shipped)
- [x] Plugin management — enable/disable, configure (#147, #174)
- [x] Settings page — env var overrides, feature flags (#148, #177); live runtime wiring (#178)

### Observability
- [x] Query analytics dashboard — top queries, slow queries, error rates (#145, #162)
- [x] Token usage tracking — per-user, per-conversation, over time (#149, #171)
- [x] OpenTelemetry traces — agent and DB span instrumentation (#153, #173)
- [x] Health dashboard — component-level checks (#144, #154)

### Scheduled Tasks v2
- [x] Scheduled task UI — create/edit form (#143, #155)
- [x] Task history with results and error details (#151, #167)
- [x] Delivery channel management (email, Slack, webhook) (#152, #170)

---

## 0.4.0 — Chat Experience ✅

**COMPLETE** (2026-03-11). All items shipped.

### Chat Polish
- [x] Theming — dark/light mode toggle with persistence, admin-configurable brand color (#181, PR #191)
- [x] Suggested follow-ups — agent suggests 2-3 next questions after each answer (#182, PR #189)
- [x] Data export — Excel download alongside existing CSV (#183, PR #188)
- [x] Mobile-responsive chat UI (#184, PR #195)
- [x] Saved queries — starred filter, save prompts, dedicated view (#185, PR #197)

### Discovery
- [x] Visual schema explorer — non-admin entity browser with relationships and sample data (#186, PR #203)
- [x] Chart improvements — area chart, stacked bar, scatter plot types (#187, PR #194)

---

## 0.5.0 — Launch

3-week sprint (March 11 – April 1). **Everything serves the Show HN launch in early April.** Items ordered by priority — P0 is the demo that gets stars, P1 expands who can use it, P2 is polish for launch day.

> **Strategic context:** See `.claude/research/design/competitive-landscape.md` for why this milestone is structured this way — the embeddable widget is Atlas's best distribution mechanic and the one thing no competitor can demo.

### Embeddable Widget (P0 — the demo)

The widget turns Atlas from "a tool you deploy" into "infrastructure you embed." Every app with an Atlas widget is a distribution channel. WrenAI can't copy this (AGPL). Vanna can't copy this (Python library). This is Atlas's lane.

- [x] `@useatlas/react` package (#218, PR #245) — extract `AtlasChat` + `AtlasUIProvider` into standalone React component package (`packages/react/`). Bundle with tsup, zero Next.js dependency. Props: `apiUrl`, `apiKey`, `theme`, `position`. Publish to npm
  - [x] Headless hooks mode (#225, PR #268) — export `useAtlasChat`, `useAtlasAuth`, `useAtlasTheme` without UI
  - [x] Custom tool renderers API (#226, PR #273) — `toolRenderers` prop for embedder-defined result rendering
- [x] Widget host route (#227, PR #248) — `/widget` route on Hono API serving lightweight HTML page with embedded chat UI. Self-contained CSS, no external dependencies. Dark/light theme support via query params
  - [x] Configurable branding (#237, PR #255) — logo, accent color, welcome message, pre-filled query via query params
- [x] Script tag loader (#236, PR #254) — `widget.js` (~2KB). Injects floating chat bubble, opens iframe to `/widget` on click. `postMessage` API for host↔widget communication: theme sync, auth token passthrough, open/close control, query result events. Configured via `data-*` attributes on the script tag
  - [x] Programmatic JS API (#239, PR #258) — `Atlas.open()`, `Atlas.close()`, `Atlas.ask(question)`
  - [x] Event callbacks and postMessage bridge (#240, PR #258) — `onOpen`, `onClose`, `onQueryComplete`, auth token passthrough
- [x] SDK streaming (#219, PR #244) — `streamQuery()` async iterator on `@useatlas/sdk`. Yields typed events: `{ type: 'text', content }`, `{ type: 'tool-call', name, args }`, `{ type: 'result', columns, rows }`. Enables real-time UX in widget and custom integrations
  - [x] Abort/cancel support (#228, PR #244) — `AbortController` integration for `streamQuery()`

### Distribution (P1 — expand reach)

Each of these removes a reason someone would skip Atlas.

- [x] BigQuery datasource plugin (#220, PR #250) — `@useatlas/bigquery`. `@google-cloud/bigquery` client, `node-sql-parser` BigQuery dialect, standard plugin structure following existing datasource plugins in `plugins/`. Most-requested missing source — unlocks GCP shops
  - [x] Cost-gated query approval (#229, PR #276) — dry-run to estimate cost, configurable approval modes: `auto` / `always` / `threshold` (default $1.00). Uses existing action approval system + beforeQuery hook
- [x] Conversation sharing (#221, PR #249) — shareable links with optional expiry and permission controls (anyone with link / org-only). New `shared_conversations` table in internal DB. Public `/shared/:id` route renders read-only conversation view. People share interesting query results — this turns launch users into distribution
  - [x] OG meta tags and social preview (#230, PR #264) — title, description, branded OG image for shared links
  - [x] Share expiry controls and org-scoped permissions (#231, PR #314) — configurable TTL (1h–never), org-only mode
  - [x] Embed-as-iframe mode (#232, PR #267) — `/shared/:token/embed` minimal read-only view for external embedding

### Launch Prep (P2 — polish for launch day)

Non-code work that directly impacts launch success.

- [x] Onboarding hardening (#222, PR #259) — `bun create atlas-agent --demo` must work flawlessly end-to-end in under 60 seconds. Add E2E test covering full scaffolding flow. Fix any friction points discovered during testing
  - [x] Post-scaffold `atlas doctor` auto-run (#233, PR #275) — validate setup + report total elapsed time
- [x] README overhaul (#223, PR #261) — demo GIF/video at top, "What is Atlas → Try it in 60s → Why it's different" structure, widget embed example, comparison links
  - [x] Animated terminal recording (#234, PR #315) — SVG recording of atlas init → query flow
- [x] Landing page refresh (#238, PR #261) — useatlas.dev update with widget demo section, competitive positioning, updated feature grid
  - [x] Animated widget showcase on landing page (#241, PR #274) — visitors see interactive widget demo on useatlas.dev
- [x] Launch content (#224, PR #263) — draft Show HN post, introductory blog post, comparison pages
  - [x] Comparison page on docs site (#235, PR #263) — feature matrix vs WrenAI, Vanna, Metabase
- [x] Docs for shipped 0.5.0 features (#269, PR #271) — widget embedding guide, @useatlas/react hooks reference, conversation sharing guide

### Quality & Refactoring

- [x] Extract `@useatlas/types` shared package (#299) — canonical wire format types used by API, web, SDK, and react
- [x] `ActionToolResultShape` discriminated union refactor (#300, #301, PR #307) — type-safe status narrowing
- [x] Error handling hardening (#302, #303, #304, #306, #308, #309, PR #311) — exhaustive `parseChatError` switch, SSE parser typed error events, missing error codes added
- [x] `isActionToolResult` type guard validation (#310, PR #312) — per-variant required field checks
- [x] CLI test segfault fix (#305, PR #316) — isolated test runner to avoid `mock.module()` collisions in bun 1.3.10
- [x] Server ActionToolResult status alignment (#313) — changed `"error"` → `"failed"` to match client `ActionToolResultShape`

---

## 0.5.1 — Agent-Friendly Docs

Apply the Frances Liu docs framework (Tutorial / How-to / Reference / Explanation) systematically. Docs quality is a competitive moat — agents default to products with best-in-class documentation (see Supabase/YC podcast insight).

### Tutorials (Getting Started)
- [x] Quick start overhaul — verification checkpoints, prerequisites blocks, troubleshooting, move corner cases (#277, PR #317)
- [x] Demo dataset comparison — explain complexity/row counts for simple vs cybersec vs ecommerce in CLI prompt (#278, PR #337)

### How-to Guides (New + Improved)
- [x] "Connect your own database" rewrite — split by DB type, each phase independently executable, end with "common failures / recovery" (#279, PR #319)
- [x] "Customize the widget" guide — CSS variables, theming beyond light/dark, postMessage API reference with inline-commented snippets (#280, PR #321)
- [x] "Multi-datasource routing" guide — how the agent picks which source, how to specify in API calls (#281, PR #330)
- [x] "Schema evolution" guide — what to do when DB schema changes (`atlas diff` → `atlas init --update` workflow) (#282, PR #323)
- [x] "Rate limiting & retry" guide — configuring limits, handling 429s, SDK retry patterns (#283, PR #335)

### Reference Pages
- [x] Add curl/fetch examples to API reference overview — not just "see interactive docs" (#284, PR #320)
- [x] Code snippet inline comments audit across all reference pages (#285, PR #331)
- [x] SDK reference: add pagination examples, error code handling, batch patterns (#286, PR #333)
- [x] React hooks: add conversation history loading, custom styling/CSS override examples (#287, PR #338)
- [x] Config & environment variables reference enhancements (#288, PR #322)

### Explanation Pages
- [x] "How SQL validation works" — the 7-layer pipeline explained for non-developers (#289, PR #318)
- [x] "Semantic layer concepts" — centralized glossary of Atlas-specific terms (entity, dimension, measure, query pattern) (#290, PR #328)
- [x] Comparison tables — "Widget vs SDK vs API" (when to use which), "Auth modes" (none vs apiKey vs managed vs BYOT) (#291, PR #329)
- [x] "Atlas vs raw MCP" explanation — why a semantic layer matters, with concrete examples (#292, PR #334)

### Agent Optimization
- [x] Agent optimization audit — llms.txt, stable headings, media-only references (#293, PR #339)

### Bug Fixes
- [x] `Atlas.ask()` silently drops queries due to postMessage type mismatch (#324, PR #326)
- [x] Config `auth` field not wired to auth detection pipeline (#325, PR #327)
- [x] SDK reference missing `validation_error` in error codes table (#332, PR #336)

---

## 0.5.2 — Onboarding & CLI Polish

Make the first 60 seconds perfect. Every error a new user could hit should have a clear, actionable message.

### Onboarding Flow
- [x] `atlas init` progress spinner — show table count, profiling progress, ETA for large databases (#343, PR #352)
- [x] `atlas init` failure threshold — exit with error (not warning) if >20% of tables fail to profile (#344, PR #360)
- [x] CLI `--help` flag — proper help text for all subcommands, not just code comments (#349, PR #364)
- [x] First-run detection — if no `.env` file exists, prompt to copy `.env.example` (#340, PR #351)

### Error Handling
- [x] Replace "Something went wrong" with pattern-matched errors — ECONNREFUSED → "Database unreachable at host:port", 502 → "Provider API unavailable", timeout → "Query exceeded N-second timeout" (#341, PR #353)
- [x] Wrap agent stream errors in `internal_error` with request ID — prevent stack trace leakage (#342, PR #353)
- [x] DuckDB profiler error tracking and fatal error detection (#354, PR #356)
- [x] Surface action registry build failure to users (#355, PR #357)
- [x] Postgres profiler missing fatal error detection (#358, PR #363)
- [x] Column-level catch blocks in profilers don't detect fatal errors (#359, PR #363)
- [x] Plugin tools merge failure silently degrades chat (#361, PR #362)
- [x] Database connection errors: suggest valid schema names when schema not found (#345, PR #372)
- [x] Pool exhaustion: map "too many connections" to `rate_limited` error code with guidance (#346, PR #369)
- [x] Transient vs permanent error hints — indicate whether retrying makes sense (#347, PR #366)

### Developer Experience
- [x] Enhanced `atlas validate` — check config + semantic layer + connectivity in one command (#348, PR #369)
- [x] Better error messages for invalid `atlas.config.ts` — show the specific field and expected type (#350, PR #365)
- [x] Add `completions` subcommand to CLI reference docs (#367, PR #368)
- [x] Completions registry missing flags for init and benchmark (#371)

### Incidental Bugs
- [x] `atlas doctor` alias has different exit semantics than old `runDoctor` (#373, PR #374)
- [x] CI does not catch missing workspace members in Dockerfiles (#370, PR #370)
- [x] React reference stale "Something went wrong" error fallback (#375, direct push)
- [x] Environment variables reference mentions dropped Render platform (#376, direct push)

---

## 0.5.3 — UI & Accessibility Polish

No feature adds — just making everything feel right. Accessibility is table stakes for adoption.

### Accessibility
- [x] Chat input, message bubbles, skip link, starter prompts, submit button ARIA attributes (#377, PR #391)
- [ ] Lighthouse/axe audit — run automated a11y checks, fix all critical/serious findings (#378)
- [ ] Keyboard navigation: ensure all interactive elements reachable via Tab, activated via Enter/Space (#379)

### UI Polish
- [x] Error boundaries — graceful fallback UI for component crashes instead of blank screens (#380, PR #393)
- [ ] Loading states audit — ensure every async operation has a visible loading indicator (#381)
- [x] Empty states — meaningful messages when no conversations, no saved queries, no results (#382, PR #392)

### Incidental Findings
- [ ] Fix hardcoded ARIA IDs in @useatlas/react — collision risk with multiple instances (#394)
- [ ] Add DataTable tests to @useatlas/react package (#395)
- [ ] Mobile polish pass — test all flows on small screens, fix any overflow/truncation issues (#383)
- [ ] Chart responsiveness — ensure all chart types render correctly at all container sizes (#384)
- [ ] Admin console consistency — unified table styles, consistent action button placement (#385)

### Widget Polish
- [ ] Export TypeScript types for `globalThis.AtlasWidget` — enable IDE autocomplete for embedders (#386)
- [ ] Widget README expansion — error handling examples, auth fallback, what happens when API unreachable (#387)
- [ ] Custom renderer docs — document all available fields on each tool result type (#388)
- [ ] CSS customization guide — document CSS variables for widget styling (#389)
- [ ] Widget error states — graceful degradation when API is down or auth fails (#390)

---

## 0.5.4 — SDK & Integration Polish

Make every integration surface production-ready.

### SDK
- [ ] Add `listTables()` convenience method — discover schema without explore
- [ ] `streamQuery()` timeout/resume documentation — what happens on disconnect
- [ ] `retryAfterSeconds` null-safety — document when property is populated, fix README example
- [ ] Error code catalog — document every error code with cause, fix, and retry guidance

### Plugins
- [x] Obsidian plugin — natural-language database queries from Obsidian (#396)

### Integration Testing
- [ ] End-to-end widget embed test — script tag → load → auth → query → result in browser test
- [ ] SDK streaming test — connect → stream → abort → reconnect
- [ ] MCP server smoke test — Atlas MCP → query → result

### Documentation Cross-Cuts
- [ ] Every guide ends with troubleshooting section
- [ ] Every how-to page: prerequisites, constraints, permissions listed at top (self-contained)
- [ ] Every reference page: code examples > prose (prioritize snippets over descriptions)
- [ ] Cross-link audit — ensure related pages reference each other (RLS ↔ auth, rate limiting ↔ SDK errors)

---

## 0.6.0 — Governance & Integrations

Post-launch. Governance primitives for teams + remaining integration plugins. Only build what users ask for.

### Access Control
- [ ] RLS improvements — multi-column policies, array claim support, OR-logic between policies
- [ ] Session management — list/revoke sessions, timeout policies
- [ ] OIDC/OAuth provider integration docs and configuration guide

### Audit & Compliance
- [ ] Audit log improvements — CSV export, full-text search, connection/table filtering
- [ ] Data classification tags on query audit trails — capture table/column metadata from validated AST

### Collaboration
- [ ] Semantic layer diff in UI — compare DB schema against YAML files from admin console

### Integrations
- [ ] Microsoft Teams interaction plugin — following the Slack plugin pattern, bot framework integration
- [ ] Webhook interaction plugin — generic inbound webhook for Zapier, Make, n8n integration
- [ ] Email digest plugin — user-subscribed daily/weekly metric summaries beyond scheduled task delivery

### Data Protection
- [ ] PII detection and column masking — context plugin for profiling tags + `afterQuery` hook for role-based masking

---

## 0.7.0 — Performance & Scale

Handle larger semantic layers, more concurrent users, and bigger result sets. Semantic layer indexing is a prerequisite for the dynamic learning layer in 0.8.0.

### Caching & Indexing
- [ ] Query result caching — hash-based with configurable TTL, in-memory LRU default, Redis via plugin
- [ ] Semantic layer indexing — pre-computed index to skip explore calls for common patterns. Inject relevant subset into system prompt based on question similarity. Required before dynamic learning layer can add more context

### Infrastructure
- [ ] Connection pooling improvements — warmup, drain on health degradation, per-connection pool sizing from admin UI
- [ ] Streaming Python execution output — progressive stdout chunks and chart renders
- [ ] Tenant-scoped semantic layers — per-tenant entity routing or database-backed storage (needs design doc)

### Learning (Phase 1)
- [ ] `atlas learn` CLI — offline batch process that reviews audit log, proposes YAML amendments (new `query_patterns`, join discoveries, glossary refinements). Human reviews the diff, commits what's useful. Zero runtime overhead, no DB dependency. Gives Atlas the "gets smarter over time" story. See competitive landscape doc section 5 for RAG vs semantic learning analysis

---

## 0.8.0 — Intelligence & Learning

Move beyond stateless Q&A toward an agent that gets smarter over time.

### Learning (Phase 2 — Dynamic Layer)
- [ ] Dynamic learning layer — `learned_patterns` table in internal DB. Agent proposes amendments after successful queries. Low-confidence patterns sit idle; high-confidence ones (repeated N times, admin-approved) injected into context via context plugin. Admin console review/approve/delete UI. Static YAML layer stays authoritative — dynamic layer is "agent notes" that augment but don't override. Requires semantic layer indexing (0.7) to manage context window pressure

### Knowledge
- [ ] Prompt library — curated per-industry collections (SaaS metrics, e-commerce KPIs, cybersecurity compliance)
- [ ] Query suggestion engine — learn from past successful queries, "people who looked at this table also asked..."

### Advanced
- [ ] Self-hosted model improvements — vLLM, TGI, Ollama test matrix, performance benchmarks, recommended configs
- [ ] Notebook-style interface — cell-based UI with re-run, fork, reorder for exploratory analysis
- [ ] Multi-agent collaboration — specialist agents per domain with coordinator routing

### Enterprise Auth
- [ ] SAML provider support in managed auth
- [ ] SCIM provisioning for user sync

---

## Ideas / Backlog

_Untracked ideas. Create issues when committing to work._

- Multi-seed selection in `create-atlas` (choose demo type: cybersec, ecommerce, devops)
- Voice input / natural language voice queries
- GraphQL datasource plugin
- MongoDB datasource plugin
- `atlas migrate` — semantic layer versioning and migration tracking
- A/B testing for agent prompts
- Guided semantic layer setup wizard (web-based replacement for `atlas init`)
- Python SDK — `pip install useatlas`, thin HTTP wrapper around Atlas API. Build when a Python user asks for it, not before
- "Powered by Atlas" badge on embedded widgets (opt-out) — viral distribution mechanic
- OSI (Open Semantic Interchange) compatibility — align YAML format with emerging standard (dbt + Cube + Snowflake + ThoughtSpot)
- Benchmark participation — publish Spider/BIRD results for credibility
