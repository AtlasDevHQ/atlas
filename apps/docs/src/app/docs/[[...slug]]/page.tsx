import { source } from "@/lib/source";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { LLMCopyButton } from "@/components/llm-copy-button";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage
      toc={page.data.toc}
      lastUpdate={page.data.lastModified}
      editOnGithub={{
        owner: "AtlasDevHQ",
        repo: "atlas",
        sha: "main",
        path: `apps/docs/content/docs/${page.path}`,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex items-center gap-2 border-b pb-4">
        <LLMCopyButton url={`${page.url}.mdx`} />
      </div>
      <DocsBody>
        <MDX
          components={{
            ...defaultMdxComponents,
            Tab,
            Tabs,
            Step,
            Steps,
            Accordion,
            Accordions,
          }}
        />
      </DocsBody>
    </DocsPage>
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
