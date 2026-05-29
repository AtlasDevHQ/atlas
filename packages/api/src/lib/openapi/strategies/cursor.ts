/**
 * `cursor` pagination strategy — opaque next-cursor token.
 *
 * The dialect Twenty uses: each page carries an `endCursor` (and a `hasNextPage`
 * flag) in its body; the next page is fetched by setting that cursor on a query
 * param (`starting_after`). Stripe's `starting_after`/`ending_before` is the same
 * shape — a fifth strategy file is usually unnecessary for it.
 *
 * Config fields:
 *  - `itemsPath`   (req) — dot-path to the item array, e.g. `"data.people"`.
 *  - `cursorParam` (req) — query param the next cursor is set on, e.g. `"starting_after"`.
 *  - `cursorPath`  (req) — dot-path to the next cursor in the body, e.g. `"pageInfo.endCursor"`.
 *  - `hasMorePath` (opt) — dot-path to a boolean "more pages" flag, e.g. `"pageInfo.hasNextPage"`.
 *                          When set, the walk stops unless it is exactly `true`.
 *
 * Termination: stops when `hasMorePath` (if configured) isn't `true`, when the
 * cursor is absent/empty, or when the returned cursor equals the one already on
 * the request (no progress — an upstream echoing its cursor can't loop forever).
 */
import {
  continueWith,
  dotGet,
  optionalString,
  PAGE_DONE,
  requireString,
  withQuery,
  type PaginationConfig,
  type PaginationStrategy,
  type PaginationStrategyFactory,
} from "../paginator";

export const cursorStrategy: PaginationStrategyFactory = {
  name: "cursor",
  create(config: PaginationConfig): PaginationStrategy {
    const itemsPath = requireString(config, "itemsPath");
    const cursorParam = requireString(config, "cursorParam");
    const cursorPath = requireString(config, "cursorPath");
    const hasMorePath = optionalString(config, "hasMorePath");

    return {
      name: "cursor",
      itemsPath,
      next(response, request) {
        if (hasMorePath !== undefined && dotGet(response.body, hasMorePath) !== true) {
          return PAGE_DONE;
        }
        const cursor = dotGet(response.body, cursorPath);
        if (typeof cursor !== "string" || cursor.length === 0) return PAGE_DONE;
        // No-progress guard: if the upstream echoes the same cursor, stop.
        if (cursor === request.params.query?.[cursorParam]) return PAGE_DONE;
        return continueWith(withQuery(request, { [cursorParam]: cursor }));
      },
    };
  },
};
