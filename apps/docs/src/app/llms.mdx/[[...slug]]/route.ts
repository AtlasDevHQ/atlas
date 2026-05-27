import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";
import { notFound } from "next/navigation";

// Markdown twin for every docs page.
//
// Canonical URLs are still /llms.mdx/<slug> and /<slug>.mdx — those
// are rewritten by Caddy (apps/docs/Caddyfile) onto the on-disk file
// path /llms.mdx/<slug>/index.md.
//
// Why the trailing "index.md" segment: under output: 'export' a flat
// catch-all writes <slug>.body files, which collide whenever a slug
// both terminates as a page AND has children (e.g. /plugins is a page
// and /plugins/overview is also a page). Appending "index.md" forces
// every variant to live inside a directory, so the leaf-vs-parent
// path collision can't happen.
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

  const content = await getLLMText(page);
  const tokenEstimate = Math.ceil(content.length / 4);
  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Markdown-Tokens": String(tokenEstimate),
      "X-Markdown-Source": page.url,
    },
  });
}

export function generateStaticParams() {
  return source.generateParams().map((p) => ({
    slug: [...(p.slug ?? []), INDEX_SUFFIX],
  }));
}
