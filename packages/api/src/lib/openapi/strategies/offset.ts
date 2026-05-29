/**
 * `offset` pagination strategy — numeric `offset` + `limit` window.
 *
 * Advances `offset` by `limit` each page. Without a total, a short page (fewer
 * than `limit` items) is the last page; with `totalPath`, the walk stops once
 * `offset + limit >= total`.
 *
 * Config fields:
 *  - `itemsPath`   (req) — dot-path to the item array.
 *  - `offsetParam` (req) — query param carrying the row offset, e.g. `"offset"`.
 *  - `limit`       (req) — page size (offset increment). Must be > 0.
 *  - `limitParam`  (opt) — query param to (re)send `limit` on each page.
 *  - `totalPath`   (opt) — dot-path to a total-count in the body, e.g. `"totalCount"`.
 */
import {
  coerceNumber,
  dotGet,
  extractItems,
  optionalString,
  PaginationConfigError,
  requireNumber,
  requireString,
  withQuery,
  type PaginationConfig,
  type PaginationStrategy,
  type PaginationStrategyFactory,
} from "../paginator";

export const offsetStrategy: PaginationStrategyFactory = {
  name: "offset",
  create(config: PaginationConfig): PaginationStrategy {
    const itemsPath = requireString(config, "itemsPath");
    const offsetParam = requireString(config, "offsetParam");
    const limit = requireNumber(config, "limit");
    const limitParam = optionalString(config, "limitParam");
    const totalPath = optionalString(config, "totalPath");
    if (limit <= 0) {
      throw new PaginationConfigError({
        strategy: "offset",
        field: "limit",
        message: `Pagination strategy "offset" requires limit > 0 (got ${limit}).`,
      });
    }

    return {
      name: "offset",
      itemsPath,
      next(response, request) {
        const pageLength = extractItems(response.body, itemsPath).length;
        if (pageLength === 0) return null;

        const currentOffset = coerceNumber(request.params.query?.[offsetParam]) ?? 0;
        const nextOffset = currentOffset + limit;

        if (totalPath !== undefined) {
          const total = coerceNumber(dotGet(response.body, totalPath));
          if (total !== undefined && nextOffset >= total) return null;
        } else if (pageLength < limit) {
          // No total to lean on: a short page is the last page.
          return null;
        }

        return withQuery(request, {
          [offsetParam]: nextOffset,
          ...(limitParam !== undefined ? { [limitParam]: limit } : {}),
        });
      },
    };
  },
};
