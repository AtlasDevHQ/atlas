# ADR-0022: Cross-group reach — the agent queries across all Connection groups by default; cross-source answers via LLM composition, not federation

**Status:** Accepted
**Date:** 2026-06-22
**Milestone:** — (design from [#3868](https://github.com/AtlasDevHQ/atlas/issues/3868), Architecture Backlog; implementation PRD + slices to follow)
**Supersedes:** [ADR-0011](./0011-unified-conversation-scope.md)'s "SQL routing binds exactly one active Connection group per conversation." ADR-0011's Conversation-scope umbrella, REST scope (exclude-set + focus), and per-conversation-authoritative model are retained and extended; only the single-active-group SQL-routing default is replaced.
**Builds on:** [ADR-0010](./0010-rest-datasource-environment-scoping.md) (REST workspace-global-by-default), [ADR-0011](./0011-unified-conversation-scope.md) (Conversation scope), [ADR-0012](./0012-group-scoped-semantic-layer-directories.md) (group-scoped semantic layer)
**Issue:** [#3868](https://github.com/AtlasDevHQ/atlas/issues/3868)

## Context

The connection-environment model was designed when a workspace had **one datasource** (Postgres). A workspace now holds many heterogeneous datasources (Postgres, MySQL, ClickHouse, Elasticsearch, Snowflake, plus REST datasources like Stripe). Two facts revealed the model is inverted from what users want:

1. **The #3253 multi-engine staging soak** had to *hack* heterogeneous engines (ClickHouse, Elasticsearch) into a single `config.group_id` via psql to make them appear in the picker — forcing different-schema datasources into the homogeneous-**Member** model (Members "share a schema," per CONTEXT.md), which they do not.
2. **#3867(b):** the picker showed `mysql-staging` but the agent still cross-routed to ClickHouse on a failure — a *soft middle state*. We almost filed it as a bug; it is actually closer to the intended default. That is the tell: the model needs rethinking, not patching.

The desired end state, from the #3868 grill: a user asks a question and the agent **figures out which of the workspace's datasources hold the answer**, queries them (possibly several), and composes the answer — cross-datasource is the *default*, not an exception.

This exposes an asymmetry: **REST scope already defaults to "all REST datasources in scope"** (ADR-0010/0011), while **SQL routing binds to exactly one active Connection group.** SQL is the outlier; this ADR makes SQL reach behave like REST reach already does.

## Decision

Five sub-decisions, all confirmed in the #3868 grill (2026-06-22).

### 1. SQL reach defaults to all Connection groups (the agent ranges cross-group)

The agent's default analytical surface is **every visible Connection group** in the workspace (within content-mode / RLS / whitelist scope), not one active group. **SQL reach** is a new axis *above* member routing; member routing (Auto/Pin/All) is unchanged and operates *within* a group.

### 2. Cross-source answers are LLM composition, not federation

When a question spans multiple groups (or a group + a REST datasource), the agent runs **one query per source** (`executeSQL` per group, `executeRestOperation` per REST datasource) and **correlates the result sets in its own reasoning**. The "join" is the LLM stitching result sets in context — *not* a SQL operation. Each individual query stays within one source's dialect, whitelist, and 4-layer AST validation. Atlas builds **no** cross-engine query engine. (CONTEXT.md → *Cross-source composition*.)

### 3. Residency is orthogonal and out of scope

Atlas-internal residency (`ResidencyResolver`, the per-workspace, immutable control-plane region) is **invisible to the agent** and is *not* an analytical axis. A workspace's Atlas-side data is never split across Atlas regions; the customer's own datasources may physically live anywhere, and the agent reaches all of them regardless of location. Cross-group reach therefore **never composes with residency** — there is no residency boundary for it to cross. Multi-residency-in-one-workspace is explicitly out of scope: that need is "two workspaces," not residency-aware reach. (CONTEXT.md → the "region" flagged ambiguity.)

### 4. Discovery via a compact, auto-generated Source catalog

The agent learns *which* source to query from a **Source catalog** injected into the system prompt: one compact entry per Connection group + REST datasource (name + short description + headline entities). Descriptions are **auto-generated** from each group's entities at semantic-generation time (the `semantic/groups/<group>/` seam, `/wizard/enrich`) and **operator-refinable** via an editable `description` on the group — the established profile-then-refine pattern. The agent reads the catalog to route, then uses `explore` to drill into the chosen group's full semantic layer. Embedding/vector retrieval is **deferred** until a workspace's catalog itself outgrows the prompt.

### 5. Picker reshape — two unambiguous axes, no soft middle

The scope picker's SQL side gains a **Group reach** axis and removes the soft middle state that produced #3867(b):

- **Group reach (new, cross-group):** **All sources** (default — every group + REST datasource reachable, agent routes per question) **or** **Focus → one group** (a *hard, exclusive* narrowing: only that group is reachable for the conversation, mirroring REST-focus's exclusivity).
- **Member routing (unchanged, intra-group):** Auto / **Pin** / All — only meaningful, and only surfaced, *inside* a focused multi-member group.

This resolves the issue's "Pin vs focus" conflation: **Focus** narrows *which group* (cross-group); **Pin** locks *which member* (intra-group). They are different axes. There is **no** soft "prefer-but-allow" hint — "let the agent decide" *is* the default (All sources), so a soft hint would only re-introduce the #3867(b) ambiguity.

## Consequences

- **`executeSQL` gains a per-query group target.** The agent declares which group each query runs against, and validation uses **that group's** whitelist (already keyed per-connection via `getWhitelistedTables(connectionId)`). Today's `connectionId ?? requestContextConnectionId ?? "default"` binding becomes the *focused-group* case; the default-reach case lets the agent name the group per call.
- **Source catalog is new system-prompt content.** A group-level `description` (auto-generated + refinable) plus an entity-name summary feed a compact catalog block (~1–2 lines/group, bounded). Revisit at large group counts (deferred embedding retrieval).
- **Picker / Conversation scope.** SQL routing's "active group" becomes a **Group reach** control (All / Focus-one). Member routing (Auto/Pin/All) surfaces only under a focused group. The scope chip distinguishes states (e.g. `All sources` vs `Postgres only · Pin us-prod`). `conversations` persists the reach state alongside the existing ADR-0011 scope fields (per-conversation-authoritative).
- **Migration (clean break — pre-customer posture, CONTEXT.md §Deployment posture; re-verify the posture still holds at build time).** New-conversation default flips from "the workspace's primary/active group" to **All sources**. Existing conversations bound to a group map to **Focus → that group** (behavior-preserving). The sticky single-group preference is cleared so new chats start at all-reach. No deprecation shim — the two internal workspaces absorb the break.
- **No federation engine.** Closes the recurring "why doesn't Atlas do cross-engine JOINs?" question: deliberately not built; large cross-engine joins are not a supported shape.
- **Whitelist/semantic enforcement stays per-group, per-query** — unchanged in mechanism (the whitelist is already group-keyed); the change is that the agent selects the group per query rather than the conversation binding it once.

## Alternatives considered

- **Real federation (DuckDB-with-scanners / Trino).** Rejected (deferred): a massive new subsystem — connectors, a unified dialect, pushdown — that **breaks the 4-layer security model** (single-dialect AST + per-group whitelist). Many "cross-engine join" questions are small-lookup-then-filter shapes that LLM composition handles. Revisit only if real large cross-engine joins become a hard requirement.
- **Keep one-active-group, improve the picker.** Rejected: the #3253 soak + #3867(b) show the single-active-group model is the *cause*; patching the picker leaves "ask once, agent finds it across sources" impossible.
- **Soft "focus hint" (prefer-but-allow).** Rejected: it *is* the #3867(b) ambiguity. The default (All sources) already serves "let the agent decide"; Focus must be hard/exclusive.
- **Explore-blind discovery (no catalog).** Rejected: routing off folder names alone guesses wrong with many groups and burns round-trips. The catalog is the "menu."
- **Embedding/vector retrieval for discovery.** Deferred, not rejected: more infra than a compact catalog needs today; the natural next step when the catalog outgrows the prompt.
- **Residency-aware reach (per-group region boundary).** Rejected: residency is per-workspace control-plane, invisible to the agent; a single workspace never spans residency regions. Multi-residency analytical context is "two workspaces."
