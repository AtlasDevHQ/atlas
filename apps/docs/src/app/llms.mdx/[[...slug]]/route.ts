import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";
import { notFound } from "next/navigation";

// Markdown twin for every docs page. Canonical URLs are /llms.mdx/<slug>
// and /<slug>.mdx — Caddy (deploy/docs/Caddyfile) rewrites those onto the
// on-disk path /llms.mdx/<slug>/index.md.
//
// Why the trailing "index.md" segment: under output: 'export' a flat
// catch-all writes <slug>.body files, which collide whenever a slug both
// terminates as a page AND has children (e.g. /plugins is a page and
// /plugins/overview is also a page). Appending "index.md" forces every
// variant to live inside a directory, so the leaf-vs-parent collision
// can't happen. Response headers are not persisted by Next.js export —
// Content-Type is set by Caddy's MIME map for .md.
export const dynamic = "force-static";

const INDEX_SUFFIX = "index.md";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  if (!slug || slug.length === 0 || slug[slug.length - 1] !== INDEX_SUFFIX) {
    notFound();
  }
  const pageSlug = slug.slice(0, -1);
  const page = source.getPage(pageSlug);
  if (!page) notFound();

  // Markdown twins are root/SaaS-only today (self-hosted twins land in #4266),
  // so the saas branch is the correct one to resolve here.
  return new Response(await getLLMText(page, "saas"));
}

export function generateStaticParams() {
  return source.generateParams().map((p) => ({
    slug: [...(p.slug ?? []), INDEX_SUFFIX],
  }));
}
