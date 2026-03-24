# Docs Persona Audit — Phase 1 Classification

**Date:** 2026-03-24
**Issue:** #847
**Milestone:** 0.9.2 — Docs Persona Audit

## Persona Definitions

| Persona | Who | What they control |
|---------|-----|-------------------|
| **End user** | Anyone querying data via Atlas chat | Chat, notebooks, MCP, sharing, scheduled tasks |
| **Workspace admin** | Enterprise customer managing their Atlas workspace | SSO, roles, billing, approval workflows, branding |
| **Platform operator** | Us — running app.useatlas.dev infrastructure | SLA monitoring, backups, abuse prevention, deployment |

Note: **Developer/integrator** (self-hosting or embedding Atlas) appears frequently in plugins/reference/deployment sections. These are classified as the closest persona match with a note.

## Summary

- **Total pages audited:** 354 (99 content + 247 API reference + 8 index/meta)
- **Pages with framing issues:** 28 content pages
- **Pages correctly framed:** 71 content pages
- **Key pattern:** SaaS enterprise features (SSO, SCIM, IP allowlist, custom roles, audit, approval) are well-framed. Self-hosted/deployment concerns bleed into user-facing guides.

---

## Content Pages

### Getting Started

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Introduction to Atlas | `index.mdx` | End user | Yes | None |
| Quick Start | `getting-started/quick-start.mdx` | End user | Yes | None — correct for self-hosted developers |
| Connect Your Data | `getting-started/connect-your-data.mdx` | End user | **No** | Self-hosted focus; SaaS customers don't set `ATLAS_DATASOURCE_URL` themselves. Connection is provisioned via admin console on SaaS |
| Concepts | `getting-started/concepts.mdx` | End user | Yes | None — audience-agnostic |
| Semantic Layer | `getting-started/semantic-layer.mdx` | End user | Yes | None |
| Demo Datasets | `getting-started/demo-datasets.mdx` | End user | Yes | None |

### Guides — End User Features

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Choosing an Integration | `guides/choosing-an-integration.mdx` | End user | Yes | None |
| MCP Server | `guides/mcp.mdx` | End user | Yes | None |
| Python Data Analysis | `guides/python.mdx` | End user | Yes | None |
| Notebook View | `guides/notebook.mdx` | End user | Yes | None |
| Guided Tour | `guides/guided-tour.mdx` | End user | Yes | None |
| Sharing Conversations | `guides/sharing-conversations.mdx` | End user | Yes | None |
| Actions Framework | `guides/actions.mdx` | Workspace admin | Yes | None — correctly frames approval modes for admins |

### Guides — Enterprise / Workspace Admin (SaaS)

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Enterprise SSO | `guides/enterprise-sso.mdx` | Workspace admin | Yes | Correctly framed with SaaS callout |
| SCIM Directory Sync | `guides/scim.mdx` | Workspace admin | Yes | Correctly framed with SaaS callout |
| IP Allowlisting | `guides/ip-allowlisting.mdx` | Workspace admin | Yes | Correctly framed with SaaS callout |
| Custom Roles | `guides/custom-roles.mdx` | Workspace admin | Yes | Correctly framed |
| Audit Log Retention | `guides/audit-retention.mdx` | Workspace admin | Yes | Correctly framed |
| Approval Workflows | `guides/approval-workflows.mdx` | Workspace admin | Yes | Correctly framed |
| Usage Metering | `guides/usage-metering.mdx` | Workspace admin | Yes | Correctly framed |
| Admin Console | `guides/admin-console.mdx` | Workspace admin | Yes | Correctly framed |
| Semantic Layer Wizard | `guides/semantic-layer-wizard.mdx` | Workspace admin | Yes | Correctly framed |
| Model Routing | `guides/model-routing.mdx` | Workspace admin | Yes | Correctly framed |
| White-Labeling | `guides/white-labeling.mdx` | Workspace admin | Yes | Correctly framed |

### Guides — Mixed/Wrong Framing

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Slack Integration | `guides/slack.mdx` | Workspace admin | **No** | Mixed audience — single-workspace section assumes admin controls Slack app creation + env vars. For SaaS, Slack app is platform operator concern |
| Scheduled Tasks | `guides/scheduled-tasks.mdx` | Workspace admin | **No** | Prerequisites say `ATLAS_SCHEDULER_ENABLED=true` — SaaS admins don't control this. Backend choice (bun/webhook/vercel) is operator concern |
| Social Login Providers | `guides/social-providers.mdx` | Workspace admin | **No** | Tells readers to "add a socialProviders block to betterAuth() call in packages/api/src/lib/auth/server.ts" — self-hosted developer work, not admin. Missing self-hosted callout |
| Self-Serve Signup | `guides/signup.mdx` | Workspace admin | **No** | Mixes SaaS signup flow with self-hosted config file editing |
| Demo Mode | `guides/demo-mode.mdx` | Platform operator | **No** | Entirely self-hosted/operator perspective (env vars, datasource selection). Not relevant to SaaS customers |
| Onboarding Emails | `guides/onboarding-emails.mdx` | Workspace admin | **No** | Prerequisites say `ATLAS_ONBOARDING_EMAILS_ENABLED=true` — not admin-controllable on SaaS. Resend config is operator concern |
| PII Detection & Masking | `guides/pii-masking.mdx` | Workspace admin | **No** | Prerequisites list "Managed auth" and "Internal database" — deployment-level concerns. SaaS feature callout present but prerequisites confusing |
| Compliance Reporting | `guides/compliance-reporting.mdx` | Workspace admin | **No** | Prerequisites mention deployment-level concerns. Should clarify who controls them |
| Billing & Plans | `guides/billing-and-plans.mdx` | Workspace admin | **No** | Mixed: admin (usage dashboard, plan changes) + platform operator (Stripe setup, webhook config, env vars). Stripe section should be separate |
| Embedding Widget | `guides/embedding-widget.mdx` | End user / Developer | **No** | Prerequisites say "Atlas API server running and accessible" — infrastructure. Conflates end users (who use widget) with developers (who install it) |
| Multi-Datasource Routing | `guides/multi-datasource.mdx` | Developer | **No** | Framed for developers configuring `atlas.config.ts` and running CLI. Not a user guide — belongs in deployment/configuration |
| Schema Evolution | `guides/schema-evolution.mdx` | Developer | **No** | Uses `atlas diff` and `atlas init` CLI. Prerequisites say "Atlas CLI installed" and "ATLAS_DATASOURCE_URL set" — developer/operator setup |
| Multi-Tenancy | `guides/multi-tenancy.mdx` | Workspace admin / Platform operator | **No** | Mixed: org-scoped semantic layers (admin) + per-org connection pooling and cache scoping (operator) |
| Query Caching | `guides/caching.mdx` | Workspace admin | **No** | Prerequisites say "Atlas server running". Config via `atlas.config.ts` and env var — operator concerns mixed with admin monitoring |
| Self-Hosted Models | `guides/self-hosted-models.mdx` | Platform operator | **No** | Operator-focused (inference server setup, deployment config). In guides section suggesting end-user relevance |
| Rate Limiting | `guides/rate-limiting.mdx` | End user / Platform operator | **No** | Two audiences: server config (`ATLAS_RATE_LIMIT_RPM`, `atlas.config.ts`) is operator; SDK retry handling is developer |
| Troubleshooting | `guides/troubleshooting.mdx` | Developer / Operator | **No** | Uses `atlas doctor`, env vars, debug logs — operations guidance, not user guide |
| Custom Domains | `guides/custom-domains.mdx` | Platform operator | **No** | Framed for "platform admin" managing domains across workspaces. Workspace admins don't control domain provisioning |
| Observability | `guides/observability.mdx` | Platform operator | **No** | Configuring OpenTelemetry collectors and log levels — infrastructure, not user guidance |

### Deployment

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Deploy | `deployment/deploy.mdx` | Platform operator | **No** | Mixes self-hosted (Docker, Railway) with SaaS (Vercel). Health checks and Docker HEALTHCHECK are operator concerns but not labeled |
| Authentication | `deployment/authentication.mdx` | Platform operator | **No** | Covers both operator setup (`ATLAS_AUTH_MODE`, `BETTER_AUTH_SECRET`) and user concerns (API key usage, JWT claims). Should split into setup (operator) and usage (end user) |

### Security

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| SQL Validation | `security/sql-validation.mdx` | End user / Platform operator | **No** | Threat model is operator-focused; validation guarantees are important for end users. Mixed without clear sections |
| Row-Level Security | `security/row-level-security.mdx` | Workspace admin / Platform operator | **No** | RLS configuration is admin concern; claim resolution and auth mode compatibility are operator concerns. Spans three personas |

### Architecture

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Sandbox Architecture | `architecture/sandbox.mdx` | Platform operator | Yes | Threat model, backend selection, resource limits — correctly operator-focused |

### Frameworks

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Bring Your Own Frontend | `frameworks/overview.mdx` | Developer | Yes | None |
| React (Vite) | `frameworks/react-vite.mdx` | Developer | Yes | None |
| Nuxt (Vue) | `frameworks/nuxt.mdx` | Developer | Yes | None |
| SvelteKit | `frameworks/sveltekit.mdx` | Developer | Yes | None |
| TanStack Start | `frameworks/tanstack-start.mdx` | Developer | Yes | None |

### Comparisons

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Atlas vs Alternatives | `comparisons/index.mdx` | End user | Yes | None |
| Atlas vs Raw MCP | `comparisons/raw-mcp.mdx` | End user | Yes | None |
| Atlas vs WrenAI | `comparisons/wrenai.mdx` | End user | Yes | None |
| Atlas vs Vanna | `comparisons/vanna.mdx` | End user | Yes | None |
| Atlas vs Metabase | `comparisons/metabase.mdx` | End user | Yes | None |

### Roadmap

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Roadmap | `roadmap.mdx` | End user | Yes | None |

### Reference

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| API Overview | `reference/api.mdx` | End user / Developer | Yes | Dual audience handled well |
| CLI Reference | `reference/cli.mdx` | Developer | Yes | None |
| Configuration | `reference/config.mdx` | Developer | Yes | None |
| Environment Variables | `reference/environment-variables.mdx` | Developer / Operator | Yes | None — deployment-time configuration |
| Error Codes | `reference/error-codes.mdx` | End user / Developer | Yes | Dual audience handled well |
| React Hooks | `reference/react.mdx` | Developer | Yes | None |
| SDK Reference | `reference/sdk.mdx` | Developer | Yes | None |

### Platform Operations

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Platform Admin Console | `platform-ops/platform-admin.mdx` | Platform operator | Yes | Cross-tenant workspace management |
| SLA Monitoring | `platform-ops/sla-monitoring.mdx` | Platform operator | Yes | None |
| Backups & DR | `platform-ops/backups.mdx` | Platform operator | Yes | None |
| Data Residency | `platform-ops/data-residency.mdx` | Platform operator | Yes | None |
| Abuse Prevention | `platform-ops/abuse-prevention.mdx` | Platform operator | Yes | None |

### Plugins

| Page | Path | Primary Persona | Framing OK? | Issues Found |
|------|------|-----------------|-------------|--------------|
| Plugin Directory | `plugins/overview.mdx` | Developer | Yes | None |
| Plugin Authoring Guide | `plugins/authoring-guide.mdx` | Developer | Yes | None |
| Plugin Cookbook | `plugins/cookbook.mdx` | Developer | Yes | None |
| Plugin Composition | `plugins/composition.mdx` | Developer | Yes | None |
| Datasource Plugins (index) | `plugins/datasources/index.mdx` | Developer | Yes | None |
| BigQuery | `plugins/datasources/bigquery.mdx` | Developer | Yes | None |
| ClickHouse | `plugins/datasources/clickhouse.mdx` | Developer | Yes | None |
| DuckDB | `plugins/datasources/duckdb.mdx` | Developer | Yes | None |
| MySQL | `plugins/datasources/mysql.mdx` | Developer | Yes | None |
| Salesforce | `plugins/datasources/salesforce.mdx` | Developer | Yes | None |
| Snowflake | `plugins/datasources/snowflake.mdx` | Developer | Yes | None |
| Sandbox Plugins (index) | `plugins/sandboxes/index.mdx` | Developer | Yes | None |
| Daytona | `plugins/sandboxes/daytona.mdx` | Developer | Yes | None |
| E2B | `plugins/sandboxes/e2b.mdx` | Developer | Yes | None |
| nsjail | `plugins/sandboxes/nsjail.mdx` | Developer | Yes | None |
| Sidecar | `plugins/sandboxes/sidecar.mdx` | Developer | Yes | None |
| Vercel Sandbox | `plugins/sandboxes/vercel-sandbox.mdx` | Developer | Yes | None |
| Interaction Plugins (index) | `plugins/interactions/index.mdx` | Developer | Yes | None |
| Chat SDK Bridge | `plugins/interactions/chat.mdx` | Developer | Yes | Very long page covering 8 platforms; consider splitting |
| Discord Bot | `plugins/interactions/discord.mdx` | Developer | Yes | Minor: Developer Portal setup could note "requires developer access" for non-developers |
| Email Digest | `plugins/interactions/email-digest.mdx` | Developer | Yes | Minor: subscription API is end-user-facing, setup is developer. Could separate sections |
| Google Chat Bot | `plugins/interactions/gchat.mdx` | Developer | Yes | None |
| GitHub Bot | `plugins/interactions/github.mdx` | Developer | Yes | None |
| Linear Bot | `plugins/interactions/linear.mdx` | Developer | Yes | None |
| MCP Server Plugin | `plugins/interactions/mcp.mdx` | Developer | Yes | None |
| Obsidian Plugin | `plugins/interactions/obsidian.mdx` | End user | Yes | Minor: requires API key from workspace admin |
| Slack Bot (deprecated) | `plugins/interactions/slack.mdx` | Developer | Yes | Deprecated, migration path provided |
| Teams Bot (deprecated) | `plugins/interactions/teams.mdx` | Developer | Yes | Deprecated, migration path provided |
| Telegram Bot | `plugins/interactions/telegram.mdx` | Developer | Yes | None |
| Webhook | `plugins/interactions/webhook.mdx` | Developer | Yes | None |
| WhatsApp Bot | `plugins/interactions/whatsapp.mdx` | Developer | Yes | None |
| Action Plugins (index) | `plugins/actions/index.mdx` | Developer | Yes | None |
| Email Action | `plugins/actions/email.mdx` | Developer | Yes | None |
| JIRA Action | `plugins/actions/jira.mdx` | Developer | Yes | None |
| Context Plugins (index) | `plugins/context/index.mdx` | Developer | Yes | None |
| YAML Context | `plugins/context/yaml-context.mdx` | Developer | Yes | None |

---

## API Reference Pages (247 pages, auto-generated)

API reference pages are auto-generated from OpenAPI spec. Classification is by endpoint group:

| API Group | # Pages | Primary Persona | Notes |
|-----------|---------|-----------------|-------|
| actions | 5 | End user | Action lifecycle (approve/deny/rollback) |
| auth | 4 | End user | Sign in/up, session management |
| chat | 1 | End user | Chat completions |
| conversations | 10 | End user | Conversation CRUD, notebook state |
| demo | 4 | End user | Demo mode endpoints |
| health | 1 | End user | Health check |
| prompts | 2 | End user | Prompt library |
| query | 1 | End user | Direct SQL query |
| scheduled-tasks | 10 | End user | Task CRUD and runs |
| semantic | 2 | End user | Semantic layer read |
| sessions | 2 | End user | Session management |
| slack | 5 | End user | Slack integration |
| suggestions | 3 | End user | Query suggestions |
| tables | 1 | End user | Table listing |
| validate-sql | 1 | End user | SQL validation |
| widget | 5 | End user | Widget loader and config |
| wizard | 4 | End user | Semantic layer wizard |
| billing | 3 | Workspace admin | Plan management, Stripe portal |
| branding | 1 | Workspace admin | Custom branding |
| onboarding | 6 | Workspace admin | Onboarding flow |
| onboarding-emails | 2 | Workspace admin | Email templates |
| admin — overview | 1 | Workspace admin | Admin dashboard |
| admin — abuse-prevention | 3 | **Platform operator** | Cross-tenant abuse detection/reinstatement |
| admin — approval-workflows | 9 | Workspace admin | Approval rules and queue |
| admin — audit | 4 | Workspace admin | Audit log queries |
| admin — audit-analytics | 5 | Workspace admin | Audit analytics |
| admin — audit-retention | 5 | Workspace admin | Retention policies |
| admin — branding | 3 | Workspace admin | Custom branding config |
| admin — compliance | 5 | Workspace admin | Compliance reports |
| admin — connections | 13 | Workspace admin | Datasource connections |
| admin — invitations | 3 | Workspace admin | User invitations |
| admin — ip-allowlist | 3 | Workspace admin | IP restrictions |
| admin — learned-patterns | 5 | Workspace admin | AI learning management |
| admin — model-config | 4 | Workspace admin | LLM model configuration |
| admin — onboarding-emails | 2 | Workspace admin | Email template config |
| admin — organizations | 8 | Workspace admin | Org management |
| admin — password | 2 | Workspace admin | Password policies |
| admin — plugins | 6 | Workspace admin | Plugin management |
| admin — prompts | 8 | Workspace admin | Prompt library management |
| admin — roles | 6 | Workspace admin | Role management |
| admin — scim | 5 | Workspace admin | SCIM provisioning |
| admin — semantic | 14 | Workspace admin | Semantic layer management |
| admin — sessions | 4 | Workspace admin | Session management |
| admin — settings | 3 | Workspace admin | Workspace settings |
| admin — sso | 7 | Workspace admin | SSO configuration |
| admin — suggestions | 2 | Workspace admin | Suggestion management |
| admin — tokens | 3 | Workspace admin | API token management |
| admin — usage | 4 | Workspace admin | Usage analytics |
| admin — users | 7 | Workspace admin | User management |
| platform-admin | 8 | Platform operator | Cross-tenant admin |
| platform-admin — backups | 7 | Platform operator | Backup management |
| platform-admin — custom-domains | 4 | Platform operator | Domain provisioning |
| platform-admin — residency | 4 | Platform operator | Data residency |
| platform-admin — sla | 7 | Platform operator | SLA monitoring |

**API reference framing note:** The admin — abuse-prevention endpoints are under the `admin` prefix but serve platform operators (cross-tenant abuse detection). Consider moving to `platform-admin` prefix for consistency, or at minimum adding a "Platform operators only" callout.

---

## Issue Summary by Category

### Category 1: Deployment/Config — Self-hosted vs SaaS framing (7 pages)
- `getting-started/connect-your-data.mdx` — SaaS customers don't set ATLAS_DATASOURCE_URL
- `deployment/deploy.mdx` — mixes self-hosted and SaaS without clear separation
- `deployment/authentication.mdx` — operator setup mixed with user auth usage
- `guides/demo-mode.mdx` — entirely self-hosted, not labeled
- `guides/social-providers.mdx` — code editing in auth server, self-hosted only
- `guides/self-hosted-models.mdx` — operator-focused, misplaced in guides
- `guides/troubleshooting.mdx` — developer/operator debugging, not user guidance

### Category 2: Enterprise features — Customer vs operator voice (8 pages)
- `guides/scheduled-tasks.mdx` — exposes feature flags and backend choice
- `guides/onboarding-emails.mdx` — exposes feature flag, Resend config
- `guides/billing-and-plans.mdx` — Stripe setup mixed with admin usage
- `guides/pii-masking.mdx` — deployment prerequisites confusing
- `guides/compliance-reporting.mdx` — deployment prerequisites confusing
- `guides/signup.mdx` — mixes SaaS and self-hosted perspectives
- `guides/slack.mdx` — Slack app creation is operator concern on SaaS
- `guides/multi-tenancy.mdx` — admin org management mixed with operator pooling

### Category 3: Reference pages — Audience clarity (2 pages)
- `security/sql-validation.mdx` — mixed operator/user without clear sections
- `security/row-level-security.mdx` — spans three personas without separation

### Category 4: Misplaced guides — Should be in deployment/operations (5 pages)
- `guides/multi-datasource.mdx` — developer config guide, not user guide
- `guides/schema-evolution.mdx` — CLI/developer operations
- `guides/caching.mdx` — operator config mixed with admin monitoring
- `guides/observability.mdx` — operator infrastructure guide
- `guides/custom-domains.mdx` — platform operator domain provisioning

### Category 5: Mixed-audience pages needing sections (4 pages)
- `guides/rate-limiting.mdx` — server config (operator) vs SDK handling (developer)
- `guides/embedding-widget.mdx` — developer setup vs end-user usage
- `guides/slack.mdx` — single-workspace vs multi-workspace deployment
- `security/row-level-security.mdx` — admin policy vs operator auth config

### Category 6: Plugin pages — Minor improvements (2 pages)
- `plugins/interactions/chat.mdx` — very long, consider splitting by platform
- `plugins/interactions/email-digest.mdx` — could separate operator setup from user API
