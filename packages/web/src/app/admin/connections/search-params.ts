import { parseAsStringLiteral } from "nuqs";
import type { GroupByDimension } from "./group-by";

/** Legal `?groupBy` values. Exported so the page can narrow Radix's
 * `string | undefined` ToggleGroup callback against this tuple instead
 * of an unchecked `as GroupByDimension` cast. */
export const GROUP_BY_VALUES = ["type", "environment"] as const satisfies readonly GroupByDimension[];

// Both directions of the union ↔ tuple bond should be enforced. The
// `satisfies` above catches a tuple entry that isn't in the union; this
// catches a union member missing from the tuple (which would make the
// parser silently reject a legal value).
type _GroupByExhaustive =
  Exclude<GroupByDimension, (typeof GROUP_BY_VALUES)[number]> extends never ? true : never;
type _AssertGroupByExhaustive = _GroupByExhaustive extends true ? true : never;
const _exhaustivenessProof: _AssertGroupByExhaustive = true;

/** Type predicate so callers (e.g. the ToggleGroup's `onValueChange`)
 * can narrow Radix's untyped string callback against the same tuple
 * the URL parser uses — keeping the rejection rules in one place. */
export function isGroupByDimension(value: string): value is GroupByDimension {
  return (GROUP_BY_VALUES as readonly string[]).includes(value);
}

export const connectionsSearchParams = {
  // Falls back to "type" on an unknown value rather than throwing — admins
  // hitting a hand-edited URL land on the default view.
  groupBy: parseAsStringLiteral(GROUP_BY_VALUES).withDefault("type"),
};
