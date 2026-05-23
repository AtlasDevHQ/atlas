import { redirect } from "next/navigation";

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
