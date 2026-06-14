/**
 * Shared entity-YAML vocabulary contract.
 *
 * Atlas has TWO entity-YAML renderers that intentionally stay separate
 * (different ends of the persistence spectrum — see ADR-0017):
 *
 * - **DB / profiled** — `packages/api/src/lib/semantic/generate/yaml.ts`
 *   (`generateEntityYAML`): live connection → durable draft rows.
 * - **REST / spec-derived** — `packages/api/src/lib/openapi/semantic-generator.ts`
 *   (`renderEntityYaml`, Path B): cached OpenAPI snapshot → ephemeral prompt /
 *   admin-display YAML.
 *
 * They overlap only in *vocabulary*: both describe an entity with a `type`
 * tag, a `dimensions` block (NOT `columns`), `joins` (keyed `target_entity` /
 * `relationship`), and `query_patterns`. Before this contract those key names
 * lived as bare string literals in each renderer, free to drift silently —
 * one could rename `dimensions` → `columns` and the human-facing
 * `/admin/semantic` view (which reads both) would quietly break for one source
 * only.
 *
 * This module is the single source of truth for those shared key names. Both
 * renderers build their YAML objects through {@link ENTITY_YAML_KEYS} /
 * {@link ENTITY_YAML_JOIN_KEYS} / {@link ENTITY_YAML_DIMENSION_KEYS}, so a
 * rename is a one-line change here that moves both renderers in lockstep — a
 * silent per-renderer drift is impossible. {@link SharedEntityYamlSchema}
 * additionally lets a test assert each renderer's output speaks the shared
 * vocabulary (drift → test failure).
 *
 * Scope (issue #3628, item 2): this is a naming/schema-consistency contract for
 * the entity-YAML *renderers* (DB output + REST Path B + the `/admin/semantic`
 * display). It is deliberately NOT about the agent prompt: the REST agent
 * prompt defaults to the compact `operation-graph` representation (Path A),
 * whose token advantage (#2931 bake-off) this contract must never erode.
 */
import { z } from "zod";

/**
 * Canonical top-level key names shared by both entity-YAML renderers. Values
 * are the literal YAML keys — consume the constants (`[ENTITY_YAML_KEYS.x]:`)
 * rather than re-typing the string so the two renderers can't diverge.
 */
export const ENTITY_YAML_KEYS = {
  name: "name",
  type: "type",
  description: "description",
  dimensions: "dimensions",
  joins: "joins",
  measures: "measures",
  queryPatterns: "query_patterns",
} as const;

/** Canonical key names inside a `joins[]` entry shared by both renderers. */
export const ENTITY_YAML_JOIN_KEYS = {
  targetEntity: "target_entity",
  relationship: "relationship",
} as const;

/** Canonical key names inside a `dimensions[]` entry shared by both renderers. */
export const ENTITY_YAML_DIMENSION_KEYS = {
  name: "name",
  type: "type",
  primaryKey: "primary_key",
  description: "description",
} as const;

/**
 * The entity `type:` tag for a REST/OpenAPI resource. DB entities use
 * `fact_table` / `view` / `materialized_view`; the REST renderer (and any
 * read-only admin surface that renders REST entities) uses this one. Centralized
 * so the renderer and consumers (e.g. `/admin/semantic` read-only gating) agree.
 */
export const REST_ENTITY_TYPE_TAG = "rest_resource" as const;

// ---------------------------------------------------------------------------
// Shared-subset Zod schema — value shapes for the keys both renderers emit.
// `.loose()` so each renderer's own extras pass (SQL adds `sql` / `sample_values`
// / `measures`; REST adds `resource` / `operations` / join `via`). The contract
// is about the shared KEY NAMES + their value types, not an exhaustive doc shape.
// ---------------------------------------------------------------------------

const SharedDimensionSchema = z
  .object({
    [ENTITY_YAML_DIMENSION_KEYS.name]: z.string(),
    [ENTITY_YAML_DIMENSION_KEYS.type]: z.string(),
    [ENTITY_YAML_DIMENSION_KEYS.primaryKey]: z.boolean().optional(),
    [ENTITY_YAML_DIMENSION_KEYS.description]: z.string().optional(),
  })
  .loose();

const SharedJoinSchema = z
  .object({
    [ENTITY_YAML_JOIN_KEYS.targetEntity]: z.string(),
    [ENTITY_YAML_JOIN_KEYS.relationship]: z.string(),
    [ENTITY_YAML_KEYS.description]: z.string().optional(),
  })
  .loose();

const SharedQueryPatternSchema = z
  .object({
    [ENTITY_YAML_KEYS.description]: z.string(),
  })
  .loose();

/**
 * The shared subset both entity-YAML renderers must speak. Every section is
 * optional (not every entity has joins / query_patterns), but where a section
 * IS present it must use these canonical key names and value shapes. A renderer
 * that emitted `columns` instead of `dimensions`, or `target` instead of
 * `target_entity`, fails validation here.
 */
export const SharedEntityYamlSchema = z
  .object({
    [ENTITY_YAML_KEYS.name]: z.string().optional(),
    [ENTITY_YAML_KEYS.type]: z.string(),
    [ENTITY_YAML_KEYS.description]: z.string().optional(),
    [ENTITY_YAML_KEYS.dimensions]: z.array(SharedDimensionSchema).optional(),
    [ENTITY_YAML_KEYS.joins]: z.array(SharedJoinSchema).optional(),
    [ENTITY_YAML_KEYS.queryPatterns]: z.array(SharedQueryPatternSchema).optional(),
  })
  .loose();

export type SharedEntityYaml = z.infer<typeof SharedEntityYamlSchema>;
