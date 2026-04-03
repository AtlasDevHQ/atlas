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
 * Ordered chronologically, oldest first.
 */
export const milestones: Milestone[] = [
  // ── Shipped ──────────────────────────────────────────────
  {
    version: "pre",
    title: "Public Launch",
    status: "shipped",
    summary:
      "Initial open-source release with admin user management, one-click Vercel deploy (Neon + AI Gateway), @useatlas packages on npm, and CI automation for template drift checks and starter repo sync.",
  },
  {
    version: "pre",
    title: "Adapter Plugin Refactor",
    status: "shipped",
    summary:
      "Datasource adapters extracted from core into standalone plugins. Plugin SDK gained parserDialect and forbiddenPatterns hooks, with official plugins for ClickHouse, Snowflake, DuckDB, and Salesforce.",
  },
  {
    version: "pre",
    title: "Python Data Science Sandbox",
    status: "shipped",
    summary:
      "Sandboxed executePython tool for data analysis — runs Python with import guards, renders charts inline in the chat UI, and works across all sandbox backends.",
  },
  {
    version: "0.1.0",
    title: "Documentation & Developer Experience",
    status: "shipped",
    summary:
      "Docs site launched with reference pages, integration guides, interactive API reference, OG images, sitemap, and llms.txt. CLI gained atlas doctor, atlas validate, and shell completions.",
    githubMilestone: 1,
  },
  {
    version: "0.2.0",
    title: "Plugin Ecosystem",
    status: "shipped",
    summary:
      "18 official plugins published to npm under @useatlas/*. Plugin SDK gained testing utilities, scaffold command, multi-type support, and schema migrations.",
    githubMilestone: 2,
  },
  {
    version: "0.3.0",
    title: "Admin Console & Operations",
    status: "shipped",
    summary:
      "Self-service management and observability. Connection CRUD, action approval, user invite, query analytics dashboard, health checks, token usage tracking, and OpenTelemetry traces.",
    githubMilestone: 3,
  },
  {
    version: "0.4.0",
    title: "Chat Experience",
    status: "shipped",
    summary:
      "Dark/light mode with persistence, suggested follow-up questions, Excel export, mobile-responsive chat UI, saved queries, visual schema explorer, and expanded chart types.",
    githubMilestone: 4,
  },
  {
    version: "0.5.0",
    title: "Launch",
    status: "shipped",
    summary:
      "Embeddable widget infrastructure, SDK streaming via streamQuery(), BigQuery plugin, conversation sharing with public links, and @useatlas/types shared package.",
    githubMilestone: 5,
  },
  {
    version: "0.5.1",
    title: "Agent-Friendly Docs",
    status: "shipped",
    summary:
      "Systematic docs overhaul for human and LLM consumption. Quick start with verification checkpoints, how-to guides, inline code examples, and agent optimization audit.",
    githubMilestone: 10,
  },
  {
    version: "0.5.2",
    title: "Onboarding & CLI Polish",
    status: "shipped",
    summary:
      "First 60 seconds made perfect. atlas init progress spinner, pattern-matched errors, first-run .env detection, request IDs on errors, and proper --help text across all subcommands.",
    githubMilestone: 11,
  },
  {
    version: "0.5.3",
    title: "UI & Accessibility Polish",
    status: "shipped",
    summary:
      "ARIA labels, Lighthouse/axe audit in CI, full keyboard navigation, loading state audit, meaningful empty states, error boundaries, mobile polish, and widget TypeScript exports.",
    githubMilestone: 12,
  },
  {
    version: "0.5.4",
    title: "SDK & Integration Polish",
    status: "shipped",
    summary:
      "SDK gained listTables() and complete error code catalog. End-to-end integration tests for widget embed, SDK streaming, and MCP server. Obsidian plugin docs.",
    githubMilestone: 13,
  },
  {
    version: "0.6.0",
    title: "Governance & Operational Hardening",
    status: "shipped",
    summary:
      "Action timeout enforcement, rollback API, advanced RLS with multi-column policies, session management, audit log CSV export and full-text search, Microsoft Teams and webhook integrations.",
    githubMilestone: 7,
  },
  {
    version: "0.7.0",
    title: "Performance & Multi-Tenancy",
    status: "shipped",
    summary:
      "Multi-tenant foundation via Better Auth org plugin. Tenant-scoped connection pooling, query result caching, pre-computed semantic index, streaming Python execution, and atlas learn CLI.",
    githubMilestone: 8,
  },
  {
    version: "0.7.1",
    title: "Immediate Cleanup",
    status: "shipped",
    summary:
      "Post-sprint quality pass. Resolved lint warnings, moved chat error stack traces to debug-level logging, filled docs gaps for atlas index, streaming Python, and cache admin UI.",
    githubMilestone: 15,
  },
  {
    version: "0.7.2",
    title: "Type Safety & Code Smells",
    status: "shipped",
    summary:
      "Eliminated non-null assertion operators, replaced explicit any types, removed dead exports and unused code (net -1,150 lines), and broke up complex functions into well-named helpers.",
    githubMilestone: 16,
  },
  {
    version: "0.7.3",
    title: "Error Handling & Resilience",
    status: "shipped",
    summary:
      "Eliminated silent catch blocks, standardized error type narrowing with instanceof guards, replaced generic messages with actionable guidance, and added request IDs to all 500 responses.",
    githubMilestone: 17,
  },
  {
    version: "0.7.4",
    title: "Test Hardening",
    status: "shipped",
    summary:
      "Password endpoint tests, cache edge cases for TTL boundaries and LRU eviction, streaming Python timeout tests, atlas learn edge cases, and shared mock factory migration.",
    githubMilestone: 18,
  },
  {
    version: "0.7.5",
    title: "Docs Completeness",
    status: "shipped",
    summary:
      "Feature-to-docs mapping audit across 0.1.0\u20130.7.4, new guide pages for query caching and multi-tenancy, stale reference cleanup, and landing page refresh.",
    githubMilestone: 19,
  },
  {
    version: "0.8.0",
    title: "Intelligence & Learning",
    status: "shipped",
    summary:
      "Dynamic learning layer with deduplication and confidence scoring. Admin review UI, curated prompt library, query suggestion engine, self-hosted model support, and notebook-style interface.",
    githubMilestone: 9,
  },
  {
    version: "0.8.1",
    title: "Notebook Refinement",
    status: "shipped",
    summary:
      "Notebook fork/branch from any cell, drag-and-drop reorder with server persistence, markdown text cells for narrative annotation, and export to Markdown/HTML. OpenAPI codegen pipeline.",
    githubMilestone: 20,
  },
  {
    version: "0.9.0",
    title: "SaaS Infrastructure",
    status: "shipped",
    summary:
      "Platform foundation for hosted Atlas. Self-serve signup, Stripe billing, SSO/SCIM, PII detection and column masking, Chat SDK with 8 platform adapters, SLA monitoring, and automated backups.",
    githubMilestone: 21,
  },
  {
    version: "0.9.1",
    title: "Docs & Polish",
    status: "shipped",
    summary:
      "OpenAPI auto-generation migrated from 4,300 manual lines to codegen. Eight architecture refactors shipped, enterprise hardening, and react-hook-form adoption across all 26 admin pages.",
    githubMilestone: 22,
  },
  {
    version: "0.9.2",
    title: "Docs Persona Audit",
    status: "shipped",
    summary:
      "Systematic audit of all 354 docs pages for persona clarity. Reframed deployment/config and enterprise guides, relocated misplaced pages, added persona callout sections.",
    githubMilestone: 23,
  },
  {
    version: "0.9.3",
    title: "Architecture Deepening",
    status: "shipped",
    summary:
      "Route handler error wrapper eliminated 155 try-catch blocks (-852 lines). AdminContentWrapper adopted across all 30 admin pages (-302 lines). OpenAPI schema factories and shared utilities.",
    githubMilestone: 25,
  },
  {
    version: "0.9.4",
    title: "Effect.ts Migration",
    status: "shipped",
    summary:
      "Full Effect.ts adoption across the API server. Tagged error types, composable Layers, @effect/ai agent loop, native Effect SQL clients, and layer-based test setup across 36+ files.",
    githubMilestone: 26,
  },

  {
    version: "0.9.5",
    title: "Post-Effect Validation",
    status: "shipped",
    summary:
      "Comprehensive end-to-end validation after the Effect.ts migration \u2014 250 unit tests, 434 enterprise tests, 44 browser tests, and all 5 production services confirmed healthy. No regressions found.",
    githubMilestone: 27,
  },

  {
    version: "0.9.6",
    title: "SaaS Customer Experience",
    status: "shipped",
    summary:
      "Made the admin console work for paying SaaS workspace admins. Scoped settings and routes to workspaces, hid platform internals, and added self-service for API keys, integrations, billing, sandbox, custom domains, and data residency.",
    highlights: [
      "Org-context enforcement on all routes",
      "Workspace-level settings overrides",
      "Split Settings page into workspace and platform tiers",
      "API key management UI",
      "Integrations hub with Slack self-service",
      "Custom domain configuration",
      "Billing page with usage vs limits",
      "Sandbox backend selection per workspace",
      "Drizzle Kit versioned migration framework",
    ],
    githubMilestone: 28,
  },

  {
    version: "0.9.7",
    title: "SaaS-First Admin Experience",
    status: "shipped",
    summary:
      "Made app.useatlas.dev feel like a real SaaS product. Deploy mode flag, hot-reloadable settings, OAuth-first integration connect flows for 7 platforms, plugin marketplace with browse/install/configure, semantic layer web editor with autocomplete and version history, and dual-mode BYOT for self-hosted.",
    githubMilestone: 29,
  },
  {
    version: "0.9.8",
    title: "Docs & Polish",
    status: "shipped",
    summary:
      "Documentation for 0.9.7 features, integration type safety refactors, data residency region selection during signup and automated migration orchestration, periodic settings refresh for multi-instance SaaS, and deploy-validation CI for scaffold templates.",
    githubMilestone: 30,
  },
  // ── Shipped (latest) ─────────────────────────────────────
  {
    version: "1.0.0",
    title: "SaaS Launch",
    status: "shipped",
    summary:
      "Public launch of hosted Atlas at app.useatlas.dev. All launch infrastructure shipped — pricing, SLA commitments, legal pages, migration tooling, hosted user docs, 3-region deployment with cross-region data migration, pre-launch smoke testing, and competitive positioning refresh.",
    highlights: [
      "3-region deployment (US, EU, APAC) with misrouting detection and cross-region data migration",
      "SLA page with uptime guarantees, latency targets, and support tiers",
      "Terms of Service, Privacy Policy, and DPA at useatlas.dev",
      "Migration tooling — atlas export/import for self-hosted to SaaS",
      "OpenStatus integration for incident management",
      "Pre-launch smoke test — end-to-end SaaS flow validation",
      "Competitive landscape and comparison pages refreshed for 1.0",
    ],
    githubMilestone: 24,
  },
  {
    version: "1.0.1",
    title: "Post-Launch Polish",
    status: "shipped",
    summary:
      "Stabilization pass after the 1.0.0 SaaS launch. Fixed stale docs language ('coming soon', 'planned', 'not yet implemented') across 4 pages, removed outdated code TODOs, and prepared a landing zone for early user feedback.",
  },
];
