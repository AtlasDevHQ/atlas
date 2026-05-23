import { redirect } from "next/navigation";

/**
 * Legacy URL for the Admin Action Log. Now renders as a tab on `/admin/audit`;
 * search params are forwarded so a bookmarked filter (`?actor=…&from=…`)
 * survives.
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
