import { parseAsString, parseAsStringLiteral } from "nuqs";

/**
 * URL state for /admin/abuse.
 *
 * `level` — filter chips (all / warning / throttled / suspended). The list
 * endpoint returns all non-"none" flagged workspaces — filtering happens
 * client-side since the flagged set is always small.
 * `expanded` — workspaceId of the currently-expanded investigation panel.
 */
export const abuseSearchParams = {
  level: parseAsStringLiteral([
    "all",
    "warning",
    "throttled",
    "suspended",
  ] as const).withDefault("all"),
  expanded: parseAsString,
};
