/**
 * The Anchor — what an Improvement conversation optionally starts from (#4519,
 * PRD #4502; CONTEXT.md § Semantic improvement → "Anchor").
 *
 * An anchor is a **launcher, never a cage**: it scopes the turn-one Briefing to
 * the thing the admin cares about (a connection group, or a single entity) and
 * rides every turn so the Briefing stays scoped, while free-form conversation
 * continues to work anchored or not. A **sweep** ("find improvements") is simply
 * the anchorless start. This slice ships the group + entity anchors; the column
 * anchor arrives with the coverage view (#4521).
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
  | { readonly kind: "entity"; readonly entity: string; readonly group?: string };

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

/**
 * The resolved anchor the pure assembler renders. A group anchor front-loads the
 * group's entity inventory + coverage counts; an entity anchor front-loads that
 * entity's current YAML and its tracked profile.
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
    };

/**
 * The effective Connection group of a parsed entity for anchor matching. DB-loaded
 * entities carry the group on `connection` (the fallback from `connection_group_id`);
 * disk-loaded entities carry the layout-resolved `group`. A NULL/absent scope is
 * the flat `"default"` group (ADR-0012).
 */
function entityGroupOf(entity: ParsedEntity): string {
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

/**
 * Resolve a wire `ImproveAnchor` into the rendered `BriefingAnchor` the assembler
 * front-loads, PURELY from the entities + profiles the loader already gathered
 * (no DB/LLM/clock). Group anchors always resolve (an empty group renders "no
 * entities yet — route to enrich"). An entity anchor resolves only when the named
 * entity is present in scope; a miss returns `null` so the briefing simply starts
 * unanchored rather than fabricating an entity that isn't there.
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

  // Entity anchor — match by name, disambiguating by group only when supplied.
  const match = entities.find(
    (e) => e.name === anchor.entity && (anchor.group == null || entityGroupOf(e) === anchor.group),
  );
  if (!match) return null;

  const profile = profiles.find((p) => p.table_name === match.table) ?? null;
  return {
    kind: "entity",
    entity: match.name,
    group: match.group ?? match.connection ?? null,
    yaml: serializeEntityYaml(match),
    profile: profile
      ? { table: profile.table_name, rowCount: profile.row_count, columnCount: profile.columns.length }
      : null,
  };
}
