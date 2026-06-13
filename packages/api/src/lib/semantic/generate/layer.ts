/**
 * Shared semantic-layer assembly — one engine, every caller.
 *
 * `generateSemanticLayer` turns an array of **already-analyzed** `TableProfile`s
 * into the full set of in-memory semantic-layer artifacts (entity YAMLs, the
 * catalog, the glossary, and per-table metric YAMLs) without touching the
 * filesystem. Callers decide where the bytes land:
 *
 *  - the CLI (`atlas init`) writes them to `semantic/.../` on disk;
 *  - the `SemanticGenerator` Effect service (Blocker #1, #3506) returns them to
 *    a programmatic / MCP caller and registers their tables into the whitelist.
 *
 * Before this module the entity/catalog/glossary/metric loop was hand-inlined
 * in three places (CLI SQL path, CLI CSV/Parquet path, the web wizard), so the
 * filename + ordering conventions could silently drift. Centralizing the
 * assembly keeps "what each caller produces" identical by construction.
 *
 * Pure + deterministic: it composes the existing `generate*` functions
 * (`./yaml`) and performs no I/O, no LLM, no DB access. It expects profiles to
 * have already passed through {@link analyzeTableProfiles} (the heuristics that
 * populate inferred FKs, table flags, enum detection) — generation does not
 * re-run them.
 */

import path from "node:path";
import type { TableProfile } from "@useatlas/types";
import type { DBType } from "@atlas/api/lib/db/connection";
import {
  generateEntityYAML,
  generateCatalogYAML,
  generateGlossaryYAML,
  generateMetricYAML,
} from "./yaml";

/**
 * Derive the on-disk filename for a table's artifact, stripping any path
 * components a table name might smuggle in. Callers write `fileName` straight
 * into `path.join(dir, fileName)`, so sanitizing here makes the field
 * traversal-safe by construction for *every* caller (the CLI profiles a trusted
 * local DB; a future MCP datasource tool profiles caller-supplied connections).
 * `path.basename` leaves ordinary identifiers — including dotted ones like
 * `public.orders` — untouched.
 */
function artifactFileName(tableName: string): string {
  return `${path.basename(tableName)}.yml`;
}

/** A single generated YAML artifact and the filename callers should write it to. */
export interface GeneratedArtifact {
  /** Logical table name the artifact describes (e.g. `orders`, `public.orders`). */
  table: string;
  /**
   * Filename to write the artifact to, e.g. `orders.yml`. Path-component-safe
   * by construction (`path.basename`), so callers can `path.join` it directly
   * without re-sanitizing.
   */
  fileName: string;
  /** Rendered YAML content. */
  yaml: string;
}

/** The complete set of semantic-layer artifacts for one datasource. */
export interface GeneratedSemanticLayer {
  /** One entity YAML per profile, in profile order. */
  entities: GeneratedArtifact[];
  /** `catalog.yml` content. */
  catalog: string;
  /** `glossary.yml` content. */
  glossary: string;
  /**
   * One metric YAML per profile that yields measures, in profile order.
   * Profiles for which {@link generateMetricYAML} returns `null` (views,
   * no numeric columns) are omitted — mirroring the CLI's existing behavior.
   */
  metrics: GeneratedArtifact[];
}

/** Options controlling how the semantic layer is rendered. */
export interface GenerateSemanticLayerOptions {
  /** Datasource dialect — drives type mapping and `FROM` qualification. */
  dbType: DBType;
  /** Schema used to qualify table names. Defaults to `"public"`. */
  schema?: string;
  /**
   * Connection-group identifier emitted as the entity `connection:` field.
   * Omit (or pass `undefined`) for the default group, which emits no field.
   */
  sourceId?: string;
}

/**
 * Assemble the full semantic layer for a set of analyzed profiles.
 *
 * @param profiles - Analyzed `TableProfile`s (post-{@link analyzeTableProfiles}).
 * @param opts - Dialect, schema, and connection-group context.
 * @returns In-memory entity/catalog/glossary/metric artifacts. No I/O.
 */
export function generateSemanticLayer(
  profiles: TableProfile[],
  opts: GenerateSemanticLayerOptions,
): GeneratedSemanticLayer {
  const schema = opts.schema ?? "public";

  const entities: GeneratedArtifact[] = profiles.map((profile) => ({
    table: profile.table_name,
    fileName: artifactFileName(profile.table_name),
    yaml: generateEntityYAML(profile, profiles, opts.dbType, schema, opts.sourceId),
  }));

  const catalog = generateCatalogYAML(profiles);
  const glossary = generateGlossaryYAML(profiles);

  const metrics: GeneratedArtifact[] = [];
  for (const profile of profiles) {
    const metricYaml = generateMetricYAML(profile, schema, opts.dbType);
    if (metricYaml) {
      metrics.push({
        table: profile.table_name,
        fileName: artifactFileName(profile.table_name),
        yaml: metricYaml,
      });
    }
  }

  return { entities, catalog, glossary, metrics };
}
