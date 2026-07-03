import { selfHostedSource } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";
import { twinPageSlug, twinStaticParams } from "@/lib/llms-surface";
import { notFound } from "next/navigation";

// Markdown twin for every /self-hosted docs page. Canonical URLs are
// /self-hosted/llms.mdx/<slug> and /self-hosted/<slug>.mdx — Caddy
// (deploy/docs/Caddyfile, the "#4266" fenced block) rewrites those onto the
// on-disk path /self-hosted/llms.mdx/<slug>/index.md. Resolved against
// `selfHostedSource` with the "self-hosted" audience, so a shared page's twin
// carries the on-prem branch here and the saas branch at the root twin — the
// per-section resolution that keeps the two audiences from cross-leaking
// (PRD #4257, slice #4266).
export const dynamic = "force-static";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const pageSlug = twinPageSlug(slug);
  if (pageSlug === null) notFound();
  const page = selfHostedSource.getPage(pageSlug);
  if (!page) notFound();

  return new Response(await getLLMText(page, "self-hosted"));
}

export function generateStaticParams() {
  return twinStaticParams(selfHostedSource.generateParams());
}
