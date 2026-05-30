/**
 * `spec-refresh` — the per-install OpenAPI spec **refresh interval** knob
 * (PRD #2868 slice, #2977). A non-secret value stored on a generic OpenAPI
 * datasource's `workspace_plugins.config` JSONB (no migration, no encryption
 * surface) that says how often the cached spec snapshot should be re-discovered.
 *
 * This slice ships only the stored setting + its validation + a read accessor —
 * **no background scheduler**. The admin "Refresh now" reuses the existing manual
 * re-discovery path; the periodic fiber that consumes {@link getSpecRefreshIntervalMs}
 * lands in #2978 (modeled on the `Effect.repeat(Schedule.spaced(...))` pattern in
 * `layers.ts`, the way `getExpertSchedulerIntervalMs` feeds the semantic-expert
 * tick).
 *
 * Stored canonical value — one of:
 *   - `"off"` (default) — never auto-refresh.
 *   - a named preset: `"daily"` (24h) or `"weekly"` (168h).
 *   - a bounded custom interval `"<N>h"` — N in `[MIN_SPEC_REFRESH_HOURS,
 *     MAX_SPEC_REFRESH_HOURS]` (1h … 30d).
 *
 * Three contracts:
 *   - {@link normalizeSpecRefreshInterval} — write path. CLAMPS an
 *     out-of-range-but-positive number; REJECTS genuine garbage with an actionable
 *     message. No silent fallback (the value matters for upstream egress timing).
 *   - {@link getSpecRefreshIntervalMs} — read path / #2978 scheduler. `off` and any
 *     drifted value → `null` (skip); every live value → a positive, clamped ms count.
 *   - {@link coerceSpecRefreshInterval} — fail-soft display coercion for the detail
 *     summary + UI Select (a non-string / unknown stored value → the `off` default).
 */

/** The sentinel value meaning "never auto-refresh" — the default. */
export const SPEC_REFRESH_OFF = "off";

/** Named presets the UI surfaces, expressed in hours. Keep in lockstep with the web Select. */
export const SPEC_REFRESH_PRESET_HOURS: Readonly<Record<string, number>> = {
  daily: 24,
  weekly: 168,
};

/** Custom-interval bounds (hours): 1 hour … 30 days. An out-of-range value clamps to these. */
export const MIN_SPEC_REFRESH_HOURS = 1;
export const MAX_SPEC_REFRESH_HOURS = 720;

/** Default stored value when nothing is configured. */
export const DEFAULT_SPEC_REFRESH_INTERVAL = SPEC_REFRESH_OFF;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Actionable rejection message for the write path. Names every valid option +
 * the custom bounds so the admin sees exactly what to enter (CLAUDE.md: no
 * generic "something went wrong").
 */
const INVALID_INTERVAL_MESSAGE =
  `Invalid refresh interval. Use "${SPEC_REFRESH_OFF}", "daily", "weekly", or a number of hours ` +
  `between ${MIN_SPEC_REFRESH_HOURS} and ${MAX_SPEC_REFRESH_HOURS} (e.g. "6h").`;

function clampHours(hours: number): number {
  return Math.min(MAX_SPEC_REFRESH_HOURS, Math.max(MIN_SPEC_REFRESH_HOURS, hours));
}

/**
 * Parse the CUSTOM numeric interval form — a number of hours given as a `number`,
 * a bare numeric string (`"6"`), or a `"<N>h"` string — and return the CLAMPED
 * hours, or `null` when the value isn't a positive finite number. Does not
 * recognize the `off` sentinel or the named presets; the callers layer those on.
 */
function parseCustomHours(raw: unknown): number | null {
  let hours: number;
  if (typeof raw === "number") {
    hours = raw;
  } else if (typeof raw === "string") {
    const match = /^(\d+(?:\.\d+)?)h?$/.exec(raw.trim().toLowerCase());
    const digits = match?.[1];
    if (digits === undefined) return null;
    hours = Number.parseFloat(digits);
  } else {
    return null;
  }
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return clampHours(hours);
}

/** Result of {@link normalizeSpecRefreshInterval}. */
export type NormalizedSpecRefreshInterval =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

/**
 * Validate + clamp a refresh-interval value for the WRITE path. Accepts the `off`
 * sentinel and named presets verbatim (case-insensitive, trimmed), a number of
 * hours (number / `"6"` / `"6h"`) which is clamped into bounds, and rejects
 * everything else with {@link INVALID_INTERVAL_MESSAGE}. An out-of-range positive
 * number is CLAMPED, not rejected — only a non-positive / unparseable / wrong-typed
 * value is refused (so a fat-fingered "90 days" never silently becomes "off").
 */
export function normalizeSpecRefreshInterval(raw: unknown): NormalizedSpecRefreshInterval {
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === SPEC_REFRESH_OFF) return { ok: true, value: SPEC_REFRESH_OFF };
    if (lower in SPEC_REFRESH_PRESET_HOURS) return { ok: true, value: lower };
  }
  if (typeof raw === "string" || typeof raw === "number") {
    const hours = parseCustomHours(raw);
    if (hours !== null) return { ok: true, value: `${hours}h` };
  }
  return { ok: false, message: INVALID_INTERVAL_MESSAGE };
}

/**
 * Fail-soft display coercion for the detail summary + UI Select. A stored value is
 * always a canonical string; a non-string / unrecognized value (drifted or
 * hand-edited row) coerces to the `off` default rather than rendering `undefined`.
 * A drifted out-of-range `"<N>h"` is normalized to its clamped form so the UI never
 * shows a value the scheduler wouldn't honor.
 */
export function coerceSpecRefreshInterval(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_SPEC_REFRESH_INTERVAL;
  const result = normalizeSpecRefreshInterval(raw);
  return result.ok ? result.value : DEFAULT_SPEC_REFRESH_INTERVAL;
}

/**
 * Resolve a stored interval to milliseconds for the READ path — the #2978
 * scheduler tick. Mirrors `getExpertSchedulerIntervalMs` (returns a positive ms
 * count), with one addition: `off` (and any drifted / unparseable value) resolves
 * to `null`, the signal for the scheduler to SKIP this install entirely rather
 * than auto-refresh on a fabricated cadence. A drifted out-of-range `"<N>h"` is
 * clamped on read too — defense for hand-edited rows.
 */
export function getSpecRefreshIntervalMs(raw: unknown): number | null {
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === SPEC_REFRESH_OFF) return null;
    const presetHours = SPEC_REFRESH_PRESET_HOURS[lower];
    if (presetHours !== undefined) return presetHours * HOUR_MS;
  }
  const hours = parseCustomHours(raw);
  return hours === null ? null : hours * HOUR_MS;
}
