import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";

export const dynamic = "force-static";

export async function GET() {
  const pages = source.getPages();
  const results = await Promise.all(
    pages.map(async (page) => {
      try {
        // `source` is the root/SaaS section, so resolve audience conditionals
        // to the saas branch (PRD #4257).
        return await getLLMText(page, "saas");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[llms-full.txt] ${page.url}: ${msg}`);
        return `# ${page.data.title} (${page.url})\n\n> Error: Could not load this page.`;
      }
    }),
  );

  return new Response(results.join("\n\n---\n\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
