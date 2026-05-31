/**
 * `spec-refresh` — the per-install OpenAPI spec **refresh interval** knob
 * (PRD #2868 slice, #2977). A non-secret value stored on a generic OpenAPI
 * datasource's `workspace_plugins.config` JSONB (no migration, no encryption
 * surface) that says how often the cached spec snapshot should be re-discovered.
 *
 * This slice ships only the stored setting + its validation + a read accessor —
 * **no background scheduler in this module**. The admin "Refresh now" reuses the
 * existing manual re-discovery path; the periodic fiber that consumes the due-check
 * ({@link evaluateSpecRefreshDue}, which wraps {@link getSpecRefreshIntervalMs})
 * shipped in #2978 as `scheduler/openapi-install-rediscover.ts` — a `setInterval`-
 * based loop mirroring `byot-catalog-refresh.ts`.
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
 *
 * The #2978 scheduler (`scheduler/openapi-install-rediscover.ts`) also consumes the
 * watermark helpers added below — {@link SPEC_LAST_CHECKED_AT_FIELD},
 * {@link parseIsoToMs}, {@link evaluateSpecRefreshDue} — which together answer "is
 * this install due for an auto re-discovery?" without re-implementing the interval
 * grammar. They live here (next to the interval parser, in a dependency-free module)
 * rather than in the scheduler so the WRITE path and the READ/DUE path share one
 * source of truth for the stored shape.
 */

/** The sentinel value meaning "never auto-refresh" — the default. */
export const SPEC_REFRESH_OFF = "off";

/**
 * The `workspace_plugins.config` JSONB key holding the ISO-8601 timestamp of the
 * last SCHEDULED re-discovery check for an install (#2978). Written by the Tier-2
 * scheduler on every terminal per-install outcome (success, fail-soft, or
 * config-skip) — never by the manual "Refresh now" route, which instead bumps the
 * snapshot's `probedAt` (see {@link evaluateSpecRefreshDue} for why both count as
 * recent activity). Non-secret, so it merges into config via plain `jsonb` /
 * `text` writes alongside `spec_refresh_interval` — no encryption surface.
 */
export const SPEC_LAST_CHECKED_AT_FIELD = "spec_last_checked_at";

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
    // `Object.hasOwn`, not `in` — `in` matches inherited prototype keys
    // (`toString`, `constructor`, `__proto__`), which would otherwise pass
    // validation here and then index to a non-number (→ NaN) in
    // `getSpecRefreshIntervalMs`. Only the real preset keys are valid.
    if (Object.hasOwn(SPEC_REFRESH_PRESET_HOURS, lower)) return { ok: true, value: lower };
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
    // Own-property guard (not bracket-index alone): a prototype key like
    // `"toString"` would index to a function and `fn * HOUR_MS` → NaN, which
    // would then leak a non-finite interval into the scheduler's due-check.
    const presetHours = Object.hasOwn(SPEC_REFRESH_PRESET_HOURS, lower)
      ? SPEC_REFRESH_PRESET_HOURS[lower]
      : undefined;
    if (presetHours !== undefined) return presetHours * HOUR_MS;
  }
  const hours = parseCustomHours(raw);
  return hours === null ? null : hours * HOUR_MS;
}

/**
 * Parse an ISO-8601 timestamp read back from JSONB to epoch ms, or `null` when the
 * value is absent / not a string / unparseable. Used to read both the
 * {@link SPEC_LAST_CHECKED_AT_FIELD} watermark and a snapshot's `probedAt` at the
 * untyped JSONB trust boundary — a drifted / hand-edited value resolves to `null`
 * (treated as "no activity recorded") rather than `NaN`, which would make every
 * comparison against it false and silently freeze the install's due-ness.
 */
export function parseIsoToMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** The decision the #2978 scheduler makes for one candidate install per tick. */
export interface SpecRefreshDueDecision {
  /**
   * The configured interval in ms, or `null` when the install is `off` (or its
   * stored value drifted to something unparseable) — `null` means NEVER due, the
   * hard gate the scheduler honors so an `off` install is never auto-refreshed.
   */
  readonly intervalMs: number | null;
  /**
   * The most recent activity watermark in epoch ms — `max(spec_last_checked_at,
   * snapshot.probedAt)`, or `0` when neither is present. See {@link evaluateSpecRefreshDue}.
   */
  readonly lastActivityMs: number;
  /** `true` iff an interval is configured AND that interval has elapsed since `lastActivityMs`. */
  readonly due: boolean;
}

/**
 * Decide whether an install is due for a SCHEDULED re-discovery (#2978), from its
 * raw `workspace_plugins.config` JSONB and the current epoch ms.
 *
 * The "last activity" watermark is the MAX of two timestamps, so two different
 * write paths both reset the scheduler clock without coordinating:
 *   - {@link SPEC_LAST_CHECKED_AT_FIELD} — stamped by the scheduler on every
 *     terminal per-install outcome (including a fail-soft probe failure, which is
 *     the persisted negative-cache: a down upstream is not re-probed until its own
 *     interval elapses again, instead of being hammered every tick).
 *   - `openapi_snapshot.probedAt` — bumped by BOTH a scheduled success and a manual
 *     "Refresh now". Folding it in means a freshly-installed datasource (recent
 *     `probedAt`, no watermark yet) is NOT immediately re-probed on the first tick,
 *     and a manual refresh resets the clock so the scheduler won't redundantly
 *     re-probe moments later — all without the manual route having to write the
 *     watermark itself.
 *
 * `off` (or a drifted/garbage interval) → `intervalMs: null` → `due: false`: the
 * AC's "off installs are never auto-refreshed", enforced here rather than relying
 * on the SQL pre-filter alone (defense in depth for a hand-edited row).
 */
export function evaluateSpecRefreshDue(
  config: Record<string, unknown> | null | undefined,
  nowMs: number,
): SpecRefreshDueDecision {
  const c = config ?? {};
  const intervalMs = getSpecRefreshIntervalMs(c.spec_refresh_interval);
  const lastChecked = parseIsoToMs(c[SPEC_LAST_CHECKED_AT_FIELD]);
  const snapshot = c.openapi_snapshot;
  const probedAt =
    typeof snapshot === "object" && snapshot !== null
      ? parseIsoToMs((snapshot as Record<string, unknown>).probedAt)
      : null;
  const lastActivityMs = Math.max(lastChecked ?? 0, probedAt ?? 0);
  const due = intervalMs !== null && nowMs - lastActivityMs >= intervalMs;
  return { intervalMs, lastActivityMs, due };
}
