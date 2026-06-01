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
 *
 * Two tracks, each ordered newest-first:
 *  - `releases`           — the public git-tag train (`v0.0.1`, `v0.0.2`, …). Mirrors GitHub
 *                           Releases; one entry per tag cut via `/release`.
 *  - `developmentHistory` — internal milestone numbers (`1.6.0` … `0.1`) that predate public
 *                           versioning. Kept as a pre-launch development record, not public semver.
 *
 * See ADR-0008 for the versioning model. New tags are appended to `releases` at /release time.
 */
export const releases: Release[] = [
  {
    version: "v0.0.3",
    title: "Spec Lifecycle",
    date: "2026-05-31",
    summary:
      "OpenAPI datasources now keep themselves current. Once you connect a REST service, Atlas tracks its spec over time: a configurable per-install refresh interval re-discovers operations on a schedule, a structured drift diff shows exactly what changed since the last sync, and a breaking-change signal flags when an operation your queries depend on is removed or altered. Specs are fetched once and cached across workspaces — the shared cache reuses the parsed spec and operation graph but never the credential — so re-discovery stays cheap even as installs multiply. This release also repositions the marketing site and docs around Atlas as a semantic layer for any query layer: SQL warehouses or REST/OpenAPI services, answered through one model.",
    highlights: [
      "Scheduled spec re-discovery — set a per-install refresh interval and Atlas re-reads the OpenAPI spec on its own; a 'Rediscover schema' control triggers it on demand",
      "Structured drift diff — every re-discovery produces a readable changeset (operations added, removed, changed) instead of a silent overwrite",
      "Breaking-change drift signal — when re-discovery removes or alters an operation, Atlas raises a breaking-change alert and records a `connection.spec_drift_breaking` audit entry",
      "Shared cross-workspace spec cache — a spec is downloaded once and reused across workspaces; the cache shares the parsed spec and graph, never the credential",
      "Query-layer repositioning — the homepage and docs now present Atlas as a semantic layer for any query layer (SQL or REST/OpenAPI), led by an answer-first hero",
    ],
  },
  {
    version: "v0.0.2",
    title: "REST Datasources",
    date: "2026-05-31",
    summary:
      "Atlas datasources are no longer SQL-only. A new generic OpenAPI primitive lets you connect any REST service that publishes an OpenAPI 3.x spec as a first-class, read-side datasource the agent can query in chat — right alongside your Postgres, MySQL, and warehouse connections. Install from Admin → Connections by pointing Atlas at a spec URL and supplying credentials (API key or OAuth2); Atlas discovers the available operations and the agent calls them through a new `executeRestOperation` tool, with pagination handled for you. Reads are the safe default — write operations are strictly opt-in, per endpoint, behind a confirm-before-write step — and an SSRF egress guard keeps every request scoped to the service you configured. Twenty, Stripe, GitHub, and Notion ship as ready-made connectors built on the same primitive.",
    highlights: [
      "Connect any OpenAPI/REST service as a datasource — point Atlas at an OpenAPI 3.x spec, add credentials, and the agent can query it in chat next to your SQL connections; install, rediscover, and toggle the operation representation from Admin → Connections",
      "Ready-made connectors for Twenty, Stripe, GitHub, and Notion — thin wrappers over the generic primitive, each handling its own auth and vendor quirks (Stripe `expand[]`, Notion's required `Notion-Version` header, GitHub OAuth2)",
      "Automatic pagination — cursor, offset, page, and link-header strategies are handled for you, with page-level caching so large result sets don't re-fetch",
      "Read-safe by default, writes opt-in — every operation is validated before it runs; write endpoints require an explicit per-endpoint allowlist plus a confirm-before-write prompt before anything mutates",
      "Credentials encrypted at rest + SSRF egress guard — API keys and OAuth tokens are stored encrypted, and requests are scoped to the configured base URL so a spec can't redirect Atlas at internal services",
      "API-key and OAuth2 install paths — connect via a short credentials form or a full OAuth2 authorization flow, depending on the service",
    ],
  },
  {
    version: "v0.0.1",
    title: "Release Process Bootstrap",
    date: "2026-05-29",
    summary:
      "The first tagged release of Atlas — and the start of versioned, tag-gated production deploys. From here, prod advances only when an annotated git tag is cut, rather than auto-deploying on every merge: `main` continuously ships to staging, and a release tag promotes that exact commit to production. The headline deliverable is the customer-facing Stability Contract, which spells out what's stable to build on today (the REST API surface, the MCP tool surface, the plugin SDK, the semantic-layer wire format) and what may still change before v1.0.0. Docs + release tooling only — no runtime feature ships under this tag; it's the foundation the rest of the v0.0.x train is cut from.",
    highlights: [
      "Tag-gated production deploys — prod advances only on an annotated `v*.*.*` tag via the `/release` flow; `main` continuously deploys to staging, so production is always a deliberately tagged commit",
      "Stability Contract published — explicit stability commitments for the REST API, MCP tool surface, plugin SDK, and semantic-layer wire format, at Reference → Stability",
      "Versioning policy (ADR-0008) — the `v0.0.x` series is the pre-launch development train; `v0.1.0` is reserved to mark the public launch (target July 2026)",
    ],
  },
];

/**
 * Pre-public-versioning development history. These are internal milestone numbers, not public
 * semver — they predate the git-tag train (ADR-0008) and are kept as a record of what shipped
 * during development. The public version train is `releases` above.
 */
export const developmentHistory: Release[] = [
  {
    version: "1.6.0",
    title: "CRM & lead capture",
    date: "2026-05-26",
    summary:
      "Every meaningful lead event — demo signup, Better Auth signup, Stripe trial-to-paid conversion, talk-to-sales submission — now lands in Twenty CRM at crm.useatlas.dev automatically, tagged by source. The `mailto:sales@useatlas.dev` CTAs on `/pricing`, `/sla`, `/dpa`, and `/terms` are replaced with a real in-page form (Cloudflare Turnstile-protected) that creates a Twenty Person + Note with qualifying context. Under the hood, a durable `crm_outbox` table absorbs Twenty downtime — every dispatch is enqueue-then-flush via a Scheduler-backed background flusher with exponential backoff, plus an operator UI at `/platform/crm-outbox` for inspection / retry / mark-dead. The integration ships as a general-purpose `@useatlas/twenty` plugin (AGPL) plus a SaaS wiring layer in `ee/src/saas-crm/` gated behind the `SaasCrm` Context.Tag — self-hosted Atlas gets the plugin (admin UI install or `atlas.config.ts`) but never the SaaS dispatch path, with a closeout `scripts/check-twenty-resolver-imports.sh` gate locking the seam. Numbers: 11 issues + PRD #2726, slice 6 (Twenty-as-datasource) deferred to 1.7.0 because Twenty Cloud doesn't expose Postgres.",
    highlights: [
      "Demo / signup / sales-form / conversion → Twenty Person — four event sources stamp `atlasFirstSource` (sticky) + `atlasLastSource` (overwritten) custom fields. Better Auth `databaseHooks.user.create.after` (#2731) enqueues `signup` leads; Stripe `customer.subscription.created` (#2737) enqueues `conversion` leads for the already-stamped Person",
      "Talk-to-sales dialog replaces mailto — shared `<TalkToSalesDialog>` (#2730 / #2733) on `/pricing` Business tier, `/sla`, `/dpa`, `/terms` with a page-specific `topic` field. `POST /api/v1/contact` enqueues a Person + Note via the outbox; Cloudflare Turnstile siteverify fail-closed; `<noscript>` mailto fallback preserved",
      "Durable `crm_outbox` + Scheduler-backed flusher (#2729) — replaces fire-and-forget capture with classify/backoff/dead-letter semantics; depth gauges + `oldest-pending-age` warned per flusher tick (#2734); operator UI at `/platform/crm-outbox` (#2735) for `retry` / `mark-dead` with both mutations audit-logged (`ADMIN_ACTIONS.crm_outbox.{retry, markDead}`)",
      "`@useatlas/twenty` plugin (#2727 / PR #2785) — AGPL, self-hostable via Admin → Integrations → Twenty or `atlas.config.ts:plugins`. Admin UI at `/admin/integrations/twenty` (#2732) writes `workspace_plugins.config` with F-41 selective-field encryption on `apiKey`. Actions: `upsertPerson`, `createNote`, `createOpportunity`",
      "`atlas ops backfill-crm-leads` (#2736) — one-shot CLI enqueues every existing `demo_leads` row into `crm_outbox` so historical signups also dispatch to Twenty. Idempotent via the per-source idempotency key; `--dry-run` / `--batch-size` / `--source` flags",
      "Credential resolver split (#2850 closeout) — `ee/saas-crm/` reads the `TWENTY_API_KEY` env for Atlas's own pipeline; `plugins/twenty/` reads per-workspace `workspace_plugins.config` only. `scripts/check-twenty-resolver-imports.sh` gate keeps `resolveOperatorCredentials` reachable only from `ee/src/saas-crm/`. Two leak directions structurally impossible — a customer install with missing apiKey can't fall through to Atlas's operator key, and a future change in `ee/src/saas-crm/` can't accidentally read a customer's `twenty_integrations` row",
      "`SaasCrm` Context.Tag with `available: boolean` — load-bearing for the `/api/v1/contact` 404-vs-200 branch and the `/platform/crm-outbox` nav-link gate (`saasOnly`). Noop default returns success-after-enqueue without dispatching, so self-hosted Atlas runs without Twenty credentials and the SaaS-only pages 404 cleanly",
      "Slice 6 deferred to 1.7.0 — Twenty Cloud doesn't expose Postgres, so the lightweight \"plug it in as an Atlas connection\" path isn't available. Generic REST / non-SQL datasources (Twenty, Stripe, OpenSearch) is now the seed for 1.7.0 ([milestone #54](https://github.com/AtlasDevHQ/atlas/milestone/54))",
    ],
    githubMilestone: 52,
  },
  {
    version: "1.5.3",
    title: "Multi-platform install models",
    date: "2026-05-26",
    summary:
      "Self-serve integrations broaden from Slack + Salesforce + Jira to **eight chat platforms** plus Linear. Workspace admins can now connect Telegram, Discord, Linear, GitHub, Teams MultiTenant, WhatsApp, and Google Chat from `/admin/integrations` — each shipped as a `plugin_catalog` row covering the three install model shapes (OAuth, Form/StaticBot, Service-account) without an `atlas.config.ts` edit. Under the hood, `workspace_plugins` graduates to the **universal install record** for both Datasource and Chat/Action integrations, and the legacy `connections` table is dropped in a one-shot migration (slice 6) — Datasource credentials now live in `workspace_plugins.config` JSONB via selective-field encryption, same pattern as every other plugin secret. `/admin/integrations` legacy chrome is killed in favour of a Chat / Actions section split; Salesforce moves under `/admin/connections` (it's a Datasource, not an Integration). Catalog state gains a `coming_soon` flag with an `atlas.config.ts` operator override so SaaS and self-hosted can present different cards. An Email `sendEmail` agent-loop tool wires the existing `@useatlas/email-digest` action into the agent via LazyPluginLoader. The 1.5.2 chat-plugin × Atlas extension-contract audit picks up its 4th instance closeout (#2680 reaction-back hotfix) with brand-typed `ChannelId` / `ThreadId` / `WorkspaceId`. Numbers: 32 issues + PRD #2738, 17-slice plan (Phase A foundation → E closeout) plus an operator-surface docs sweep (10 docs gaps closed).",
    highlights: [
      "Eight chat platforms self-serve installable — Slack, Teams, Discord, Telegram, Linear, GitHub, WhatsApp, Google Chat. Each ships as a `plugin_catalog` row that workspace admins connect from `/admin/integrations` without an `atlas.config.ts` edit; SaaS gets per-region App Registrations, self-hosted operators register the App once",
      "Three install model shapes formalised — OAuth (Slack/Salesforce/Jira/Linear/GitHub-App), Form/StaticBot (Telegram/Discord/WhatsApp/Linear-apikey/Webhook/Obsidian/Email), Service-account (Google Chat + GitHub PAT, manifest-paste for Teams). See [ADR-0006](/docs/adr/0006-three-pillar-integration-taxonomy) for the taxonomy, [ADR-0007](/docs/adr/0007-unified-install-pipeline) for the unified install pipeline",
      "`workspace_plugins` becomes the universal install record — one table for Datasource + Chat + Action installs replaces the legacy split (`connections` for Datasource, `workspace_plugins` for everything else). Slice 6 (#2744) is the cutover: `ConnectionRegistry` pivots to read `workspace_plugins`, migration 0096 drops the `connections` table, the `__demo__` Postgres row becomes an `auto_install` catalog entry, and the admin Connections route reuses the integration install renderer",
      "Datasource credentials migrate to selective-field encryption — Postgres / MySQL / Snowflake / ClickHouse URLs and credentials live in `workspace_plugins.config` JSONB, encrypted per-field per the catalog row's `config_schema` `secret: true` flag. Same `encryptSecretFields` / `decryptSecretFields` helpers as every other plugin secret. `encryptUrl` / `decryptUrl` deprecated re-exports retired per the original #2285 schedule",
      "Salesforce moves to `/admin/connections` (#2745) — it's a Datasource via the OAuth render path, not an Integration. Removes the catalog stub from `/admin/integrations`",
      "`/admin/integrations` dedup (#2746) — legacy chrome retired in favour of a Chat / Actions section split; each section renders only the catalog rows for its pillar. `coming_soon` state (#2747) ships behind an `atlas.config.ts:catalog` operator override so SaaS and self-hosted can present different availability",
      "Email `sendEmail` agent tool (#2698) — the `@useatlas/email-digest` action plugin gets a `sendEmail({ to, subject, body })` agent-loop wrapper via LazyPluginLoader; the agent can now follow up by email when a query result deserves a heads-up",
      "Brand-typed identity at the chat-plugin boundary — `WorkspaceId` / `AtlasUserId` / `ExternalUserId` (1.5.0 follow-up #2641) joined by `ChannelId` / `ThreadId` (#2680) make encoding mismatches compile-uncheckable; the 4th #2677-pattern hotfix (`pending.record(channelId)` vs `pending.peek(threadId)`) closes that error class for good. The Atlas-extension contract audit doc + read-side fail-loud warns from 1.5.2 remain the load-bearing guard going forward",
      "Operator-surface docs sweep (10 gaps) — environment-variables.mdx now lists OAuth TTLs + region URLs + Vercel sandbox vars + MCP session timeout (#2767); config.mdx gains a Catalog section for `plugin_catalog` seeding (#2768); CLI reference adds the operator subcommands (`proactive enable/disable`, `seed`, `ops wipe` — #2766); error-codes.mdx gains an Effect-tagged catalog (#2774); architecture/entitlements.mdx documents the 1.5.2 PLAN_RANK bundle (#2772); architecture/enterprise.mdx documents the 1.5.1 `check-ee-imports.sh` + `ee-stub-build` operator surface (#2770); `useMcpConnect` (#2775), `@useatlas/obsidian-reader` + `@useatlas/webhook-action` (#2773), and the deleted `@useatlas/slack` redirect (#2771) all land in their respective pages",
      "Pre-customer posture, clean breaks — no migration shim for the legacy datasource-install path; the `connections` table is dropped in one go. Test mocks migrate to `encryptSecretFields` rather than `encryptUrl` stubs",
    ],
    githubMilestone: 51,
  },
  {
    version: "1.5.2",
    title: "Self-serve integrations",
    date: "2026-05-23",
    summary:
      "Atlas integrations no longer require an `atlas.config.ts` edit per customer. A new `/admin/integrations` page lets workspace admins install Slack, Salesforce, Jira, Email, Webhook, and Obsidian themselves — operators register the App once per platform, customers click Connect, OAuth (or a short form) handles the rest. Six platforms shipped via two re-usable patterns: lazy-loaded OAuth handlers under `/api/v1/integrations/<platform>/{install,callback}` for Slack/Salesforce/Jira, and a form-based install path for static-credential platforms (Email/Webhook/Obsidian). Per-tenant credentials live in two stores by concern (ADR-0003 + ADR-0005): install metadata in `workspace_plugins`, secrets in a new `integration_credentials` table encrypted with `ATLAS_ENCRYPTION_KEYS`. Disconnect is a single button with dual-store teardown. A new `WorkspaceInstallGate` short-circuits proactive listener events for workspaces that don't have a Connection — every chat event consults the gate before classifier work runs. Slack proactive answers also got a UX pass: threaded replies, conversational tone (not SQL-developer-mode), and disclosure buttons for the asker to see the underlying SQL on demand. Numbers: 33 issues + parent PRD #2649, 7 OAuth slices + 7-step closeout sweep, 1.5.1's `core → ee` inversion held throughout.",
    highlights: [
      "Self-serve `/admin/integrations` page — workspace admins see catalog cards for every Platform the operator registered (per-region SaaS App Registrations) and click **Connect** to start OAuth; the catalog is seeded from `atlas.config.ts:catalog` at boot, so adding a new Platform is a one-time operator task per region rather than a per-customer config edit",
      "Slack OAuth lifted to `/api/v1/integrations/slack/{install,callback}` (#2653) — `SlackOAuthInstallHandler` writes the install record (`workspace_plugins`) and the credential (`chat_cache:slack:installation:<teamId>`) atomically per [ADR-0003](/docs/adr/0003-two-store-chat-install-metadata-credentials); legacy `/api/v1/slack/{commands,events,interactions}` routes retired in #2683 in favour of the chat-plugin's single webhook",
      "Salesforce as first lazy integration (#2658) + `integration_credentials` table — per-platform OAuth handler + `LazyPluginLoader` instantiates the plugin on first use per workspace, process-cached thereafter; secrets land in the new `integration_credentials` table (one row per (workspace × catalog_id × credential_type)) encrypted by `ATLAS_ENCRYPTION_KEYS`, eliminating the JSONB-blob credential pattern. See [ADR-0005](/docs/adr/0005-integration-credentials-table)",
      "Jira as second lazy integration (#2659) — ~54% fewer files than Salesforce; proved the lazy-OAuth pattern abstracts and ships in days, not weeks. Same `OAuthPlatformInstallHandler` + `OAuthPlatformTokenRefresher` shape — adding a 3rd platform now costs ~5 files",
      "Form-based install for static-credential platforms (#2660 / #2661) — Email/Webhook/Obsidian don't need OAuth; admins paste a target URL / SMTP creds / vault path into a typed form and the install record lands directly. Same catalog seam as OAuth, different handler kind (`form` vs `oauth`)",
      "Disconnect flow (#2656) — `DELETE /api/v1/integrations/:platform` + an admin button on every connected card; dual-store teardown deletes credentials FIRST then the install record (ordering per ADR-0003 so a half-failed disconnect can't leave an orphan token in `chat_cache`)",
      "`WorkspaceInstallGate` (#2655) — every proactive listener event consults `workspace_plugins` for an enabled row before classifier work runs; no install record = no Connection = silent skip (no classify, no meter, no rate-limit hit). Closes the multi-tenant proactive bypass that #2607 left open",
      "Entitlement bundle (#2713, arch-win #70) — unified `PLAN_RANK` rank ordering across the wire + `is_operator_workspace` flag for the Atlas dogfood org's runtime bypass + 4-layer gating (catalog → wire → backend → renderer) + throttled gate-deny logging. Admin UI no longer lets you configure features your plan-tier can't actually use (#2701 closed the silent-deny gap)",
      "Slack proactive UX polish (#2704 / #2705 / #2709) — answers now post as threaded replies off the asker's message instead of bare-channel posts; tone shifted from SQL-developer-mode to conversational; disclosure buttons reveal the underlying SQL + result table on demand",
      "Chat-plugin × Atlas extension contract audit (#2677 / #2725) — new `docs/architecture/chat-plugin-atlas-contract.md` enumerates every Atlas extension field at the `@useatlas/chat` / `@chat-adapter/*` boundary with legacy-writer → new-writer → read-sites → fail-loud transitions, closing the 3-of-3 pattern that produced #2628 / #2630 / #2676. CLAUDE.md gains a `Plugin migrations` checklist locking future PRs to update the contract doc",
      "Pre-customer posture, clean breaks allowed — no migration shim for the legacy `slack.ts` routes; the chat-plugin owns the surface end-to-end. `@useatlas/types@0.1.6` hoists catalog literal unions so SDK + react consumers share the wire vocabulary",
    ],
    githubMilestone: 50,
  },
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
      "Branded `encryptSecret` return types — `URLSecret` and `OpaqueSecret` brands enforce the picking guide at compile time. (The deprecated `encryptUrl` / `decryptUrl` re-exports forecast for retirement at 1.5.0 actually retired in 1.5.3 / #2819 once the `connections` table drop landed.)",
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
