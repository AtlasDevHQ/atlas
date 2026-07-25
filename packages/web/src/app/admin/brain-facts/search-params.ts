import { parseAsBoolean, parseAsInteger, parseAsString, parseAsStringLiteral } from "nuqs";
import { BRAIN_FACT_STATUS_FILTERS } from "@/ui/lib/admin-schemas";

/**
 * URL state for the fact review queue.
 *
 * ADR-0036 names review-gate throughput a first-class concern the moment facts
 * arrive at connector scale, so the queue is filterable and paginated from day
 * one and every one of those knobs lives in the URL — a reviewer working a
 * backlog has to be able to hand a colleague the exact slice they are looking
 * at, and come back to it after a refresh.
 *
 * `status` carries the API's own filter value verbatim (`draft` by default,
 * plus `published` / `archived` / `all`) so the URL maps 1:1 onto the request.
 * It is CLAMPED to the shared vocabulary at parse time, not merely defaulted:
 * a `parseAsString` would forward `?status=nonsense` to the API (a 400, red
 * table) while the filter chips fell back to highlighting "Awaiting review" —
 * a filter row that lies about the queue underneath it.
 *
 * Bulk actions are deliberately out of scope for this slice.
 */
export const brainFactsSearchParams = {
  status: parseAsStringLiteral(BRAIN_FACT_STATUS_FILTERS).withDefault("draft"),
  /** Only provisional-entity candidates — the quality queue. */
  provisional: parseAsBoolean.withDefault(false),
  /** Only candidates carrying an advisory `in-tension-with` edge. */
  tension: parseAsBoolean.withDefault(false),
  /** Substring match across subject, predicate, and object. */
  q: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
};
