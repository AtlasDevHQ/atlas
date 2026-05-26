import { parseAsString, parseAsStringLiteral } from "nuqs";

/**
 * URL state for /platform/crm-outbox.
 *
 * `status` — filter chips (all / pending / in_flight / done / dead).
 * Sent to the API as the `status` query param (drops the "all"
 * sentinel server-side).
 * `eventType` — free-text filter (e.g. "demo", "sales-form", "signup").
 * `since` — RFC-3339 timestamp WITH timezone offset (e.g.
 * "2026-05-26T10:00:00.000Z"). The UI's `<input type="datetime-local">`
 * returns a naïve local string; the page converts it to UTC ISO
 * before storing here so a deep-linked URL means the same window
 * regardless of the operator's local zone.
 * `selectedId` — outbox row id whose detail Sheet is open.
 */
export const crmOutboxSearchParams = {
  status: parseAsStringLiteral([
    "all",
    "pending",
    "in_flight",
    "done",
    "dead",
  ] as const).withDefault("all"),
  eventType: parseAsString.withDefault(""),
  since: parseAsString.withDefault(""),
  selectedId: parseAsString,
};
