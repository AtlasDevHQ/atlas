import { source } from "@/lib/source";
import { generateOGImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  // OG image URLs end with /image.png (e.g., /docs-og/guides/slack/image.png).
  // Strip that trailing segment to recover the page slug for content lookup.
  const pageSlug = slug.slice(0, -1);
  const page = source.getPage(pageSlug);
  if (!page) notFound();

  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: "Atlas Docs",
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: [...page.slugs, "image.png"],
  }));
}
