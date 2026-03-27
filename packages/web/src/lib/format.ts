/**
 * Shared date/time formatting helpers for admin pages and UI components.
 *
 * All helpers accept nullable input and return "—" for missing or invalid dates.
 */

type DateInput = Date | string | number | null | undefined;

function toSafeDate(date: DateInput): Date | null {
  if (date == null) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Mar 27, 2026" — date only, short month. */
export function formatDate(date: DateInput): string {
  const d = toSafeDate(date);
  if (!d) return "\u2014";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "March 27, 2026" — date only, long month. Used by date-filter UI. */
export function formatLongDate(date: DateInput): string {
  const d = toSafeDate(date);
  if (!d) return "\u2014";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** "Mar 27, 2026, 2:30 PM" — date + time, short month. */
export function formatDateTime(date: DateInput): string {
  const d = toSafeDate(date);
  if (!d) return "\u2014";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a number with K/M suffixes for compact display. */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** "Mar 27, 2:30 PM" — date + time without year, short month. */
export function formatShortDateTime(date: DateInput): string {
  const d = toSafeDate(date);
  if (!d) return "\u2014";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
