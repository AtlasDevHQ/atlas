export type MilestoneStatus = "shipped" | "current" | "planned";

export interface Milestone {
  version: string;
  title: string;
  status: MilestoneStatus;
  summary: string;
  highlights?: string[];
  githubMilestone?: number;
}

/**
 * Roadmap milestone data — single source of truth for the roadmap page.
 * Condensed to customer-meaningful phases, not internal sprint tracking.
 */
export const milestones: Milestone[] = [
  // ── Shipped ──────────────────────────────────────────────
  {
    version: "0.1–0.2",
    title: "Foundation",
    status: "shipped",
    summary:
      "Open-source release with plugin ecosystem. Docs site, CLI tooling, 18 official plugins on npm, Plugin SDK with scaffolding and testing utilities. Datasource plugins for PostgreSQL, MySQL, BigQuery, ClickHouse, Snowflake, DuckDB, and Salesforce.",
  },
  {
    version: "0.3–0.5",
    title: "Core Product",
    status: "shipped",
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
    version: "0.6–0.7",
    title: "Enterprise & Scale",
    status: "shipped",
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
    version: "0.8",
    title: "Intelligence & Learning",
    status: "shipped",
    summary:
      "Dynamic learning layer that gets smarter over time. Agent proposes learned patterns from successful queries, admin reviews and approves. Notebook-style interface with fork/branch, drag-and-drop reorder, markdown cells, and export. Curated prompt library and query suggestions.",
  },
  {
    version: "0.9",
    title: "SaaS Platform",
    status: "shipped",
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
  // ── Shipped (latest) ─────────────────────────────────────
  {
    version: "1.0.0",
    title: "SaaS Launch",
    status: "shipped",
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
];
