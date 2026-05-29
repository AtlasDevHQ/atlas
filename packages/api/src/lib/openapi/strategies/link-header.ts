/**
 * `link-header` pagination strategy — RFC 8288 `Link` header (GitHub-style).
 *
 * Each page's `Link` header carries the next page's URL: `Link: <…?page=2>;
 * rel="next"`. We parse the `rel="next"` URL, extract its query params, and
 * merge them onto the current request (keeping the same operation + path — the
 * generic case is "same list endpoint, next page of query params"). When no
 * `next` link is present, the walk is done.
 *
 * Config fields:
 *  - `itemsPath` (req) — dot-path to the item array (for merging).
 *  - `rel`       (opt) — link relation to follow (default `"next"`).
 */
import {
  optionalString,
  requireString,
  withQuery,
  type PaginationConfig,
  type PaginationStrategy,
  type PaginationStrategyFactory,
} from "../paginator";

export const linkHeaderStrategy: PaginationStrategyFactory = {
  name: "link-header",
  create(config: PaginationConfig): PaginationStrategy {
    const itemsPath = requireString(config, "itemsPath");
    const rel = optionalString(config, "rel") ?? "next";

    return {
      name: "link-header",
      itemsPath,
      next(response, request) {
        const header = response.headers["link"];
        if (typeof header !== "string" || header.length === 0) return null;
        const nextUrl = parseLinkHeader(header, rel);
        if (nextUrl === null) return null;
        const patch = extractQueryParams(nextUrl);
        if (patch === null) return null;
        return withQuery(request, patch);
      },
    };
  },
};

/**
 * Find the URL for `rel` in an RFC 8288 `Link` header value. Handles multiple
 * comma-separated links and space-separated relation lists
 * (`rel="next last"`). Returns the URL or `null`.
 */
function parseLinkHeader(value: string, rel: string): string | null {
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (match === null) continue;
    const [, url, params] = match;
    const relMatch = /rel\s*=\s*"?([^";]+)"?/i.exec(params);
    if (relMatch !== null && relMatch[1].trim().split(/\s+/).includes(rel)) {
      return url;
    }
  }
  return null;
}

/** Parse a (possibly relative) URL's query string into a scalar query patch. */
function extractQueryParams(url: string): Record<string, string> | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://link-header.invalid");
  } catch {
    return null;
  }
  const patch: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    patch[k] = v;
  });
  return patch;
}
