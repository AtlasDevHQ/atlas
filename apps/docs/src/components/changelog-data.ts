export interface Release {
  version: string;
  title: string;
  date?: string;
  summary: string;
  highlights?: string[];
  githubMilestone?: number;
}

/**
 * Changelog release data — single source of truth for the changelog page.
 * Ordered reverse chronologically, newest first.
 */
export const releases: Release[] = [
  {
    version: "1.5.0",
    title: "Proactive Chat",
    date: "2026-05-17",
    summary:
      "Atlas now answers questions in your chat platform without being summoned. A new `/ee`-gated paid tier turns Atlas into a passive listener on Slack channels admins opt in to: it watches for data-shaped messages, reacts with a single emoji when it thinks it can help, and only generates an answer when the asker taps the reaction. No mention, no slash command, no thread interruption — until the user opts in. A three-layer kill switch (per-channel pause via `@atlas pause`, admin workspace toggle, per-user DM `unsubscribe`) plus a monthly quota cap give workspaces the controls they need to ship this in production. Slack-first; the same pipeline is ready for Teams/Discord/etc. once the early adopters hit the <5% misfire / ≥70% acceptance bar. Numbers: 10 issues across detection, controls, audit + meter, sensitivity, public-dataset HITL, feedback, and a one-time install consent flow.",
    highlights: [
      "Reaction-first tracer — Atlas listens in opt-in Slack channels, classifies messages as data questions with a sensitivity-tunable confidence threshold, and reacts with a single emoji; the asker taps the reaction to pull an answer (no DM spam, no thread takeover until consent)",
      "Three-layer kill switch — channel members can `@atlas pause` for 24h, workspace admins can disable proactive mode globally, individual users can DM `unsubscribe` to opt out across the workspace; all three short-circuit before classification",
      "Admin opt-in surface — Settings → Slack → Proactive Mode lets admins enable per workspace, choose a sensitivity preset (low / medium / high), and pick channels from a checkbox list; nothing leaks until admin flips it on",
      "Meter + audit instrumentation — every reaction, expansion, and answer lands in `query_audit` with a `proactive` actor kind; new metering surface tracks monthly quota usage per workspace with a hard cap to prevent runaway costs",
      "Public-dataset HITL — when a non-linked Slack user asks a question against a workspace's public datasets, Atlas surfaces an answer for admin review before posting; design partners can ramp public-Q&A confidence before flipping the switch",
      "Inline feedback buttons + `/atlas feedback` — every proactive answer ships with 👍 / 👎 buttons plus a slash command for free-form text; feedback rows feed the future sensitivity-tuning loop",
      "Sensitivity preset rationale — each preset (low / medium / high) ships with a documented confidence threshold, expected misfire rate, and a workspace-visible reasoning trail so admins can pick the bias that fits their culture",
      "Activation announcement + install consent — when proactive mode is first enabled, Atlas posts a one-time disclosure to the admin-configured announcement channel and gates the install flow on the admin acknowledging the data-handling policy; idempotent on re-enable",
      "Monthly quota cap — workspace-level monthly question cap (default tuned per tier) hard-stops proactive answers when exceeded, with admin alerts at 80% / 95% / 100%; quota resets on the billing anchor",
      "`/ee`-gated, Slack-first — feature lives in `ee/` under the commercial license; self-hosted workspaces ship without it. Teams, Discord, and Google Chat adapters are wired but feature-flagged off until the misfire / acceptance bar holds in production",
    ],
    githubMilestone: 43,
  },
  {
    version: "1.4.6",
    title: "Chat as dashboard editor",
    date: "2026-05-17",
    summary:
      "Dashboards now have a chat-bound editor. Open the chat drawer on a dashboard and Atlas knows which cards you can see — `executeSQL`, `createCard`, `updateCardSql`, and `removeCard` route through the bound dashboard automatically. Every admin mutation flows into your **personal draft** of the dashboard rather than the published copy your teammates see, so you can iterate on a card definition without spooking the org. Publish promotes the draft via an atomic three-way merge against a persisted baseline — overlapping teammate changes surface as a one-click rebase banner, non-overlapping changes merge cleanly. A new `screenshotDashboard` vision tool lets the agent literally see what the user sees so it can answer 'why is this card flat?' from pixels. Numbers: PRD + 8 implementation slices, all landed in one day with three migrations carrying matching `pgTable` mirrors.",
    highlights: [
      "Chat-bound dashboard editor — open the chat drawer on any dashboard page; the agent picks up a `boundDashboardId` context so `executeSQL` / `createCard` / `updateCardSql` / `removeCard` target the dashboard automatically; conversations persist `bound_dashboard_id` for hand-offs from the root chat",
      "Per-user drafts foundation — every admin mutation writes to the caller's draft in `dashboard_user_drafts`, never directly to the published copy; `dashboard-versioning` deep module owns transactional `publishDraft` with a persisted `baseline jsonb` for exact three-way merge and a stale-baseline `409` guard for concurrent writes",
      "Publish UI + diff modal — dashboard header gains a draft badge with pending-change count; **Publish** opens `PublishDiffModal` with a card-by-card diff renderer before committing; a baseline-changed banner offers a one-click rebase when a teammate publishes underneath you",
      "Stage tracker for destructive ops — `removeCard` and `updateCardSql` return a `stage_required` envelope rather than applying immediately; the UI overlays ghosts on affected cards; pure idempotent `pending → applied` / `pending → discarded` transitions in the new `stage-tracker` deep module",
      "`screenshotDashboard` vision tool — long-lived Chromium pool, per-(user, dashboard) cache, mutation-invalidated; warm p50 1.2–1.5s, 33/33 OK in the spike; agent uses pixels to answer 'why is this card flat?' instead of guessing from SQL alone",
      "History tab — dashboard chat drawer ships a History tab listing prior chat sessions tied to this dashboard (workspace-wide); each session opens as a read-only transcript so teammates can pick up an investigation mid-flight",
      "`createDashboard` reframe — renamed from `proposeDashboard`; persists a real row in the user's draft; root chat hands off to the bound drawer via `?openChat=true` so creation-to-edit is one continuous conversation",
      "`ATLAS_DASHBOARD_DRAFTS_ENABLED` flag flipped to default-ON — the per-user draft path is now the default for all installs; setting the env var to the literal string `false` falls back to the pre-1.4.6 direct-write model with the chat-bound editor degrading to a read-only viewer",
      "Migrations 0073 / 0079 / 0083 — `conversations.bound_dashboard_id`, `dashboard_user_drafts`, `dashboard_stage_changes`; each carries a matching `pgTable` mirror in `schema.ts` and real-Postgres coverage via `migrate-pg.test.ts`",
    ],
    githubMilestone: 46,
  },
  {
    version: "1.4.4",
    title: "Multi-environment semantic layer",
    date: "2026-05-17",
    summary:
      "The biggest schema shift since 1.0. Workspaces can now group multiple connections into a single **environment** (e.g. `us-int`, `eu`, `us-prod` all running the same schema) and have every piece of authored content — semantic entities, PII classifications, dashboards, scheduled tasks, approval rules — live at the group level instead of the connection level. The agent picks up group-aware chat routing automatically; the admin UI gains a merge-into-group wizard, a Phase 4 archive cascade for retiring a group cleanly, and a `Group by [Type | Environment]` toggle on `/admin/connections`. A drift-on-tree treatment on `/admin/semantic` retires the separate `/admin/schema-diff` page. `@useatlas/types` graduates to 0.1.x as the legacy `connection_id` columns are dropped from the wire. Numbers: PRD + 10 implementation slices + 17-finding closeout audit + a 2026-05-16 dogfood follow-on covering admin IA reshape (PRD #2458 + 5 slices), SaaS plan + trial onboarding (PRD #2464 + 4 slices), and three rounds of browser-driven verification fixes — 64 issues total.",
    highlights: [
      "Connection groups foundation — `connection_groups` table + admin CRUD UI (`/admin/connections → Environments`) lets workspaces collapse N connections sharing the same schema into one named environment with a primary member; primary is the auto-pick for single-environment queries and drives view-time resolution for dashboard cards",
      "Group-scoped content end-to-end — semantic entities (#2340), PII classifications (#2341), dashboard cards (#2342), scheduled tasks (#2343), and approval rules (#2344) all carry `connection_group_id` and resolve at run-time; getEntity / deleteEntity / dashboard refresh / scheduler tick all respect the group boundary",
      "Group-aware chat routing + per-turn env override (#2345) — the agent picks an environment for each turn based on conversation context; users can override per-message via a picker in the chat header; the override propagates into `executeSQL` as `connectionGroupId`",
      "Admin merge-into-group wizard + Phase 4 archive cascade — convert N existing connections to a new environment in one flow; archiving a group cascades to its members, content, and scheduled tasks atomically; UX warns up-front for cards / tasks that would orphan",
      "`/admin/semantic` drift drawer + tree (PRD #2458) — drift badges on the file tree highlight entities whose live DB schema diverges from the YAML; the drawer surfaces a column-level diff plus inline reconcile actions; `/admin/schema-diff` retired (pre-customer, no migration needed)",
      "`/admin/connections` Group-by toggle — switch the connection list between **Group by Type** (Postgres / Snowflake / ClickHouse) and **Group by Environment** (us-int / eu / us-prod) so admins can scan either axis",
      "SaaS trial onboarding (PRD #2464) — every SaaS signup gets a 14-day trial assigned at workspace creation, one-time backfill for existing free workspaces, trial countdown banner on `/admin/billing`, and `user-configured` copy retired from `/admin/model-config` so the trial path doesn't show a stale prompt",
      "Application-layer FK gate on `connection_group_id` (#2424) — conversations + dashboards now reject cross-org group references with a typed error before the write hits Postgres, closing the foothold the closeout audit found in #2407",
      "Legacy `connection_id` dropped (#2346 + #2347 + migration 0069) — wire types, route handlers, and admin UI all migrate to `connectionGroupId` exclusively; `@useatlas/types` major-bumped to 0.1.x to signal the breaking change",
      "Closeout audit (#2407) shipped 17 fixes — `g_*` synthetic name leaks, env-delete tombstones, single-connection picker visibility, dashboard card-create single-group bypass, scheduler tenant boundary crosses, `me-connection-groups` empty-org silence, and a long bug-pass tail",
      "Verification-pass batches (2026-05-16) — first wave (8 parallel agents) closed chat empty-state DB overlay, ConnectionRegistry boot-hydrate, SaaS demo-conn leak, Add Connection env field + 429 surfacing, admin MFA gate consistency, post-signup landing race, stale-bundle cache headers; second wave finished the `/admin` Overview platform/org split and `/admin/connections` live-count parity; third wave (PM browser-driven) closed useAdminFetch empty-path CORS, entity-count drift across admin surfaces, missing chat env picker, agent `default`-leak on SaaS, orphan empty env group, and the Cloudflare CSP beacon",
      "Architecture-wins #58–#60 — `withGroupScope` helper deep module extraction (#2338) became the standard for any new group-scoped query; `stripGroupPrefix` shared util consolidated 6 duplicated implementations",
    ],
    githubMilestone: 45,
  },
  {
    version: "1.4.5",
    title: "Cross-environment querying",
    date: "2026-05-17",
    summary:
      "Workspaces with more than one **environment** (e.g. `us-int`, `eu`, `us-prod` connection groups sharing the same schema, from 1.4.4) can now ask one question and get an answer across all of them. The agent picks a routing scope per question — `Auto` for environment-specific queries, `Pin` for stable single-source results, `All envs` to fan out and merge under an `environment` discriminator column. Partial failure is first-class: a fan-out that succeeds on 2 of 3 environments returns the merged rows and surfaces the third as a degraded warning rather than blowing up the whole turn. The full audit trail rolls up per-environment child queries to a parent row via `query_audit.parent_audit_id`. Numbers: PRD + 5 slices, all landed same day, with two new deep modules (`environment-routing`, `multi-env-result-merger`) and `@llm`-tagged e2e coverage.",
    highlights: [
      "Three routing modes — `Auto` (agent picks per question), `Pin` (every call targets the pinned environment), `All envs` (every call fans out and merges); picker lives in the chat header; default is `Auto`",
      "`executeSQL` `scope` param — agent fills `auto` / `pin` / `all` based on conversation `routing_mode` + per-turn semantics; `environment-routing` deep module owns the dispatch decision; `multi-env-result-merger` owns the fan-out + row merge with an injected `environment` discriminator",
      "Agent system prompt teaches scope decisions — heuristics documented in-prompt so the agent knows to pin for dashboard-card SQL but fan out for 'compare X across environments' questions; eval canonical questions cover both halves",
      "Conversation-level `routing_mode` — persisted on `conversations.routing_mode` so a user pinning to `eu` mid-investigation stays pinned across page reloads; three-state shadcn picker UI with descriptive helper text",
      "Partial-failure as a first-class result — `envContributions` on `ExecuteSqlResult` carries per-environment row counts + errors; a 2-of-3 success returns the merged rows and surfaces the third's error as a degraded warning instead of failing the turn",
      "Audit-log parent rollup — `query_audit.parent_audit_id` links per-environment child queries to a parent row so admin audit views see a single logical query plus its physical fan-out children",
      "OTel `atlas.routing_mode` attribute — every agent step tagged for cross-environment analytics in the observability stack",
      "Browser e2e coverage — `@llm`-tagged happy-path + partial-failure specs in `e2e/browser/` that skip cleanly when no overlay / LLM key is present; runnable in CI on tagged releases",
    ],
    githubMilestone: 47,
  },
  {
    version: "1.4.3",
    title: "Agent-first polish + BYOT review tail",
    date: "2026-05-12",
    summary:
      "Round-out release for 1.4.2 — closes the post-#2174 BYOT direct-provider review tail and ships the SDK multi-workspace MCP shape. Tighter typing across the BYOT credential boundary (a discriminated `WorkspaceCredentials` union with a parameterized `ByotAdapter<Cred>` so Bedrock joins the same dispatch table as Anthropic and OpenAI). Branded encryption return types (`URLSecret` vs `OpaqueSecret`) make the URL-passthrough vs prefix-only picking guide a compile-time fact. A scheduler-graduated daily catalog refresh replaces the cron-shaped helper, with an admin manual-run endpoint visible from the Scheduler Tasks page. `@useatlas/sdk@0.0.14` exposes the plural `workspace_ids` claim so embedded onboarding flows can render a workspace picker. Docs catch up too: Bedrock IAM + region guide and the direct-provider model picker reference. Numbers: 12 issues across BYOT typing, encryption hygiene, scheduler graduation, SDK multi-workspace surface, and the auth-client cast-collapse arc.",
    highlights: [
      "Scheduler-driven BYOT catalog refresh — daily cron walks every encrypted credential, surfaces success/failure counts in `/admin/scheduler/tasks`, and exposes admin-only `POST /api/v1/admin/scheduler/tasks/byot-catalog-refresh/run` for manual triggers; runbook at `platform-ops/byot-catalog-refresh`",
      "`WorkspaceCredentials` discriminated union + `ByotAdapter<Cred>` parameterized dispatch — Bedrock joins the same typed adapter table as Anthropic and OpenAI; folds the S25 + S26 BYOT review threads into one PR",
      "Branded `encryptSecret` return types — `URLSecret` and `OpaqueSecret` brands enforce the picking guide at compile time; the deprecated `encryptUrl` / `decryptUrl` aliases stay branded so external SDK consumers pinned pre-#2285 keep their migration ramp through 1.5.0",
      "`@useatlas/sdk@0.0.14` multi-workspace MCP shape — `completeConnect` surfaces the plural `workspace_ids` claim, `buildConfig` opts into a multi-workspace env-hint block, `useMcpConnect` exposes a `workspaces` array for picker UX",
      "AWS Bedrock BYOT IAM + region guide — minimum IAM policy snippet, model availability per region, and the key rotation flow at `integrations/llm-providers/bedrock`",
      "Direct-provider BYOT model picker docs — Anthropic + OpenAI + Bedrock searchable picker over the live provider catalog with the L1 + Postgres L2 cache story at `guides/model-routing`",
      "`useSession()` widened for `session.fields` extras — closes the #2262 `authClient`-cast-collapse arc; four callsites lose their local `as { activeOrganizationId?; activeOrganizationName? }` narrows",
    ],
    githubMilestone: 44,
  },
  {
    version: "1.4.2",
    title: "End-user shakeout",
    date: "2026-05-12",
    summary:
      "Polish pass from dogfooding Atlas as an end-user. Chat-first front door for non-admins (root `/` lands on the agent, not the admin console), per-user default-landing preference for admins who live in `/admin`. Platform-admin chrome lifted to top-level `/platform/*` so URL prefix mirrors role scope. BYOT now supports direct Anthropic / OpenAI / Bedrock keys with provider-side model discovery and a Postgres L2 catalog cache. New `/settings/profile` self-serve page covers name + password + MFA + sessions. Dev mode gets a LaunchDarkly-style pending-changes pill so draft work is visible. Numbers: 42 issues across admin chrome, BYOT, profile, multi-tenant correctness, platform-admin polish, and a long bug pass.",
    highlights: [
      "Chat-first front door — root `/` lands non-admins on the agent; admins pick a per-user default landing (chat / notebook / dashboards / admin) in Settings → Profile",
      "Unified left rail across `/`, `/notebook`, `/dashboards` — shadcn Sidebar shell parity with `/admin` so every surface picks up the same nav primitives",
      "BYOT direct-provider discovery — Anthropic + OpenAI + Bedrock keys now get a searchable model picker over the live provider catalog (`/v1/models` + `ListFoundationModels`), backed by a per-orgId L1 + Postgres L2 cache and graceful unknown-model handling",
      "Vercel AI Gateway model catalog picker — searchable picker with provider/capability filters surfaces the full gateway catalog instead of free-form model input",
      "Platform admin nav lift — `/admin/platform/*` + `/admin/organizations` + `/admin/abuse` promoted to top-level `/platform/*` so the URL prefix mirrors role scope; `/admin/users` split into workspace + `/platform/users`",
      "`/settings/profile` — name + password + MFA + sessions in one self-serve page (B2B-safe; org-owned email stays read-only); reached from the avatar menu in both chat and admin chrome",
      "Persistent admin top bar — workspace breadcrumb + avatar menu carries across every admin page",
      "Dev-mode discoverability — LaunchDarkly-style PendingChangesPill counts staged drafts across content tables; admin mutations always write drafts so Publish stays the canonical promote-to-live step",
      "`__demo__` collapsed to one global row — onboarding INSERTs at `org_id='__global__'` with ON CONFLICT DO NOTHING; per-org archived tombstone shadows the global without mutating shared state",
      "Shared primitives extracted — `<MfaPanel>` shared between `/admin/account-security` and `/settings/profile`, `AdminBreadcrumb` discriminated union, canonical shadcn DatePicker / DateRangePicker across every admin date selector",
      "Boot + CI hardening — Boot Smoke path-gated to scaffold-relevant changes (doc-only PRs skip the 4-min job), `ci` lint/type/test/syncpack/template-drift fan out as parallel jobs, real-Postgres migration smoke catches SQL planning errors that mock-pool tests miss, full Dockerfile + SaaS env boot smoke with `/api/health` probe",
    ],
    githubMilestone: 42,
  },
  {
    version: "1.4.1",
    title: "MCP: Bringing It All Together",
    date: "2026-05-09",
    summary:
      "Round-out release for 1.4.0 — closes the genuine gaps from the agent-first launch. Per-user MCP onboarding lives in Settings → AI Agents (no CLI required). Per-OAuth-client rate limits, surface-scoped approval rules, and cross-workspace agent identity round out the governance surface for hard-charging or multi-workspace agents. Hosted MCP performance is now measured (not guessed) — reproducible k6 scripts and a CI runner mean future regressions get caught. The MCP plugin SDK lets first-party plugins ship custom tools that agents see alongside the typed semantic-layer tools, and the @useatlas/sdk MCP onboarding helper makes embedded \"connect your agent\" flows a 5-line addition. Numbers: 34 issues, 5 themes plus a 9-item closeout sweep.",
    highlights: [
      "Settings → AI Agents — per-user MCP connect + manage flow with a 3-step wizard, refresh-token state surfacing, audit-log filter for `actorKind=mcp`/`clientId`/`tool`, and a live MCP usage chip; non-CLI users can install + manage MCP without touching atlas.config.ts",
      "`mcp.useatlas.dev` — first-class brand hostname for MCP traffic, advertised in OAuth audiences and protected-resource metadata; CLI default points here; cross-region `421 Misdirected Request` body returns the brand URL",
      "Per-OAuth-client rate limiting — sliding-window limiter scoped to `(workspaceId, clientId)` with per-tool weighting (`executeSQL`/`explore` 5×); admin overrides via dedicated table; structured 429 envelope + `mcp.rate_limited` audit",
      "Surface-scoped approval rules — approval rules can target `chat`, `mcp`, `scheduler`, `slack`, `teams`, `webhook`, or `any`; admin UI gains a surface dropdown; an unstamped route only matches `'any'` rules so the gate stays active even on transports that haven't been wired in",
      "Cross-workspace agent identity — one OAuth flow + one client config serves multi-workspace users; per-request scoping via `X-Atlas-Workspace`; live DB membership lookup so workspace-leave revokes MCP access immediately rather than waiting for token refresh",
      "Measured hosted MCP performance — `apps/docs/content/docs/architecture/mcp-performance.mdx` documents cold-start, concurrent-session ladder, realistic-mix latencies, bottleneck order, and tuning recipes; `eval/load-tests/mcp/` k6 scripts reproduce the numbers against any deployment; `.github/workflows/load-test-mcp.yml` runs them on demand and writes a markdown summary to the workflow run",
      "MCP-path eval harness — every canonical question dispatched through the real `createHostedMcpRouter()` over real OAuth 2.1 + JWT (no auth mock), graded by both deterministic and LLM modes; `description-rubric.test.ts` keeps tool descriptions on a fixed rubric so agents see consistent guidance",
      "Plugin SDK MCP-tools extension point — `AtlasPlugin.mcpTools()` lets plugins ship their own tools that the host registers as `<plugin-id>.<name>`; the same description rubric applies; reference implementation in `plugins/yaml-context/`; foundation for future context-provider plugins",
      "`@useatlas/sdk/mcp` programmatic onboarding — `atlas.mcp.beginConnect` / `completeConnect` / `buildConfig` / `listAgents` / `revokeAgent` for embedding \"connect your agent\" in your own product; `useMcpConnect` hook in `@useatlas/react` wraps the popup-or-redirect lifecycle",
      "Canonical eval prompts surfaced via `prompts/list` — 20 NovaMart questions exposed as `canonical-{slug}` MCP prompts, gated by `ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS` (`auto` / `always` / `never`); Settings → AI Agents preview block shares the listing pipeline with the wire so visible-prompt sets stay in lockstep",
    ],
    githubMilestone: 41,
  },
  {
    version: "1.4.0",
    title: "MCP & Agent-First DX",
    date: "2026-05-05",
    summary:
      "The agent-first install and discovery surface is closed end-to-end. Any MCP client can install Atlas in one command and connect to the hosted endpoint over standards-compliant OAuth 2.1 (Dynamic Client Registration + PKCE), or pair the bundled NovaMart fixture with a local install for zero-config self-hosted use. Typed semantic-layer tools (listEntities, describeEntity, searchGlossary, runMetric) and a structured error envelope let agents recover from ambiguity, validation failures, or rate limits without blind retries. Atlas is now listed on the official MCP Registry — agents discovering software through the registry find it the same way they find Postgres or GitHub.",
    highlights: [
      "One-command MCP install — `bunx @useatlas/mcp init --local` (zero-config local with bundled NovaMart fixture) or `--hosted --write` (browser-based OAuth 2.1 loopback against Atlas SaaS, same shape as `gh auth login`)",
      "Hosted MCP endpoint per-region (us/eu/apac) — Dynamic Client Registration, PKCE, JWT access tokens, RFC 9728 protected-resource metadata, `421 Misdirected Request` enforced for cross-region requests so the residency promise holds for MCP traffic",
      "Admin Settings → OAuth Clients — list registered clients with last-use + outstanding-token counts, revoke a client and every token it issued in one click",
      "Typed semantic-layer MCP tools — `listEntities`, `describeEntity`, `searchGlossary`, `runMetric` so agents can call the YAML format programmatically instead of scraping it",
      "Structured `AtlasMcpToolError` envelope with closed code catalog (`validation_failed`, `ambiguous_term`, `rls_denied`, `query_timeout`, `unknown_entity`, `unknown_metric`, `rate_limited`, `internal_error`) — each tool's MCP description ends with an explicit `Error contract:` line so agents discover recovery paths from the tool itself",
      "OTel coverage for MCP — activation + tool-call distribution + latency counters land in the existing observability stack",
      "Listed on `registry.modelcontextprotocol.io` as `io.github.AtlasDevHQ/atlas`, auto-published via OIDC on every `mcp-v*` tag",
      "Eval harness with 20 canonical questions under `eval/canonical-questions/` — deterministic semantic-layer reads + LLM mode for the full agent loop, CI-gated on release tags",
      "NovaMart canonical demo seed — three seeds collapsed to one e-commerce dataset; landing, docs, scaffolder, and eval harness all share the same example questions",
    ],
    githubMilestone: 40,
  },
  {
    version: "1.1 – 1.2",
    title: "Post-launch refinement",
    date: "2026-04-17",
    summary:
      "Three milestones shaping how users meet the product and how teams govern what their workspace shows. Notebooks bridge exploratory chat and persistent dashboards, developer mode lets admins stage changes before rolling them out, and the hardcoded starter-prompts grid becomes an adaptive surface composed from per-user favorites, admin-moderated popular queries, and demo-industry fallback.",
    highlights: [
      "Notebooks — convert chat to persistent notebook, fork cells with \"What if?\", dashboard bridge, report route, execution metadata",
      "Developer / published mode — stage draft changes across connections, semantic entities, prompt collections, and starter prompts; atomic publish; pending-changes banner",
      "Adaptive starter prompts — pin your own questions, admin-moderated popular queries, demo-industry fallback; replaces hardcoded grid",
      "Available everywhere — chat empty state, notebook new-cell empty state, @useatlas/react widget, @useatlas/sdk getStarterPrompts()",
      "Onboarding demo identity — new workspaces start on a __demo__ connection, switch to developer mode to connect real data without exposing partial state",
    ],
  },
  {
    version: "1.0.0",
    title: "SaaS Launch",
    date: "2026-04-03",
    summary:
      "Public launch of hosted Atlas at app.useatlas.dev. Pricing, SLA commitments, legal pages, migration tooling for self-hosted to SaaS, hosted user documentation, and status page with incident management.",
    highlights: [
      "3-region deployment (US, EU, APAC) with misrouting detection",
      "SLA page with uptime guarantees, latency targets, and support tiers",
      "Migration tooling — atlas export/import for self-hosted to SaaS",
      "OpenStatus integration for incident management",
    ],
    githubMilestone: 24,
  },
  {
    version: "0.9",
    title: "SaaS Platform",
    summary:
      "Everything needed to run Atlas as a hosted product. Self-serve signup, Stripe billing, SSO/SCIM, PII detection, Chat SDK with 8 platform adapters, plugin marketplace, semantic layer web editor, OAuth connect flows, and 3-region deployment.",
    highlights: [
      "Self-serve signup with guided semantic layer wizard",
      "Enterprise auth — SSO (SAML/OIDC), SCIM, custom roles, IP allowlists, approval workflows",
      "Chat SDK — Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp",
      "Plugin marketplace — browse, install, configure per workspace",
      "Semantic layer web editor with autocomplete and version history",
      "Data residency — 3 regions (US, EU, APAC) with cross-region migration",
      "Effect.ts architecture — typed errors, composable Layers, @effect/ai agent loop",
    ],
  },
  {
    version: "0.8",
    title: "Intelligence & Learning",
    summary:
      "Dynamic learning layer that gets smarter over time. Agent proposes learned patterns from successful queries, admin reviews and approves. Notebook-style interface with fork/branch, drag-and-drop reorder, markdown cells, and export. Curated prompt library and query suggestions.",
  },
  {
    version: "0.6–0.7",
    title: "Enterprise & Scale",
    summary:
      "Governance primitives and multi-tenant architecture. Row-level security with multi-column policies, session management, audit logging with CSV export, Microsoft Teams and webhook integrations. Multi-tenancy via Better Auth org plugin with tenant-scoped pooling, caching, and semantic layers.",
    highlights: [
      "Row-level security — multi-column, array claims, OR-logic policies",
      "Multi-tenancy — org-scoped connections, pools, cache, semantic layers",
      "Query result caching with configurable TTL and admin flush",
      "Streaming Python execution with sandboxed chart rendering",
    ],
  },
  {
    version: "0.3–0.5",
    title: "Core Product",
    summary:
      "Admin console with connection management, query analytics, and observability. Chat UI with theming, follow-ups, Excel export, and mobile support. Embeddable widget, TypeScript SDK with streaming, conversation sharing, and BigQuery plugin.",
    highlights: [
      "Admin console — connections, users, plugins, analytics, health checks",
      "Chat experience — dark/light mode, saved queries, schema explorer, charts",
      "Embeddable widget — @useatlas/react, script tag loader, SDK streaming",
      "119 docs pages audited for agent and human consumption",
    ],
  },
  {
    version: "0.1–0.2",
    title: "Foundation",
    summary:
      "Open-source release with plugin ecosystem. Docs site, CLI tooling, 18 official plugins on npm, Plugin SDK with scaffolding and testing utilities. Datasource plugins for PostgreSQL, MySQL, BigQuery, ClickHouse, Snowflake, DuckDB, and Salesforce.",
  },
];
