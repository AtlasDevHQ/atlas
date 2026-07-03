import { selfHostedSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { SectionDocsPage } from "@/components/section-docs-page";
import { createSectionRelativeLink } from "@/lib/mdx-links";

// Self-hosted / on-prem docs at /self-hosted. Renders self-hosted-only content
// plus the SAME shared pages as the root, with the "self-hosted" audience
// injected — so a shared page adapts to this mount from one source file.
export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = selfHostedSource.getPage(params.slug);
  if (!page) notFound();

  return (
    <SectionDocsPage
      page={page}
      audience="self-hosted"
      linkComponent={createSectionRelativeLink(selfHostedSource, page)}
      // The /llms.mdx/<slug> markdown twins are root-only for now; the
      // self-hosted section gets its own machine-readable surfaces in a later
      // slice (#4266), so the copy button would 404 here.
      showLLMCopy={false}
    />
  );
}

export function generateStaticParams() {
  return selfHostedSource.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = selfHostedSource.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
