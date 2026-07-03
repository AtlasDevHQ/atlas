import { selfHostedSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { SectionDocsPage } from "@/components/section-docs-page";
import { createSectionRelativeLink } from "@/lib/mdx-links";
import { canonicalForSelfHostedMount } from "@/lib/redirects";

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
      // Section-aware markdown twins now exist at /self-hosted/llms.mdx/<slug>
      // (this section's own surfaces, PRD #4257 slice #4266). The copy button's
      // `${page.url}.mdx` → /self-hosted/<slug>.mdx, which Caddy rewrites onto
      // the self-hosted twin — so it resolves in-section, not against the root.
      showLLMCopy
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
    // Canonical tag (#4267). A self-hosted-only page canonicalizes to its own
    // /self-hosted URL (its old root URL now 308-redirects here); a shared page
    // canonicalizes back to its site-root mount to avoid duplicate-content
    // dilution. See canonicalForSelfHostedMount for the full rationale. Resolved
    // against metadataBase (https://docs.useatlas.dev) in layout.tsx.
    alternates: {
      canonical: canonicalForSelfHostedMount(page.url, page.absolutePath),
    },
  };
}
