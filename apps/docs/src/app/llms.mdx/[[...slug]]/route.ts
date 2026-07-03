import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";
import { twinPageSlug, twinStaticParams } from "@/lib/llms-surface";
import { notFound } from "next/navigation";

// Markdown twin for every root / SaaS docs page. Canonical URLs are
// /llms.mdx/<slug> and /<slug>.mdx — Caddy (deploy/docs/Caddyfile) rewrites
// those onto the on-disk path /llms.mdx/<slug>/index.md. The /self-hosted
// section has its own twins at /self-hosted/llms.mdx/<slug>/index.md
// (PRD #4257, slice #4266); see the twin-shape rationale in lib/llms-surface.ts.
export const dynamic = "force-static";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const pageSlug = twinPageSlug(slug);
  if (pageSlug === null) notFound();
  const page = source.getPage(pageSlug);
  if (!page) notFound();

  // Root/SaaS twins resolve audience conditionals to the saas branch.
  return new Response(await getLLMText(page, "saas"));
}

export function generateStaticParams() {
  return twinStaticParams(source.generateParams());
}
