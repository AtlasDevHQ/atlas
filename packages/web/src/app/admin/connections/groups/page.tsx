import { redirect } from "next/navigation";

/**
 * Legacy URL for the connection-groups admin surface. As of slice 4 of
 * PRD #2458 the page is embedded under `/admin/connections` behind a
 * `Group by: [Type | Environment]` toggle — the standalone route is kept
 * solely so bookmarks issued before the IA reshape keep landing on the
 * right view.
 *
 * Server-side redirect (Next.js `redirect()`), not a client-side
 * `useEffect`: admins with the old bookmark must never see a flash of
 * the legacy layout — the browser should arrive at
 * `/admin/connections?groupBy=environment` before any React renders.
 */
export default function ConnectionGroupsRedirect(): never {
  redirect("/admin/connections?groupBy=environment");
}
