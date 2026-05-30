/**
 * `vendor-quirk` — a declarative description of a vendor REST API's deviations
 * from "plain" OpenAPI that the generic client (`client.ts`) must honor on every
 * request (v0.0.2 slice 6a, #3028).
 *
 * The whole point is that a vendor quirk is **DATA, not a code branch.** A data
 * candidate (`data-candidates.ts`: Stripe today; Notion #3029, GitHub #3030
 * next) declares its quirk once as a {@link VendorQuirk} literal; the generic
 * client applies it through the existing header/query seams in
 * `executeOperation` with NO per-vendor `if (vendor === "stripe")` branch. Adding
 * a candidate's required header is a one-line entry in that literal — the
 * acceptance criterion this module exists to satisfy.
 *
 * Two axes, the only deviations the candidate set surfaces so far:
 *  - {@link VendorQuirk.requiredHeaders} — static headers the API mandates on
 *    every call regardless of the operation (e.g. Notion's
 *    `Notion-Version: 2022-06-28`). Nothing in the OpenAPI document models a
 *    "send this header on every request" requirement, so it lives here.
 *  - {@link VendorQuirk.queryParamShaping} — per-parameter key encoding the
 *    OpenAPI `style`/`explode` model doesn't capture for a vendor. Stripe expects
 *    array params in the bracket-repeat form `expand[]=a&expand[]=b`; the spec
 *    only declares `style: deepObject, explode: true` on a bare `expand`, so the
 *    `[]` suffix is a shaping rule, not something the graph carries.
 *
 * Pure + dependency-free on purpose: `types.ts` imports {@link VendorQuirk} for
 * `ExecuteOptions.quirk`, so this module must not import from `types.ts` (that
 * would be a cycle). The two apply helpers operate over plain header / query
 * records and are unit-tested in isolation.
 */

/** A query value as the client models it — scalar, exploding array, or dropped. */
export type QueryValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number | boolean>
  | undefined;

/**
 * One query-parameter shaping rule: rewrite the KEY a param is emitted under.
 * The value (and the client's array-explode behavior) is untouched — only the
 * key changes — so an array still serializes as repeated keys, now under the
 * reshaped name.
 */
export interface QueryParamShapeRule {
  /** The query parameter this rule reshapes, by its OpenAPI name (e.g. "expand"). */
  readonly param: string;
  /**
   * Emit the param under a bracket-suffixed key (`expand` → `expand[]`) so an
   * array value serializes as `expand[]=a&expand[]=b` — Stripe's (and Rails'
   * form-encoding) array convention. Ignored when {@link rename} is set.
   */
  readonly bracketArray?: boolean;
  /** Rename the param key outright. Takes precedence over {@link bracketArray}. */
  readonly rename?: string;
}

/**
 * A vendor's declarative deviations from plain REST. Both axes are optional — a
 * candidate with no quirk (a perfectly generic API) simply omits this and the
 * apply helpers are no-ops.
 */
export interface VendorQuirk {
  /**
   * Static headers the API mandates on every request. Applied as defaults: a
   * header the caller already set (an `in: header` param) wins, so a quirk header
   * never clobbers an explicit per-request value.
   */
  readonly requiredHeaders?: Readonly<Record<string, string>>;
  /** Per-parameter key-encoding overrides. Applied to the query bucket pre-encode. */
  readonly queryParamShaping?: ReadonlyArray<QueryParamShapeRule>;
}

/** Case-insensitive header presence check (HTTP header names are case-insensitive). */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

/**
 * Merge a quirk's {@link VendorQuirk.requiredHeaders} into a header bag IN PLACE.
 * A header already present (case-insensitively) is left untouched — the quirk is
 * a default, not an override, so an explicit `in: header` param the caller set
 * always wins. No-op when the quirk (or its `requiredHeaders`) is absent.
 */
export function applyQuirkHeaders(
  headers: Record<string, string>,
  quirk: VendorQuirk | undefined,
): void {
  const required = quirk?.requiredHeaders;
  if (required === undefined) return;
  for (const [name, value] of Object.entries(required)) {
    if (!hasHeader(headers, name)) headers[name] = value;
  }
}

/**
 * Rewrite a query-param record per the quirk's {@link VendorQuirk.queryParamShaping}
 * rules. Pure: returns a NEW record (the input is read-only) — or the input
 * unchanged when there are no rules. A param with no matching rule passes through
 * verbatim; a matched param is re-keyed (`rename` wins over `bracketArray`)
 * carrying its original value (arrays preserved, so the client's explode still
 * applies under the new key). Params a rule doesn't name — including a
 * pagination cursor added later in the walk — are never touched.
 */
export function applyQuirkQueryShaping(
  query: Readonly<Record<string, QueryValue>> | undefined,
  quirk: VendorQuirk | undefined,
): Readonly<Record<string, QueryValue>> | undefined {
  if (query === undefined) return undefined;
  const rules = quirk?.queryParamShaping;
  if (rules === undefined || rules.length === 0) return query;

  const ruleByParam = new Map(rules.map((r) => [r.param, r]));
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    const rule = ruleByParam.get(key);
    if (rule === undefined) {
      out[key] = value;
      continue;
    }
    const reshapedKey = rule.rename ?? (rule.bracketArray ? `${key}[]` : key);
    out[reshapedKey] = value;
  }
  return out;
}
