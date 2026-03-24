# Competitive Landscape: Text-to-SQL & Agentic Analytics

> Last updated: March 2026 (post-0.4.0 ship)
>
> Previous version: February 2026 (pre-public). This revision incorporates shipped milestones (0.1–0.4), updated competitor data, and strategic analysis against the current roadmap.

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

## 2. What Atlas Is (Current State — Post-0.4.0)

Deploy-anywhere, open-source text-to-SQL data analyst agent. MIT-licensed. TypeScript end-to-end (Hono + Next.js + bun).

| Capability | Implementation |
|---|---|
| Text-to-SQL agent | Multi-step reasoning via Vercel AI SDK, 25-step max, explores semantic layer before writing SQL |
| Semantic layer | YAML-based entities, glossary, metrics, auto-profiled via CLI (`atlas init`), optional LLM enrichment |
| 7-layer SQL security | Regex guard → AST parse → table whitelist → RLS injection → auto-LIMIT → statement timeout → read-only enforcement |
| 6 databases | PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, Salesforce (via datasource plugins) |
| 5 LLM providers | Anthropic, OpenAI, Bedrock, Ollama, AI Gateway |
| Plugin SDK | 15 plugins across 5 types (datasource, context, interaction, action, sandbox) with Better Auth-inspired architecture |
| 5-tier sandbox isolation | Vercel Firecracker VM → nsjail → sidecar container → just-bash (OverlayFs) + plugin backends |
| Python execution | Sandboxed Python with AST-based import guard for data analysis/visualization |
| Row-level security | JWT claim-based WHERE injection, fail-closed, applied after plugin hooks |
| Auth system | 4 modes: none, API key, managed (Better Auth sessions), BYOT (JWT/JWKS) |
| Admin console | Connections, users, plugins, semantic layer browser, query analytics, settings |
| Scheduled reports | Cron-based recurring queries → email, Slack, webhooks |
| Slack integration | Slash commands, threaded follow-ups, OAuth multi-workspace |
| MCP server | stdio transport for Claude Desktop, Cursor, etc. |
| TypeScript SDK | `createAtlasClient()` for programmatic access |
| Headless API | `POST /api/v1/query` for JSON responses (no UI needed) |
| Embeddable UI | Pure HTTP client, works with React/Next/Nuxt/Svelte/etc. |
| Scaffolding | `bun create atlas-agent my-app` |
| Deploy templates | Docker, Railway, Vercel (full-stack or headless) |
| Schema drift detection | `atlas diff` compares DB schema against semantic layer |
| Audit logging | Every query logged with user, SQL, timing |
| OpenTelemetry | Built-in tracing + structured Pino logging |

**Shipped milestones:**
- 0.1.0 — Docs site, DX polish, test coverage, project hygiene
- 0.2.0 — Plugin ecosystem (18 npm packages, 15 plugins, scaffolding CLI)
- 0.3.0 — Admin console phase 2, observability, scheduled tasks
- 0.4.0 — Chat experience (theming, follow-ups, export, mobile, saved queries, schema explorer, charts)

---

## 3. Direct Competitors

### Tier 1: Closest competitors (open-source text-to-SQL agent + semantic layer)

| Project | Stars | What it is | Key difference from Atlas |
|---|---|---|---|
| [WrenAI](https://github.com/Canner/WrenAI) | ~8K | GenBI platform. Semantic engine + text-to-SQL + charts + dashboards | Closest competitor. Java-based semantic engine (MDL), Docker-only deploy, BI-focused (dashboards, embedded analytics). More "replace Looker" than "deploy-anywhere agent." AGPL-3.0 (copyleft — restricts commercial embedding) |
| [Vanna AI](https://github.com/vanna-ai/vanna) | ~13K | Python RAG-based text-to-SQL library | Library, not a deployable product. No semantic layer on disk. RAG-based (learns from usage) vs Atlas's explicit YAML definitions. V2.0 added agent architecture and RLS. Python-only |
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
- ~8K GitHub stars
- Built-in dashboard and chart embedding

**Atlas advantages:**
- MIT license (embed freely in commercial products)
- Single-process architecture (Hono server + optional frontend)
- 7-layer SQL validation (unmatched in OSS)
- 5-tier sandbox isolation (nsjail, Firecracker, sidecar, etc.)
- Deploy-anywhere (Docker, Railway, Vercel — not just Docker)
- Plugin SDK with 15 plugins (no competitor has a composable plugin model)
- YAML-on-disk semantic layer (git-friendly, auto-generated, no Java engine)
- Python execution sandbox for data analysis

**Wren AI advantages:**
- More database connectors (12+ vs 6)
- Larger community (~8K vs early-stage)
- More mature chart/dashboard generation
- Built-in BI features (embedded dashboards)

**Bottom line:** WrenAI is "replace Looker." Atlas is "embed an AI analyst anywhere." The AGPL license is a significant commercial constraint for WrenAI users.

### Atlas vs Vanna AI (highest stars)

**Vanna AI:**
- Python RAG-based system — trains on historical queries, DDL, and documentation
- v2.0 introduced agent framework with RLS, audit logs, rate limiting
- Embeddable Plotly Dash component
- ~13K GitHub stars (largest community in the space)

**Atlas advantages:**
- Deterministic semantic layer vs probabilistic RAG (explicit YAML > opaque embeddings)
- Planned semantic learning approach is architecturally superior — curated, auditable, git-diffable vs opaque vector retrieval (see section 5)
- 7-layer SQL validation pipeline (~103 unit tests) vs basic parameterization
- Deploy-anywhere with sandboxing vs "deploy yourself"
- No training step required — `atlas init` and you're running
- Plugin SDK for extensibility vs monolithic library

**Vanna advantages:**
- 13K stars, established Python community
- Already learns from organizational patterns (Atlas's learning is planned, not shipped)
- Python-native (matches data team lingua franca)

**Bottom line:** Vanna is a Python library for data scientists. Atlas is a deployable product for teams. Different buyers. On "learning," the approaches are philosophically different: Vanna asks "what query worked before?" (RAG retrieval), Atlas will ask "what does the schema actually mean?" (semantic enrichment). Atlas's approach is better long-term but Vanna has the head start of it actually working today.

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
- Full agent UX (chat, follow-ups, charts, scheduled reports) vs API-only
- No vendor lock-in, no cloud requirement

**Cube advantages:**
- Enterprise caching engine, multi-API surface
- 19K stars, established market presence
- More sophisticated semantic layer transforms

**Bottom line:** Cube is infrastructure. Atlas is product. Different layer of the stack. Potential integration opportunity (Atlas could read Cube's semantic layer).

---

## 5. Architecture Comparisons

### Semantic Layer Approaches

| Approach | Projects | Strengths | Weaknesses |
|---|---|---|---|
| **File-based YAML** | Atlas | Version-controlled, git-friendly, auto-generated from DB, LLM-enrichable | Less powerful transforms, static at deploy time |
| **YAML + semantic learning** | Atlas (planned) | All YAML benefits + runtime learning via curated DB layer | Not yet built; requires internal DB |
| **MDL/DataFusion** | Wren AI | Query engine-backed, powerful transforms | Heavier infrastructure (3+ containers), AGPL |
| **RAG-trained** | Vanna AI | Learns from historical queries, adaptive | Probabilistic, no explicit schema model, requires training, opaque |
| **Warehouse-native** | Snowflake, Databricks | Tight integration with data platform | Vendor lock-in |
| **Cube metrics** | Cube.js | YAML-like but API-driven, production-grade caching | Enterprise pricing for advanced features |
| **dbt MetricFlow** | dbt Labs | Open standard (Apache 2.0) | Requires dbt project, heavy toolchain |

### RAG vs Semantic Learning (Atlas's approach to "getting smarter")

Vanna's RAG approach: store past queries in a vector DB, retrieve similar ones at generation time. Atlas's planned approach: feed runtime discoveries back into the semantic layer as curated, reviewable knowledge.

| | RAG (Vanna) | Semantic learning (Atlas, planned) |
|---|---|---|
| Storage | Vector DB of past queries | YAML files (static) + internal DB table (dynamic) |
| Retrieval | Similarity search at query time | Always loaded into agent context |
| Auditability | Opaque embeddings | `git diff` on YAML changes; admin UI for dynamic patterns |
| Quality control | Hope the retrieved examples are good | Human/LLM review before promotion |
| Philosophy | "What query worked before?" | "What does the schema actually mean?" |
| Failure mode | Retrieves wrong examples → wrong SQL | Bad pattern auto-promoted → wrong context |

**Key insight:** RAG is a crutch for a weak semantic layer. If your entity YAMLs already describe joins, patterns, and glossary, the LLM doesn't need to retrieve past queries — it has the schema knowledge directly. The gap is when the agent discovers something useful at runtime (e.g., "30% of accounts rows are test data, always filter `status != 'test'`"), that knowledge currently dies with the conversation.

**Two-phase approach:**
1. **Phase 1 (`atlas learn` CLI)** — Offline batch process. Reviews audit log, proposes YAML amendments (new `query_patterns`, join discoveries, glossary refinements). Human reviews the diff, commits what's useful. Zero runtime overhead, zero DB dependency. Fits existing workflow.
2. **Phase 2 (dynamic learning layer)** — Runtime DB table (`learned_patterns`). Agent proposes amendments after successful queries. Low-confidence patterns sit idle; high-confidence ones (repeated N times, or admin-approved) get injected into context via context plugin. Admin console provides review/approve/delete UI.

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
| **Atlas** | Regex → AST parse → table whitelist → RLS injection → auto-LIMIT → statement timeout → read-only. Unparseable queries **rejected**. ~103 unit tests | **7 layers** |
| **Wren AI** | Semantic governance via MDL definitions. No AST validation documented | 1-2 layers |
| **Vanna AI** | Parameterized queries, row-level security (v2.0), audit logs | 2-3 layers |
| **DBHub** | `--readonly` mode, `--max-rows` flag | 1 layer |
| **Most others** | Basic parameterization or none | 0-1 layers |

### Deployment Models

| Project | Deployment Targets |
|---|---|
| **Atlas** | Docker, Railway, Vercel (3 targets, 2 example templates) |
| **Wren AI** | Docker, Wren Cloud |
| **Vanna AI** | FastAPI (deploy yourself) |
| **Cube.js** | Docker, Cube Cloud |
| **Most Python tools** | Docker Compose only |

---

## 6. Atlas's Genuine Differentiators

What's genuinely unique — not "we do X too" but "nobody else does X":

### 1. Deploy-anywhere architecture
Docker, Railway, Vercel (Firecracker VMs), embedded in Next.js. No other OSS text-to-SQL tool has this deploy flexibility. WrenAI is Docker-only. Vanna is a Python library. nao is early.

### 2. Security-first by design
7-layer SQL validation, 5-tier sandboxing, RLS, encrypted credentials, audit logging. Most OSS competitors treat security as an afterthought. Atlas's validation pipeline (~103 unit tests) is unusually rigorous for the category.

### 3. Plugin SDK
15 plugins, 5 types, Better Auth-inspired architecture with `$InferServerPlugin`. No other OSS text-to-SQL tool has a real plugin ecosystem. This is the path from "tool" to "platform."

### 4. YAML semantic layer + auto-generation
`atlas init` profiles your database and generates everything. WrenAI has a similar concept (MDL) but it's a Java engine. Atlas keeps it dead simple: YAML files on disk, cat-able, git-diffable, no runtime dependency.

### 5. Embeddable UI as pure HTTP client
The frontend has zero dependency on the backend package. This is architecturally unusual — most tools couple their UI to their server.

### 6. MCP server
First-class Model Context Protocol support. Use Atlas as a tool inside Claude Desktop or Cursor.

### 7. Headless API + SDK
`POST /api/v1/query` for programmatic access. Most competitors focus on chat UI, not API-first.

### 8. TypeScript end-to-end
Hono + Next.js + bun. The Python-dominated space can't match the deploy simplicity of a single-runtime TypeScript stack.

---

## 7. Honest Weaknesses

### Critical gaps

- **No adoption proof** — 4 milestones shipped (~180+ issues), zero documented public users. WrenAI and Vanna won on community (8K and 13K stars), not features. Features don't matter if nobody knows you exist.

- **No learning from usage (yet)** — Vanna 2.0 learns from organizational patterns via RAG. Atlas relies on the static semantic layer. However, this is a planned differentiator, not just a gap — see "RAG vs Semantic Learning" in section 5. The planned approach (curated semantic enrichment from runtime discoveries) is architecturally superior to RAG, but it's not built yet. Phase 1 (`atlas learn` CLI, offline batch review of audit log → YAML diffs) is low-effort and could ship early. Phase 2 (dynamic DB layer with admin review) is post-v1.0.

- **No chart/dashboard builder** — WrenAI has built-in visualization + dashboard embedding. Atlas has chart detection and rendering but no dashboard persistence or embedded BI features.

- **Smaller community** — Solo-dev project vs VC-backed teams (WrenAI, nao) and established Python communities (Vanna).

- **No Python SDK** — Many data teams are Python-first. Vanna and nao speak their language natively. Atlas doesn't need to rewrite in Python, but a `pip install useatlas` wrapper around the HTTP API would remove the biggest objection from the data team persona.

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

## 9. Strategic Analysis Against Roadmap

### Current roadmap order

0.5 Governance & Sharing → 0.6 Embeddable & Integrations → 0.7 Performance & Scale → 0.8 Intelligence & Learning

### Recommendation: Reorder for adoption, not enterprise readiness

**Problem:** The roadmap optimizes for enterprise features (RLS improvements, SAML, session management) before solving the adoption problem. You're building governance for users who don't exist yet.

**Proposed reorder:**

#### Pull forward (adoption accelerators)

1. **Embeddable widget** (from 0.6) — The `<script>` tag embed + `streamQuery()` SDK is the best distribution mechanic. Every developer embedding Atlas becomes a distribution channel. Vanna can't do this (Python library). WrenAI's embed is tied to their dashboard model. This is Atlas's lane.

2. **BigQuery plugin** (from 0.7) — Most-requested missing source. GCP shops are a large segment. `node-sql-parser` already supports BigQuery dialect. High-signal, low-effort.

3. **Python SDK** (not on roadmap) — `pip install useatlas`, thin wrapper around the HTTP API. Weekend project. Removes the biggest objection from the data team persona without rewriting anything.

4. **Comparison pages** (not on roadmap) — "Atlas vs WrenAI vs Vanna" on the docs site. People search for these. Direct SEO value.

5. **3-5 documented deployments** — Even if they're your own projects or friends' companies. "Used by X" is worth more than any feature.

#### Defer (serve existing enterprise customers you don't have)

- RLS improvements (multi-column, array claims) — current RLS is functional
- Session management (list/revoke) — premature without enterprise users
- SAML/SCIM — explicitly wait until demand
- Audit log CSV export — nice-to-have, not adoption-driving

#### Keep as-is

- Conversation sharing (0.5) — good adoption feature, people share interesting query results
- Semantic layer diff in UI (0.5) — supports the admin console story
- Query result caching (0.7) — important for scale but not for initial adoption

#### Reshape "Intelligence & Learning" (0.8)

The original 0.8 lumps together prompt libraries, learning, multi-agent, and SAML/SCIM. The semantic learning conversation reveals two distinct features that should ship at different times:

- **`atlas learn` CLI (Phase 1)** — Pull into 0.5 or 0.6. Offline batch process: review audit log, propose YAML amendments, human reviews diff. Zero runtime overhead, no DB dependency, fits existing YAML workflow. This gives Atlas the "gets smarter over time" story without any runtime complexity. Low effort, high narrative value.

- **Dynamic learning layer (Phase 2)** — Keep in 0.8. Requires internal DB, admin UI for review/approve, context plugin injection, confidence scoring. This is where the hard problems live (signal extraction, context window pressure, auto-approval risk). Only worth building after there's query volume to learn from.

### Net effect

The reordered sequence would be roughly:

1. **0.5.0 — Distribution** (embeddable widget, BigQuery, Python SDK, comparison docs, conversation sharing, `atlas learn` CLI)
2. **0.6.0 — Governance** (RLS improvements, audit enhancements, session management)
3. **0.7.0 — Performance** (caching, semantic layer indexing*, connection pooling, streaming Python)
4. **0.8.0 — Intelligence** (dynamic learning layer, prompt library, multi-agent, SAML/SCIM)

*Semantic layer indexing (0.7) becomes a prerequisite for the dynamic learning layer (0.8) — you can't add more context until you're smarter about injecting less.

---

## 10. Positioning Recommendation

### Category

**Open-source agentic analytics platform** — or more specifically: **embeddable AI data analyst agent**.

### One-liner

Atlas is the only tool where you can `bun create atlas-agent my-app`, point it at a database, and have a production-ready, security-hardened, embeddable AI data analyst running on Docker/Railway/Vercel in minutes — with a plugin SDK for extensibility.

### Competitive angle (vs specific competitors)

| vs | Atlas angle |
|---|---|
| WrenAI | "MIT-licensed, deploy-anywhere, embeddable. Not locked to Docker + AGPL" |
| Vanna | "Deployable product, not a Python library. Curated semantic knowledge, not opaque RAG retrieval" |
| Cube D3 | "Full agent UX out of the box. No separate semantic layer infrastructure needed" |
| ThoughtSpot | "Open-source alternative. Self-hosted. MIT-licensed. $0/year" |
| Raw MCP + database | "Semantic layer, SQL validation, RLS, audit logging, sandboxing. Everything between your AI and your database" |

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

### Why AGPL is wrong for Atlas

Dub and WrenAI use AGPL. For a link shortener (Dub) this works — nobody embeds a link shortener, they use the SaaS. For WrenAI it's a competitive weakness that Atlas should exploit.

Atlas's embeddable widget strategy (`<script>` tag, React component, iframe isolation) is the #1 distribution mechanic. Under AGPL, any application embedding Atlas's chat component would arguably need to be AGPL-compatible. This kills adoption in commercial products — the exact audience Atlas wants.

### Why Apache 2.0 + CLA is unnecessary

The instinct is: "MIT is too permissive, what if AWS offers Managed Atlas?" But:

1. **Better Auth proves MIT works.** They're MIT with no CLA, shipping a managed infra product. Nobody is offering "Managed Better Auth" because the managed experience is a product, not just the OSS in a container
2. **CLA adds contributor friction.** Every PR requires a legal agreement. For a project trying to grow from zero contributors, this is the wrong trade-off
3. **Premature optimization.** If Atlas gets big enough for AWS to clone it, that's a success problem. The threat today is obscurity, not exploitation
4. **Relicensing is a last resort, not a plan.** HashiCorp, Elastic, and MongoDB all relicensed under pressure. It worked, but it burned community goodwill. Better to never need it

### Recommendation: MIT + `/ee` + managed product

The Better Auth model with Dub's `/ee` pattern:

```
atlas/
├── packages/           # MIT — all agent functionality, plugins, CLI, embeddable UI
├── plugins/            # MIT — community + official plugins
├── ee/                 # Commercial license — enterprise-only features
│   ├── LICENSE         # Proprietary (or source-available like Elastic License 2.0)
│   ├── sso/            # SAML/SCIM providers
│   ├── audit-pro/      # Advanced audit (export, retention, compliance)
│   ├── multi-tenant/   # Tenant-scoped semantic layers, isolation
│   └── analytics-pro/  # Usage dashboards, cost tracking, SLA monitoring
├── LICENSE             # MIT
└── ...
```

**How it works:**

| Layer | License | What's included | When to build |
|---|---|---|---|
| **Core** | MIT | Agent, semantic layer, CLI, plugins, embeddable UI, admin console, auth, sandbox, MCP, SDK. Everything Atlas does today | Now (already done) |
| **`/ee`** | Commercial (source-available) | SAML/SCIM, advanced audit, multi-tenant isolation, usage analytics, SLA monitoring | When enterprise customers ask for it |
| **Atlas Cloud** | SaaS | Managed hosting, onboarding wizard, semantic layer management UI, monitoring, support/SLA | When there's enough adoption to justify it |

**Why this works for Atlas specifically:**

1. **MIT core preserves the embed story.** Developers embed Atlas in commercial products freely. This is the distribution advantage over WrenAI (AGPL)
2. **`/ee` creates a monetization path without relicensing.** You own the `/ee` code outright — no CLA needed for community contributions to the MIT core
3. **Enterprise features are naturally separable.** SAML, SCIM, advanced audit, multi-tenant — these are discrete modules that don't touch the core agent loop. They're additive, not subtractive
4. **No community goodwill risk.** The MIT core never changes license. Enterprise features were always commercial. Nobody feels bait-and-switched
5. **The managed product is the real business.** `/ee` is a hedge; Atlas Cloud (managed hosting with ops, monitoring, SLA) is where the actual revenue would come from. Better Auth's infra product at $299/mo for audit logs and monitoring is the template

**What NOT to do:**

- Don't create `/ee` now. There are no enterprise customers. Build it when someone asks for SAML and is willing to pay
- Don't add a CLA. It signals "we might relicense" and adds friction for zero benefit at this stage
- Don't restrict any current functionality. Everything shipped through 0.4.0 stays MIT forever
- Don't overthink this. The license decision matters less than getting 100 users. Ship features, not legal structures

---

## 13. Immediate Action Items

Prioritized by impact-to-effort ratio:

| # | Action | Effort | Impact | Why |
|---|---|---|---|---|
| 1 | Write "Atlas vs WrenAI vs Vanna" comparison page | Small | High | Direct SEO for people evaluating tools |
| 2 | Ship Python SDK wrapper (`pip install useatlas`) | Small | High | Removes biggest objection from data teams |
| 3 | Get 3-5 real deployments documented | Medium | High | "Used by X" is worth more than any feature |
| 4 | Pull embeddable widget into next milestone | Large | High | Best distribution mechanic Atlas has |
| 5 | Pull BigQuery plugin into next milestone | Medium | High | Most-requested missing source |
| 6 | Build `atlas learn` CLI (Phase 1 learning) | Medium | High | "Gets smarter over time" narrative without runtime complexity. Reviews audit log, proposes YAML diffs. Directly counters "Atlas doesn't learn" weakness |
| 7 | Articulate the "MCP is not enough" story | Small | Medium | Gartner-backed positioning against raw MCP tools |
| 8 | Publish benchmark results (Spider/BIRD) | Medium | Medium | Credibility with technical evaluators |
| 9 | Build semantic layer indexing | Large | Medium | Prerequisite for dynamic learning (Phase 2). Also improves token efficiency for large deployments |

---

## 13. Sources & References

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
