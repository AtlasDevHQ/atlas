/**
 * `page` pagination strategy — 1-based page number.
 *
 * Increments a `page` query param each request. Termination, in priority order:
 * `totalPagesPath` (stop once `currentPage >= totalPages`), else `pageSize`
 * (a short page is the last), else a zero-length page.
 *
 * Config fields:
 *  - `itemsPath`      (req) — dot-path to the item array.
 *  - `pageParam`      (req) — query param carrying the page number, e.g. `"page"`.
 *  - `pageSize`       (opt) — expected per-page count; a shorter page ends the walk.
 *  - `startPage`      (opt) — page number of the first request (default `1`).
 *  - `totalPagesPath` (opt) — dot-path to a total-pages count in the body.
 */
import {
  coerceNumber,
  continueWith,
  dotGet,
  extractItems,
  optionalNumber,
  optionalString,
  PAGE_DONE,
  pageError,
  requireString,
  withQuery,
  type PaginationConfig,
  type PaginationStrategy,
  type PaginationStrategyFactory,
} from "../paginator";

export const pageStrategy: PaginationStrategyFactory = {
  name: "page",
  create(config: PaginationConfig): PaginationStrategy {
    const itemsPath = requireString(config, "itemsPath");
    const pageParam = requireString(config, "pageParam");
    const pageSize = optionalNumber(config, "pageSize");
    const startPage = optionalNumber(config, "startPage") ?? 1;
    const totalPagesPath = optionalString(config, "totalPagesPath");

    return {
      name: "page",
      itemsPath,
      next(response, request) {
        const pageLength = extractItems(response.body, itemsPath).length;
        if (pageLength === 0) return PAGE_DONE;

        const rawPage = request.params.query?.[pageParam];
        const coercedPage = coerceNumber(rawPage);
        if (rawPage !== undefined && coercedPage === undefined) {
          // Page is set but unparseable — corrupt state. Stop loud rather than
          // silently re-basing to startPage and re-fetching the early pages.
          return pageError(
            `page param "${pageParam}" is present but not a number: ${JSON.stringify(rawPage)}`,
          );
        }
        const currentPage = coercedPage ?? startPage;

        if (totalPagesPath !== undefined) {
          const totalPages = coerceNumber(dotGet(response.body, totalPagesPath));
          if (totalPages !== undefined && currentPage >= totalPages) return PAGE_DONE;
        } else if (pageSize !== undefined && pageLength < pageSize) {
          return PAGE_DONE;
        }

        return continueWith(withQuery(request, { [pageParam]: currentPage + 1 }));
      },
    };
  },
};
