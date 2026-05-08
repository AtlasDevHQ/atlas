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
- [x] **1.4.0 — MCP & Agent-First DX** (#40, 21 issues) — closed the agent-first install/discovery surface end-to-end. `bunx @useatlas/mcp init` (zero-config local + `--hosted` OAuth 2.1 loopback) #2018, hosted MCP endpoint per-region (us/eu/apac) with DCR + PKCE + RFC 9728 protected-resource metadata + `421 Misdirected Request` residency enforcement #2024 (PRs #2054/#2056/#2057/#2059/#2062), admin Settings → OAuth Clients revocation surface, typed semantic-layer MCP tools (`listEntities`/`describeEntity`/`searchGlossary`/`runMetric`) #2020 with structured `AtlasMcpToolError` envelope #2030, OTel coverage for MCP tool calls #2029, eval harness with 20 canonical questions #2025, NovaMart canonical seed (three seeds collapsed to one) #2021, README/docs/landing leading with the moat sentence + YAML-first story #2026, `@useatlas/mcp` published to npm #2042, listed on `registry.modelcontextprotocol.io` as `io.github.AtlasDevHQ/atlas` (auto-published via OIDC on every `mcp-v*` tag) #2027, path-A standalone-serve decision (hosted-only) #2052, scaffolder rename to `bun create atlas-agent`/`bun create atlas-plugin`. Backlog deferred: `/agent-mode` view (#2022), `runbooks-context` plugin (#2023). Architecture debt tracked separately: `/ee` decoupling (#2017).

---

## Active: 1.4.1 — MCP: Bringing It All Together

Tracker: [milestone #41](https://github.com/AtlasDevHQ/atlas/milestones/41). Round out 1.4.0 properly across five themes — workspace-native UX, brand + production hygiene, governance, eval + tool quality, distribution + extensibility. Each item is a real follow-up that should ideally have been in 1.4.0 but is honest scope for an immediate next pass. No skimping.

### Theme A — Workspace-native UX

- [x] Settings → AI Agents — per-user MCP connect + manage flow ([#2065](https://github.com/AtlasDevHQ/atlas/issues/2065), [#2100](https://github.com/AtlasDevHQ/atlas/pull/2100)) — `/settings/ai-agents` page + 3-step connect wizard + per-user OAuth-client endpoints. Closes the install-path gap for non-CLI users.
- [x] Hosted-MCP token refresh + expiry UX, end-to-end tested ([#2066](https://github.com/AtlasDevHQ/atlas/issues/2066), [#2106](https://github.com/AtlasDevHQ/atlas/pull/2106)) — Playwright + bun-test refresh path coverage, `tokenState` on `/me/oauth-clients`, `oauth_token.refresh` audit + OTel counter, state-aware Settings → AI Agents rendering.
- [x] Admin audit-log filter view for MCP tool calls ([#2067](https://github.com/AtlasDevHQ/atlas/issues/2067), [#2101](https://github.com/AtlasDevHQ/atlas/pull/2101)) — `actorKind=mcp` / `clientId` / `tool` query filters with nuqs URL-state UI; new `0049_audit_log_mcp_columns` migration.

### Theme B — Brand + production hygiene

- [x] `mcp.useatlas.dev` first-class hostname ([#2068](https://github.com/AtlasDevHQ/atlas/issues/2068)) — `resolveOAuthValidAudiences` + protected-resource metadata + hosted MCP verifier all advertise/accept the brand-mirror `mcp*.useatlas.dev/mcp` audience alongside the regional `api.*.useatlas.dev/mcp` fallback (backward compat); CLI default flips to `https://mcp.useatlas.dev`; cross-region 421 body returns the brand URL; Settings → AI Agents wizard surface uses the brand hostname; docs sweep complete. DNS provisioning (Railway custom domains) happens at flip time outside the branch.
- [x] Verify sticky routing for `/mcp/*` ([#2069](https://github.com/AtlasDevHQ/atlas/issues/2069), [#2107](https://github.com/AtlasDevHQ/atlas/pull/2107)) — Railway confirmed random LB (Context7-verified, no sticky available). Phase 0 boot guard + OpenStatus monitor + doc correction; spawned MCP session-store ADR + Phase 1 issue [#2109](https://github.com/AtlasDevHQ/atlas/issues/2109) (deferred until trigger).
- [x] Load-test hosted MCP, document perf profile ([#2070](https://github.com/AtlasDevHQ/atlas/issues/2070), [#2145](https://github.com/AtlasDevHQ/atlas/pull/2145)) — k6 profile against `mcp.useatlas.dev` 2026-05-07; `apps/docs/content/docs/architecture/mcp-performance.mdx` populated with measured numbers (cold-start, concurrent-session ladder, realistic-mix aggregate, bottleneck order, deploy-shape recipes). The 100-session cap behaves as designed (99.7 % `503 too_many_sessions` at the 200-session stage); SaaS prod runs at 300 post the [#2139](https://github.com/AtlasDevHQ/atlas/pull/2139) idle-TTL sweep. Surfaced two latent bugs that shipped same day: [#2141](https://github.com/AtlasDevHQ/atlas/pull/2141) (MCP edge whitelist preload) + [#2147](https://github.com/AtlasDevHQ/atlas/pull/2147) (demo / wizard `unknown_entity` regression).

### Theme C — Governance

- [x] Per-OAuth-client rate limiting for MCP ([#2071](https://github.com/AtlasDevHQ/atlas/issues/2071), [#2180](https://github.com/AtlasDevHQ/atlas/pull/2180)) — sliding-window limiter scoped by `(workspaceId, clientId)` with per-tool weighting (executeSQL/explore = 5×); admin overrides live in a standalone `oauth_client_rate_limits` table to avoid Better-Auth-owned `oauthClient` schema collision. 429 envelope + `mcp.rate_limited` audit + Playwright e2e.
- [x] MCP-specific approval rules ([#2072](https://github.com/AtlasDevHQ/atlas/issues/2072), [#2191](https://github.com/AtlasDevHQ/atlas/pull/2191)) — surface-scoped approval rules with the seven-value `surface` enum (`any` / `chat` / `mcp` / `scheduler` / `slack` / `teams` / `webhook`); `any` (default) preserves pre-2072 fires-everywhere semantics while pinned values fire only for matching origins. Migration `0052_approval_rules_surface` adds the column + CHECK + `(org_id, surface)` index plus an audit-side surface column on `approval_queue`. Routes (chat/query/demo/slack/scheduler/MCP-tools/MCP-hosted) stamp the surface on `RequestContext`; `checkApprovalRequired` filters in SQL with `surface = 'any' OR surface = $req`. Admin UI gains a surface dropdown + list column; admin-action audit metadata records the surface on rule create/update + approve/deny. Scope isolation: an unstamped route only matches `'any'` rules — the governance gate is still active (any-rules fire), but surface-scoped rules don't accidentally trip on a transport that forgot to stamp.
- [ ] Cross-workspace agent identity ([#2073](https://github.com/AtlasDevHQ/atlas/issues/2073)) — one OAuth flow + one client config serves multi-workspace users; `X-Atlas-Workspace` header for per-request scoping.

### Theme D — Eval + tool quality

- [x] Eval harness runs through the MCP path — Phase 1 + 2 ([#2074](https://github.com/AtlasDevHQ/atlas/issues/2074), [#2119](https://github.com/AtlasDevHQ/atlas/issues/2119), PRs [#2120](https://github.com/AtlasDevHQ/atlas/pull/2120)/[#2125](https://github.com/AtlasDevHQ/atlas/pull/2125)/[#2126](https://github.com/AtlasDevHQ/atlas/pull/2126)) — `canonical-mcp-eval (deterministic)` + `eval-mcp-llm` CI jobs together cover protocol + JWT + LLM tool-selection. Phase 2 part A (#2125) replaced the `verifyAccessToken` mock with a real OAuth 2.1 loopback against in-process Better Auth + JWKS; part B (#2126) added `--mcp-llm` mode that hands an LLM the discovered MCP tool surface and grades the per-question dispatch sequence with `tool_selection`/`recovery`/`latency`/`protocol` artifact categories (≥18/20 acceptance floor, baseline at `eval/canonical-questions/mcp-llm-baseline.json`). Concurrent-session stress test bumped from N=5 → N=10 in the part-B closeout (partial #2070). #2078 turned out NOT to be a hard prereq — Part A's `EvalMcpClient` proves the LLM-on-client approach without registry-coupling.
- [x] MCP tool description audit ([#2075](https://github.com/AtlasDevHQ/atlas/issues/2075)) — consistency, length, hallucination-bait. All 6 tool descriptions rewritten to a fixed rubric (80–150 words, `Use this when …`, `Don't use this …`/`Avoid …`, inline JSON example, structured `Error contract:` appendage). [`description-rubric.test.ts`](https://github.com/AtlasDevHQ/atlas/blob/main/packages/api/src/lib/tools/__tests__/description-rubric.test.ts) fails CI on future drift. Held-out LLM tool-selection fixture at [`eval/canonical-questions/tool-selection.json`](https://github.com/AtlasDevHQ/atlas/blob/main/eval/canonical-questions/tool-selection.json) wired into `--mcp-llm --tool-selection` with a 0.9 accuracy floor; contributor doc at [`apps/docs/content/docs/architecture/mcp-tools.mdx`](https://github.com/AtlasDevHQ/atlas/blob/main/apps/docs/content/docs/architecture/mcp-tools.mdx).
- [x] MCP prompts library exposes canonical eval questions ([#2076](https://github.com/AtlasDevHQ/atlas/issues/2076), [#2182](https://github.com/AtlasDevHQ/atlas/pull/2182)) — 20 NovaMart questions surface as `canonical-{slug}` `prompts/list` entries, gated by tri-state `ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS` (`auto`/`always`/`never`) with demo-workspace fail-closed fallback. Settings → AI Agents preview block shipped via [#2179](https://github.com/AtlasDevHQ/atlas/issues/2179) — source-grouped preview with closed-gate banner linking to Admin → Settings → MCP, sharing the listing pipeline with `prompts/list` so visible-prompt sets stay in lockstep.

### Theme E — Distribution + extensibility

- [x] Claude Desktop catalog submission — in-repo deliverables ([#2077](https://github.com/AtlasDevHQ/atlas/issues/2077)) — catalog-shaped tool annotations doc at [`apps/docs/content/docs/architecture/mcp-tool-annotations.mdx`](https://github.com/AtlasDevHQ/atlas/blob/main/apps/docs/content/docs/architecture/mcp-tool-annotations.mdx) (six 1-sentence rows separate from the LLM-facing rubric, server short/long description copy, submission checklist), privacy policy now names MCP explicitly with a dedicated section that pins external-agent data flow as identical to Atlas-UI queries (same auth/audit/retention; agent-vendor sees its own prompts only), and a branding pack at [`apps/www/public/brand/`](https://github.com/AtlasDevHQ/atlas/tree/main/apps/www/public/brand) — `mark.svg` (1024 viewBox source of truth), `mark-1024.png` (RGBA transparent), and a [`README.md`](https://github.com/AtlasDevHQ/atlas/blob/main/apps/www/public/brand/README.md) cataloging every asset, dimensions, intended use, brand color tokens, and a re-render command. Off-repo submission (review tenant + 60-90s demo video + Anthropic form at clau.de/mcp-directory-submission + Notion alignment-tracker entry) is now unblocked but operator-side — *not* claiming "submitted to catalog" until the form actually goes in.
- [x] Plugin SDK extension point for MCP tools ([#2078](https://github.com/AtlasDevHQ/atlas/issues/2078), [#2190](https://github.com/AtlasDevHQ/atlas/pull/2190)) — `AtlasPlugin.mcpTools()` ships as a first-class agent-surface contract alongside `contextProvider`. The host registers each contributed tool as `<plugin-id>.<name>` so plugin tools cannot shadow `executeSQL` / `explore` / the typed semantic tools. Dispatch is transport-agnostic in `@atlas/api/lib/plugins/mcp-tools.ts` (input zod-validation, `withRequestContext` actor binding for audit + RLS, per-OAuth-client rate limiter, `internal_error` envelope on handler throws); the MCP-side `packages/mcp/src/plugin-tools.ts` is a 70-line shim that injects `traceMcpToolCall` for OTel coverage and forwards the real `McpServer`. `description-rubric.test.ts` was extended to walk every plugin tool registered in `pluginMcpToolRegistry` and apply the same 80–150 word / `Use this when …` / `Don't use this …` / inline-JSON-example checks as native tools — drift fails CI regardless of authoring location. Reference implementation in `plugins/yaml-context/src/index.ts` (`context-yaml.getYamlContextStats`); contract + complete example at [`/plugins/sdk/mcp-tools`](https://docs.useatlas.dev/plugins/sdk/mcp-tools). Foundation for `runbooks-context` (1.4.2 headline).
- [x] `@useatlas/sdk` programmatic MCP onboarding helper ([#2079](https://github.com/AtlasDevHQ/atlas/issues/2079)) — `atlas.mcp.beginConnect` / `completeConnect` / `buildConfig` / `listAgents` / `revokeAgent` ship in `@useatlas/sdk` (also as a separate `@useatlas/sdk/mcp` subpath for tree-shaking); `connectMachineToMachine` ships as a documented throw pending the `client_credentials` grant tracked in #2024. `useMcpConnect` in `@useatlas/react/hooks` wraps the popup-or-redirect lifecycle and surfaces a discriminated `{ connect, status, error, accessToken, workspaceId }` return so success/error are type-narrowed without runtime guards. Worked Next.js example at `examples/embedded-mcp-onboarding/` covers Connect button + same-origin postMessage callback page. C3 multi-workspace shape is gap-tracked as a follow-up — single-workspace is the baseline today.

### Theme F — Spawn follow-ups (added 2026-05-08 to extend 1.4.1 closeout)

Nine items surfaced during 1.4.1 work that didn't have a home. Closing them inside 1.4.1 keeps the milestone coherent — every loose thread the work generated lands here before the milestone collapses.

- [ ] Durable Postgres-backed MCP session store via Better Auth `secondaryStorage` ([#2109](https://github.com/AtlasDevHQ/atlas/issues/2109)) — spawned by B2 sticky-routing ADR; lifts the in-memory session map so any region can resume any session. Architecture-tagged.
- [ ] Wire MCP load tests into Playwright + CI infra ([#2129](https://github.com/AtlasDevHQ/atlas/issues/2129)) — B3 shipped a manual runbook; this issue cadenced it. `scripts/print-bearer.ts` + scheduled CI job + result capture.
- [ ] Consolidate the two parallel `listEntities` exports ([#2150](https://github.com/AtlasDevHQ/atlas/issues/2150)) — `lib/semantic/lookups.ts:listEntities` (disk YAML, MCP path) vs `lib/semantic/entities.ts:listEntities` (per-org DB, whitelist path) read different sources; collapse to one. Architecture-tagged.
- [ ] Per-client rate-limit hardening — deferred items from C1 review ([#2183](https://github.com/AtlasDevHQ/atlas/issues/2183)) — burst-credit policy, per-tool weight overrides, and a few audit-shape gaps caught in #2180 review.
- [ ] Consolidate the three-place MCP prompts wire schema ([#2192](https://github.com/AtlasDevHQ/atlas/issues/2192)) — D3 review surfaced redundant shape definitions across registry / API / web; unify behind `@useatlas/types/mcp`.
- [ ] `PromptListEntry` per-source discriminated union ([#2193](https://github.com/AtlasDevHQ/atlas/issues/2193)) — replace stringly-typed `sourceMode` with a tagged union so impossible (source, evalMode) pairs are unrepresentable.
- [ ] Consolidate `/guides/mcp` + `/guides/mcp-hosted` ([#2113](https://github.com/AtlasDevHQ/atlas/issues/2113)) — per-client subsections, "after you connect" capstone, security paragraph; the docs split predates the 1.4.0 hosted-MCP work.
- [ ] Rethink `explore` tool surface — file-ops vs semantic operations ([#2123](https://github.com/AtlasDevHQ/atlas/issues/2123)) — `explore` predates the typed tools; revisit whether it should be split (`explore.shell` vs `explore.semantic`) or scoped down. Architecture-tagged.
- [ ] Extract shared OAuth 2.1 + DCR helper from `packages/sdk` and `packages/mcp` ([#2203](https://github.com/AtlasDevHQ/atlas/issues/2203)) — E3 (#2198) duplicates `packages/mcp/src/init/hosted.ts`'s loopback flow; collapse to a single `packages/oauth-helper/` so HTTPS-only validation + future spec quirks land once. Architecture-tagged.

Backlog (post-1.4.1): `runbooks-context` plugin (#2023, 1.4.2 headline candidate), `/agent-mode` chat-first view (#2022), `/ee` decoupling refactor (#2017), agent-auth provider (#2058).

Ordering recommendation: B → D → C → E → F (closeout sweep). Theme A complete (3/3); **Theme B + Theme D fully closed**; **Theme C now 2/3** (C1 #2180, C2 #2191); **Theme E now 3/3** (E1 in-repo deliverables shipped — submission unblocked; E2 #2190; E3 #2198); Theme F 0/9. Open: C3 #2073 (in flight via PR #2202), plus the 9 Theme-F follow-ups — ten left to close 1.4.1. Next risk-class item is **C3 (cross-workspace agent identity, [#2073](https://github.com/AtlasDevHQ/atlas/issues/2073))** — finishing the governance trio. E1's in-repo deliverables shipped (#2195); the catalog-form submission is operator-side via Notion / YC alignment. Theme F follows.

---

## Parallel: 1.4.2 — End-user shakeout

Tracker: [milestone #42](https://github.com/AtlasDevHQ/atlas/milestones/42). Bug-hunting and polish from dogfooding Atlas as an end-user/tester after 1.4.1 ships. Mostly admin console rough edges (#2167–#2172, #2175–#2177), BYOT gaps (#2173, #2174), and platform-admin/operational findings (#2165, #2166, #2168). Scope is intentionally elastic — issues land here as bug-bash passes file them. Promote items to a dedicated milestone if scope grows (e.g. BYOT may outgrow #2173/#2174).

## Closed parallel tracks

- [x] **Multi-method MFA hardening** (6 issues #2082/#2090/#2091/#2092/#2093/#2094) — WebAuthn passkeys + TOTP + trusted-device 30d shipped end-to-end across enrollment, sign-in, governance, telemetry, and recovery. Full detail in `ROADMAP-archive.md`.

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
