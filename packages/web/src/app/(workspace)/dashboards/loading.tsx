import { DashboardDetailSkeleton } from "@/ui/components/dashboards/dashboard-skeleton";

// Route-level fallback for a hard navigation into /dashboards. Renders the
// same layout-matching skeleton the detail page shows during its client fetch
// (#4323) so the surface never flashes a blank frame before content lands.
export default function Loading() {
  return <DashboardDetailSkeleton />;
}
