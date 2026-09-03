import { selfHostedSource } from "@/lib/source";
import { renderLlmsFullText } from "@/lib/llms-surface";

// Self-hosted / on-prem full-text surface at /self-hosted/llms-full.txt.
// Sourced from `selfHostedSource` (self-hosted + shared, never saas-only) and
// resolved to the "self-hosted" audience, so an agent answering a self-hosted
// question is fed the on-prem branch — the self-hosted-scoped counterpart of
// the root /llms-full.txt (PRD #4257, slice #4266).
export const dynamic = "force-static";

export async function GET() {
  const body = await renderLlmsFullText(
    selfHostedSource.getPages(),
    "self-hosted",
    "self-hosted/llms-full.txt",
  );

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
