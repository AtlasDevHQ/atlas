/**
 * Canonical group-scoped identity for a semantic amendment (#4507).
 *
 * The tuple `(group, entity, amendmentType, target)` identifies *what* an
 * amendment changes, independent of *when* it was proposed. It is the single
 * key used for three things that must never diverge:
 *
 *   1. Permanent rejection memory — a rejected identity is refused on
 *      re-proposal at insert time (`insertSemanticAmendment`), on every path
 *      (chat tool, scheduler, CLI).
 *   2. Pending dedup — a re-proposed *pending* change converges on the
 *      existing row instead of queuing a duplicate; the key is the row's
 *      storage key (`pattern_sql`).
 *   3. Staleness dampening in the analyzer (`expert/categories.ts`) — a
 *      rejected identity scores lower (rejection memory is permanent — no
 *      time window, so this is "ever-rejected", not "recently-rejected").
 *
 * Lives in its own leaf module (no imports) so the DB layer
 * (`db/internal.ts`), the analyzer (`expert/categories.ts`,
 * `expert/context-loader.ts`), and the CLI can all import the same formula
 * without dragging each other's surface into their test fixtures — the
 * mechanical guarantee that "group-scoped keys everywhere" cannot drift back
 * apart. Mirrors the sibling `dedup-key.ts`.
 */

/** The stored-row inputs needed to reconstruct an amendment's identity. */
export interface AmendmentIdentityRow {
  sourceEntity: string;
  connectionGroupId: string | null;
  /** `learned_patterns.amendment_payload` — JSON string or already-parsed. */
  amendmentPayload: string | Record<string, unknown> | null;
}

/**
 * The semantic *target* that distinguishes one amendment from another of the
 * same type on the same entity. Each amendment type stores its target under a
 * different field, so a single `.name` read would collapse distinct changes
 * (e.g. a table-description edit and a dimension-description edit) into one
 * identity — turning the permanent rejection guard into an over-broad block.
 * This mirrors, per type, the `name` the analyzer keys staleness on
 * (`expert/categories.ts`), so an identity reconstructed from a stored row
 * matches the identity the analyzer computed for the same finding.
 *
 * `add_query_pattern` is intentionally coarse (no target): the generated
 * pattern name carries a per-run index and is not a stable identity, so the
 * analyzer keys all query-pattern proposals for an entity as one — matched
 * here by returning `undefined`.
 */
export function amendmentTargetName(
  amendmentType: string,
  amendment: unknown,
): string | undefined {
  if (!amendment || typeof amendment !== "object" || Array.isArray(amendment)) {
    return undefined;
  }
  const a = amendment as Record<string, unknown>;
  switch (amendmentType) {
    case "add_query_pattern":
      return undefined;
    case "update_description":
      // Table-level edits key on the field ("table"); dimension-level edits
      // key on the dimension name.
      if (typeof a.field === "string") return a.field;
      if (typeof a.dimension === "string") return a.dimension;
      return undefined;
    case "add_glossary_term":
    case "update_glossary_term":
      return typeof a.term === "string" ? a.term : undefined;
    default:
      return typeof a.name === "string" ? a.name : undefined;
  }
}

/**
 * Amendment types whose identity binds to the group's single glossary document
 * rather than the host entity the term was found under (#4518). Inlined — this
 * leaf module imports nothing — mirroring `isGlossaryAmendmentType` in
 * `expert/apply.ts`; the literal `"glossary"` below mirrors `GLOSSARY_DOC_NAME`.
 */
function isGlossaryIdentityType(amendmentType: string): boolean {
  return amendmentType === "add_glossary_term" || amendmentType === "update_glossary_term";
}

/**
 * Build the canonical identity key. A NULL/absent group maps to `"default"`
 * (ADR-0012 flat group), matching `entity.group` in the analyzer so one
 * group's rejection never suppresses another group's same-named amendment.
 * The target is omitted when absent (e.g. coarse query-pattern identities).
 *
 * Glossary amendments bind to the group's ONE glossary document (`name =
 * "glossary"`), so their identity is host-entity-agnostic (#4518): the same
 * `(group, term)` is a single identity no matter which entity surfaced the
 * term. Keying a glossary amendment on the host entity would leak — a rejection
 * of "MRR" proposed under `orders` would not suppress "MRR" under `customers`,
 * and pending dedup would queue two rows that both upsert the identical term
 * into the same per-group glossary. Collapsing the entity component to the
 * fixed `"glossary"` document name closes that leak; `amendmentType` stays in
 * the key, so an `add`- and `update_glossary_term` for the same term remain
 * distinct verbs (as `add_`/`update_dimension` are).
 */
export function amendmentIdentityKey(
  group: string | null | undefined,
  entity: string,
  amendmentType: string,
  target?: string | null,
): string {
  const g = group ?? "default";
  const e = isGlossaryIdentityType(amendmentType) ? "glossary" : entity;
  return `${g}:${e}:${amendmentType}${target ? `:${target}` : ""}`;
}

/**
 * Reconstruct the identity key from a stored `learned_patterns` amendment row.
 * Returns `null` when the payload is malformed or missing an `amendmentType`
 * (an unreconstructable row is never treated as matching any identity).
 */
export function amendmentIdentityFromRow(row: AmendmentIdentityRow): string | null {
  let payload: unknown = row.amendmentPayload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // intentionally ignored: malformed payload — cannot reconstruct identity
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const amendmentType = p.amendmentType;
  if (typeof amendmentType !== "string" || amendmentType.length === 0) return null;
  return amendmentIdentityKey(
    row.connectionGroupId,
    row.sourceEntity,
    amendmentType,
    amendmentTargetName(amendmentType, p.amendment),
  );
}
