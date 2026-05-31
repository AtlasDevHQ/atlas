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
 *  - `itemsPath` (opt) — dot-path to the item array. DEFAULTS to the response
 *    root (`""`), because GitHub — the canonical `Link`-header API — returns a
 *    TOP-LEVEL array from its list endpoints (`GET /repos/{}/{}/pulls` → `[…]`),
 *    not a wrapped `{ data: [...] }`. Set it only when a vendor wraps its list.
 *  - `rel`       (opt) — link relation to follow (default `"next"`).
 */
import {
  continueWith,
  extractItems,
  optionalString,
  PAGE_DONE,
  pageError,
  withQuery,
  type PaginationConfig,
  type PaginationStrategy,
  type PaginationStrategyFactory,
} from "../paginator";

export const linkHeaderStrategy: PaginationStrategyFactory = {
  name: "link-header",
  create(config: PaginationConfig): PaginationStrategy {
    // Root (`""`) by default — `extractItems("")` returns the body itself, the
    // GitHub bare-array shape. A wrapped vendor overrides with a dot-path.
    const itemsPath = optionalString(config, "itemsPath") ?? "";
    const rel = optionalString(config, "rel") ?? "next";

    return {
      name: "link-header",
      itemsPath,
      next(response, request) {
        // An empty page ends the walk, mirroring the count-based strategies: a
        // server returning no items while still advertising rel=next is
        // misbehaving — trust the data over the header rather than loop to maxPages.
        if (extractItems(response.body, itemsPath).length === 0) return PAGE_DONE;

        const header = response.headers["link"];
        if (typeof header !== "string" || header.length === 0) return PAGE_DONE;
        const nextUrl = parseLinkHeader(header, rel);
        if (nextUrl === null) return PAGE_DONE;
        const patch = extractQueryParams(nextUrl);
        if (patch === null) {
          // A rel=next link was present but its URL didn't parse. We can't compute
          // the next page and won't fabricate one — surface as an error so the
          // merge is flagged truncated rather than silently ending as if complete.
          return pageError(`rel="${rel}" link is present but its URL did not parse: ${nextUrl}`);
        }
        return continueWith(withQuery(request, patch));
      },
    };
  },
};

/**
 * Find the URL for `rel` in an RFC 8288 `Link` header value. Handles multiple
 * comma-separated links and space-separated relation lists (`rel="next last"`).
 * Splits only on commas that begin a new `<…>` link, so a comma inside a URL
 * (e.g. `?ids=1,2,3`) doesn't split one link into two. Returns the URL or `null`.
 */
function parseLinkHeader(value: string, rel: string): string | null {
  for (const part of value.split(/,\s*(?=<)/)) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (match === null) continue;
    const [, url, params] = match;
    if (linkParamsDeclareRel(params, rel)) return url;
  }
  return null;
}

/**
 * True when a link's parameter string declares `rel`. Scans each `;`-separated
 * `key=value` param and matches only an actual `rel` key (RFC 8288 allows a
 * space-separated relation list, e.g. `rel="next last"`), so a literal `rel=`
 * inside another param's value — or a `rev=` param — can't false-match.
 */
function linkParamsDeclareRel(params: string, rel: string): boolean {
  for (const param of params.split(";")) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== "rel") continue;
    const value = param.slice(eq + 1).trim().replace(/^"|"$/g, "");
    return value.split(/\s+/).includes(rel);
  }
  return false;
}

/**
 * Parse a (possibly relative) URL's query string into a query patch. A key that
 * repeats in the next-page URL (e.g. `?labels=bug&labels=help&page=2`) is
 * collected into an array so the filter survives to the next page — the client
 * explodes arrays back into repeated keys. A single-valued key stays a string.
 */
function extractQueryParams(url: string): Record<string, string | string[]> | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://link-header.invalid");
  } catch {
    // intentionally ignored: a malformed rel=next URL means we cannot compute the
    // next page. Returning null lets next() surface it as a strategy error so the
    // merge is flagged truncated (we won't fabricate a URL).
    return null;
  }
  const patch: Record<string, string | string[]> = {};
  for (const key of new Set(parsed.searchParams.keys())) {
    const all = parsed.searchParams.getAll(key);
    patch[key] = all.length > 1 ? all : all[0];
  }
  return patch;
}
