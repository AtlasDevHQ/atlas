import { redirect } from "next/navigation";

/**
 * Token Usage folded into `/admin/usage` (consolidation, May 2026). The
 * standalone Token Usage page was a slice of overall plan consumption; the
 * Usage dashboard now renders both as tabs.
 */
export default function TokenUsageRedirect() {
  redirect("/admin/usage?tab=tokens");
}
