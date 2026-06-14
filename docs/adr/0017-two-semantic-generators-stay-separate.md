# ADR-0017: The two semantic generators stay separate (spec-derived vs profiled)

**Status:** Accepted
**Date:** 2026-06-14
**Context milestone:** v0.0.16 — In-Product Datasource Onboarding (Profiler Seam)
**Depends on:** [ADR-0010](./0010-rest-datasource-environment-scoping.md), [ADR-0013](./0013-db-stored-plugin-datasource-connections.md)
**Closes:** [#3628](https://github.com/AtlasDevHQ/atlas/issues/3628) (the REST exclusion left open by the [#3303](https://github.com/AtlasDevHQ/atlas/issues/3303) profiler-seam PRD)

## Context

Atlas has **two** code paths that turn a datasource into a semantic-layer entity model, and they look superficially mergeable — both emit "entities" with columns/dimensions, joins, and query patterns. The #3303 profiler-seam epic deliberately *excluded* REST/OpenAPI datasources, and that exclusion invited a recurring question: should the two generators be unified behind one `SemanticGenerator` seam? This ADR records why the answer is **no** — they converge on a shared *surface* and a shared *vocabulary*, but never on a shared *generator*.

The two paths sit at opposite ends of the persistence spectrum:

1. **Spec-derived (ephemeral)** — `lib/openapi/semantic-generator.ts`
   (`generateSemanticModel` → `renderEntityYaml`). Pure functions over the
   normalized OpenAPI `OperationGraph`. **No I/O.** Entities are deterministic
   from the spec, generated lazily at prompt-build time (and, as of #3628, at
   admin read time), and **never written to `semantic_entities`**. The cached
   `workspace_plugins.config.openapi_snapshot` is the only durable artifact; the
   refresh model is "rediscover" (re-probe → diff → swap snapshot), not
   "regenerate + persist".

2. **Profiled (persisted)** — `lib/effect/semantic-generator.ts` +
   `lib/semantic/generate/yaml.ts` (`generateEntityYAML`). Profiles a **live
   connection** (row sampling, heuristics), generates editable YAML, and writes
   it as **draft rows** in `semantic_entities` — publish-gated through the atomic
   `/api/v1/admin/publish` endpoint and registered into the SQL whitelist. The
   YAML is a human-editable authoring artifact.

## Decision

**Keep the two generators separate. Converge them on a shared display surface
and a shared field vocabulary — not on a shared generator abstraction.**

Concretely (all shipped in #3628):

- **Shared surface.** REST-derived entities are now visible (read-only) in
  `/admin/semantic`, sourced live from the cached snapshot via
  `generateSemanticModel` — so both onboarding paths converge on one place to
  *see* the semantic layer. REST entities are **not** routed through
  `semantic_entities` / draft-publish; a read-only view is enough, and
  persisting a rediscover-refreshed, spec-derived model would re-introduce the
  staleness/sync problem the snapshot model exists to avoid.

- **Shared vocabulary.** Where both renderers emit entity YAML, the shared key
  names (`type`, `dimensions`, `joins` / `target_entity` / `relationship`,
  `query_patterns`, `primary_key`) are lifted into a contract in
  `@useatlas/schemas/semantic-entity-yaml` (`ENTITY_YAML_KEYS` etc. +
  `SharedEntityYamlSchema`). Both renderers consume the constants and a drift
  test validates both outputs, so the two YAML dialects can't silently diverge.

- **No shared generator.** The generators themselves stay distinct. A unifying
  `SemanticGenerator` super-seam would be accidental complexity: the two share
  only vocabulary, while differing on every load-bearing axis — input (spec
  graph vs live connection), purity (pure vs I/O + heuristics), output lifetime
  (ephemeral vs durable draft), and lifecycle (rediscover vs profile + publish).

## Consequences

- **REST onboarding is unchanged.** No profiling/"generate" step is added to
  REST install — there's no row-sampling to do; the install-time probe is the
  right model. Install remains the whole onboarding step.

- **The agent prompt is untouched.** The REST agent prompt keeps the compact
  `operation-graph` representation (Path A) as its default — the #2931 bake-off
  measured it as materially cheaper than entity-YAML (Path B). The shared-surface
  work renders entity YAML for the **human** admin view only; it adds no
  agent-token cost and must never push the prompt toward Path B. See
  [the bake-off](../architecture/openapi-representation-bakeoff.md).

- **One place to look, two places to change.** Operators see all entities in
  `/admin/semantic`; SQL entities are edited there, REST entities change only by
  editing the upstream spec + rediscovering. The read-only affordance on REST
  rows encodes that difference in the UI.

## Alternatives considered

- **(A) Merge into one `SemanticGenerator`.** Rejected — the only real overlap
  is vocabulary, now captured by the schema contract. A shared seam would couple
  a pure, no-I/O spec walk to a connection-profiling, DB-writing, publish-gated
  pipeline.

- **(B) Persist REST entities into `semantic_entities` for parity.** Rejected —
  a rediscover-refreshed spec model would constantly drift from its persisted
  copy, recreating the exact sync problem the snapshot model avoids. Read-only,
  derive-on-read is correct for a deterministic-from-spec model.

- **(C) Leave REST invisible in `/admin/semantic`.** Rejected — a REST-only
  workspace saw a misleading "no semantic layer / run `atlas init`" empty state
  while the agent was already querying REST entities. The visibility gap was the
  coherence bug #3628 set out to close.
