/**
 * Pick the most-recently-updated dashboard from a list. Ties (identical
 * `updatedAt`) break by id ascending so the "/dashboards → first dashboard"
 * redirect is deterministic across reloads. Returns null on an empty list.
 *
 * Extracted from the /dashboards server component so the sort + tiebreak
 * logic stays unit-testable without booting a Next.js render.
 */
export function selectMostRecentDashboardId<
  T extends { id: string; updatedAt: string },
>(dashboards: T[]): string | null {
  if (dashboards.length === 0) return null;
  const sorted = dashboards.toSorted((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });
  return sorted[0].id;
}
