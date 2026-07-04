// The shared dashboard surface renders a data-only SNAPSHOT (#4316). Its shapes
// are the wire types projected by the API (`SharedDashboardView` /
// `SharedDashboardCard`) — the SSOT lives in `@useatlas/types`, mirrored by
// `sharedDashboardViewSchema` in `@useatlas/schemas`. They deliberately carry NO
// `sql` and no internal ids (connectionGroupId, owner/org ids), so a query
// internal cannot reach this unauthenticated surface even by omission.
//
// Re-exported under the local `SharedCard` / `SharedDashboard` names the page,
// tile, and helpers already use, plus the new `SharedParameterSummaryItem`
// alias (#4316) for the frozen parameter chips.

import type {
  SharedDashboardCard,
  SharedDashboardParameterSummaryItem,
  SharedDashboardView,
} from "@/ui/lib/types";

export type SharedCard = SharedDashboardCard;
export type SharedParameterSummaryItem = SharedDashboardParameterSummaryItem;
export type SharedDashboard = SharedDashboardView;
