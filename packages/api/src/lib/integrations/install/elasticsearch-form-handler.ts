/**
 * `ElasticsearchFormInstallHandler` — Admin → Integrations install/edit for the
 * `@useatlas/elasticsearch` datasource (#3270). Lets a workspace admin connect an
 * Elasticsearch / OpenSearch cluster from the UI instead of editing
 * `atlas.config.ts`.
 *
 * As of #3300 this is a thin specialization of the reusable
 * {@link DatasourceFormInstallHandler}: the generic handler carries the entire
 * behavior (config_schema-driven encryption, mask-on-read / restore-on-save,
 * SaaS keyset gate, corrupt-schema fail-close, multi-instance upsert) and ES
 * supplies only its slug + default install id. ClickHouse / Snowflake / BigQuery
 * register the same generic handler with their own slug — so a change to the
 * install behavior lands in one place, and ES's path stays identical (pinned by
 * `__tests__/elasticsearch-form-handler.test.ts`).
 *
 * Multi-instance (#3858): the unified `@useatlas/elasticsearch` plugin serves
 * BOTH Elasticsearch and OpenSearch under this one slug, so a workspace must be
 * able to install both at once. The form carries a reserved
 * {@link DATASOURCE_INSTALL_ID_FIELD} connection id; when omitted, the first
 * install reads `install_id = elasticsearch` ({@link ELASTICSEARCH_INSTALL_ID})
 * and a second supplies its own (e.g. `opensearch-logs`).
 *
 * @see ./datasource-form-handler.ts — {@link DatasourceFormInstallHandler}
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ../../plugins/secrets.ts — encrypt / mask / restore walkers
 */

import { DatasourceFormInstallHandler } from "./datasource-form-handler";
import type { CatalogId } from "./types";

/** Catalog slug — the dispatch key in `registerFormHandler`. */
export const ELASTICSEARCH_SLUG: CatalogId = "elasticsearch";
/** Catalog FK — the canonical `catalog:<slug>` id seeded in `plugin_catalog`. */
export const ELASTICSEARCH_CATALOG_ID = "catalog:elasticsearch";
/**
 * Default per-workspace install id — used when the install form omits a custom
 * connection id, so the FIRST Elasticsearch/OpenSearch connection reads
 * `install_id = elasticsearch` and re-submits without a custom id edit it in
 * place. A second connection of this catalog supplies its own id (#3858).
 */
export const ELASTICSEARCH_INSTALL_ID = "elasticsearch";

/** Test-only injection of the install id generator. */
export interface ElasticsearchFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

/**
 * Elasticsearch / OpenSearch datasource form-install handler. A
 * {@link DatasourceFormInstallHandler} pinned to the `elasticsearch` slug — kept
 * as a named subclass so the register + test call sites that spell out the
 * ES-specific symbol keep compiling and the catalog wiring reads clearly.
 */
export class ElasticsearchFormInstallHandler extends DatasourceFormInstallHandler {
  constructor(options: ElasticsearchFormInstallHandlerOptions = {}) {
    super({
      slug: ELASTICSEARCH_SLUG,
      installId: ELASTICSEARCH_INSTALL_ID,
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    });
  }
}
