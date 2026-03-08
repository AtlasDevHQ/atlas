import { source } from "@/lib/source";

export const revalidate = false;

export function GET() {
  const pages = source.getPages();

  const lines = [
    "# Atlas",
    "",
    "> Documentation for Atlas — deploy-anywhere text-to-SQL data analyst agent.",
    "",
  ];

  for (const page of pages) {
    const desc = page.data.description
      ? `: ${page.data.description}`
      : "";
    lines.push(`- [${page.data.title}](${page.url})${desc}`);
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
