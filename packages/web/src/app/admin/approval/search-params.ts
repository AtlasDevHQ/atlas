import { parseAsString, parseAsStringLiteral } from "nuqs";

/**
 * URL state for /admin/approval.
 *
 * `status` — the currently-selected queue filter.
 * `expanded` — id of the single inline-expanded request (review surface).
 *
 * Server-side `queue` endpoint supports `all` as "no filter" by omitting the
 * query param, so `all` is only a client concept — we don't append
 * `?status=all` upstream.
 */
export const approvalSearchParams = {
  status: parseAsStringLiteral([
    "pending",
    "approved",
    "denied",
    "expired",
    "all",
  ] as const).withDefault("pending"),
  expanded: parseAsString,
};
