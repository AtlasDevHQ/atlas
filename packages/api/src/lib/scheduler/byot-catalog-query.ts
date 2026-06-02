/**
 * Stale BYOT-catalog query builder (#2284, dormancy gate #2377).
 *
 * Extracted from `byot-catalog-refresh.ts` so the real-Postgres migration
 * smoke (`migrate-pg.test.ts`) can assert the dormancy-gate SEMANTICS against
 * a live database using the exact production SQL — the in-process scheduler
 * unit tests mock `internalQuery` and so can only assert the query's shape,
 * not how its `IS NULL OR … > threshold` predicate actually selects rows.
 * This module has no heavy imports, so the integration test can pull the
 * builder without dragging in the scheduler's enterprise/Effect graph.
 */

/**
 * Build the stale-catalog selection query.
 *
 * The interval thresholds are parameterized as milliseconds → `now() -
 * $n::bigint * interval '1 ms'` so each is configurable without inlining the
 * int into a string literal.
 *
 *   - Legacy (dormancy disabled / non-managed): `$1` = stale-TTL ms, `$2` =
 *     limit. Selects every configured workspace whose catalog is older than
 *     the TTL.
 *   - Gated (`dormancyEnabled`): additionally `$3` = dormancy-window ms, and a
 *     `LEFT JOIN organization` + `org.last_active_at IS NULL OR … > now() -
 *     $3` filter. The dormancy predicate is ANDed onto the legacy TTL
 *     predicate, and a missing org row (orphaned config) yields `NULL` →
 *     treated as active. So the gate only ever ADDS skips for orgs that
 *     demonstrably exist AND are idle — it never drops a refresh the legacy
 *     query would have done.
 */
export function buildStaleCatalogQuery(dormancyEnabled: boolean): string {
  return dormancyEnabled
    ? `SELECT wmc.org_id, wmc.provider, wmc.bedrock_region
       FROM workspace_model_config wmc
       LEFT JOIN organization org ON org.id = wmc.org_id
       LEFT JOIN workspace_model_catalog wmcat
         ON wmcat.org_id = wmc.org_id AND wmcat.provider = wmc.provider
       WHERE wmc.provider IN ('anthropic', 'openai', 'bedrock')
         AND (org.last_active_at IS NULL OR org.last_active_at > now() - ($3::bigint * interval '1 ms'))
         AND (wmcat.fetched_at IS NULL OR wmcat.fetched_at < now() - ($1::bigint * interval '1 ms'))
       ORDER BY wmcat.fetched_at NULLS FIRST
       LIMIT $2`
    : `SELECT wmc.org_id, wmc.provider, wmc.bedrock_region
       FROM workspace_model_config wmc
       LEFT JOIN workspace_model_catalog wmcat
         ON wmcat.org_id = wmc.org_id AND wmcat.provider = wmc.provider
       WHERE wmc.provider IN ('anthropic', 'openai', 'bedrock')
         AND (wmcat.fetched_at IS NULL OR wmcat.fetched_at < now() - ($1::bigint * interval '1 ms'))
       ORDER BY wmcat.fetched_at NULLS FIRST
       LIMIT $2`;
}
