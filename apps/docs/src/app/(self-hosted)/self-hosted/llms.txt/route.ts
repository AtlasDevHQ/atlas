import { selfHostedSource } from "@/lib/source";
import { llms } from "fumadocs-core/source";
import { absolutizeLlmsUrls } from "@/lib/llms-surface";

// Self-hosted / on-prem index at /self-hosted/llms.txt. `selfHostedSource` is
// the self-hosted section (self-hosted + shared, never saas-only), so this
// index lists only /self-hosted/* URLs — the self-hosted-scoped counterpart of
// the root /llms.txt (PRD #4257, slice #4266).
export const dynamic = "force-static";

export function GET() {
  const content = absolutizeLlmsUrls(llms(selfHostedSource).index());

  return new Response(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
