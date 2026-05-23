import { redirect } from "next/navigation";

export default async function McpSettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      qs.append(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) qs.append(key, item);
    }
  }
  const query = qs.toString();
  const suffix = query ? `?${query}` : "";
  redirect(`/admin/settings${suffix}#setting-ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS`);
}
