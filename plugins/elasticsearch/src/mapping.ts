/**
 * Elasticsearch `_mapping` → semantic-layer entity transform.
 *
 * A PURE, dependency-free module (no SDK, no `fetch`, no `@atlas/api`, no
 * `js-yaml`): it turns the JSON returned by `GET /_mapping` into entity-doc
 * objects that match the `semantic/entities/*.yml` shape Atlas profiles SQL
 * datasources into. The CLI profiler (`atlas init` / `atlas diff`) fetches the
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

/** Per-index body of a `GET /_alias` response: the aliases pointing at it. */
export interface EsAliasIndexEntry {
  aliases?: Record<string, unknown>;
}

/** Full `GET /_alias` response, keyed by concrete index → its aliases (#3269). */
export type EsAliasResponse = Record<string, EsAliasIndexEntry>;

/** One data stream from `GET /_data_stream` (the subset the profiler reads). */
export interface EsDataStreamEntry {
  name?: string;
  /** Backing (`.ds-…`) indices, newest last. Hidden — omitted from `GET /_mapping`. */
  indices?: { index_name?: string }[];
}

/** Full `GET /_data_stream` response (#3269). */
export interface EsDataStreamResponse {
  data_streams?: EsDataStreamEntry[];
}

/**
 * The kind of logical source an entity represents. A concrete `index` is the
 * single-index case; `pattern` (`logs-*`), `alias`, and `data_stream` each
 * collapse multiple backing indices into ONE queryable entity (#3269).
 */
export type EsLogicalKind = "index" | "pattern" | "alias" | "data_stream";

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
 *  ignore them and key off `name` / `type`. The `name` / `sql` / `type` keys are
 *  coupled by convention to what {@link "../../../packages/cli/lib/diff".parseEntityYAML}
 *  reads back — the round-trip test in `__tests__/mapping.test.ts` enforces it. */
export interface EsDimension {
  name: string;
  /** Raw, unescaped ES field path (dotted). The SQL whitelist gates on the
   *  index (`table`), not dimension names, but the `executeSQL` surface (#3262)
   *  must treat this as untrusted when composing `SELECT`/`FROM`. */
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
  /** Non-empty by construction: {@link mappingToEntity} returns `null` rather
   *  than emit a field-less entity. The type permits `[]`, so a second
   *  constructor must uphold this — a zero-dimension entity would register in
   *  the SQL whitelist with no queryable columns. */
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
  // `indexMapping` is an unchecked cast over untrusted `_mapping` JSON
  // (`getMapping` does `as EsMappingResponse`). The optional-chain below plus
  // `walk`'s `typeof … === "object"` guard are the ONLY runtime narrowing — a
  // refactor that moves field extraction off `flattenMapping`/`walk` must
  // re-establish that guard.
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

// ---------------------------------------------------------------------------
// Logical sources: aliases, data streams, and index patterns (#3269)
// ---------------------------------------------------------------------------

/**
 * Parse `GET /_alias` into `alias → set of backing concrete indices`. Defensive
 * over untrusted JSON: a body that isn't the `{ <index>: { aliases: {…} } }`
 * shape (e.g. a `_mapping` body handed in by mistake) yields an empty map rather
 * than throwing. System aliases (dot-prefixed) are skipped unless asked for.
 */
export function parseAliases(
  response: EsAliasResponse | undefined,
  opts?: { includeSystem?: boolean },
): Map<string, Set<string>> {
  const includeSystem = opts?.includeSystem ?? false;
  const out = new Map<string, Set<string>>();
  if (!response || typeof response !== "object") return out;

  for (const index of Object.keys(response)) {
    const aliases = response[index]?.aliases;
    if (!aliases || typeof aliases !== "object") continue;
    for (const alias of Object.keys(aliases)) {
      if (!includeSystem && isSystemIndex(alias)) continue;
      const set = out.get(alias) ?? new Set<string>();
      set.add(index);
      out.set(alias, set);
    }
  }
  return out;
}

/**
 * Parse `GET /_data_stream` into `data-stream name → set of backing `.ds-…`
 * indices`. Defensive: a body without the `{ data_streams: [...] }` shape yields
 * an empty map. System streams (dot-prefixed) are skipped unless asked for.
 */
export function parseDataStreams(
  response: EsDataStreamResponse | undefined,
  opts?: { includeSystem?: boolean },
): Map<string, Set<string>> {
  const includeSystem = opts?.includeSystem ?? false;
  const out = new Map<string, Set<string>>();
  const list = response?.data_streams;
  if (!Array.isArray(list)) return out;

  for (const ds of list) {
    const name = typeof ds?.name === "string" ? ds.name : "";
    if (!name) continue;
    if (!includeSystem && isSystemIndex(name)) continue;
    const set = new Set<string>();
    for (const entry of Array.isArray(ds.indices) ? ds.indices : []) {
      const indexName = typeof entry?.index_name === "string" ? entry.index_name : "";
      if (indexName) set.add(indexName);
    }
    out.set(name, set);
  }
  return out;
}

/**
 * `<base>-<suffix>` where the suffix is a date (`2024`, `2024.01`, `2024.01.01`,
 * `2024-01-01` — `.` or `-` separated) or a rollover sequence (`000001`). The
 * date alternative is matched BEFORE the bare-number one so a dash-separated date
 * (whose own internal `-`s would otherwise fool a last-dash split) is captured
 * whole. `base` is non-greedy so the leftmost dash that yields a valid suffix
 * wins (`filebeat-7.10.0-2024.01.01` → base `filebeat-7.10.0`). Index names are
 * short (ES caps them at 255 bytes), so the bounded backtracking is safe.
 */
const PATTERN_SUFFIX_RE = /^(.+?)-(\d{4}([.-]\d{2}){0,2}|\d{4,})$/;

/**
 * Derive the shared base of a time-/rollover-partitioned index, or `null` when
 * the name carries no such suffix:
 *   - `logs-2024.01.01` / `logs-2024-01-01` → `logs`
 *   - `metrics-000001`         → `metrics`
 *   - `filebeat-7.10.0-2024.01.01` → `filebeat-7.10.0`
 *   - `orders` / `products` / `logs-prod` → `null` (not a pattern member)
 */
export function indexPatternBase(index: string): string | null {
  const match = PATTERN_SUFFIX_RE.exec(index);
  return match ? match[1] : null;
}

/**
 * Collapse a list of concrete index names into `pattern → member indices`. Two
 * or more indices sharing a {@link indexPatternBase} become a `<base>-*` pattern;
 * a lone dated index (no sibling) is left for the caller to emit as a concrete
 * index, so a single day of logs isn't surprisingly hidden behind a wildcard.
 */
export function detectIndexPatterns(indexNames: string[]): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  for (const name of indexNames) {
    const base = indexPatternBase(name);
    if (!base) continue;
    const list = byBase.get(base) ?? [];
    list.push(name);
    byBase.set(base, list);
  }

  const patterns = new Map<string, string[]>();
  for (const [base, members] of byBase) {
    if (members.length >= 2) patterns.set(`${base}-*`, members);
  }
  return patterns;
}

/** Union the flattened leaf fields across several indices' mappings, first-seen
 *  type wins (members of a pattern/alias/data-stream share a template). */
function unionFlatFields(
  indices: string[],
  response: EsMappingResponse,
): FlatEsField[] {
  const seen = new Set<string>();
  const out: FlatEsField[] = [];
  for (const index of indices) {
    for (const field of flattenMapping(response?.[index]?.mappings?.properties)) {
      if (seen.has(field.path)) continue;
      seen.add(field.path);
      out.push(field);
    }
  }
  return out;
}

/** Human grain + description for a logical (multi-index) entity. */
function logicalCopy(
  kind: Exclude<EsLogicalKind, "index">,
  name: string,
  memberCount: number,
  fieldCount: number,
): { grain: string; description: string } {
  const noun =
    kind === "pattern" ? "index pattern" : kind === "alias" ? "alias" : "data stream";
  const members = `${memberCount} backing ${memberCount === 1 ? "index" : "indices"}`;
  const fields = `${fieldCount} field${fieldCount === 1 ? "" : "s"}`;
  return {
    grain: `one row per document across the ${name} ${noun}`,
    description: `Elasticsearch ${noun} "${name}" (${members}), profiled from the union of their mappings. Contains ${fields}.`,
  };
}

/**
 * Build a single logical entity (pattern / alias / data stream) from the union
 * of its member indices' mappings. Returns `null` when the union has no fields
 * (every backing index is empty / unmapped), so the caller skips a field-less
 * entity — mirroring {@link mappingToEntity}. The entity's `table` is the
 * LOGICAL name (`logs-*`, the alias, or the stream), which is exactly what both
 * query surfaces and the whitelist key on (#3269).
 */
export function buildLogicalEntity(opts: {
  name: string;
  kind: Exclude<EsLogicalKind, "index">;
  memberIndices: string[];
  response: EsMappingResponse;
  group?: string;
}): EsEntityDoc | null {
  const fields = unionFlatFields(opts.memberIndices, opts.response);
  if (fields.length === 0) return null;

  const { grain, description } = logicalCopy(
    opts.kind,
    opts.name,
    opts.memberIndices.length,
    fields.length,
  );
  return {
    name: indexToEntityName(opts.name),
    type: "fact_table",
    table: opts.name,
    ...(opts.group ? { group: opts.group } : {}),
    grain,
    description,
    dimensions: fields.map(toDimension),
  };
}

/** The cluster shape `mappingsToLogicalEntities` consumes (#3269). */
export interface LogicalProfilingInput {
  /** `GET /_mapping` — concrete indices (powers patterns, aliases, standalone). */
  mapping: EsMappingResponse;
  /** `GET /_alias` — alias → backing indices. */
  aliases?: EsAliasResponse;
  /** `GET /_data_stream` — data streams → backing `.ds-…` indices. */
  dataStreams?: EsDataStreamResponse;
  /**
   * Mappings of the data streams' `.ds-…` backing indices, fetched SEPARATELY:
   * the default `GET /_mapping` omits hidden backing indices, so the profiler
   * fetches `GET /<stream>/_mapping` per stream and merges the results here.
   */
  dataStreamMapping?: EsMappingResponse;
}

/**
 * Transform a cluster's mapping + alias + data-stream metadata into entity docs,
 * representing time-partitioned indices as ONE logical entity (#3269). Each
 * concrete index is claimed by at most one entity, resolved in this precedence:
 *
 *   1. **Data streams** — explicit logical sources; their `.ds-…` backing
 *      indices are claimed and their fields come from `dataStreamMapping`.
 *   2. **Aliases** — explicit logical sources; backing indices claimed, fields
 *      unioned from the main `mapping`.
 *   3. **Index patterns** — `<base>-*` detected from the remaining (unclaimed,
 *      non-system) indices, ≥2 members (see {@link detectIndexPatterns}).
 *   4. **Standalone indices** — whatever is left, emitted exactly as
 *      {@link mappingsToEntities} would (byte-identical to the pre-#3269 output).
 */
export function mappingsToLogicalEntities(
  input: LogicalProfilingInput,
  opts?: { group?: string; includeSystem?: boolean },
): EsEntityDoc[] {
  const includeSystem = opts?.includeSystem ?? false;
  const group = opts?.group;
  const mapping = input.mapping ?? {};
  const out: EsEntityDoc[] = [];
  // Concrete indices already represented by a logical entity — never re-emitted.
  const claimed = new Set<string>();

  // 1. Data streams.
  const dataStreams = parseDataStreams(input.dataStreams, { includeSystem });
  const dataStreamMapping = input.dataStreamMapping ?? {};
  for (const [name, indices] of dataStreams) {
    const members = [...indices];
    for (const m of members) claimed.add(m);
    const entity = buildLogicalEntity({
      name,
      kind: "data_stream",
      memberIndices: members,
      response: dataStreamMapping,
      ...(group ? { group } : {}),
    });
    if (entity) out.push(entity);
  }

  // 2. Aliases (a name colliding with a data stream defers to the stream).
  const aliases = parseAliases(input.aliases, { includeSystem });
  for (const [name, indices] of aliases) {
    if (dataStreams.has(name)) continue;
    const members = [...indices];
    for (const m of members) claimed.add(m);
    const entity = buildLogicalEntity({
      name,
      kind: "alias",
      memberIndices: members,
      response: mapping,
      ...(group ? { group } : {}),
    });
    if (entity) out.push(entity);
  }

  // 3. Patterns from the remaining concrete indices.
  const remaining = Object.keys(mapping).filter(
    (idx) => (includeSystem || !isSystemIndex(idx)) && !claimed.has(idx),
  );
  for (const [pattern, members] of detectIndexPatterns(remaining)) {
    for (const m of members) claimed.add(m);
    const entity = buildLogicalEntity({
      name: pattern,
      kind: "pattern",
      memberIndices: members,
      response: mapping,
      ...(group ? { group } : {}),
    });
    if (entity) out.push(entity);
  }

  // 4. Standalone concrete indices (existing behavior, unchanged).
  for (const index of Object.keys(mapping)) {
    if (!includeSystem && isSystemIndex(index)) continue;
    if (claimed.has(index)) continue;
    const entity = mappingToEntity(index, mapping[index], group ? { group } : undefined);
    if (entity) out.push(entity);
  }

  return out;
}

/**
 * Filesystem-safe slug for an entity's YAML filename. A concrete index name is
 * already safe and passes through unchanged (back-compat with pre-#3269 files);
 * a pattern's `*` / `?` and any other unsafe character are replaced, so
 * `logs-*` → `logs-star`. The slug is for the FILENAME only — the entity's
 * `table` keeps the literal logical name the query surfaces use.
 */
export function entityFileSlug(table: string): string {
  return table
    .replace(/\*/g, "star")
    .replace(/\?/g, "q")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}
