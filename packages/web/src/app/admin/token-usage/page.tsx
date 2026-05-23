import { redirect } from "next/navigation";

/**
 * Token Usage folded into `/admin/usage` (consolidation, May 2026). The
 * standalone Token Usage page was a slice of overall plan consumption; the
 * Usage dashboard now renders both as tabs.
 *
 * Forwards `?from=…&to=…` (and any other query) so a bookmarked date range
 * follows the user into the Tokens tab — Codex flagged the bare redirect as
 * losing legacy filter state.
 */
export default async function TokenUsageRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  qs.set("tab", "tokens");
  for (const [key, value] of Object.entries(params)) {
    if (key === "tab") continue;
    if (typeof value === "string") {
      qs.append(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) qs.append(key, item);
    }
  }
  redirect(`/admin/usage?${qs.toString()}`);
}
