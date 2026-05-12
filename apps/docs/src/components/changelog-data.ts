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
