# ADR-0010: REST datasource environment scoping

**Status:** Accepted — picker-surface consequence superseded by [ADR-0011](./0011-unified-conversation-scope.md) (REST becomes pickable/excludable + a REST-only focus, not a read-only footer). The scoping model, resolver tri-state, and `catalog_id` discriminator below all stand.
**Date:** 2026-05-31
**Context milestone:** v0.0.3 — Spec Lifecycle (closeout of a composability gap from v0.0.2)
**Depends on:** [ADR-0006](./0006-three-pillar-integration-taxonomy.md), [ADR-0007](./0007-unified-install-pipeline.md)
**Closes:** [#3044](https://github.com/AtlasDevHQ/atlas/issues/3044) (spans v0.0.2 REST datasources × 1.4.5 cross-environment routing — PRDs [#2868](https://github.com/AtlasDevHQ/atlas/issues/2868), [#2336](https://github.com/AtlasDevHQ/atlas/issues/2336))

## Context

Atlas has two subsystems that were built independently and never composed:

1. **Cross-environment routing** (milestones 1.4.4 / 1.4.5) — connection *groups* + an Auto/Pin/All picker. A conversation pins to one member of a group (e.g. `apac-prod`), and `executeSQL` honours that scope: `pin` routes to the current member, `all` fans out across every member, `auto` lets the agent decide. Members are SQL connection ids; the routing module (`env-routing/`) is SQL-only.

2. **REST / OpenAPI datasources** (`v0.0.2`, PRD #2868) — `executeRestOperation` over an `openapi-generic` install (Twenty, Stripe, GitHub, an internal service). These were added *after* routing and resolve via `resolveWorkspaceRestDatasources(orgId)` — keyed on the **workspace only**, with no routing input.

The gap: a chat **pinned to one environment can still query any connected REST datasource**, the REST datasource never appears in the env picker, and the pin doesn't constrain it. The routing-scope indicator therefore **silently overstates** what the chat is constrained to.

Both subsystems already store their installs in `workspace_plugins` with `pillar = 'datasource'`. SQL connections and REST datasources are distinguished only by `catalog_id` (`catalog:postgres` / `catalog:mysql` / … vs `catalog:openapi-generic` / `catalog:{stripe,github,notion}-data`). The group-scoping plumbing for REST half-exists: `config.group_id` is a free-form JSONB string a REST install *can* already carry, but no resolver reads it.

## Decision

**Hybrid model: workspace-global by default, optionally environment-scoped.**

A REST datasource is **workspace-global by default** (no `config.group_id`). One Stripe / GitHub / Twenty account is not region-specific, so a workspace-global REST datasource is intentionally cross-environment — it is **not** constrained by the conversation's environment pin, and that is correct.

An admin **may optionally scope** a REST datasource to a connection group by assigning it the group's `group_id` (reusing the same `config.group_id` field SQL connections carry — one group identity, no parallel field). A scoped REST datasource is the per-region case (e.g. a region-local internal API).

### Scope rule (resolver)

A REST datasource is **in-scope for a chat turn** iff:

```text
groupId == null              // workspace-global — always available
  OR groupId === activeGroupId  // scoped — available only when its group is active
```

This is **mode-independent.** The active group is the same under `pin` / `auto` / `all`; those modes only choose which SQL member(s) execute *within* the group — they don't change which REST datasources belong to the group. `resolveWorkspaceRestDatasources*` accepts an optional **tri-state** `activeGroupId`:

- **`null`** (an active-group-aware caller — the agent loop — with no group bound) → resolve only workspace-global datasources, so a scoped datasource never leaks into a context whose group can't be confirmed. The agent loop always passes `connectionGroupId ?? null`, so the chat path is strictly scoped.
- **a string** (the active group id) → resolve workspace-global datasources plus those scoped to that exact group.
- **omitted (`undefined`)** → apply **no** scope filter (resolve every install). Reserved for the authorized confirm-replay path (`tools/rest-operation.ts`'s `resolveFromContext`): a staged write is bound by a signed token and must replay regardless of the request's group context.

Because no REST install carries a `group_id` today, **back-compat is total**: every existing datasource is workspace-global and always in scope.

### Always-correct half (the bug, ships under any model)

The misleading-scope half is a bug regardless of the model. The agent prompt and the env picker now make a REST datasource's cross-environment reach **explicit**:

- **Workspace-global** datasources are framed as "NOT constrained by the conversation's environment selection — available in every environment."
- **Scoped** datasources note the group they belong to.

So a pinned chat never silently appears fully constrained while a workspace-global REST datasource is reachable.

### Robustness: `catalog_id` discriminates SQL members from REST installs

REST installs share `workspace_plugins` + `pillar = 'datasource'` with SQL connections. The two queries that resolve **SQL** routing-group members —
`loadGroupRoutingContext` (`env-routing/lookup.ts`) and `GET /api/v1/me/connection-groups` —
must therefore **exclude** REST `catalog_id`s. Without that exclusion, a REST install that shares a `group_id` with SQL connections would be returned as a SQL "member", and `executeSQL`'s `all`-fanout would attempt a SQL query against a connection that isn't registered in the SQL `ConnectionRegistry` (it fails soft, but degrades the fanout silently). The shared constant `REST_DATASOURCE_CATALOG_IDS` (`openapi/data-candidates.ts`) is the discriminator both queries filter on.

## Consequences

- **No migration.** Reuses the existing `config.group_id` JSONB field; no schema change, no drift-gate concern.
- **Admin UX.** `/admin/connections` gains a per-datasource "Environment" control (a group picker; "Workspace-global" clears the assignment). It writes `config.group_id` via the existing JSONB-merge PATCH.
- **Picker surface.** `/api/v1/me/connection-groups` additionally returns the workspace's REST datasources with their `groupId`, so the env picker can show "+ N workspace-global REST datasources (not env-scoped)" and list scoped ones under their group — without rendering them as pickable SQL execution targets.
- **Resolver contract preserved.** Group filtering happens before credential resolution, so the never-rejects `[]` fail-soft contract and the `RestDatasourceReconnectError` semantics are unchanged for the in-scope set.

## Alternatives considered

- **(A) Pure env-scoped.** Force every REST datasource into a group. Rejected: a single Stripe account isn't apac-specific; forcing a group is busywork and wrong for the common case.
- **(B) Pure workspace-global + surfaced.** Never scope; just make the cross-env reach explicit. This is the right *default* but can't express the genuine per-region API case, so it becomes the default arm of the hybrid rather than the whole answer.
- **Separate `config.datasource_group_id` field.** Avoids touching the SQL-member queries but splits group identity in two and can't surface a REST datasource as "belonging to" a SQL environment group. Rejected in favour of one group identity + the `catalog_id` discriminator.
