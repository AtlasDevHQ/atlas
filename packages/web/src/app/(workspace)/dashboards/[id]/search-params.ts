/**
 * Dashboard view URL state (#2267 parameters, #3212 drilldown).
 *
 * The dashboard parameter override map lives in ONE nuqs query key so the
 * parameter bar (manual control changes) and click-to-drilldown (set a
 * parameter by clicking a data point) read + write the SAME state. A drilldown
 * value therefore shows up in the bar (where it can be cleared/overridden),
 * survives reload, and is shareable — consistent with the conversation-scope
 * URL pattern.
 *
 * The override map is JSON-encoded into a single string param rather than one
 * param per key: the parameter set is dynamic (defined per dashboard), so a
 * fixed nuqs schema can't enumerate the keys ahead of time.
 *
 * SECURITY: these values are bound server-side through the `/render` endpoint's
 * parameterized query path (`@atlas/api/lib/dashboard-parameters`) — never
 * interpolated into SQL text. Unknown keys (e.g. a drilldown target that names
 * no declared parameter) are ignored by the resolver.
 */
import { parseAsString } from "nuqs";
import type { ParameterValues } from "@/ui/components/dashboards/dashboard-parameter-bar";

/** URL query key holding the JSON-encoded dashboard parameter override map. */
export const DASHBOARD_PARAMS_KEY = "dparams";

/** nuqs parser for {@link DASHBOARD_PARAMS_KEY}. Shared by the page (drilldown
 *  writes) and the parameter bar (manual changes) so both subscribe to the
 *  same key. */
export const dashboardParamsParser = parseAsString;

/** Parse the URL-encoded override map defensively (drop anything unusable). */
export function parseOverrides(raw: string | null): ParameterValues {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ParameterValues;
    }
  } catch {
    // intentionally ignored: malformed URL state — fall back to defaults rather than throwing.
  }
  return {};
}

/**
 * Serialize an override map for the URL. Drops `null`/empty-string entries so
 * the URL stays clean, and returns `null` when nothing remains — nuqs clears
 * the param entirely for `null`, so "no overrides" serialises to no query state.
 */
export function serializeOverrides(overrides: ParameterValues): string | null {
  const cleaned: ParameterValues = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === "") continue;
    cleaned[k] = v;
  }
  return Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
}

/**
 * Merge a single drilldown value into the current (raw) override map and return
 * the serialized URL value (#3212). A `null`/empty value clears that key. The
 * result is suitable to hand straight to the nuqs setter.
 */
export function withOverride(
  raw: string | null,
  key: string,
  value: string | number | null,
): string | null {
  return serializeOverrides({ ...parseOverrides(raw), [key]: value });
}
