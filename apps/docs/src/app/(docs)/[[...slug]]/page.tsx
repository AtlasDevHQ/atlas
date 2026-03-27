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
import { APIPage } from "@/components/api-page";
import { RoadmapTimeline } from "@/components/roadmap-timeline";
import { LLMCopyButton } from "@/components/llm-copy-button";
import { getGithubLastEdit } from "fumadocs-core/content/github";

/**
 * Fetch the last commit date for a docs page via the GitHub API.
 * Returns undefined in development (to avoid rate limits) and on any
 * API failure (graceful degradation — the UI simply hides the date).
 * Results are cached for 24 hours (86400s) via Next.js fetch cache.
 */
async function getLastUpdate(path: string): Promise<Date | undefined> {
  if (process.env.NODE_ENV === "development") return undefined;

  try {
    const time = await getGithubLastEdit({
      owner: "AtlasDevHQ",
      repo: "atlas",
      sha: "main",
      // page.path already includes the .mdx extension (e.g., "guides/slack.mdx")
      path: `apps/docs/content/docs/${path}`,
      // getGithubLastEdit sets this as the raw Authorization header value
      token: process.env.GITHUB_TOKEN
        ? `Bearer ${process.env.GITHUB_TOKEN}`
        : undefined,
      options: { next: { revalidate: 86400 } },
    });
    return time ?? undefined;
  } catch (error) {
    console.warn(
      `[docs] Failed to fetch last edit time for "${path}":`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const lastUpdate = await getLastUpdate(page.path);

  const isFullWidth = page.data.full === true;

  return (
    <DocsPage
      toc={page.data.toc}
      lastUpdate={lastUpdate}
      full={isFullWidth}
      editOnGithub={{
        owner: "AtlasDevHQ",
        repo: "atlas",
        sha: "main",
        path: `apps/docs/content/docs/${page.path}`,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      {!isFullWidth && (
        <div className="flex items-center gap-2 border-b pb-4">
          <LLMCopyButton url={`${page.url}.mdx`} />
        </div>
      )}
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
            APIPage,
            RoadmapTimeline,
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
