import { source } from "@/lib/source";
import { notFound } from "next/navigation";
import { SectionDocsPage } from "@/components/section-docs-page";
import { createSectionRelativeLink } from "@/lib/mdx-links";

// SaaS / Cloud docs at the site root. Renders the existing content/docs tree
// (unchanged URLs) plus the shared pages, with the "saas" audience injected.
export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return (
    <SectionDocsPage
      page={page}
      audience="saas"
      linkComponent={createSectionRelativeLink(source, page)}
      showLLMCopy
    />
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const slugPath = (params.slug ?? []).join("/");
  const imageUrl = slugPath
    ? `/docs-og/${slugPath}/image.png`
    : `/docs-og/image.png`;

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      images: imageUrl,
      siteName: "Atlas Docs",
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
      images: imageUrl,
    },
  };
}
