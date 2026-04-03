# Competitive Landscape: Text-to-SQL & Agentic Analytics

> Last updated: April 2026 (1.0.0 SaaS launch)
>
> Previous versions: March 2026 (post-0.4.0 ship), February 2026 (pre-public). This revision incorporates 15 shipped milestones (0.1–1.0.0), updated competitor data, and strategic analysis for the hosted SaaS launch at app.useatlas.dev.

---

## 1. Market Context

The category is shifting from **"text-to-SQL"** → **"conversational analytics"** → **"agentic analytics"**. Gartner published a [Market Guide for Agentic Analytics](https://go.thoughtspot.com/analyst-report-gartner-market-guide-for-agentic-analytics.html) in 2026, officially recognizing this as a product category.

**Key Gartner prediction:** "By 2028, 60% of agentic analytics projects relying solely on MCP will fail due to the lack of a consistent semantic layer." This is the exact problem Atlas solves — semantic layer + agent loop, not just a raw database MCP bridge.

**Market sizing:**

- Worldwide analytic platforms: **$48.6B** (2025), 15.5% CAGR
- Agentic AI market: **$5.4B** (2024) → projected **$130B+ by 2033** (24x growth)
- AI agents specifically: **$7.6B** (2025) → **$50.3B by 2030** (MarketsAndMarkets)
- Gartner predicts **70% of analytics users** will rely on NL interfaces by 2026
- 45% of Fortune 500 are piloting agentic AI with strong preference for private-cloud deployments

---

## 2. What Atlas Is (Current State — 1.0.0 SaaS Launch)

Deploy-anywhere, open-source text-to-SQL data analyst agent. AGPL-3.0 core with MIT client libraries. TypeScript end-to-end (Hono + Next.js + Effect.ts + bun). Hosted SaaS at app.useatlas.dev.

| Capability | Implementation |
|---|---|
| Text-to-SQL agent | Multi-step reasoning via Vercel AI SDK + @effect/ai, configurable step max (default 25), explores semantic layer before writing SQL |
| Semantic layer | YAML-based entities, glossary, metrics, auto-profiled via CLI (`atlas init`), LLM enrichment, web editor with autocomplete + version history |
| Dynamic learning | `atlas learn` CLI (offline YAML proposals from audit log) + runtime `learned_patterns` DB layer with admin review/approve UI |
| 7-layer SQL security | Regex guard → AST parse → table whitelist → RLS injection → auto-LIMIT → statement timeout → read-only enforcement |
| 7 databases | PostgreSQL, MySQL, BigQuery, ClickHouse, Snowflake, DuckDB, Salesforce (via datasource plugins) |
| 6 LLM providers | Anthropic, OpenAI, Bedrock, Ollama, OpenAI-compatible (vLLM, TGI, LiteLLM), AI Gateway |
| Plugin marketplace | 21+ plugins across 5 types, browse/install/configure per workspace, Plugin SDK with `definePlugin()` |
| 5-tier sandbox isolation | Vercel Firecracker VM → nsjail → sidecar container → just-bash (OverlayFs) + BYOC plugin backends (Vercel/E2B/Daytona) |
| Python execution | Sandboxed Python with AST-based import guard, streaming output, chart rendering |
| Row-level security | Multi-column, array claims, OR-logic policies, fail-closed |
| Auth system | 4 modes: none, API key, managed (Better Auth sessions), BYOT (JWT/JWKS). Enterprise: SSO (SAML/OIDC), SCIM, custom roles, IP allowlists, approval workflows |
| Admin console | Connections, users, plugins, semantic layer editor, query analytics, learned patterns, settings (workspace + platform tiers), billing, integrations hub |
| Multi-tenancy | Better Auth org plugin, org-scoped semantic layers/connections/pools/cache, tenant isolation validated |
| Chat SDK | 8 platform adapters: Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp. Unified JSX cards, OAuth + BYOT dual-mode |
| Notebook interface | Cell-based exploratory analysis, fork/branch, drag-and-drop reorder, markdown text cells, export to Markdown/HTML |
| Embeddable widget | Script tag loader, `@useatlas/react` component, `@useatlas/sdk` with streaming, headless API |
| Conversation sharing | Public share links with OG tags + embed mode |
| Effect.ts architecture | Typed errors (Data.TaggedError), composable Layers, Context.Tag services, @effect/ai agent loop, @effect/sql native clients, runHandler bridge |
| Enterprise features (`/ee`) | SSO/SCIM, custom roles, IP allowlists, approval workflows, audit retention/export, PII detection/masking, compliance reporting, data residency, custom domains, white-labeling, SLA monitoring, backups |
| SaaS infrastructure | Self-serve signup, billing (Stripe), usage metering, onboarding wizard, demo mode, guided tour, email sequences |
| 3-region deployment | US (us-west), EU (europe-west4), APAC (asia-southeast1) with misrouting detection and region-aware ConnectionRegistry |
| Scheduled reports | Cron-based recurring queries → email, Slack, webhooks |
| MCP server | stdio + SSE transport for Claude Desktop, Cursor, etc. |
| Scaffolding | `bun create @useatlas my-app` with deploy validation CI |
| Deploy templates | Docker, Railway (production), Vercel (full-stack or headless) |
| Schema drift detection | `atlas diff` compares DB schema against semantic layer |
| Caching | LRU query result cache with org-scoped keys, configurable TTL, admin flush |
| Semantic indexing | Pre-computed inverted index, keyword-based context injection |
| Audit logging | Every query logged with user, SQL, timing, tables/columns accessed, data classification |
| OpenTelemetry | Built-in tracing + structured Pino logging |
| Prompt library | Curated per-industry question collections |
| Query suggestions | Learn from past successful queries |

**Shipped milestones:**
- 0.1.0 — Docs site, DX polish, test coverage, project hygiene
- 0.2.0 — Plugin ecosystem (18 npm packages, 15 plugins, scaffolding CLI)
- 0.3.0 — Admin console phase 2, observability, scheduled tasks
- 0.4.0 — Chat experience (theming, follow-ups, export, mobile, saved queries, schema explorer, charts)
- 0.5.0 — Embeddable widget (`@useatlas/react`), BigQuery plugin, SDK streaming, conversation sharing
- 0.5.1–0.5.4 — Agent-friendly docs (119 MDX pages), onboarding polish, UI & accessibility, SDK & integration polish
- 0.6.0 — RLS improvements (multi-column, array, OR), action approval, Teams/webhook integrations, plugin SDK enhancements (typed deps, tool hooks, custom validation)
- 0.7.0 — Multi-tenancy (Better Auth org plugin), query caching, semantic indexing, streaming Python, `atlas learn` CLI, org-scoped everything
- 0.7.1–0.7.5 — 5 point releases of type safety, error handling, test hardening, docs completeness
- 0.8.0 — Dynamic learning layer (learned_patterns DB + agent proposals + admin UI), notebook interface, prompt library, query suggestions
- 0.8.1 — Notebook refinement (fork/branch, export, text cells), OpenAPI codegen pipeline
- 0.9.0 — SaaS infrastructure: self-serve signup, billing (Stripe), SSO/SCIM, PII masking, Chat SDK (8 platforms), SLA monitoring, abuse prevention, backups, data residency, custom domains, demo mode, onboarding tour + email sequences
- 0.9.1 — Docs for all SaaS features, OpenAPI auto-gen (4,300→230 lines), enterprise hardening, 8 architecture refactors, react-hook-form migration across 26 admin pages
- 0.9.2 — Docs persona audit (354 pages classified), structural reorganization
- 0.9.3 — Architecture deepening (route error wrapper -852 lines, AdminContentWrapper -302 lines, shared factories)
- 0.9.4 — Effect.ts migration: full backend rewrite to Effect Context.Tag services, @effect/ai agent loop, @effect/sql native clients, typed errors, composable Layers
- 0.9.5 — Post-Effect validation: 250 unit tests, 434 EE tests, 44 browser tests, zero regressions
- 0.9.6 — SaaS customer experience: org-scoped routes, workspace settings, self-service API keys/integrations/billing/sandbox/residency
- 0.9.7 — Plugin marketplace (catalog + browse/install + platform admin), semantic web editor (CRUD + autocomplete + version history), OAuth connect flows (7 platforms), BYOT dual-mode, deploy validation CI
- 0.9.8 — Data residency (signup selection + migration orchestration), periodic settings refresh, docs and polish
- 1.0.0 — 3-region deployment (US/EU/APAC), misrouting detection, SLA commitments, legal pages, status page, migration tooling, social media content

---

## 3. Direct Competitors

### Tier 1: Closest competitors (open-source text-to-SQL agent + semantic layer)

| Project | Stars | What it is | Key difference from Atlas |
|---|---|---|---|
| [WrenAI](https://github.com/Canner/WrenAI) | ~9K | GenBI platform. Semantic engine + text-to-SQL + charts + dashboards | Closest competitor. Rust-based semantic engine (MDL/DataFusion), Docker-only deploy, BI-focused (dashboards, embedded analytics). More "replace Looker" than "deploy-anywhere agent." AGPL-3.0 (copyleft — restricts commercial embedding). Added air-gapped enterprise and MCP server |
| [Vanna AI](https://github.com/vanna-ai/vanna) | ~15K | Python RAG-based text-to-SQL library | Library, not a deployable product. No semantic layer on disk. RAG-based (learns from usage) vs Atlas's explicit YAML definitions. V2.0 added agent architecture and RLS. Cloud SaaS at app.vanna.ai. Python-only |
| [nao](https://github.com/getnao/nao) | ~1K | YC-backed analytics agent builder | Similar philosophy (context-first, CLI-generated semantic layer). Newer, smaller. Python-based. Less deploy flexibility |

### Tier 2: Adjacent (semantic layer platforms adding AI)

| Project | What it is | Relationship to Atlas |
|---|---|---|
| [Cube.js](https://github.com/cube-js/cube) | Semantic layer + BI platform (~19K stars) | The semantic layer standard-bearer. Recently added AI agents + MCP (D3 platform). Atlas is lighter — bundles its own YAML semantic layer rather than requiring a separate Cube deployment |
| [Evidence](https://evidence.dev) | Code-first BI (Markdown + SQL) | Different approach: static reports from SQL, not conversational agent. Complementary more than competitive |
| [Metabase](https://www.metabase.com/) | Open-source BI with AI Q&A | Established BI tool that bolted on NL querying. Much larger scope (dashboards, permissions, etc). Atlas is focused and embeddable |

### Tier 3: Different approach, same problem

| Project | What it is | Relationship to Atlas |
|---|---|---|
| [SQLCoder (Defog)](https://github.com/defog-ai/sqlcoder) | Fine-tuned LLMs for SQL generation | Model-level solution. Atlas uses general-purpose LLMs + semantic context instead of fine-tuning |
| [Chat2DB](https://github.com/chat2db/Chat2DB) | AI-powered SQL client/IDE | Desktop app for developers, not an embeddable agent for end users |
| [DB-GPT](https://github.com/eosphoros-ai/DB-GPT) | Private LLM database interaction (~18K stars) | Python microservices, AWEL operator controls. More infrastructure toolkit than product |
| [DBHub](https://github.com/bytebase/dbhub) | MCP server for databases (~2K stars) | MCP bridge only — `--readonly` mode, `--max-rows`. No semantic layer, no agent loop, no validation. Exactly what Gartner warns about |

### Tier 4: Enterprise commercial (what Atlas could grow into)

| Product | What it is |
|---|---|
| ThoughtSpot | Agentic analytics platform (recognized in Gartner 2026 Market Guide). Spotter agent |
| Databricks AI/BI | Genie — text-to-SQL built into the lakehouse |
| Looker AI (Gemini) | NL querying on LookML semantic layer. 66% accuracy improvement with semantic layer validates Atlas's approach |
| Mode / Hex | Notebook-style analytics with AI copilots |
| Tableau Pulse | Salesforce's AI analytics layer |

---

## 4. Head-to-Head Deep Dives

### Atlas vs WrenAI (closest competitor)

**Wren AI:**
- Microservices architecture (3+ containers: AI service, engine, UI)
- AGPL-3.0 license (copyleft — restricts commercial embedding)
- MDL semantic layer backed by DataFusion query engine
- Wren Cloud managed offering
- MCP server for AI client integration
- 12+ database connectors
- ~9K GitHub stars
- Built-in dashboard and chart embedding

**Atlas advantages:**
- MIT client libraries (embed freely in commercial products; server is AGPL)
- Single-process architecture (Hono server + optional frontend)
- 7-layer SQL validation (unmatched in OSS)
- 5-tier sandbox isolation (nsjail, Firecracker, sidecar, BYOC) + plugin backends
- Deploy-anywhere (Docker, Railway, Vercel — not just Docker)
- Plugin marketplace with 21+ plugins and Plugin SDK (no competitor has a composable plugin model)
- YAML-on-disk semantic layer (git-friendly, auto-generated, no Rust engine) + web editor with autocomplete and version history
- Python execution sandbox for data analysis with streaming output
- Effect.ts typed backend (structured concurrency, composable Layers, typed errors)
- 3-region deployment (US, EU, APAC) with misrouting detection and data residency
- Chat SDK with 8 platform adapters (Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp)
- Dynamic learning layer (`atlas learn` CLI + runtime learned_patterns with admin review)
- Full SaaS infrastructure: billing, SSO/SCIM, approval workflows, custom domains
- Notebook interface for exploratory analysis

**Wren AI advantages:**
- More database connectors (12+ vs 7)
- Larger community (~9K vs early-stage)
- More mature chart/dashboard generation
- Built-in BI features (embedded dashboards)
- Air-gapped enterprise deployment option

**Bottom line:** WrenAI is "replace Looker." Atlas is "embed an AI analyst anywhere." Atlas now has the complete SaaS infrastructure, enterprise features, and multi-region deployment that WrenAI lacks.

### Atlas vs Vanna AI (highest stars)

**Vanna AI:**
- Python RAG-based system — trains on historical queries, DDL, and documentation
- v2.0 introduced agent framework with RLS, audit logs, rate limiting
- Embeddable Plotly Dash component
- ~15K GitHub stars (largest community in the space)

**Atlas advantages:**
- Deterministic semantic layer vs probabilistic RAG (explicit YAML > opaque embeddings)
- `atlas learn` CLI + dynamic learning layer — curated, auditable, git-diffable semantic enrichment vs opaque vector retrieval (see section 5). Now shipped, not planned
- 7-layer SQL validation pipeline (~250+ unit tests) vs basic parameterization
- Deploy-anywhere with sandboxing vs "deploy yourself"
- No training step required — `atlas init` and you're running
- Plugin marketplace with 21+ plugins vs monolithic library
- Full production stack: auth (SSO/SCIM), admin console, billing, multi-tenancy, 3-region deployment
- Chat SDK with 8 platform adapters vs no integrations
- Notebook interface for multi-step exploratory analysis
- Effect.ts typed backend with structured concurrency and circuit breaking

**Vanna advantages:**
- ~15K stars, established Python community
- Python-native (matches data team lingua franca)
- More database connectors out of the box
- Simpler getting-started for Python notebooks

**Bottom line:** Vanna is a Python library for data scientists. Atlas is a deployable SaaS product for teams. Different buyers. On "learning," Atlas now has both `atlas learn` (offline YAML proposals from audit log) and a runtime dynamic learning layer with admin review — architecturally superior to Vanna's RAG (auditable YAML diffs vs opaque embeddings) and now shipped.

### Atlas vs Cube D3 (enterprise semantic layer adding AI)

**Cube.js:**
- Most mature OSS semantic layer (~19K stars)
- Launched D3 agentic analytics platform (June 2025)
- MCP server for AI client integration
- Enterprise pricing tier
- GraphQL/REST/SQL APIs with built-in caching engine

**Atlas advantages:**
- Agent-native from day one (not a semantic layer with an agent bolted on)
- Simpler deployment (single process vs Cube infrastructure)
- Full agent UX (chat, notebooks, follow-ups, charts, scheduled reports, 8 chat platform integrations) vs API-only
- Plugin marketplace with composable ecosystem vs database drivers only
- 3-region deployment with data residency and misrouting detection
- Semantic web editor with autocomplete and version history
- Full SaaS: billing, SSO/SCIM, custom domains, approval workflows
- No vendor lock-in, no cloud requirement for self-hosted

**Cube advantages:**
- Enterprise caching engine (pre-aggregation/materialized rollups), multi-API surface
- ~19K stars, established market presence
- More sophisticated semantic layer transforms
- Recognized in Gartner 2026 Market Guide alongside ThoughtSpot

**Bottom line:** Cube is infrastructure. Atlas is product. Different layer of the stack. Potential integration opportunity (Atlas could read Cube's semantic layer).

---

## 5. Architecture Comparisons

### Semantic Layer Approaches

| Approach | Projects | Strengths | Weaknesses |
|---|---|---|---|
| **File-based YAML** | Atlas | Version-controlled, git-friendly, auto-generated from DB, LLM-enrichable | Less powerful transforms, static at deploy time |
| **YAML + semantic learning** | Atlas (shipped) | All YAML benefits + runtime learning via curated DB layer | Requires internal DB |
| **MDL/DataFusion** | Wren AI | Query engine-backed, powerful transforms | Heavier infrastructure (3+ containers), AGPL |
| **RAG-trained** | Vanna AI | Learns from historical queries, adaptive | Probabilistic, no explicit schema model, requires training, opaque |
| **Warehouse-native** | Snowflake, Databricks | Tight integration with data platform | Vendor lock-in |
| **Cube metrics** | Cube.js | YAML-like but API-driven, production-grade caching | Enterprise pricing for advanced features |
| **dbt MetricFlow** | dbt Labs | Open standard (Apache 2.0) | Requires dbt project, heavy toolchain |

### RAG vs Semantic Learning (Atlas's approach to "getting smarter")

Vanna's RAG approach: store past queries in a vector DB, retrieve similar ones at generation time. Atlas's approach (shipped in 0.7.0 + 0.8.0): feed runtime discoveries back into the semantic layer as curated, reviewable knowledge.

| | RAG (Vanna) | Semantic learning (Atlas, shipped) |
|---|---|---|
| Storage | Vector DB of past queries | YAML files (static) + internal DB table (dynamic) |
| Retrieval | Similarity search at query time | Always loaded into agent context |
| Auditability | Opaque embeddings | `git diff` on YAML changes; admin UI for dynamic patterns |
| Quality control | Hope the retrieved examples are good | Human/LLM review before promotion |
| Philosophy | "What query worked before?" | "What does the schema actually mean?" |
| Failure mode | Retrieves wrong examples → wrong SQL | Bad pattern auto-promoted → wrong context |

**Key insight:** RAG is a crutch for a weak semantic layer. If your entity YAMLs already describe joins, patterns, and glossary, the LLM doesn't need to retrieve past queries — it has the schema knowledge directly. The gap is when the agent discovers something useful at runtime (e.g., "30% of accounts rows are test data, always filter `status != 'test'`"), that knowledge currently dies with the conversation.

**Two-phase approach (both shipped):**
1. **Phase 1 (`atlas learn` CLI, shipped 0.7.0)** — Offline batch process. Reviews audit log, proposes YAML amendments (new `query_patterns`, join discoveries, glossary refinements). Human reviews the diff, commits what's useful. Zero runtime overhead, zero DB dependency. Fits existing workflow.
2. **Phase 2 (dynamic learning layer, shipped 0.8.0)** — Runtime DB table (`learned_patterns`). Agent proposes amendments after successful queries. Low-confidence patterns sit idle; high-confidence ones (repeated N times, or admin-approved) get injected into context via context plugin. Admin console provides review/approve/delete UI.

**Architecture:**
```
Static (YAML on disk)          Dynamic (internal DB)
─────────────────────          ────────────────────
entities/*.yml                 learned_patterns table
glossary.yml                   ├── type: filter_hint | join_discovery | term_clarification | query_pattern
metrics/*.yml                  ├── content: structured JSON
catalog.yml                    ├── confidence: float
                               ├── approved: bool | null
    ↓                          └── source_conversation_id
    ↓                              ↓
    └──────── agent.ts ────────────┘
              (system prompt merges both; static wins on conflict)
```

**Open problems:**
- **Confidence scoring** — "User asks a follow-up rather than rephrasing = satisfaction signal" is shaky. Users ask follow-ups about wrong answers too. Signal extraction is the real ML problem
- **Context window pressure** — 62-entity deployments already consume significant context. Adding N learned patterns compounds this. Semantic layer indexing (pre-computed, inject relevant subset) becomes a prerequisite, not a nice-to-have
- **Auto-approval risk** — `auto_approve_threshold` means garbage patterns could auto-promote. Need a quality gate stronger than frequency

### SQL Validation Comparison

| Project | Validation Approach | Depth |
|---|---|---|
| **Atlas** | Regex → AST parse → table whitelist → RLS injection → auto-LIMIT → statement timeout → read-only. Unparseable queries **rejected**. ~250+ unit tests | **7 layers** |
| **Wren AI** | Semantic governance via MDL definitions. No AST validation documented | 1-2 layers |
| **Vanna AI** | Parameterized queries, row-level security (v2.0), audit logs | 2-3 layers |
| **DBHub** | `--readonly` mode, `--max-rows` flag | 1 layer |
| **Most others** | Basic parameterization or none | 0-1 layers |

### Deployment Models

| Project | Deployment Targets |
|---|---|
| **Atlas** | Docker, Railway, Vercel + Atlas Cloud SaaS (3 regions: US, EU, APAC) |
| **Wren AI** | Docker, Wren Cloud |
| **Vanna AI** | FastAPI (deploy yourself) |
| **Cube.js** | Docker, Cube Cloud |
| **Most Python tools** | Docker Compose only |

---

## 6. Atlas's Genuine Differentiators

What's genuinely unique — not "we do X too" but "nobody else does X":

### 1. Deploy-anywhere architecture + 3-region hosted SaaS
Docker, Railway, Vercel (Firecracker VMs), embedded in Next.js — plus a hosted SaaS at app.useatlas.dev with 3 regions (US, EU, APAC). No other OSS text-to-SQL tool has this deploy flexibility AND a hosted option. WrenAI is Docker-only + Wren Cloud. Vanna is a Python library + app.vanna.ai.

### 2. Security-first by design
7-layer SQL validation, 5-tier sandboxing, RLS (multi-column, array, OR-logic), encrypted credentials, audit logging with data classification, PII detection/masking, approval workflows. Most OSS competitors treat security as an afterthought. Atlas's validation pipeline (~250+ unit tests) is unusually rigorous for the category.

### 3. Plugin marketplace
21+ plugins, 5 types, browse/install/configure per workspace, Better Auth-inspired architecture with `$InferServerPlugin`. No other OSS text-to-SQL tool has a real plugin ecosystem with a marketplace. This is the path from "tool" to "platform."

### 4. YAML semantic layer + auto-generation + web editor + dynamic learning
`atlas init` profiles your database and generates everything. Web editor with schema-aware autocomplete and version history. `atlas learn` CLI proposes YAML amendments from audit log. Runtime learned_patterns DB layer with admin review. No competitor has this full lifecycle: auto-generate → edit in UI or code → learn from usage → human review.

### 5. Embeddable UI as pure HTTP client
The frontend has zero dependency on the backend package. This is architecturally unusual — most tools couple their UI to their server. MIT client libraries enable commercial embedding.

### 6. Chat SDK with 8 platform adapters
Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp — with unified JSX cards, OAuth connect flows, and BYOT dual-mode. No competitor offers this breadth of chat integrations.

### 7. Effect.ts typed backend
Structured concurrency, typed errors (Data.TaggedError), composable Layers, @effect/ai agent loop, @effect/sql native clients. The only text-to-SQL tool with this level of backend type safety and composability.

### 8. Full SaaS infrastructure
Self-serve signup, Stripe billing, SSO/SCIM, custom roles, IP allowlists, approval workflows, data residency, custom domains, white-labeling, SLA monitoring, abuse prevention, backups. Most OSS tools punt on SaaS infrastructure — Atlas has the complete stack.

### 9. MCP server
First-class Model Context Protocol support (stdio + SSE transport). Use Atlas as a tool inside Claude Desktop or Cursor with full semantic layer and validation.

### 10. Headless API + SDK
`POST /api/v1/query` for programmatic access, `@useatlas/sdk` with streaming. Most competitors focus on chat UI, not API-first.

### 11. TypeScript end-to-end
Hono + Next.js + Effect.ts + bun. The Python-dominated space can't match the deploy simplicity of a single-runtime TypeScript stack.

---

## 7. Honest Weaknesses

### Critical gaps

- **No adoption proof** — 15+ milestones shipped (~500+ issues), hosted SaaS launching, but zero documented public users yet. WrenAI and Vanna won on community (9K and 15K stars), not features. The SaaS launch is the adoption inflection point.

- **No chart/dashboard builder** — WrenAI has built-in visualization + dashboard embedding. Atlas has chart detection and rendering but no dashboard persistence or embedded BI features. The notebook interface partially addresses this (multi-step analysis with charts), but it's not a dashboard tool.

- **Smaller community** — Solo-dev project vs VC-backed teams (WrenAI, nao) and established Python communities (Vanna).

- **No Python SDK** — Many data teams are Python-first. Vanna and nao speak their language natively. Atlas doesn't need to rewrite in Python, but a `pip install useatlas` wrapper around the HTTP API would remove the biggest objection from the data team persona.

### Resolved since last update

- ~~No learning from usage~~ — **Shipped.** `atlas learn` CLI (offline batch YAML proposals from audit log, 0.7.0) + dynamic learning layer (runtime `learned_patterns` DB with admin review/approve UI, 0.8.0). Atlas's approach is now architecturally superior to Vanna's RAG AND shipped.

- ~~No embeddable widget~~ — **Shipped 0.5.0.** Script tag loader, `@useatlas/react`, `@useatlas/sdk` with streaming.

- ~~No BigQuery~~ — **Shipped 0.5.0.** `@useatlas/bigquery` plugin.

### Not actually weaknesses

- **No fine-tuned models** — Defog's SQLCoder achieves 96% accuracy on benchmarks, but general-purpose LLMs + semantic layer is the better long-term bet. Models improve for free; fine-tuned models need retraining.

- **TypeScript not Python** — This is a differentiator for the JS/TS audience, not a universal weakness. The right move is a Python SDK wrapper, not a rewrite.

---

## 8. The Unmentioned Threat

**General-purpose AI tools with database MCP connections.**

The biggest competitive threat isn't in the competitor table. It's Cursor, Windsurf, Claude Desktop, and similar tools connecting directly to databases via MCP servers (DBHub, etc.).

The "text-to-SQL" problem is increasingly getting solved by general-purpose AI coding tools that just connect to databases directly. A developer using Claude Desktop + a Postgres MCP server can ask data questions without Atlas.

**Why Atlas still wins this scenario:**
- **Semantic layer** — Raw MCP gives the AI no business context. It sees `dim_user_status_cd` and guesses. Atlas sees "User Status: active, churned, suspended"
- **SQL validation** — MCP servers execute whatever SQL the AI generates. Atlas validates through 7 layers
- **RLS** — No MCP bridge does row-level security
- **Non-developer access** — Data analysts, PMs, and execs can't use Cursor. Atlas gives them a chat interface
- **Governance** — Audit logs, rate limiting, sandboxing. MCP has none of this

This needs to be articulated clearly in marketing: "Atlas is what sits between your AI tools and your database so you don't get SQL injected, expose PII, or run a query that takes down production."

---

## 9. Strategic Analysis — Retrospective

> **Note (April 2026):** The recommendations in the original March 2026 version of this section were largely followed. This retrospective replaces the now-stale roadmap reordering advice.

### What was recommended and what shipped

| Recommendation | Outcome |
|---|---|
| Pull embeddable widget forward | **Shipped 0.5.0.** Script tag, React component, SDK streaming. #1 distribution mechanic |
| Pull BigQuery plugin forward | **Shipped 0.5.0.** `@useatlas/bigquery` on npm |
| Comparison pages for SEO | **Shipped with 0.5.0 launch.** 6 comparison pages in docs, now updated for 1.0 |
| Ship `atlas learn` CLI early | **Shipped 0.7.0.** Offline batch YAML proposals from audit log |
| Defer SAML/SCIM until demand | **Shipped 0.9.0** as part of SaaS infrastructure push. Correct timing — built it for the hosted product, not prematurely |
| Dynamic learning layer in 0.8 | **Shipped 0.8.0.** Runtime learned_patterns DB + admin review UI |
| Python SDK | **Not yet shipped.** Still in backlog. Lower priority now that Atlas Cloud is the primary acquisition channel |
| 3-5 documented deployments | **Partially addressed.** Demo mode + Railway production deployment. Real customer deployments are the 1.0 launch goal |

### What wasn't predicted

- **Effect.ts migration (0.9.4)** — A full backend rewrite to typed Effect services wasn't in the original roadmap. This architectural investment (23 issues, ~15 PRs) dramatically improved code quality, testability, and error handling
- **SaaS infrastructure scope (0.9.0–0.9.8)** — The hosted product required far more infrastructure than anticipated: billing, tenant provisioning, deploy mode detection, hot-reload settings, plugin marketplace, semantic web editor, OAuth connect flows, data residency, region migration, BYOT dual-mode
- **3-region deployment (1.0.0)** — Multi-region wasn't in the original roadmap. Driven by enterprise data residency requirements

### Current competitive position

Atlas has closed every "honest weakness" from the March 2026 analysis except Python SDK and adoption proof. The SaaS launch is the adoption inflection point. The remaining competitive gap is community size (WrenAI ~9K, Vanna ~15K vs early-stage Atlas), which only marketing and time can address.

---

## 10. Positioning Recommendation

### Category

**Open-source agentic analytics platform** — or more specifically: **embeddable AI data analyst agent**.

### One-liner

Atlas is the only tool where you can `bun create @useatlas my-app`, point it at a database, and have a production-ready, security-hardened, embeddable AI data analyst running on Docker/Railway/Vercel in minutes — or sign up at app.useatlas.dev and skip infrastructure entirely. Plugin marketplace, 8 chat platform integrations, 3-region deployment, and enterprise features included.

### Competitive angle (vs specific competitors)

| vs | Atlas angle |
|---|---|
| WrenAI | "AGPL core + MIT client libs for embedding. Deploy anywhere or use Atlas Cloud. Plugin marketplace, 8 chat integrations, 3-region deployment — not locked to Docker" |
| Vanna | "Deployable SaaS product, not a Python library. Auditable YAML learning with admin review, not opaque RAG retrieval. Enterprise features (SSO/SCIM/approval workflows) included" |
| Cube D3 | "Full agent UX + SaaS out of the box. Plugin marketplace, notebooks, chat integrations. No separate semantic layer infrastructure needed" |
| ThoughtSpot | "Open-source alternative. Self-hosted free (AGPL). Atlas Cloud with SLA/SSO/data residency at a fraction of the cost" |
| Raw MCP + database | "Semantic layer, 7-layer SQL validation, RLS, audit logging, sandboxing, admin console, notebooks. Everything between your AI and your database" |

### The Gartner play

The 2026 Market Guide prediction ("60% of agentic analytics projects relying solely on MCP will fail due to lack of a consistent semantic layer") is Atlas's strongest marketing asset. Frame it explicitly:

> "Gartner says MCP-only analytics will fail without a semantic layer. Atlas is the open-source solution — auto-generated semantic layer, validated SQL, deploy anywhere."

---

## 11. Key Market Trends

### Trend 1: MCP as standard
DBHub, Cube, Oracle, Snowflake have all launched MCP servers. MCP enables any AI client to query databases through a standardized protocol. But MCP without governance = the thing Gartner warns about.

**Atlas play:** Ship MCP _with_ the semantic layer and validation pipeline. Not a raw database bridge.

### Trend 2: Semantic layer becoming table stakes
- Looker reports **66% accuracy improvement** with semantic layer
- OSI (Open Semantic Interchange) standard emerging — dbt + Cube + Snowflake + ThoughtSpot collaborating
- BIRD benchmark research: semantic layer + LLM > LLM alone by **20%+**

**Atlas play:** The YAML-on-disk approach is the simplest and most portable implementation. Position as the "SQLite of semantic layers" — zero infrastructure, just files.

### Trend 3: "Agentic" replaces "conversational"
Cube D3, Vanna 2.0, ThoughtSpot Spotter all adopted the agent framing. The shift is from reactive Q&A → proactive monitoring, anomaly detection, multi-step reasoning.

**Atlas play:** The explore → SQL → report agent loop is inherently agentic. But "agentic" increasingly means proactive (scheduled reports, anomaly alerts) — Atlas has scheduled tasks but not anomaly detection yet.

### Trend 4: Deploy-anywhere gaining ground
Enterprise preference is shifting to self-hosted deployments for data compliance. 45% of Fortune 500 piloting agentic AI prefer private-cloud.

**Atlas play:** Core differentiator. Lean into it harder.

### Trend 5: Benchmark reality check
- **Spider 1.0:** ~86% accuracy (saturated)
- **Spider 2.0** (enterprise-grade): GPT-4o at **10% success rate**
- **BIRD:** More realistic, ~76% execution accuracy ceiling
- **FLEX metric** (NAACL 2025): Proposes semantic equivalence checking

**Implication:** Semantic layers and validation pipelines are critical infrastructure, not optional. Raw LLM accuracy is insufficient for production analytics.

---

## 12. Licensing Strategy

### Landscape: How comparable OSS projects monetize

| Project | License | Commercial model | Embed-friendly? |
|---|---|---|---|
| **Better Auth** | MIT | Managed infra product (dashboard, audit, security detection). $0–$299/mo SaaS tiers. Core stays fully MIT | Yes |
| **Dub** | AGPL-3.0 + `/ee` | 99% AGPL open core, 1% proprietary enterprise features in `/ee` dir. $0–$250/mo usage-based SaaS | No (AGPL copyleft) |
| **WrenAI** | AGPL-3.0 | Wren Cloud managed offering | No (AGPL copyleft) |
| **Cube.js** | Apache 2.0 (core) + proprietary (cloud) | Cube Cloud managed platform. Enterprise pricing | Yes |
| **Metabase** | AGPL-3.0 + commercial | Enterprise edition with proprietary features | No (AGPL copyleft) |
| **GitLab** | MIT (CE) + proprietary (EE) | Community Edition MIT, Enterprise Edition proprietary. The original `/ee` model | Yes (CE only) |
| **Vanna** | MIT | Vanna.AI managed offering | Yes |

### Licensing — Implemented: AGPL-3.0 + `/ee` + Atlas Cloud

> **Update (April 2026):** The licensing strategy below was the original recommendation. It was implemented with AGPL-3.0 (not MIT) for the core, which is consistent with Metabase and WrenAI. Client libraries (`@useatlas/sdk`, `@useatlas/react`, `@useatlas/types`) and plugins are MIT — preserving the embed story. The `/ee` directory is source-available under a separate commercial license. Atlas Cloud SaaS is live at app.useatlas.dev.

```
atlas/
├── packages/           # AGPL-3.0 — core agent, API, web, CLI, MCP, sandbox
├── packages/sdk        # MIT — @useatlas/sdk
├── packages/react      # MIT — @useatlas/react
├── packages/types      # MIT — @useatlas/types
├── plugins/            # MIT — community + official plugins
├── ee/                 # Commercial license — enterprise-only features
│   ├── LICENSE         # Source-available commercial license
│   ├── src/            # SSO/SCIM, PII masking, compliance reporting, SLA monitoring,
│   │                   # backups, data residency, custom domains, white-labeling,
│   │                   # approval workflows, abuse prevention
│   └── ...
├── LICENSE             # AGPL-3.0
└── ...
```

| Layer | License | What's included | Status |
|---|---|---|---|
| **Core** | AGPL-3.0 | Agent, semantic layer, CLI, plugins, admin console, auth, sandbox, MCP, notebooks, Chat SDK | Shipped |
| **Client libs** | MIT | `@useatlas/sdk`, `@useatlas/react`, `@useatlas/types`, all plugins | Shipped |
| **`/ee`** | Commercial | SSO/SCIM, custom roles, IP allowlists, approval workflows, audit retention, PII masking, compliance reporting, SLA monitoring, backups, data residency, custom domains, white-labeling | Shipped |
| **Atlas Cloud** | SaaS | Managed hosting at app.useatlas.dev, 3-region deployment, self-serve signup, Stripe billing, onboarding wizard, demo mode | Launching |

**What worked:**
1. **AGPL core + MIT client libs preserves the embed story.** Developers embed MIT client libraries in commercial products. Server stays AGPL — consistent with Metabase/WrenAI, prevents hosted competitors
2. **`/ee` is built and live.** Enterprise features shipped across 0.9.0–0.9.7: SSO/SCIM, PII masking, SLA monitoring, backups, residency, custom domains, white-labeling
3. **Atlas Cloud is the business.** app.useatlas.dev with Stripe billing, 3 regions, data residency. Self-hosted is the free tier; SaaS is the product

---

## 13. Immediate Action Items (Post-1.0 Launch)

| # | Action | Effort | Impact | Status |
|---|---|---|---|---|
| 1 | ~~Comparison pages~~ | ~~Small~~ | ~~High~~ | **Done** — 6 pages in docs, updated for 1.0 |
| 2 | ~~Embeddable widget~~ | ~~Large~~ | ~~High~~ | **Done** — Shipped 0.5.0 |
| 3 | ~~BigQuery plugin~~ | ~~Medium~~ | ~~High~~ | **Done** — Shipped 0.5.0 |
| 4 | ~~`atlas learn` CLI~~ | ~~Medium~~ | ~~High~~ | **Done** — Shipped 0.7.0 |
| 5 | ~~Semantic layer indexing~~ | ~~Large~~ | ~~Medium~~ | **Done** — Shipped 0.7.0 |
| 6 | ~~"MCP is not enough" story~~ | ~~Small~~ | ~~Medium~~ | **Done** — Dedicated comparison page + blog post section |
| 7 | Get first paying SaaS customers | Medium | Critical | Launch is imminent — conversion from demo/trial is the metric |
| 8 | Ship Python SDK wrapper (`pip install useatlas`) | Small | Medium | Still the biggest gap for data team persona |
| 9 | Publish benchmark results (Spider/BIRD) | Medium | Medium | Credibility with technical evaluators. Better now with `atlas learn` |
| 10 | Document 3-5 real deployments | Medium | High | "Used by X" is worth more than any feature. SaaS customers = case studies |

---

## 14. Sources & References

### Projects
- [Wren AI](https://github.com/Canner/WrenAI) — OSS text-to-SQL with MDL semantic layer
- [Vanna AI](https://github.com/vanna-ai/vanna) — RAG-based text-to-SQL
- [nao](https://github.com/getnao/nao) — YC-backed analytics agent builder
- [Dataherald](https://github.com/Dataherald/dataherald) — Enterprise text-to-SQL with evaluator
- [DB-GPT](https://github.com/eosphoros-ai/DB-GPT) — Private LLM database interaction
- [SQL Chat](https://github.com/sqlchat/sqlchat) — Chat-based SQL client
- [DBHub](https://github.com/bytebase/dbhub) — MCP server for databases
- [Cube.js](https://github.com/cube-js/cube) — Semantic layer + headless BI
- [MindsDB](https://github.com/mindsdb/mindsdb) — Federated AI query engine
- [Evidence](https://github.com/evidence-dev/evidence) — Code-first analytics
- [SQLCoder / Defog](https://github.com/defog-ai/sqlcoder) — Fine-tuned SQL models
- [Chat2DB](https://github.com/chat2db/Chat2DB) — AI SQL client/IDE

### Market Reports
- [Gartner Market Guide for Agentic Analytics (2026)](https://go.thoughtspot.com/analyst-report-gartner-market-guide-for-agentic-analytics.html)
- [Gartner Top Trends in Data & Analytics 2025](https://www.gartner.com/en/newsroom/press-releases/2025-03-03-gartner-identifies-top-trends-in-data-and-analytics-for-2025)
- [Forrester AI Predictions 2026](https://www.biia.com/forrester-predictions-2026-ai-agents-changing-business-models-and-workplace-culture-impact-enterprise-software/)
- [Agentic AI Market — MarketsAndMarkets](https://www.marketsandmarkets.com/Market-Reports/agentic-ai-market-208190735.html)
- [Deloitte: Agentic AI Reality Check](https://www.deloitte.com/us/en/insights/topics/technology-management/tech-trends/2026/agentic-ai-strategy.html)

### Semantic Layer
- [Semantic Layer Architectures 2025 — Typedef](https://www.typedef.ai/resources/semantic-layer-architectures-explained-warehouse-native-vs-dbt-vs-cube)
- [Cube D3 Launch — HPCwire](https://www.hpcwire.com/bigdatawire/this-just-in-cube-launches-d3-the-first-agentic-analytics-platform-built-on-a-universal-semantic-layer/)
- [Why Semantic Layer Is Essential — Wren AI](https://www.getwren.ai/post/why-the-semantic-layer-is-essential-for-reliable-text-to-sql-and-how-wren-ai-brings-it-to-life)
- [Headless vs Native Semantic Layer — VentureBeat](https://venturebeat.com/ai/headless-vs-native-semantic-layer-the-architectural-key-to-unlocking-90-text)

### Benchmarks
- [BIRD Benchmark](https://bird-bench.github.io/)
- [Spider 2.0](https://spider2-sql.github.io/)
- [FLEX Metric Paper — NAACL 2025](https://aclanthology.org/2025.naacl-long.228.pdf)
- [Top Text-to-SQL Tools 2026 — Bytebase](https://www.bytebase.com/blog/top-text-to-sql-query-tools/)

### MCP
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Cube MCP Server](https://cube.dev/blog/unlocking-universal-data-access-for-ai-with-anthropics-model-context)
- [Oracle MCP Server](https://blogs.oracle.com/database/introducing-mcp-server-for-oracle-database)
- [Snowflake MCP](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp)

### Licensing & Business Model References
- [Better Auth](https://github.com/better-auth/better-auth) — MIT core + [managed infra product](https://better-auth.com/products/infrastructure) ($0–$299/mo)
- [Dub](https://github.com/dubinc/dub) — AGPL-3.0 core + proprietary `/ee` directory + [SaaS tiers](https://dub.co/pricing) ($0–$250/mo)
- [GitLab](https://about.gitlab.com/install/ce-or-ee/) — MIT CE + proprietary EE (the original `/ee` model)
- [HashiCorp BSL Switch](https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license) — Cautionary tale of MIT → BSL relicensing
- [Elastic SSPL Switch](https://www.elastic.co/blog/why-license-change-aws) — Cautionary tale of Apache 2.0 → SSPL relicensing
