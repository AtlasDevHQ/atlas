import { source } from "@/lib/source";
import { renderLlmsFullText } from "@/lib/llms-surface";

// Root / SaaS full-text surface. `source` is the SaaS section (saas + shared,
// never self-hosted), so this carries ONLY saas + shared pages — a SaaS agent
// is never fed self-hosted instructions (PRD #4257, slice #4266). The
// `/self-hosted` counterpart lives at /self-hosted/llms-full.txt.
export const dynamic = "force-static";

export async function GET() {
  const body = await renderLlmsFullText(
    source.getPages(),
    "saas",
    "llms-full.txt",
  );

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
