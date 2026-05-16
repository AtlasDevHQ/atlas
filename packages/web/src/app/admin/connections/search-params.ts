import { parseAsStringLiteral } from "nuqs";
import type { GroupByDimension } from "./group-by";

// The two legal grouping dimensions for /admin/connections. Encoded as a
// string-literal union so an invalid `?groupBy=foo` falls back to "type"
// instead of breaking the page. Default is "type" so the URL stays clean
// for the common "provider-grouped" view.
const GROUP_BY_VALUES = ["type", "environment"] as const satisfies readonly GroupByDimension[];

export const connectionsSearchParams = {
  groupBy: parseAsStringLiteral(GROUP_BY_VALUES).withDefault("type"),
};
