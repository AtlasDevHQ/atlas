/**
 * `cursor` pagination strategy — opaque next-cursor token.
 *
 * Two dialects, one strategy (no fork):
 *  - **endCursor-in-body** (Twenty): each page carries an `endCursor` (and a
 *    `hasNextPage` flag) in its body; the next page sets that cursor on a query
 *    param (`starting_after`). Configure `cursorPath` (+ optional `hasMorePath`).
 *  - **last-item-id** (Stripe, #3028): the body has NO cursor field — the next
 *    cursor IS the LAST returned list item's id, fed back as `starting_after`,
 *    with a top-level `has_more` boolean. Set `cursorFromLastItem: true`
 *    (+ `cursorItemField` for the id field, + `hasMorePath: "has_more"`). This is
 *    a common REST dialect, declared via config — not a Stripe-specific code path.
 *
 * Config fields:
 *  - `itemsPath`          (req) — dot-path to the item array, e.g. `"data.people"` or `"data"`.
 *  - `cursorParam`        (req) — query param the next cursor is set on, e.g. `"starting_after"`.
 *  - `cursorPath`         (req unless `cursorFromLastItem`) — dot-path to the next
 *                                 cursor in the body, e.g. `"pageInfo.endCursor"`.
 *  - `cursorFromLastItem` (opt) — when `true`, derive the cursor from the LAST
 *                                 item in `itemsPath` instead of `cursorPath`.
 *  - `cursorItemField`    (opt) — with `cursorFromLastItem`, the dot-path to the
 *                                 cursor field ON the last item, e.g. `"id"`.
 *                                 Omit to use the last item itself as the cursor.
 *                                 A numeric id is coerced to its string form; any
 *                                 other non-string value ends the walk fail-soft.
 *  - `hasMorePath`        (opt) — dot-path to a boolean "more pages" flag, e.g.
 *                                 `"pageInfo.hasNextPage"` / `"has_more"`. When set,
 *                                 the walk stops unless it is exactly `true`.
 *
 * Termination: stops when `hasMorePath` (if configured) isn't `true`, when the
 * item array is empty (last-item dialect), when the cursor is absent/empty, or
 * when the returned cursor equals the one already on the request (no progress —
 * an upstream echoing its cursor can't loop forever).
 */
import {
  continueWith,
  dotGet,
  extractItems,
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
    const hasMorePath = optionalString(config, "hasMorePath");
    const cursorFromLastItem = config.cursorFromLastItem === true;
    const cursorItemField = optionalString(config, "cursorItemField");
    // `cursorPath` is required only for the body-cursor dialect; the last-item
    // dialect derives the cursor from the item array instead.
    const cursorPath = cursorFromLastItem
      ? optionalString(config, "cursorPath")
      : requireString(config, "cursorPath");

    return {
      name: "cursor",
      itemsPath,
      next(response, request) {
        if (hasMorePath !== undefined && dotGet(response.body, hasMorePath) !== true) {
          return PAGE_DONE;
        }

        let cursor: unknown;
        if (cursorFromLastItem) {
          const items = extractItems(response.body, itemsPath);
          if (items.length === 0) return PAGE_DONE;
          const lastItem = items[items.length - 1];
          const rawCursor =
            cursorItemField !== undefined ? dotGet(lastItem, cursorItemField) : lastItem;
          // The last-item cursor is commonly a numeric id (Stripe uses string ids
          // like `cus_…`, but other vendors of this dialect number them). Coerce a
          // finite number to its string form so the walk continues; anything else
          // (object, null, NaN) falls through to the typeof guard below and ends
          // the walk fail-soft rather than fetching a garbage cursor.
          cursor =
            typeof rawCursor === "number" && Number.isFinite(rawCursor)
              ? String(rawCursor)
              : rawCursor;
        } else {
          // `cursorPath` is non-undefined here: the non-last-item branch took the
          // `requireString` path above (fail-loud at create time otherwise).
          cursor = dotGet(response.body, cursorPath as string);
        }

        if (typeof cursor !== "string" || cursor.length === 0) return PAGE_DONE;
        // No-progress guard: if the upstream echoes the same cursor, stop.
        if (cursor === request.params.query?.[cursorParam]) return PAGE_DONE;
        return continueWith(withQuery(request, { [cursorParam]: cursor }));
      },
    };
  },
};
