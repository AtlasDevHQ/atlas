/**
 * The Anchor — what an Improvement conversation optionally starts from (#4519,
 * PRD #4502; CONTEXT.md § Semantic improvement → "Anchor").
 *
 * An anchor is a **launcher, never a cage**: it scopes the turn-one Briefing to
 * the thing the admin cares about (a connection group, a single entity, or a
 * single column) and rides every turn so the Briefing stays scoped, while
 * free-form conversation continues to work anchored or not. A **sweep** ("find
 * improvements") is simply the anchorless start. The group + entity anchors
 * shipped with #4519; the column anchor is the coverage view's entry (#4521) —
 * clicking a *covered* column launches a conversation front-loaded with that
 * column's profile, its dimension's YAML, and its coverage state.
 *
 * Two shapes live here:
 *   - `ImproveAnchor` — the WIRE shape the improve `/chat` request carries. The
 *     web launcher sends it and the route validates it against a local schema
 *     (matching the improve surface's local-wire-type convention — the improve
 *     request/response types are inline zod in the route, not `@useatlas/*`).
 *   - `BriefingAnchor` — the RESOLVED, rendered structure the pure briefing
 *     assembler front-loads. It is produced by `resolveBriefingAnchor` from the
 *     entities + profiles the briefing loader ALREADY has in hand, so anchoring
 *     spends no extra I/O.
 *
 * NOT to be confused with two older, unrelated uses of the word "anchor" in
 * `briefing.ts`: the per-connection "anchor line" prose on `BriefingProfileLine`
 * (tracked-profile freshness rows), and its module header's "the anchor (health +
 * counts)" (the health orientation summary). This module is the CONTEXT.md domain
 * "Anchor" — the launcher scope — which `renderAnchor` emits as the `### Anchor:`
 * block.
 */

import * as yaml from "js-yaml";
import type { TableProfile } from "@useatlas/types";
import type { ParsedEntity } from "./types";

/** The wire anchor an improve conversation carries. Absent ⇒ an anchorless sweep. */
export type ImproveAnchor =
  | { readonly kind: "group"; readonly group: string }
  | { readonly kind: "entity"; readonly entity: string; readonly group?: string }
  | {
      readonly kind: "column";
      /** The entity that models the column's table. */
      readonly entity: string;
      /** The physical column name (matched to a dimension by `sql`). */
      readonly column: string;
      readonly group?: string;
    };

/** One entity in a group anchor's inventory, trimmed to what the block shows. */
export interface BriefingAnchorEntity {
  readonly name: string;
  readonly table: string;
  readonly description: string | null;
  readonly dimensionCount: number;
  readonly measureCount: number;
  readonly joinCount: number;
}

/** An entity anchor's tracked table profile, trimmed to the block's summary line. */
export interface BriefingAnchorProfile {
  readonly table: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

/** A column anchor's tracked profile facts, trimmed to the block's summary line. */
export interface BriefingAnchorColumnProfile {
  readonly type: string;
  readonly nullable: boolean;
  /** Distinct value count, or `null` when the profiler didn't compute it. */
  readonly uniqueCount: number | null;
  /** Null count, or `null` when the profiler didn't compute it. */
  readonly nullCount: number | null;
  readonly sampleValues: readonly string[];
}

/**
 * The resolved anchor the pure assembler renders. A group anchor front-loads the
 * group's entity inventory + coverage counts; an entity anchor front-loads that
 * entity's current YAML and its tracked profile; a column anchor front-loads that
 * column's dimension YAML, its tracked column profile, and its coverage state.
 */
export type BriefingAnchor =
  | {
      readonly kind: "group";
      readonly group: string;
      readonly entities: readonly BriefingAnchorEntity[];
    }
  | {
      readonly kind: "entity";
      readonly entity: string;
      readonly group: string | null;
      readonly yaml: string;
      readonly profile: BriefingAnchorProfile | null;
    }
  | {
      readonly kind: "column";
      readonly entity: string;
      readonly group: string | null;
      readonly column: string;
      /** Whether the column is modeled as a dimension (its coverage state). */
      readonly covered: boolean;
      /** The modeling dimension's current YAML, or `null` when uncovered. */
      readonly dimensionYaml: string | null;
      /** The column's tracked profile, or `null` when no baseline profile matches. */
      readonly columnProfile: BriefingAnchorColumnProfile | null;
    };

/**
 * The effective Connection group of a parsed entity for anchor matching. DB-loaded
 * entities carry the group on `connection` (the fallback from `connection_group_id`);
 * disk-loaded entities carry the layout-resolved `group`. A NULL/absent scope is
 * the flat `"default"` group (ADR-0012).
 */
export function entityGroupOf(entity: ParsedEntity): string {
  return entity.group ?? entity.connection ?? "default";
}

/**
 * Serialize a parsed entity back to a compact YAML block for the briefing. Built
 * from the parsed structure (name/table/description/dimensions/measures/joins/
 * query_patterns) rather than round-tripping the stored file, so it needs no
 * extra read; empty collections are dropped so the block stays tight. Matches the
 * dump options the apply path uses (`lineWidth: 120, noRefs: true`).
 */
function serializeEntityYaml(entity: ParsedEntity): string {
  const doc: Record<string, unknown> = { name: entity.name, table: entity.table };
  if (entity.description) doc.description = entity.description;
  if (entity.dimensions.length > 0) doc.dimensions = entity.dimensions;
  if (entity.measures.length > 0) doc.measures = entity.measures;
  if (entity.joins.length > 0) doc.joins = entity.joins;
  if (entity.query_patterns.length > 0) doc.query_patterns = entity.query_patterns;
  return yaml.dump(doc, { lineWidth: 120, noRefs: true }).trimEnd();
}

/** Serialize a single dimension for the column anchor's front-loaded YAML. */
function serializeDimensionYaml(dim: ParsedEntity["dimensions"][number]): string {
  return yaml.dump(dim, { lineWidth: 120, noRefs: true }).trimEnd();
}

/**
 * Resolve a wire `ImproveAnchor` into the rendered `BriefingAnchor` the assembler
 * front-loads, PURELY from the entities + profiles the loader already gathered
 * (no DB/LLM/clock). Group anchors always resolve (an empty group renders "no
 * entities yet — route to enrich"). An entity or column anchor resolves only when
 * the named entity is present in scope; a miss returns `null` so the briefing
 * simply starts unanchored rather than fabricating an entity/column that isn't
 * there.
 */
export function resolveBriefingAnchor(
  anchor: ImproveAnchor,
  entities: readonly ParsedEntity[],
  profiles: readonly TableProfile[],
): BriefingAnchor | null {
  if (anchor.kind === "group") {
    const inventory: BriefingAnchorEntity[] = entities
      .filter((e) => entityGroupOf(e) === anchor.group)
      .map((e) => ({
        name: e.name,
        table: e.table,
        description: e.description ?? null,
        dimensionCount: e.dimensions.length,
        measureCount: e.measures.length,
        joinCount: e.joins.length,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return { kind: "group", group: anchor.group, entities: inventory };
  }

  // Entity + column anchors both match an entity by name, disambiguating by group
  // only when supplied. A miss returns null so the briefing starts unanchored
  // rather than fabricating an entity/column that isn't in scope.
  const match = entities.find(
    (e) => e.name === anchor.entity && (anchor.group == null || entityGroupOf(e) === anchor.group),
  );
  if (!match) return null;

  const group = match.group ?? match.connection ?? null;

  if (anchor.kind === "entity") {
    const profile = profiles.find((p) => p.table_name === match.table) ?? null;
    return {
      kind: "entity",
      entity: match.name,
      group,
      yaml: serializeEntityYaml(match),
      profile: profile
        ? { table: profile.table_name, rowCount: profile.row_count, columnCount: profile.columns.length }
        : null,
    };
  }

  // Column anchor (#4521) — front-load the modeling dimension's YAML, the tracked
  // column profile, and the coverage state. The dimension is matched by `sql` =
  // the physical column name (case-insensitively), the SAME rule the coverage
  // matrix + gap analyzer use. `covered` is honest: an uncovered column resolves
  // with `dimensionYaml: null` (the launcher only offers covered columns, but the
  // resolver never fabricates a dimension that isn't there).
  const colName = anchor.column.toLowerCase();
  const dim = match.dimensions.find((d) => d.sql.toLowerCase() === colName) ?? null;
  const profileCol = profiles
    .find((p) => p.table_name === match.table)
    ?.columns.find((col) => col.name.toLowerCase() === colName);
  return {
    kind: "column",
    entity: match.name,
    group,
    column: anchor.column,
    covered: dim !== null,
    dimensionYaml: dim ? serializeDimensionYaml(dim) : null,
    columnProfile: profileCol
      ? {
          type: profileCol.type,
          nullable: profileCol.nullable,
          uniqueCount: profileCol.unique_count,
          nullCount: profileCol.null_count,
          sampleValues: profileCol.sample_values,
        }
      : null,
  };
}
