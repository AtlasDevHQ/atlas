/**
 * Shared queryKey prefix for `useAdminFetch` and the auto-invalidate broadcast
 * in `useAdminMutation`. The two hooks are coupled through this string — if
 * either side renames it, every admin page that depends on auto-invalidation
 * silently goes stale after every mutation.
 */
export const ADMIN_FETCH_QUERY_KEY = "admin-fetch" as const;
