# Semantic Expert Agent

> Design doc for an agent that iteratively improves the semantic layer through conversation, analysis, and validated amendments. Tracks to [#1180](https://github.com/AtlasDevHQ/atlas/issues/1180).

## Problem

Atlas's semantic layer (entity YAMLs, glossary, metrics) is the foundation the agent uses to write correct SQL. Today, creating and maintaining it has two paths:

1. **`atlas init`** — profiles the database and generates a baseline semantic layer. Good for bootstrapping, but the output is mechanical: column names become descriptions, types are inferred from SQL types, and joins are guessed from naming patterns. The result is functional but shallow — it lacks business context, misses virtual dimensions, and doesn't know which measures matter.

2. **Manual editing** — users hand-edit YAML or use the web semantic editor. This produces the best results but requires deep knowledge of both the data model and the YAML format. Most users don't do this.

The gap: there is no guided path from "mechanical baseline" to "rich, accurate semantic layer." Users who run `atlas init` and stop there get mediocre agent performance. Users who invest in hand-tuning get great results but the effort is high and undiscoverable.

### What exists today

| Component | What it does | Gap |
|-----------|-------------|-----|
| `atlas init` | Profiles DB → generates YAML | No business context, shallow descriptions |
| `atlas diff` | Compares DB schema vs YAML | Reports drift, doesn't fix it |
| `atlas learn` | Analyzes audit log → proposes query patterns, joins, glossary terms | Batch-only, no data analysis, no interactive conversation |
| Learned patterns runtime | Proposes patterns from successful queries | Only captures SQL patterns, not semantic layer improvements |
| Semantic editor (web) | CRUD entities with version history | Requires manual knowledge of what to improve |
| Profiler (#1179) | Deep DB profiling (cardinality, nulls, distributions) | Output not yet connected to semantic layer improvement |

### Competitive landscape

| Product | Approach | Key mechanism | Atlas opportunity |
|---------|----------|---------------|-------------------|
| **Vanna AI** | RAG corpus of DDL + docs + SQL pairs | Auto-trains from successful queries | Atlas already has this via learned patterns. Vanna has no structured semantic layer — Atlas does. |
| **WrenAI** | Structured MDL + RAG + 4-phase pipeline | Dry-run validation + auto-correction (3 retries) | Atlas should adopt test-query validation for proposed changes |
| **Cube** | Full dev toolkit (IDE + Canvas + Copilot) | Git branching, visual modeler, semantic catalog | Atlas's semantic editor + version history is simpler but covers the same ground for our audience |
| **dbt/MetricFlow** | Metrics-as-code with 3-layer validation | Parse → semantic → platform validation in CI | Atlas should validate proposals against real data, not just syntax |
| **Metabase** | Visual models (saved queries) | Metadata enrichment via UI | No learning mechanism — Atlas can surpass this easily |

**Key insight:** No competitor has an autonomous agent that examines data distributions, identifies semantic layer gaps, and proposes validated improvements through conversation. This is Atlas's differentiator.

## Design

### Modes of Operation

The semantic expert agent operates in three modes, each building on the same core analysis engine:

#### 1. Autonomous Mode (batch analysis)

The agent examines the semantic layer and database without user interaction, produces a ranked list of proposed improvements, and writes them to a review queue.

**Trigger:** `atlas improve` CLI command or scheduled cron job.

**Flow:**
```
Profiler output (schema, cardinality, nulls, distributions, sample values)
  + Current semantic YAML (entities, glossary, metrics, catalog)
  + Audit log patterns (learned_patterns table, query frequency)
  → Analysis engine (LLM with structured output)
  → Ranked proposals (scored by impact × confidence)
  → Review queue (learned_patterns table with type='semantic_amendment')
```

**What it examines:**
- **Coverage gaps** — DB columns not represented in entity dimensions
- **Description quality** — empty or auto-generated descriptions (e.g., "The column_name column")
- **Type accuracy** — dimension types that don't match actual data (e.g., `string` for a column that's always numeric)
- **Missing measures** — aggregatable numeric columns with no defined measures
- **Missing joins** — foreign key relationships not captured in entity joins
- **Glossary gaps** — business terms used in column names but not defined in glossary
- **Sample value staleness** — declared sample values that don't appear in actual data
- **Query pattern coverage** — frequently-asked query shapes (from audit log) not captured in query_patterns
- **Virtual dimension opportunities** — common expressions in audit log SQL that should be virtual dimensions (e.g., `EXTRACT(MONTH FROM created_at)`)

#### 2. Interactive CLI Mode (conversation)

The agent engages in a multi-turn conversation, asking targeted questions and proposing amendments that the user approves inline.

**Trigger:** `atlas improve --interactive` or `atlas improve -i`

**Flow:**
```
Same analysis as autonomous mode
  → Agent identifies top improvement areas
  → Presents findings one at a time
  → Asks targeted questions ("What does 'mrr' mean in your business?")
  → User answers → agent proposes YAML diff
  → User approves/rejects/modifies → agent applies or skips
  → Loop until user exits or improvements exhausted
```

**Conversation patterns:**
- "I see `users.plan_type` has values `['free', 'pro', 'enterprise']`. What do these plans represent? This will help me write a better description."
- "The `orders` table has a `total_cents` column but no measure for total revenue. Should I add a `SUM(total_cents) / 100.0` measure called `total_revenue_dollars`?"
- "I found 47 queries in the audit log that join `orders` to `products` via `orders.product_id = products.id`, but this join isn't in the entity YAML. Want me to add it?"
- "The column `acv` appears in 12 queries but isn't in the glossary. What does ACV stand for in your business?"

#### 3. Web Interactive Mode (chat UI)

Same conversation loop as CLI mode, but rendered in the Atlas web UI with rich diff previews and one-click approval.

**Trigger:** "Improve semantic layer" button in admin, or navigating to `/admin/semantic/improve`.

**Flow:**
```
Same analysis engine
  → Chat interface (reuses existing Atlas chat component)
  → Proposals shown as rich diffs (side-by-side YAML)
  → Approve/reject buttons on each proposal
  → Applied changes visible in semantic editor + version history
```

### Agent Protocol

#### Context the agent receives

The semantic expert agent is a specialized mode of the existing Atlas agent loop. It receives an augmented system prompt with:

1. **Current semantic layer** — full YAML content of all entities, glossary, metrics, catalog (not just the compressed index)
2. **Profiler output** — from the enhanced profiler (#1179): table/column cardinality, null rates, data distributions, sample values, inferred types, foreign key candidates
3. **Audit log summary** — query frequency by table, common join patterns, popular aggregations, failed query patterns
4. **Learned patterns** — approved and pending patterns from the review queue
5. **Improvement history** — previously proposed and applied amendments (to avoid re-proposing rejected changes)

#### Tools available

The expert agent uses a **superset** of the standard agent tools, registered via a dedicated `ToolRegistry`:

| Tool | Source | Purpose |
|------|--------|---------|
| `explore` | Existing | Read semantic YAML files |
| `executeSQL` | Existing | Run test queries to validate proposals |
| `profileTable` | New | Get cardinality, nulls, distributions, sample values for a table/column |
| `proposeAmendment` | New | Propose a YAML change (structured diff) with rationale |
| `checkDataDistribution` | New | Run `SELECT column, COUNT(*) ... GROUP BY ... ORDER BY COUNT(*) DESC LIMIT 20` for a column |
| `searchAuditLog` | New | Query audit log for patterns involving specific tables/columns |
| `validateProposal` | New | Dry-run a proposed change: parse YAML, check table whitelist, run test queries |

#### New tool specifications

**`profileTable`**
```typescript
// Input
{ table: string, columns?: string[] }
// Output
{
  rowCount: number,
  columns: Array<{
    name: string,
    sqlType: string,
    nullRate: number,        // 0.0–1.0
    distinctCount: number,
    topValues: Array<{ value: string, count: number }>,  // top 10
    minValue?: string,
    maxValue?: string,
  }>
}
```

Delegates to the enhanced profiler (#1179). Subject to the same table whitelist as `executeSQL` — can only profile tables already in the semantic layer. This prevents the expert agent from exploring tables outside the declared scope.

**`proposeAmendment`**
```typescript
// Input
{
  entityName: string,
  amendmentType: "add_dimension" | "add_measure" | "add_join" | "add_query_pattern"
    | "update_description" | "update_dimension" | "add_glossary_term" | "add_virtual_dimension",
  amendment: object,          // Type-specific payload (dimension object, measure object, etc.)
  rationale: string,          // Why this change improves the semantic layer
  testQuery?: string,         // Optional SQL to validate the amendment
  confidence: number,         // 0.0–1.0, agent's confidence this is correct
}
// Output
{
  proposalId: string,
  status: "queued" | "auto_approved",  // Auto-approved if confidence >= threshold
  diff: string,                         // Unified diff of the YAML change
  testResult?: { success: boolean, rowCount: number, sampleRows: object[] },
}
```

Writes to the `learned_patterns` table with `type='semantic_amendment'` and `proposed_by='expert-agent'`. In interactive modes, the diff is shown to the user for approval before applying.

**`checkDataDistribution`**
```typescript
// Input
{ table: string, column: string, limit?: number }
// Output
{
  distinctCount: number,
  nullCount: number,
  totalCount: number,
  topValues: Array<{ value: string, count: number }>,
  dataType: string,
}
```

Generates and executes a `SELECT column, COUNT(*) ... GROUP BY column ORDER BY COUNT(*) DESC LIMIT N` query through the standard SQL validation pipeline. This is a convenience wrapper — the agent could use `executeSQL` directly, but having a dedicated tool guides the LLM toward data exploration.

**`searchAuditLog`**
```typescript
// Input
{ table?: string, column?: string, minCount?: number, since?: string }
// Output
{
  patterns: Array<{
    normalizedSql: string,
    count: number,
    lastSeen: string,
    tables: string[],
    status: "pending" | "approved" | "rejected" | "not_tracked",
  }>
}
```

Queries the `audit_log` and `learned_patterns` tables. Subject to org scoping in SaaS mode.

**`validateProposal`**
```typescript
// Input
{ proposalId: string }
// Output
{
  yamlValid: boolean,          // Parsed without errors
  whitelistValid: boolean,     // All referenced tables in whitelist
  testQueryResult?: {
    success: boolean,
    error?: string,
    rowCount?: number,
    sampleRows?: object[],
  },
  issues: string[],            // Human-readable warnings
}
```

Validation pipeline: (1) parse the amended YAML via the existing entity schema validator, (2) check that all tables/columns referenced exist in the whitelist and profiler output, (3) if the proposal includes a `testQuery`, execute it through the standard SQL pipeline and verify it returns reasonable results (non-zero rows, no errors).

#### Decision logic: what to improve

The agent uses a scoring heuristic to prioritize improvements:

```
score = impact × confidence × (1 - staleness)

impact factors:
  - Table query frequency (from audit log): high-traffic tables score higher
  - Column coverage: tables with many undocumented columns score higher
  - Description quality: auto-generated descriptions score higher than missing ones
  - Measure gaps: aggregatable columns without measures score high

confidence factors:
  - Data profiling certainty: columns with clear patterns score higher
  - Foreign key evidence: columns matching PK patterns in other tables
  - Audit log corroboration: patterns seen in actual queries

staleness factors:
  - Previously rejected proposals score lower (decay over 30 days)
  - Recently edited entities score lower (user already working on them)
```

The agent processes improvements in priority order, batching related changes (e.g., all improvements to a single entity together).

### User Experience

#### Web UI

**Entry point:** "Improve" button in the admin semantic editor sidebar, or a dedicated `/admin/semantic/improve` page.

**Layout:** Split view — chat panel on the left, live YAML diff preview on the right.

**Interaction flow:**
1. Agent starts with a summary: "I analyzed your semantic layer and found 12 improvement opportunities across 5 entities. Let's start with the highest-impact ones."
2. Each proposal is presented as a card with:
   - Entity name + amendment type badge
   - Rationale (1-2 sentences)
   - YAML diff (additions in green, removals in red)
   - Test query result (if applicable) — row count + sample data
   - Confidence score (visual meter)
   - **Approve** / **Reject** / **Edit** buttons
3. "Edit" opens the proposal in the semantic editor dialog for manual modification before applying.
4. Applied changes immediately appear in the semantic editor's version history with `author_label: "semantic-expert-agent"`.
5. Session state persists — user can leave and return to continue the review.

**Autonomous mode in web UI:**
- Admin navigates to `/admin/semantic/improve`
- Clicks "Run Analysis" to trigger autonomous mode
- Results appear as a review queue (similar to learned patterns admin page)
- Bulk approve/reject with filters by entity, amendment type, confidence

#### CLI

**`atlas improve`** (autonomous mode):
```
$ atlas improve --since 2026-03-01 --min-confidence 0.7

Analyzing semantic layer...
  ✓ Loaded 24 entities, 3 metrics, 1 glossary
  ✓ Profiled 24 tables (142 columns)
  ✓ Analyzed 1,847 audit log entries

Found 8 improvements (filtered by confidence ≥ 0.7):

1. [entity: orders] Add measure: total_revenue_dollars
   SUM(total_cents) / 100.0 — seen in 234 queries
   Confidence: 0.95

2. [entity: users] Update description: plan_type
   "The plan_type column" → "Subscription tier: free, pro, or enterprise"
   Confidence: 0.85

...

Apply all? [y/N/review]
> review

Showing diff for #1:
--- a/semantic/entities/orders.yml
+++ b/semantic/entities/orders.yml
@@ -28,6 +28,10 @@
 measures:
   - name: order_count
     sql: id
     type: count_distinct
+  - name: total_revenue_dollars
+    sql: total_cents / 100.0
+    type: sum
+    description: Total revenue in dollars (converted from cents)

Apply? [y/n/edit] y
✓ Applied. Test query: SELECT SUM(total_cents)/100.0 FROM orders → 1,247,832.50 (1 row)
```

**`atlas improve -i`** (interactive mode):
```
$ atlas improve -i

Starting interactive semantic layer improvement session...
  ✓ Loaded 24 entities, profiled 24 tables

I found several areas where your semantic layer could be improved.
Let's start with the orders entity — it's your most-queried table.

> I see the column `total_cents` but no measure for revenue.
  Should I add a SUM measure called `total_revenue_dollars`
  with `total_cents / 100.0`?

You: yes, and also add an average order value measure

> Got it. I'll add both:
  1. total_revenue_dollars = SUM(total_cents / 100.0)
  2. avg_order_value = AVG(total_cents / 100.0)

  Testing... ✓ Both measures return valid results.

  Apply these changes? [y/n/edit]
```

**CLI flags:**
- `--since DATE` — only analyze audit log entries after this date
- `--min-confidence FLOAT` — filter proposals by minimum confidence (default 0.5)
- `--entities TABLE1,TABLE2` — limit analysis to specific entities
- `--dry-run` — show proposals without applying
- `--apply` — apply all proposals above confidence threshold without prompting
- `--interactive` / `-i` — start interactive conversation mode
- `--source SOURCE` — limit to a specific data source connection

#### Admin review queue

For autonomous proposals that aren't auto-approved, the existing learned patterns admin page is extended:

- New filter: `type = "semantic_amendment"` (alongside existing `type = "query_pattern"`)
- Amendment proposals show the YAML diff inline
- Bulk approve applies all selected amendments and triggers semantic index rebuild
- Rejection records `reviewed_by` and `reviewed_at` to suppress re-proposal

### Integration Points

#### 1. Profiler (#1179)

The enhanced profiler is the primary data source for the expert agent. Its output feeds the analysis engine:

```
atlas init --profile-only    →  profiler_output.json
atlas improve                →  reads profiler_output.json (or profiles on demand)
```

**Profiler data consumed:**
- Column cardinality and null rates → informs type accuracy and description quality
- Sample values → used for `sample_values` field in entity YAML
- Foreign key candidates → informs join proposals
- Data distributions → identifies virtual dimension opportunities

If profiler output is stale (>7 days) or missing, `atlas improve` re-profiles automatically.

#### 2. Learned patterns system

The expert agent writes proposals to the same `learned_patterns` table used by `atlas learn` and the runtime pattern proposer:

```sql
-- New columns needed (backward-compatible additions)
ALTER TABLE learned_patterns ADD COLUMN type TEXT DEFAULT 'query_pattern';
-- Values: 'query_pattern' (existing), 'semantic_amendment' (new)

ALTER TABLE learned_patterns ADD COLUMN amendment_payload JSONB;
-- Structured amendment data (entity name, amendment type, YAML diff, test query, etc.)
```

This reuse means:
- The admin review UI works for both pattern proposals and semantic amendments
- Bulk approve/reject workflow is shared
- Rejection history prevents re-proposal

#### 3. Semantic editor (version history)

Applied amendments create version history entries via the existing `createVersion()` function:

```typescript
await createVersion(entityId, orgId, "entity", entityName, newYamlContent, 
  `Expert agent: ${amendment.rationale}`,  // changeSummary
  "expert-agent",                           // authorId
  "Semantic Expert Agent"                   // authorLabel
);
```

Users can see expert-agent changes in the version history timeline and rollback if needed.

#### 4. Semantic index

After amendments are applied, the semantic index is invalidated and rebuilt:

```typescript
invalidateSemanticIndex();
// Next agent query will trigger rebuild via getSemanticIndex()
```

For SaaS (org-scoped), the org's whitelist cache is also invalidated:

```typescript
invalidateOrgWhitelist(orgId);
```

#### 5. Agent system prompt

Approved semantic amendments are reflected in the agent's system prompt on the next query — the semantic index includes all entity data, so improvements are immediately available to the query agent.

### Security Considerations

- **Read-only data access** — `profileTable` and `checkDataDistribution` use the same SQL validation pipeline as `executeSQL`. The expert agent cannot write to the analytics database.
- **Table whitelist scoped** — The expert agent can only examine tables already in the semantic layer. It cannot discover or profile tables outside the declared scope.
- **Org isolation** — In SaaS mode, the expert agent is scoped to the requesting org's semantic layer and audit log. Cross-org data access is impossible.
- **Amendment review** — Autonomous proposals require admin approval unless confidence exceeds a configurable threshold (default: disabled, all proposals go to review).
- **No YAML injection** — Proposed YAML changes are generated programmatically from structured amendment objects, not from raw LLM text output. The `proposeAmendment` tool returns structured data that is serialized to YAML by the application, not by the LLM.

### Phased Implementation Plan

#### Phase 1: Autonomous Analysis Engine

**Scope:** Core analysis logic + `atlas improve` CLI (non-interactive) + review queue integration.

**Deliverables:**
- `packages/api/src/lib/semantic/expert/` — analysis engine (scoring, gap detection, proposal generation)
- `packages/api/src/lib/tools/profile-table.ts` — `profileTable` tool
- `packages/api/src/lib/tools/check-distribution.ts` — `checkDataDistribution` tool
- `packages/api/src/lib/tools/search-audit-log.ts` — `searchAuditLog` tool
- `packages/api/src/lib/tools/propose-amendment.ts` — `proposeAmendment` tool
- `packages/api/src/lib/tools/validate-proposal.ts` — `validateProposal` tool
- `packages/cli/src/commands/improve.ts` — `atlas improve` CLI command (batch mode)
- Migration: `learned_patterns` table additions (`type`, `amendment_payload` columns)
- Admin UI: extend learned patterns page with `semantic_amendment` filter + diff view

**Dependencies:** Enhanced profiler (#1179) for deep column analysis. Can use basic profiler output from `atlas init` as fallback.

#### Phase 2: Interactive CLI Mode

**Scope:** Multi-turn conversation in the terminal via `atlas improve -i`.

**Deliverables:**
- `packages/cli/lib/improve/interactive.ts` — interactive session manager (readline-based)
- `packages/api/src/lib/semantic/expert/session.ts` — conversation state management
- Expert agent system prompt template with conversation-mode instructions
- Diff rendering in terminal (colorized unified diffs)
- Inline apply/reject/edit flow

**Dependencies:** Phase 1 (analysis engine + tools).

#### Phase 3: Web Interactive Mode

**Scope:** Chat-based improvement flow in the admin UI.

**Deliverables:**
- `packages/web/src/app/admin/semantic/improve/page.tsx` — improvement chat page
- `packages/api/src/api/routes/admin-semantic-improve.ts` — streaming chat endpoint for expert agent
- Split view component (chat + live diff preview)
- Proposal card component with approve/reject/edit buttons
- Integration with semantic editor for "edit before applying" flow
- Session persistence (resume improvement sessions)

**Dependencies:** Phase 2 (conversation state management).

#### Phase 4: Scheduled Improvements

**Scope:** Periodic autonomous runs via scheduler.

**Deliverables:**
- Scheduler job definition for `atlas improve` (uses existing `Scheduler` Effect service)
- Notification on new proposals (email digest or admin notification badge)
- Dashboard widget showing semantic layer health score over time
- Auto-approval policy configuration (confidence threshold, entity scope, amendment types)

**Dependencies:** Phase 1 (autonomous analysis).

### Open Questions

1. **Auto-approval threshold** — Should high-confidence proposals (e.g., adding a clearly-missing join that appears in 100+ audit log queries) be auto-approved? Default: no, all proposals require review. Configurable via `ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD`.

2. **Profiler dependency** — Phase 1 depends on #1179 (enhanced profiler). If the profiler ships late, the expert agent can fall back to basic `INFORMATION_SCHEMA` queries, but proposals will be less confident (no cardinality/distribution data).

3. **LLM cost** — Autonomous analysis sends the full semantic layer + profiler output to the LLM, which can be token-heavy for large schemas (50+ tables). Consider chunking by entity group or using the compressed semantic index for initial triage, then full YAML for targeted improvements.

4. **Conflict resolution** — If the expert agent and a human editor both modify the same entity concurrently, version history handles it (last write wins). Should we add optimistic locking (version check on write)?
