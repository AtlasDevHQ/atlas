import { source } from "@/lib/source";
import { llms } from "fumadocs-core/source";
import { absolutizeLlmsUrls } from "@/lib/llms-surface";

// Root / SaaS index. `source` is the SaaS section (saas + shared, never
// self-hosted), so this index is structurally SaaS-scoped (PRD #4257, #4266).
export const dynamic = "force-static";

export function GET() {
  const content = absolutizeLlmsUrls(llms(source).index());

  return new Response(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
