import { redirect } from "next/navigation";

/**
 * Admin Action Log folded into `/admin/audit` (consolidation, May 2026).
 * The Audit page now has two tabs — Queries (the original audit log) and
 * Admin actions (this page's content). Both sources live in the same
 * Monitoring surface; the split was a confusing artifact of historical growth.
 *
 * Forwards any query string on the legacy URL through to the new tab so
 * bookmarks that pin a filter (`?actor=…`, `?actionType=…`, `?page=…`,
 * `?from=…`, `?to=…`, `?search=…`) survive the redirect. Without this the
 * tab simply opened unfiltered — a regression noted in the Codex review of
 * the consolidation PR.
 */
export default async function AdminActionLogRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  qs.set("tab", "actions");
  for (const [key, value] of Object.entries(params)) {
    if (key === "tab") continue;
    if (typeof value === "string") {
      qs.append(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) qs.append(key, item);
    }
  }
  redirect(`/admin/audit?${qs.toString()}`);
}
