/**
 * Elasticsearch `_mapping` → semantic-layer entity transform.
 *
 * A PURE, dependency-free module (no SDK, no `fetch`, no `@atlas/api`, no
 * `js-yaml`): it turns the JSON returned by `GET /_mapping` into entity-doc
 * objects that match the `semantic/entities/*.yml` shape Atlas profiles SQL
 * datasources into. The CLU profiler (`atlas init` / `atlas diff`) fetches the
 * mapping via the thin client and serializes these objects to YAML.
 *
 * Why a dedicated transform (rather than reusing the SQL `generateEntityYAML`):
 * Elasticsearch has no rows/PKs/FKs and its query surface is Elasticsearch SQL,
 * for which the SQL profiler's generated virtual dimensions (correlated
 * `PERCENTILE_CONT` sub-queries, Postgres `EXTRACT`/`TO_CHAR`) are invalid. The
 * mapping is a typed field tree — scalar, object, `nested`, multi-field, and
 * date — and the faithful, queryable representation is one dimension per
 * flattened field path.
 *
 * Field flattening rules:
 *   - scalar (`{ type: "keyword" }`)        → one dimension at its path
 *   - object (`{ properties: {...} }`)      → recurse; dotted child paths, no
 *                                             dimension for the container itself
 *   - nested (`{ type: "nested", props }`)  → recurse; descendants flagged
 *                                             `nested: true` (array semantics)
 *   - multi-field (`{ type, fields: {...} }`) → the main field plus one
 *                                             dimension per sub-field
 *                                             (e.g. `title.keyword`), flagged
 *                                             `multi_field: true`
 *   - date / date_nanos                     → semantic type `timestamp`
 */

// ---------------------------------------------------------------------------
// Raw ES `_mapping` JSON types (untrusted — the transform narrows defensively)
// ---------------------------------------------------------------------------

/** A single mapping property node. Object/nested nodes carry `properties`;
 *  leaf nodes carry a scalar `type` and optionally multi-`fields`. */
export interface EsProperty {
  type?: string;
  properties?: Record<string, EsProperty>;
  fields?: Record<string, EsProperty>;
}

/** The per-index body of a `_mapping` response (ES 7+ typeless mappings). */
export interface EsIndexMapping {
  mappings?: { properties?: Record<string, EsProperty> };
}

/** Full `GET /_mapping` (or `GET /<index>/_mapping`) response, keyed by index. */
export type EsMappingResponse = Record<string, EsIndexMapping>;

// ---------------------------------------------------------------------------
// Semantic-layer output types (subset of the entity YAML shape)
// ---------------------------------------------------------------------------

/** Semantic dimension type vocabulary the agent reasons over. */
export type EsDimensionType = "string" | "number" | "boolean" | "timestamp";

/** A flattened leaf field from the mapping tree. */
export interface FlatEsField {
  /** Dotted field path, e.g. `vendor.name` or `title.keyword`. */
  path: string;
  /** Original Elasticsearch field type (`keyword`, `scaled_float`, `date`…). */
  esType: string;
  /** Mapped semantic dimension type. */
  type: EsDimensionType;
  /** True for a multi-field sub-field (e.g. the `.keyword` of a `text` field). */
  multiField: boolean;
  /** True when the field lives under a `nested` object (array semantics). */
  nested: boolean;
}

/** One emitted entity dimension. Extra keys (`es_type`, `multi_field`,
 *  `nested`) are provenance the agent + humans can read; the diff + whitelist
 *  ignore them and key off `name` / `type`. */
export interface EsDimension {
  name: string;
  sql: string;
  type: EsDimensionType;
  es_type: string;
  description?: string;
  multi_field?: boolean;
  nested?: boolean;
}

/** An entity doc in the `semantic/entities/*.yml` shape (ES subset). */
export interface EsEntityDoc {
  name: string;
  type: "fact_table";
  /** Index name — the SQL whitelist + `FROM` qualifier. */
  table: string;
  /** Connection-group scope (ADR-0012). Omitted for the default group. */
  group?: string;
  grain: string;
  description: string;
  dimensions: EsDimension[];
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

const NUMERIC_ES_TYPES = new Set([
  "long",
  "integer",
  "short",
  "byte",
  "double",
  "float",
  "half_float",
  "scaled_float",
  "unsigned_long",
]);

const DATE_ES_TYPES = new Set(["date", "date_nanos"]);

/**
 * Map an Elasticsearch field type to a semantic dimension type. Numeric and
 * date families are recognized explicitly; `boolean` is exact; everything else
 * (`text`, `keyword`, `ip`, and unsupported types like `geo_point`) maps to
 * `string`, the safe default for a discoverable, groupable dimension.
 */
export function mapEsFieldType(esType: string): EsDimensionType {
  if (esType === "boolean") return "boolean";
  if (DATE_ES_TYPES.has(esType)) return "timestamp";
  if (NUMERIC_ES_TYPES.has(esType)) return "number";
  return "string";
}

// ---------------------------------------------------------------------------
// Flatten
// ---------------------------------------------------------------------------

function walk(
  props: Record<string, EsProperty> | undefined,
  prefix: string,
  nested: boolean,
  out: FlatEsField[],
): void {
  if (!props || typeof props !== "object") return;

  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (!prop || typeof prop !== "object") continue;

    const path = prefix ? `${prefix}.${key}` : key;

    // Object / nested container: recurse, emit no dimension for the container.
    if (prop.properties) {
      walk(prop.properties, path, nested || prop.type === "nested", out);
      continue;
    }

    // Scalar leaf.
    if (typeof prop.type === "string") {
      out.push({
        path,
        esType: prop.type,
        type: mapEsFieldType(prop.type),
        multiField: false,
        nested,
      });

      // Multi-fields (e.g. `title.keyword`) — secondary, exact-match/aggregatable.
      if (prop.fields && typeof prop.fields === "object") {
        for (const subKey of Object.keys(prop.fields)) {
          const sub = prop.fields[subKey];
          if (sub && typeof sub.type === "string") {
            out.push({
              path: `${path}.${subKey}`,
              esType: sub.type,
              type: mapEsFieldType(sub.type),
              multiField: true,
              nested,
            });
          }
        }
      }
    }
    // else: neither `type` nor `properties` — unsupported/malformed node, skip.
  }
}

/**
 * Flatten an Elasticsearch mapping `properties` tree into a list of leaf
 * fields with dotted paths. Pure and deterministic (preserves key order).
 */
export function flattenMapping(
  properties?: Record<string, EsProperty>,
): FlatEsField[] {
  const out: FlatEsField[] = [];
  walk(properties, "", false, out);
  return out;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/**
 * Derive a PascalCase entity name from an index name. Index names allow `-`,
 * `.`, and `_`; each becomes a word boundary. Falls back to `Index` if the name
 * has no alphanumeric content (the `table:` field always keeps the raw index).
 */
export function indexToEntityName(index: string): string {
  const name = index
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return name || "Index";
}

/** True for Elasticsearch system/hidden indices (dot-prefixed, e.g. `.kibana`). */
export function isSystemIndex(index: string): boolean {
  return index.startsWith(".");
}

// ---------------------------------------------------------------------------
// Entity builders
// ---------------------------------------------------------------------------

function describeField(field: FlatEsField): string | undefined {
  if (field.multiField) {
    return `Multi-field sub-field (${field.esType}) — exact-match / aggregation variant.`;
  }
  if (field.nested) {
    return `Field within a nested object — has array semantics.`;
  }
  return undefined;
}

function toDimension(field: FlatEsField): EsDimension {
  const dim: EsDimension = {
    name: field.path,
    sql: field.path,
    type: field.type,
    es_type: field.esType,
  };
  if (field.multiField) dim.multi_field = true;
  if (field.nested) dim.nested = true;
  const description = describeField(field);
  if (description) dim.description = description;
  return dim;
}

/**
 * Build an entity doc from a single index's mapping. Returns `null` when the
 * index has no flattenable fields (an empty / property-less mapping), so the
 * caller can skip emitting a useless field-less entity.
 */
export function mappingToEntity(
  index: string,
  indexMapping: EsIndexMapping,
  opts?: { group?: string },
): EsEntityDoc | null {
  const fields = flattenMapping(indexMapping?.mappings?.properties);
  if (fields.length === 0) return null;

  const entity: EsEntityDoc = {
    name: indexToEntityName(index),
    type: "fact_table",
    table: index,
    ...(opts?.group ? { group: opts.group } : {}),
    grain: `one row per document in the ${index} index`,
    description: `Elasticsearch index "${index}" profiled from its mapping. Contains ${fields.length} field${fields.length === 1 ? "" : "s"}.`,
    dimensions: fields.map(toDimension),
  };

  return entity;
}

/**
 * Transform a full `_mapping` response into entity docs — one per index.
 * System (dot-prefixed) and field-less indices are skipped by default.
 */
export function mappingsToEntities(
  response: EsMappingResponse,
  opts?: { group?: string; includeSystem?: boolean },
): EsEntityDoc[] {
  const includeSystem = opts?.includeSystem ?? false;
  const out: EsEntityDoc[] = [];

  for (const index of Object.keys(response ?? {})) {
    if (!includeSystem && isSystemIndex(index)) continue;
    const entity = mappingToEntity(
      index,
      response[index],
      opts?.group ? { group: opts.group } : undefined,
    );
    if (entity) out.push(entity);
  }

  return out;
}
