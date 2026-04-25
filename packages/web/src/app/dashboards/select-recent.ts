type DashboardLike = { id: string; updatedAt: string };

/** Newest `updatedAt` first; ties break by id ascending for deterministic reloads. */
export function sortDashboardsByRecent<T extends DashboardLike>(dashboards: T[]): T[] {
  return dashboards.toSorted((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });
}

export function selectMostRecentDashboardId<T extends DashboardLike>(
  dashboards: T[],
): string | null {
  if (dashboards.length === 0) return null;
  return sortDashboardsByRecent(dashboards)[0].id;
}

/**
 * After deleting `deletedId`, pick the dashboard the user should land on. The
 * filter step is the load-bearing bit — calling `selectMostRecentDashboardId`
 * without it would race the cache and re-pick the row we just deleted.
 */
export function selectNextAfterDelete<T extends DashboardLike>(
  dashboards: T[],
  deletedId: string,
): string | null {
  return selectMostRecentDashboardId(dashboards.filter((d) => d.id !== deletedId));
}
