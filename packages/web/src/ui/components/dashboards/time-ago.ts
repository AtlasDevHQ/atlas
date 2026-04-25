/**
 * Compact relative-time formatter shared by the dashboard surfaces (tile
 * "last refreshed", view-all modal "updated"). Returns "never" on null so
 * callers don't have to special-case missing timestamps.
 *
 * The admin surfaces use `<RelativeTimestamp>` (with a tooltip + Intl
 * RelativeTimeFormat) instead — this helper stays plain-string + no provider
 * required for use inside dropdowns and grid tiles.
 */
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
