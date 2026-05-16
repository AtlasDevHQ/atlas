import { redirect } from "next/navigation";
import { ENVIRONMENT_VIEW_HREF } from "../group-by";

/**
 * Legacy URL for the connection-groups admin surface, kept as a
 * server-side redirect so pre-IA-reshape bookmarks land on the
 * embedded environments view.
 *
 * `redirect()` from `next/navigation` rather than a client `useEffect`:
 * admins with the old bookmark must never see a flash of the legacy
 * layout — the browser should arrive at the new URL before any React
 * renders.
 */
export default function ConnectionGroupsRedirect(): never {
  redirect(ENVIRONMENT_VIEW_HREF);
}
