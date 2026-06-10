/**
 * Blur-time clamp helpers for the numeric retention inputs (#3361).
 *
 * The two retention panels keep their numeric fields as *strings* in form
 * state so any intermediate value can exist while the field is focused
 * (you can't type "30" if "3" is coerced away). On blur the value clamps
 * to the documented range; while it's out of range, Save is disabled.
 *
 * Deliberately local to the audit panels rather than generalized into
 * `useConfigForm`: the hook's contract excludes per-field validation
 * ("pages derive those from values"), and min/max is an input-event
 * concern, not form-state bookkeeping.
 */

/**
 * Server contract: `retentionDays` must be an integer ≥ 7 when set.
 * Mirrors `MIN_RETENTION_DAYS` in `ee/src/audit/retention.ts` — the
 * frontend can't import `@atlas/ee`, so keep the two in sync by hand.
 */
export const RETENTION_CUSTOM_DAYS_MIN = 7;
/**
 * Server contract: `hardDeleteDelayDays` must be an integer ≥ 0.
 * Mirrors the `hardDeleteDelay < 0` check in `ee/src/audit/retention.ts`.
 */
export const RETENTION_HARD_DELETE_DELAY_MIN = 0;
/**
 * Upper bound for both fields: the Postgres `integer` column cap. Without
 * it, a pasted huge value "clamps" to scientific notation (`1e+24`), passes
 * the integer checks here *and* server-side, and dies at the DB as an
 * opaque error. Server validation has no explicit max, so the column type
 * is the real contract.
 */
export const RETENTION_INPUT_MAX = 2_147_483_647;

/**
 * Parse a numeric-input string. Returns null for empty/whitespace or
 * unparseable input — notably, `Number("")` is `0`, which must NOT count
 * as a valid zero.
 */
function parseNumericInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when `raw` parses to an integer within `[min, max]`. Drives the
 * Save gate: a focused field holding an intermediate out-of-range value
 * disables Save until blur clamps it (or the user finishes typing).
 */
export function isIntInRange(raw: string, min: number, max?: number): boolean {
  const n = parseNumericInput(raw);
  return (
    n !== null && Number.isInteger(n) && n >= min && (max === undefined || n <= max)
  );
}

/**
 * Blur handler: normalize `raw` to the nearest valid integer string in
 * `[min, max]`. Empty or unparseable input falls back to `min`.
 */
export function clampIntInput(raw: string, min: number, max?: number): string {
  const n = parseNumericInput(raw);
  if (n === null) return String(min);
  const rounded = Math.round(n);
  const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, rounded));
  return String(clamped);
}
