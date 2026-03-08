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

## 0.1.0 — Documentation & Developer Experience

The #1 barrier to adoption is discoverability. You can't grow what you can't find.

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

## 0.2.0 — Plugin Ecosystem

Atlas plugins follow Better Auth's pattern: factory functions with `satisfies AtlasPlugin`, Zod config schemas, `$InferServerPlugin` for client type inference, `plugins: [myPlugin({ ... })]` registration. The SDK (`createPlugin`, `definePlugin`) is stable. What's missing is distribution and docs.

### Foundation
- [x] fix: add "sandbox" to VALID_PLUGIN_TYPES in config.ts (#103, #118)
- [x] Rename plugin packages from `@atlas/plugin-*` to `@useatlas/*` — service-level names, no type suffix (#104, #120)
- [ ] Publish official plugins to npm under `@useatlas/*` scope (#105)
- [x] Plugin testing utilities in SDK — `createMockContext()`, `createMockConnection()`, `createMockExploreBackend()` (#106, #119)
- [ ] Support multi-type plugins — single plugin providing datasource + interaction + action (#117)

### Distribution & Docs
- [ ] Per-plugin docs pages on docs site — individual pages at `/plugins/clickhouse`, `/plugins/slack`, etc. (#107)
- [ ] Plugin listing page on docs site — filterable directory with badges (#108)
- [ ] Verify end-to-end plugin install flow: `bun add` + `atlas.config.ts` (#109)

### SDK DX
- [ ] Plugin scaffold: `bun create @useatlas/plugin my-plugin` (#110)
- [ ] Plugin cookbook in docs — caching, error handling, credentials, hooks recipes (#111)

### Completeness
- [x] Add missing Salesforce plugin README (#112, #118)
- [ ] Standardize plugin health check implementations (#113)
- [ ] Plugin composition docs — multiple plugins, ordering, priority (#114)
- [ ] Add `wireSandboxPlugins` to wiring.ts for consistency (#115)
- [ ] Plugin schema migrations for internal database (#116)

---

## 0.3.0 — Admin Console & Operations

Admin console phase 1 (read-only) shipped. Phase 2 enables self-service management.

### Admin Console Phase 2
- [ ] Action approval UI — approve/deny agent-triggered actions from console (currently API-only)
- [ ] Semantic layer editor — view/edit entity YAMLs from the UI
- [ ] Connection management — add/test/remove datasource connections
- [ ] User management — invite, role assignment, deactivation
- [ ] Plugin management — enable/disable, configure
- [ ] Settings page — env var overrides, feature flags

### Observability
- [ ] Query analytics dashboard — top queries, slow queries, error rates
- [ ] Token usage tracking — per-user, per-conversation, over time
- [ ] OpenTelemetry traces — end-to-end request tracing (agent steps, DB queries)
- [ ] Health dashboard — connection status, provider status, scheduler health

### Scheduled Tasks v2
- [ ] Scheduled task UI — create/edit/monitor from admin console
- [ ] Task history with results and error details
- [ ] Delivery channel management (email, Slack, webhook)

---

## 0.4.0 — UI & Collaboration

### Chat Experience
- [ ] Theming — dark/light mode toggle, custom brand colors, CSS variable API
- [ ] Embeddable widget — `<script>` tag or React component for embedding in other apps
- [ ] Conversation sharing — shareable links with optional auth
- [ ] Suggested follow-ups — agent suggests next questions based on results
- [ ] Saved queries / bookmarks

### Semantic Layer UX
- [ ] Visual schema explorer — browse entities, relationships, sample data
- [ ] Semantic layer diff in UI — show what changed since last `atlas init`
- [ ] Guided semantic layer setup — wizard for first-time users

---

## 0.5.0 — Enterprise

### Multi-tenancy
- [ ] Row-level security (RLS) improvements — multi-column, complex policies
- [ ] Tenant-scoped semantic layers — different entity sets per tenant
- [ ] Audit log UI — searchable, filterable, exportable

### SSO & Advanced Auth
- [ ] SAML provider support in managed auth
- [ ] SCIM provisioning for user sync
- [ ] Session management — revoke, timeout policies

### Compliance
- [ ] Query audit trail with data classification tags
- [ ] PII detection / column masking in responses
- [ ] SOC 2 readiness checklist in docs

---

## Ideas / Backlog

_Untracked ideas. Create issues when committing to work._

- Multi-seed selection in `create-atlas` (choose demo type: cybersec, ecommerce, devops)
- Streaming Python execution output (live chart rendering)
- Voice input / natural language voice queries
- Mobile-responsive chat UI
- Notebook-style interface (cells, re-run, fork)
- GraphQL datasource plugin
- MongoDB datasource plugin
- BigQuery datasource plugin
- Slack app directory listing
- VS Code extension (beyond MCP)
- `atlas migrate` — semantic layer versioning and migration tracking
- Prompt library — curated prompts per industry/use case
- A/B testing for agent prompts
- Multi-agent collaboration (specialist agents per domain)
- Self-hosted model support improvements (vLLM, TGI)
