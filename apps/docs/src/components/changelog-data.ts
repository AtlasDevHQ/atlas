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
