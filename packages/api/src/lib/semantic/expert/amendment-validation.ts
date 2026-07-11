/**
 * The semantic-Amendment validation seam (#4513).
 *
 * "Validation is a seam, not a tool" (CONTEXT.md § Semantic improvement): an
 * Amendment is validated where it is created (a proposal that fails never
 * enters the Pending queue) and revalidated where it is applied (the post-apply
 * document must parse as an entity; embedded SQL must parse as a query; each
 * type may touch only its declared fields). These are gates the payload must
 * pass through, never advice the model may follow — the retired
 * `validateProposal` tool was exactly the "optional validate step whose verdict
 * floats free" this module replaces.
 *
 * Three pure(ish) gates, shared by the propose seam (`propose-amendment.ts`) and
 * the apply seam (`expert/apply.ts`):
 *
 *   1. {@link validateAmendmentPayload} — the amendment object parses against
 *      its type's schema. The `update_dimension` schema is `.strict()` — the
 *      containment case: an update may never smuggle a `sql` change (repointing
 *      a dimension's expression is a bigger change than the type allows — in the
 *      spirit of ADR-0032's refine-don't-grow containment). ADD types validate
 *      their known fields' types but tolerate the extra entity attributes a real
 *      dimension carries (`primary_key`, `is_foreign_key`, …).
 *   2. {@link validateEmbeddedSql} — any embedded SQL (dimension / measure /
 *      virtual-dimension expressions, and full query patterns) passes the shared
 *      SQL validation (`validateSQL`: regex mutation guard → AST shape → forbidden
 *      functions → table whitelist), so a poisoned expression can never reach the
 *      authoritative context every SQL generation reads.
 *   3. {@link parseEntityShapeOrError} — the post-apply document parses as an
 *      {@link EntityShape} (the SAME predicate `whitelist.ts` + `entities.ts`
 *      validate rows through), so an amendment can never corrupt the entity into
 *      a shape the whitelist/loader would drop.
 *
 * {@link AMENDMENT_MUTABLE_FIELDS} declares, per update type, the fields the
 * apply-time mutation may copy onto an existing target — the SSOT the blind
 * `Object.assign` in `applyAmendment` is replaced with.
 */

import { z } from "zod";
import { AMENDMENT_TYPES, type AmendmentType } from "@useatlas/types";
import { EntityShape } from "@atlas/api/lib/semantic/shapes";

/** Loose sample-value element — the profiler emits strings, numbers, booleans. */
const SampleValue = z.array(z.unknown());

/**
 * Per-type payload schema for the inner `amendment` object.
 *
 * ADD types + `update_description` use `.passthrough()`: they validate the
 * known fields' types (a measure with no `sql`, or `sql` typed as a number, is
 * rejected) but tolerate legitimate extra entity attributes on a new entry.
 * `update_dimension` is `.strict()` — the only type that mutated the existing
 * element via a blind `Object.assign(target, amendment)` of the whole payload,
 * so it is the smuggle vector; strict rejects any field it does not declare
 * (notably `sql`).
 */
export const AMENDMENT_PAYLOAD_SCHEMAS: Record<AmendmentType, z.ZodTypeAny> = {
  add_dimension: z
    .object({
      name: z.string().min(1),
      sql: z.string().optional(),
      type: z.string().optional(),
      description: z.string().optional(),
      sample_values: SampleValue.optional(),
    })
    .passthrough(),
  add_measure: z
    .object({
      name: z.string().min(1),
      sql: z.string().min(1),
      type: z.string().optional(),
      description: z.string().optional(),
    })
    .passthrough(),
  add_join: z
    .object({
      name: z.string().optional(),
      target_entity: z.string().optional(),
      sql: z.string().min(1),
      description: z.string().optional(),
    })
    .passthrough(),
  add_query_pattern: z
    .object({
      name: z.string().min(1),
      sql: z.string().min(1),
      description: z.string().optional(),
    })
    .passthrough(),
  update_description: z
    .object({
      field: z.literal("table").optional(),
      dimension: z.string().optional(),
      description: z.string(),
    })
    .passthrough(),
  // The containment schema. `name` is the selector; `type` / `sample_values` /
  // `description` are the declared mutable fields (see AMENDMENT_MUTABLE_FIELDS).
  // `.strict()` rejects `sql` and any other undeclared field — a dimension
  // update can never repoint the column expression or grow beyond its type.
  update_dimension: z
    .object({
      name: z.string().min(1),
      type: z.string().optional(),
      sample_values: SampleValue.optional(),
      description: z.string().optional(),
    })
    .strict(),
  add_glossary_term: z
    .object({
      term: z.string().min(1),
      definition: z.string(),
      ambiguous: z.boolean().optional(),
    })
    .passthrough(),
  add_virtual_dimension: z
    .object({
      name: z.string().min(1),
      sql: z.string().min(1),
      type: z.string().optional(),
      description: z.string().optional(),
    })
    .passthrough(),
};

/**
 * The fields an update-type mutation may copy onto an existing target element —
 * "each amendment type declares the fields it may touch." Consumed by
 * `applyAmendment` in place of a blind `Object.assign`.
 *
 * `update_dimension`: `name` is the selector (used to FIND the target, never to
 * rename it) and `sql` is protected; only `type`, `sample_values`, and
 * `description` are refinements this type is allowed to make.
 */
export const AMENDMENT_MUTABLE_FIELDS: Partial<Record<AmendmentType, readonly string[]>> = {
  update_dimension: ["type", "sample_values", "description"],
};

export interface EmbeddedSql {
  /** The amendment field the SQL came from (for error attribution). */
  readonly field: string;
  readonly sql: string;
  /**
   * `query` — a full statement validated as-is (a query pattern).
   * `expression` — a column/aggregate expression wrapped `SELECT <expr>` before
   * validation so the shared parser sees a complete statement.
   */
  readonly kind: "query" | "expression";
}

/**
 * Collect the embedded SQL an amendment carries, by type. Dimensions, measures,
 * and virtual dimensions embed an EXPRESSION (`status`, `SUM(amount)`,
 * `EXTRACT(YEAR FROM created_at)`); a query pattern embeds a full QUERY. Joins
 * embed a relational ON-condition rather than a standalone query or expression,
 * so they are intentionally out of scope here (validating one would require
 * synthesizing a full JOIN over both tables — beyond this seam's remit).
 * `update_dimension` carries no `sql` (it is protected), so nothing is collected.
 */
export function collectEmbeddedSql(
  amendmentType: AmendmentType,
  amendment: Record<string, unknown>,
): EmbeddedSql[] {
  const sql = amendment.sql;
  if (typeof sql !== "string" || sql.trim() === "") return [];

  switch (amendmentType) {
    case "add_query_pattern":
      return [{ field: "sql", sql, kind: "query" }];
    case "add_dimension":
    case "add_measure":
    case "add_virtual_dimension":
      return [{ field: "sql", sql, kind: "expression" }];
    case "add_join":
    case "update_description":
    case "update_dimension":
    case "add_glossary_term":
      // add_join embeds a relational ON-condition (out of scope, see doc above);
      // the other three carry no executable SQL. Exhaustive by design — a new
      // SQL-bearing amendment type is a compile error here, never a silent skip.
      return [];
    default: {
      const _exhaustive: never = amendmentType;
      return _exhaustive;
    }
  }
}

/**
 * Validate the amendment payload against its type's schema. Returns a
 * model-readable reason on failure, or `null` when it parses.
 */
export function validateAmendmentPayload(
  amendmentType: AmendmentType,
  amendment: unknown,
): string | null {
  if (!AMENDMENT_TYPES.includes(amendmentType)) {
    return `Unknown amendment type "${amendmentType}".`;
  }
  if (!amendment || typeof amendment !== "object" || Array.isArray(amendment)) {
    return `The amendment payload for "${amendmentType}" must be an object.`;
  }
  const schema = AMENDMENT_PAYLOAD_SCHEMAS[amendmentType];
  const result = schema.safeParse(amendment);
  if (result.success) return null;
  const detail = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return `The ${amendmentType} payload is invalid: ${detail}`;
}

/**
 * Validate every embedded SQL an amendment carries through the shared SQL
 * validation. Returns the first failure's model-readable reason, or `null` when
 * all embedded SQL parses cleanly.
 *
 * `validateSQL` is imported dynamically so this module's static graph stays
 * light (zod + shapes + types only) — it is only pulled in when there is embedded SQL to
 * validate, matching the propose/apply seams' own dynamic-import discipline and
 * keeping the many partial `mock.module` fixtures that never validate SQL from
 * having to stub the whole `tools/sql` surface.
 */
export async function validateEmbeddedSql(
  amendmentType: AmendmentType,
  amendment: Record<string, unknown>,
  connectionId?: string,
  workspaceId?: string,
): Promise<string | null> {
  const embedded = collectEmbeddedSql(amendmentType, amendment);
  if (embedded.length === 0) return null;

  const { validateSQL } = await import("@atlas/api/lib/tools/sql");

  for (const { field, sql, kind } of embedded) {
    const candidate = kind === "expression" ? `SELECT ${sql}` : sql;
    const result = await validateSQL(candidate, connectionId, workspaceId);
    if (!result.valid) {
      return `Embedded SQL in "${field}" failed validation: ${result.error}`;
    }
  }
  return null;
}

/**
 * Parse a post-apply (or post-mutation) document against the shared
 * {@link EntityShape}. Returns a reason on failure, or `null` when it parses.
 * The same predicate `whitelist.ts` and `entities.ts` gate rows through, so a
 * document that fails here would be dropped by the loader/whitelist anyway —
 * this catches an amendment that corrupted the entity BEFORE it lands, instead
 * of silently disappearing the entity later.
 */
export function parseEntityShapeOrError(doc: unknown): string | null {
  const result = EntityShape.safeParse(doc);
  if (result.success) return null;
  const detail = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return `the document does not parse as a semantic entity (${detail})`;
}
