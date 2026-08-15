/**
 * The warehouse class's denominator enumeration (#5213, ADR-0041).
 *
 * The survey unit is an **(entity, dimension) pair**, and the universe is the
 * workspace's PUBLISHED semantic layer crossed with each entity's enrollable
 * dimensions — `semantic-layer-enrollment`, exactly as `CLASS_CONTRACTS.warehouse`
 * declares. Enrollment (ADR-0039) is the perimeter within it.
 *
 * ## Why the perimeter half is not the whole answer
 *
 * The issue's shorthand is *"enrolled = surveyed, unenrolled = enumerated"*, and
 * that is right about the second half and one step short on the first. ADR-0041's
 * state 1 is "inside the perimeter, **evidence actually observed**", and ADR-0040
 * rule 3 says green is evidence and never configuration. An enrolled pair the
 * producer has not yet emitted a claim for is enrolled and empty — reporting it
 * as surveyed is the configuration-as-green failure M1 shipped, one class over.
 *
 * So a pair is `surveyed` only when a warehouse-derived fact exists for it, and
 * an enrolled pair with none reads `enumerated` with `in_perimeter = true` — the
 * state the roster keeps distinct precisely so "enrolled but producing nothing"
 * is a sentence an admin can read.
 *
 * ## Every unit here is nameable, and the clause matters
 *
 * ADR-0041: "Warehouse entities are freely namable — the admin authored the
 * semantic layer they come from." That is the DELIBERATE-ACT clause, not the
 * vendor-public one: `CLASS_CONTRACTS.warehouse` declares `vendorPublic: false`
 * because a warehouse has no notion of a workspace-public entity, and
 * `coverageLabelPolicy` therefore names these units on the strength of the
 * authoring act alone. Which is why `deliberateAct` below is `true` for
 * unenrolled pairs too: the enrollment is a second deliberate act on top of the
 * first, not the only one.
 *
 * ## No vendor activity, by declaration
 *
 * `CLASS_CONTRACTS.warehouse` declares `activityMetadata: "absent"`, so every
 * unit here carries `{ probed: false }` and the surface says "unverified since
 * \<last successful cycle\>" rather than "stale". That is not a gap to fill
 * later: asking when an (entity, dimension) pair last moved means a freshness
 * query per entity against the customer's own warehouse, which many entities
 * cannot answer and which ADR-0041 rules out on the page anyway.
 *
 * @see ./coverage-enumeration.ts — the shape this produces and the write
 * @see ./enrollment-candidates.ts — the semantic-layer read this counts
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import { listEnrollments } from "@atlas/api/lib/brain/enrollment";
import {
  loadEnrollableDimensions,
  loadEnrollableEntities,
} from "@atlas/api/lib/brain/enrollment-candidates";
import { parseWarehouseEpisodeEntity } from "@atlas/api/lib/brain/warehouse-producer";
import type {
  CoverageDegradedArm,
  CoverageEnumeration,
  EnumeratedSurveyUnit,
} from "@atlas/api/lib/brain/coverage-enumeration";

const log = createLogger("brain.coverage.warehouse");

/**
 * Entities walked per cycle.
 *
 * `loadEnrollableDimensions` is one semantic-layer read PER ENTITY, so an
 * unbounded walk is a per-cycle cost proportional to the customer's warehouse
 * breadth. Hitting the bound emits the `warehouse-entity-bound-reached` MARK
 * rather than refusing, on the chat roster's argument: entities are walked in a
 * stable order, so the counted prefix does not churn, and the mark is what stops
 * a partial map reading as the whole one.
 *
 * 200 is generous against ADR-0039's own bound — enrollment exists because a
 * person has to be able to choose the set — while still being a number rather
 * than "however many rows came back".
 */
export const WAREHOUSE_COVERAGE_MAX_ENTITIES = 200;

/** Injection seam for the tests — the three reads this composes. */
export interface WarehouseCoverageDeps {
  readonly loadEnrollableEntities?: typeof loadEnrollableEntities;
  readonly loadEnrollableDimensions?: typeof loadEnrollableDimensions;
  readonly listEnrollments?: typeof listEnrollments;
}

/**
 * The survey unit's stored id.
 *
 * LENGTH-PREFIXED rather than joined by a separator, and that is the whole
 * decision. `brain_enrollment` uses a NUL byte for its in-memory pair key
 * precisely because every printable separator is ambiguous — with a `.`,
 * `("plans.status", "tier")` and `("plans", "status.tier")` build the same key —
 * and NUL is the one byte a Postgres `text` column cannot hold, so it is
 * unavailable to a STORED id. The length prefix is injective for the same reason
 * and stores fine.
 *
 * Exported with {@link parseWarehouseSurveyUnitId} so the build and the parse
 * cannot drift.
 */
export function warehouseSurveyUnitId(entity: string, dimension: string): string {
  return `${entity.length}:${entity}:${dimension}`;
}

/** {@link warehouseSurveyUnitId}'s inverse — `null` when the id is malformed. */
export function parseWarehouseSurveyUnitId(
  unitId: string,
): { readonly entity: string; readonly dimension: string } | null {
  const firstColon = unitId.indexOf(":");
  if (firstColon <= 0) return null;
  const length = Number.parseInt(unitId.slice(0, firstColon), 10);
  if (!Number.isInteger(length) || length < 0) return null;
  const entityStart = firstColon + 1;
  const entityEnd = entityStart + length;
  // The separator after the entity must be exactly where the declared length
  // says it is. Without this the parse would accept a hand-edited id whose
  // prefix disagrees with its body and return a truncated entity name.
  if (unitId.length <= entityEnd || unitId[entityEnd] !== ":") return null;
  const entity = unitId.slice(entityStart, entityEnd);
  const dimension = unitId.slice(entityEnd + 1);
  if (entity === "" || dimension === "") return null;
  return { entity, dimension };
}

/**
 * Our newest observed evidence, per (entity, dimension).
 *
 * A warehouse fact's evidence pointer is its snapshot episode, whose `source_id`
 * carries the entity (`warehouse:<entity>@<instant>`) and whose `occurred_at` IS
 * the snapshot instant. The dimension is the fact's PREDICATE — ADR-0037 §4's
 * emission contract makes the bare dimension name the predicate, which is what
 * lets this join exist at all.
 *
 * Grouped in SQL and split in TypeScript rather than one query per entity: the
 * entity is recovered by {@link parseWarehouseEpisodeEntity}, the producer's own
 * inverse, so a `source_id` format change reddens on both sides at once.
 *
 * ⚠️ No `status` filter, deliberately. A DRAFT warehouse fact is evidence that
 * the producer read the pair and emitted a claim; whether a human has published
 * it is the AUTHORITY arm's question, and ADR-0041 keeps the two arms beside each
 * other rather than folded together. Filtering to `published` here would report
 * a workspace's whole warehouse as unsurveyed until someone worked the review
 * queue, which describes the review backlog rather than the coverage.
 */
const WAREHOUSE_EVIDENCE_SQL = `SELECT e.source_id, f.predicate, max(e.occurred_at) AS newest
     FROM brain_facts f
     JOIN brain_episodes e ON e.id = f.source_episode_id
    WHERE f.workspace_id = $1 AND e.workspace_id = $1 AND e.source = $2
    GROUP BY e.source_id, f.predicate`;

/**
 * Enumerate the warehouse class's survey units for one workspace.
 *
 * Semantic-layer read failures PROPAGATE as a refusal rather than as an empty
 * universe — `loadEnrollableEntities`' own rule, and the reason it throws: "an
 * empty candidate list and a failed read render identically, and the second one
 * silently tells an admin their warehouse has nothing worth enrolling." Here the
 * same confusion would report a zeroed denominator, which ADR-0041 calls a false
 * statement rather than an error state.
 */
export async function enumerateWarehouseCoverage(params: {
  readonly workspaceId: string;
  readonly deps?: WarehouseCoverageDeps;
}): Promise<CoverageEnumeration> {
  const { workspaceId } = params;
  const loadEntities = params.deps?.loadEnrollableEntities ?? loadEnrollableEntities;
  const loadDimensions = params.deps?.loadEnrollableDimensions ?? loadEnrollableDimensions;
  const loadEnrollments = params.deps?.listEnrollments ?? listEnrollments;
  const degraded: CoverageDegradedArm[] = [];

  let entities: readonly { readonly name: string }[];
  let enrolled: ReadonlySet<string>;
  let evidence: ReadonlyMap<string, Date>;
  try {
    const [entityRows, enrollmentRows, evidenceRows] = await Promise.all([
      loadEntities(workspaceId),
      loadEnrollments(workspaceId),
      internalQuery<{ source_id: string; predicate: string; newest: Date | string | null }>(
        WAREHOUSE_EVIDENCE_SQL,
        [workspaceId, WAREHOUSE_SOURCE],
      ),
    ]);
    entities = entityRows;
    enrolled = new Set(
      enrollmentRows.map((r) => warehouseSurveyUnitId(r.entity, r.dimension)),
    );
    const byPair = new Map<string, Date>();
    for (const row of evidenceRows) {
      const entity = parseWarehouseEpisodeEntity(row.source_id);
      if (entity === null) continue;
      const at = toDate(row.newest);
      if (at === null) continue;
      const key = warehouseSurveyUnitId(entity, row.predicate);
      const prior = byPair.get(key);
      if (prior === undefined || prior < at) byPair.set(key, at);
    }
    evidence = byPair;
  } catch (err) {
    return {
      ok: false,
      error: `Atlas could not read this workspace's published semantic layer (${err instanceof Error ? err.message : String(err)}) — the warehouse coverage denominator keeps its previous reading rather than reporting zero entities. It retries on the next cycle.`,
    };
  }

  const walked = entities.slice(0, WAREHOUSE_COVERAGE_MAX_ENTITIES);
  if (entities.length > walked.length) {
    degraded.push("warehouse-entity-bound-reached");
    log.warn(
      { workspaceId, entities: entities.length, walked: walked.length },
      "brain coverage: this workspace's published semantic layer is wider than the warehouse enumeration's entity bound — the denominator carries a truncation mark",
    );
  }

  const units: EnumeratedSurveyUnit[] = [];
  for (const entity of walked) {
    let dimensions: readonly { readonly name: string }[] | null;
    try {
      dimensions = await loadDimensions(workspaceId, entity.name);
    } catch (err) {
      // ONE entity's read failed. Refusing the whole cycle for it would let a
      // single unreadable entity freeze the whole class's denominator; counting
      // it as zero dimensions would shrink the denominator silently. Neither —
      // the entity contributes no units this cycle and the previous cycle's
      // units for it are swept, which the `warehouse-entity-bound-reached` mark
      // does NOT cover, so it is logged at `error` where an operator sees it.
      log.error(
        { workspaceId, entity: entity.name, err: err instanceof Error ? err.message : String(err) },
        "brain coverage: could not read one entity's dimensions — its pairs are absent from this cycle's warehouse denominator",
      );
      continue;
    }
    // `null` is "this entity is not in the published semantic layer", which can
    // happen between the entity listing and this read (a publish landed
    // mid-cycle). Not an error and not zero dimensions: the entity is gone, so
    // it contributes nothing, which is what the next cycle will also say.
    if (dimensions === null) continue;
    for (const dimension of dimensions) {
      const unitId = warehouseSurveyUnitId(entity.name, dimension.name);
      const inPerimeter = enrolled.has(unitId);
      units.push({
        unitId,
        // `<entity>.<dimension>` for display only — the identity is `unitId`
        // above, which is unambiguous where this is merely readable.
        label: `${entity.name}.${dimension.name}`,
        inPerimeter,
        // See the module header: the admin AUTHORED the semantic layer, which is
        // ADR-0041's deliberate act for this class. Enrollment is a second one.
        deliberateAct: true,
        // The class declares `vendorPublic: false` — a warehouse has no notion
        // of a workspace-public entity — so this is always false and the label
        // above is admitted by the other clause.
        vendorReportsPublic: false,
        newestEvidenceAt: evidence.get(unitId) ?? null,
        // `activityMetadata: "absent"`. See the module header.
        activity: { probed: false },
      });
    }
  }

  return { ok: true, units, degraded };
}

function toDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
