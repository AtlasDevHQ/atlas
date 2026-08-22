/**
 * Shared Zod shapes for semantic-layer YAML rows.
 *
 * Lives outside `whitelist.ts` and `entities.ts` so both modules validate
 * row YAML through the same predicate. Without this shared module, the
 * caller-facing summary surface (`listEntities`) and the SQL whitelist
 * (`loadOrgWhitelist`) could drift on what counts as "valid enough to
 * surface to the agent" — exactly the #2142 class.
 */

import * as path from "path";
import { z } from "zod";

/**
 * Allowlist regex for a semantic-layer row name (the upsert key stored in
 * `semantic_entities.name`). Permits letters, digits, underscores, hyphens,
 * and dots — the characters that appear in schema-qualified SQL identifiers
 * (`public.orders`) and filesystem-safe table names. Reused by:
 *
 * - The wizard `/save` path-traversal guard (wizard.ts)
 * - The `artifactRowName` guard in SemanticGenerator (semantic-generator.ts)
 *
 * Exporting from the shared shapes module keeps both write paths consistent
 * and avoids independent regex drift.
 */
export const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;

/**
 * Derive the `semantic_entities.name` upsert key for a generated artifact's
 * logical table name, or `null` when the name can't be made safe.
 *
 * `path.basename` strips any path-traversal segment (a `/`-bearing name),
 * leaving a path-safe identifier; a schema-qualified dotted name like
 * `public.orders` is preserved verbatim (no slash to strip), which keeps two
 * same-named tables in different schemas distinct. Two inputs that share a
 * basename across differing path prefixes (`a/orders`, `b/orders`) are
 * intentionally coalesced to the same row key — generated table names are flat
 * identifiers, not paths, so this only bites pathological inputs that the
 * generator does not produce. The result must then pass {@link SAFE_TABLE_NAME}
 * — defense-in-depth against characters that would never survive DB validation
 * anyway. Returns `null` for names that fail the check; callers MUST filter
 * those artifacts out and log the skip (never silently swallow).
 *
 * This is the single source of truth for how a generated table name becomes a
 * semantic-store row key, shared by BOTH durable write paths —
 * `SemanticGenerator.persist` (MCP, via `artifactRowName`) and the wizard
 * `/save` handler — so the two can't drift on the upsert key (#3550).
 */
export function safeSemanticRowName(table: string): string | null {
  const name = path.basename(table);
  return SAFE_TABLE_NAME.test(name) ? name : null;
}

/**
 * Core entity shape — validates the table name and the Connection-group
 * scope. `group` is the canonical scope field (ADR-0012); `connection` is
 * its deprecated alias, still parsed for back-compat.
 */
export const EntityShape = z
  .object({
    table: z.string(),
    group: z.string().optional(),
    connection: z.string().optional(),
    /**
     * How `table` is interpreted when deriving whitelist keys (#3317).
     * - `"sql"` (default when omitted) — a dot-qualified SQL identifier
     *   (`schema.table`); the loader also registers the unqualified last
     *   segment so `FROM orders` matches `public.orders`.
     * - `"opaque"` — a literal datasource identifier (e.g. an Elasticsearch
     *   index / alias / data-stream name) where `.` is an ordinary character;
     *   the loader registers the full name only and never dot-splits it.
     */
    identifier_style: z.enum(["sql", "opaque"]).optional(),
    /**
     * WHICH ROWS OF `table` COUNT AS THIS ENTITY — a raw SQL predicate (#5329).
     *
     * ⚠️ **ONE CONSUMER APPLIES IT TODAY: the warehouse producer**
     * (`buildSnapshotSql`). Stated because the honest scope is narrower than the
     * sentence a reader wants this to be. Agent-generated SQL over the same
     * whitelisted table, `search.ts`'s sample values and the connection profiler
     * all still read every row, so this key does not yet mean *"nothing in Atlas
     * sees a filtered-out row"* — it means the producer does not mint durable
     * identity from one. A second consumer has to opt in explicitly; none is
     * carried along by declaring this here.
     *
     * `filter: "deleted_at IS NULL"` states that *an organization means a
     * non-deleted organization*. That is a claim about what the entity IS, which
     * is why it lives in the layer beside `table` rather than on any one
     * consumer's enrollment — the alternative splits the entity's meaning across
     * two places and leaves the second invisible to everyone else.
     *
     * ⚠️ **A PREDICATE, interpolated — never a value.** No bind parameter can
     * carry a `WHERE` fragment, so this sits on exactly the trust boundary a
     * dimension's `sql:` already sits on: the semantic layer is admin-authored,
     * and every statement built from it still passes the product's SELECT-only,
     * single-statement, whitelist-scoped gate before it reaches a datasource.
     * Declaring it here does not grant it any trust the gate does not.
     *
     * ⚠️ **DECLARED, never inferred.** Detecting a `deleted_at`-shaped column by
     * name is the guess `buildWarehouseClaims` already refuses for the subject
     * position, and for the same reason: a wrong guess is silent and reads as
     * success.
     *
     * Optional, and its absence means the whole table — every entity written
     * before this key existed reads exactly as it did.
     *
     * ⚠️ Distinct from the `filters` REQUEST parameter `metric-run.ts` refuses
     * (`kind: "filters_unsupported"`). That one is a caller narrowing a metric at
     * run time; this is the entity's own definition, fixed in the document.
     */
    filter: z.string().optional(),
  })
  .passthrough();

export type EntityShapeT = z.infer<typeof EntityShape>;

/**
 * Core glossary-document shape — the post-apply gate a glossary Amendment must
 * pass, mirroring {@link EntityShape}'s role for entities (#4518). A glossary
 * document is `{ terms: … }` where `terms` is either the canonical object map
 * (`terms: { <name>: {...} }`) or the legacy array form (`terms: [{ term, … }]`);
 * both are honored by every loader (`search.ts`, `lookups.ts`, `context-loader.ts`).
 * `terms` is optional so a brand-new (empty `{}`) glossary — the baseline when a
 * group has no glossary yet — still parses, and `.passthrough()` tolerates any
 * incidental top-level keys. The gate exists so an amendment can never corrupt
 * the glossary into a shape (e.g. a scalar `terms`) the loaders would silently
 * drop.
 */
export const GlossaryShape = z
  .object({
    terms: z
      .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
      .optional(),
  })
  .passthrough();

export type GlossaryShapeT = z.infer<typeof GlossaryShape>;
