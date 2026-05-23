import { redirect } from "next/navigation";

/**
 * Admin Action Log folded into `/admin/audit` (consolidation, May 2026).
 * The Audit page now has two tabs — Queries (the original audit log) and
 * Admin actions (this page's content). Both sources live in the same Monitoring
 * surface; the split was a confusing artifact of historical growth.
 */
export default function AdminActionLogRedirect() {
  redirect("/admin/audit?tab=actions");
}
