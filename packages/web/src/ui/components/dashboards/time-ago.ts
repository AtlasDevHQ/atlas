/**
 * Compact relative-time formatter shared by the dashboard surfaces (tile
 * "last refreshed", view-all modal "updated"). Returns "never" on null so
 * callers don't have to special-case missing timestamps.
 *
 * The admin surfaces use `<RelativeTimestamp>` (with a tooltip + Intl
 * RelativeTimeFormat) instead — this helper stays plain-string + no provider
 * required for use inside dropdowns and grid tiles.
 *
 * `now` is injectable so a caller can drive a LIVE caption from a ticking clock
 * (`useNow`) — the same `now` renders every tile consistently and makes the
 * function pure for unit tests.
 */
export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const ts = new Date(iso).getTime();
  // A malformed timestamp is not "0m ago" — treat it as unknown rather than
  // rendering "Invalid Date".
  if (Number.isNaN(ts)) return "never";
  const diff = now - ts;
  // Clock skew: the capture instant is AHEAD of our clock. Never report "just
  // now" for a future timestamp — that would mask a large skew (or a bad
  // timestamp) as ordinary freshness. Label it as very-recent but distinct.
  if (diff < 0) return "moments ago";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
