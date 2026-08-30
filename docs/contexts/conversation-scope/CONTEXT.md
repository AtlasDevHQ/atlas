# Conversation scope

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Conversation scope` section, moved with two mechanical edits:
> relative links repathed for the new depth, and same-file "see below" pointers whose
> targets left rewritten as links to the context that now holds them. It is no longer
> in the root file.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


A conversation can read from two kinds of **Datasource** (see [Pillars](../pillars/CONTEXT.md)): SQL connections and REST datasources. **Conversation scope** is the umbrella for *which* of those a given conversation can query. It has two axes — **SQL routing** and **REST scope** — surfaced together in the chat header's **scope picker** (`ChatScopePicker`, historically `ChatEnvPicker` / "env picker"). Scope is **per-conversation and authoritative**: it persists on the `conversations` row, an opened conversation restores its own scope, and a workspace-scoped browser preference (the *sticky* last selection) seeds brand-new chats. See [ADR-0011](../../adr/0011-unified-conversation-scope.md).

- **Conversation scope**:
  The full set of datasources a conversation can query — its SQL routing plus its REST scope. The scope picker's single source of truth.
  _Avoid_: "env" / "environment picker" (the picker predates REST and covered SQL only); "reach" (considered, dropped in favour of "scope").

- **SQL routing**:
  The SQL axis of scope — the active **Connection group**, which of its **Members** execute, and the **routing mode** (Auto/Pin/All) that decides that. `executeSQL` only.
  _Avoid_: "SQL scope" (the axis is named *routing*); "environment" used loosely for the group.

- **Connection group**:
  A named set of interchangeable SQL connections (e.g. a multi-region `prod` group with `apac-prod` / `eu-prod` / `us-prod`). The unit SQL routing binds to.

  ⚠️ **There is no operator-designated primary, and this line used to say there was** (#5326). Where a single member has to be chosen — `resolveGroupPrimaryConnectionId`, for an amendment's evidence — the choice is `members.sort()[0]`, i.e. **alphabetical** (`lib/group-reach/lookup.ts`, `lib/env-routing/lookup.ts`). Renaming a datasource changes which member is chosen, silently. The old wording named a control an operator could set, sending a reader to look for a setting that does not exist.

  ⚠️ **"Interchangeable" is an ASSUMPTION the model makes, not a property Atlas enforces.** Members sharing a schema is checked nowhere; a group whose members are *shards* (different rows per member) is representable and is what the Atlas team's own `g_prod` is. Every consumer that reads one member and treats it as the group is correct for replicas and wrong for shards.

  The **warehouse producer** is the one consumer that no longer does either (#5326, fixed): it snapshots **every** member and describes their union, and refuses the entity when two members hold a row with the same primary key — the keys it writes carry the entity name and no member, so merging those two rows would be a false `same` with no inverse. It was the alphabetical-primary reading until then, and on prod it described 1 of 4 organizations while asserting them as the workspace's.
  _Avoid_: "environment" (informal only), "cluster"; describing the primary as designated, chosen, or configurable.

- **Member**:
  One SQL connection within a connection group; an `executeSQL` execution target. REST datasources are **not** members — they have no such group membership and are not run by `executeSQL`.

- **Routing mode**:
  The Auto / Pin / All value of SQL routing — **Auto** (agent decides per turn), **Pin** (one member), **All** (fan out across every member). Persisted as `routingMode`. SQL-only; it never affects REST scope.
  _Avoid_: conflating with `executeSQL`'s per-turn **`scope`** argument (the agent's per-call member choice under Auto), or with the umbrella **Conversation scope**.

- **REST scope**:
  The REST axis of scope — which of the workspace's **REST datasources** the conversation can reach. Two states:
  - *Default* — all in scope (workspace-global REST is reachable in every conversation, per [ADR-0010](../../adr/0010-rest-datasource-environment-scoping.md)), narrowed by an **exclude-set** (`rest_excluded_datasource_ids`); a newly-added REST datasource is reachable by default, and SQL routing stays active.
  - *Focused (REST-only)* — the conversation targets exactly one REST datasource (`rest_focus_datasource_id`) and **SQL is suspended** (no `executeSQL`). The "ask Stripe only" case.
  _Avoid_: "REST routing" (REST is scoped/focused, not routed).

- **REST datasource**:
  A **Datasource** reached over an `openapi-generic` install via `executeRestOperation` rather than SQL. Workspace-global by default, optionally group-scoped (ADR-0010). In default REST scope iff (workspace-global OR scoped to the active group) AND not in the exclude-set; in focused scope iff it is the focus target.

### Relationships

- A **Conversation scope** has one **SQL routing** axis and one **REST scope** axis.
- **SQL routing** binds one **Connection group** + a **routing mode**; the group has one or more **Members**.
- **REST scope** is either *default* (workspace in-scope **REST datasources** minus the exclude-set, SQL active) or *focused* (one REST datasource, SQL suspended).
- A **routing mode** governs **Members** only; it never changes **REST scope** (REST scope follows the active group + exclude-set, mode-independent — ADR-0010).

### Flagged ambiguities

- "env picker" / "environment" — the chat-header control was built SQL-only (#2345) and named for environments; it now governs full **Conversation scope**. Canonical name: **scope picker**; "environment" survives only as an informal synonym for **Connection group**.
- "scope" is overloaded — **Conversation scope** (this umbrella) vs `executeSQL`'s per-turn **`scope`** argument (the agent's per-call member choice under Auto routing) vs ADR-0010 "in-scope". Disambiguate in prose.
- "reach" / "routing" as the umbrella — both considered and rejected. The umbrella is **Conversation scope**; the SQL axis is **SQL routing**; the REST axis is **REST scope**.
- "region" — overloaded across two unrelated axes. **Atlas-internal residency region** (the control-plane region that is the **sole physical home of a Workspace's entire control-plane footprint** — its identity (`user` / `organization` / `member` / `session` / `account`), metadata, audit log, conversations, and semantic layer. Each region is a **fully independent stack** — its own internal DB and its own Better Auth instance — so an EU Workspace has **no row in the US DB** and `api.useatlas.dev` `401`s it. `ResidencyResolver`, per-workspace, immutable (a change is an operator-driven cross-region *data migration*, never a re-pick). Two planes route differently: the **analytics-datasource** axis is resolved transparently *below* the connection and is **invisible to the agent**; the **auth/control plane** is region-pinned *above* the connection — the browser must reach the Workspace's *own* regional API to authenticate, so region must be known **before** the first identity write — see [ADR-0024](../../adr/0024-regional-identity-isolation.md)) is *not* the **Connection group / Member** axis (the customer's analytical datasources, which may physically live anywhere and which the agent ranges over). Cross-group analytical reach never composes with residency — residency sits below it and the agent never sees it. A group's members being *named* by region (`us-prod`) is the customer's own replica/shard naming, unrelated to Atlas residency.

### Example dialogue

> **Dev:** "If I **Pin** a conversation to `apac-prod`, does that stop it hitting Stripe?"
> **Maintainer:** "No — the **routing mode** only picks which **Member** runs `executeSQL`. Stripe is a workspace-global **REST datasource**, so it's in **REST scope** regardless of the pin. To take it out, **exclude** it. If you want *only* Stripe and no SQL at all, **focus** it — that suspends SQL routing for the conversation."

### Cross-source composition

When a question spans more than one **Datasource** — several **Connection groups**, or a group plus a **REST datasource** — Atlas answers by **cross-source composition**: the agent runs a separate query per source (`executeSQL` per group, `executeRestOperation` per REST datasource) and **correlates the returned result sets in its own reasoning**. The "join" is the LLM stitching result sets in context, not a SQL operation — so every individual query still stays within one source's dialect, whitelist, and AST validation.
  _Avoid_: "federation" / "cross-engine join" — Atlas has **no** query engine that executes a single SQL `JOIN` across heterogeneous datasources. A federated query engine (DuckDB-with-scanners / Trino) would be a separate, deliberately-unbuilt capability, never this.
