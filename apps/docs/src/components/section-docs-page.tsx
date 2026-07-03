import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { getGithubLastEdit } from "fumadocs-core/content/github";
import type { ComponentProps, FC } from "react";
import { APIPage } from "@/components/api-page";
import { ChangelogTimeline } from "@/components/changelog-timeline";
import { LLMCopyButton } from "@/components/llm-copy-button";
import { AudienceProvider, AudienceLabel, type Audience } from "@/lib/audience";
import { githubEditPath } from "@/lib/mdx-links";
import type { SectionPage } from "@/lib/source";

/**
 * Fetch the last commit date for a docs page via the GitHub API.
 * Returns undefined in development (to avoid rate limits) and on any API
 * failure (graceful degradation — the UI simply hides the date). Results are
 * cached for 24 hours (86400s) via Next.js fetch cache.
 *
 * `sourcePath` is the page's real source file, repo-relative under `apps/docs/`
 * — for a shared page this is the one `apps/docs/content/shared/…` file on both
 * mounts (spike #4258 caveat 1).
 */
async function getLastUpdate(sourcePath: string): Promise<Date | undefined> {
  if (process.env.NODE_ENV === "development") return undefined;

  try {
    const time = await getGithubLastEdit({
      owner: "AtlasDevHQ",
      repo: "atlas",
      sha: "main",
      path: sourcePath,
      // getGithubLastEdit sets this as the raw Authorization header value
      token: process.env.GITHUB_TOKEN
        ? `Bearer ${process.env.GITHUB_TOKEN}`
        : undefined,
      options: { next: { revalidate: 86400 } },
    });
    return time ?? undefined;
  } catch (error) {
    console.warn(
      `[docs] Failed to fetch last edit time for "${sourcePath}":`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/**
 * Renders one docs page for a human section (SaaS root or self-hosted). Both
 * route groups delegate here so a single-sourced shared page renders
 * IDENTICALLY on both mounts — the only per-section inputs are:
 *
 * - `audience` — injected into the MDX render scope (a shared page reads it via
 *   `<AudienceLabel/>` / `useAudience()` and adapts, resolved at build time).
 * - `linkComponent` — the mount-specific `createRelativeLink` result, so
 *   relative MDX links resolve against THIS section's source.
 * - `showLLMCopy` — the markdown-twin copy button, wired only where the
 *   `/llms.mdx/<slug>` route exists (the root today; self-hosted lands in a
 *   later slice).
 */
export async function SectionDocsPage({
  page,
  audience,
  linkComponent,
  showLLMCopy,
}: {
  page: SectionPage;
  audience: Audience;
  linkComponent: FC<ComponentProps<"a">>;
  showLLMCopy: boolean;
}) {
  const MDX = page.data.body;
  const lastUpdate = await getLastUpdate(githubEditPath(page.absolutePath));
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
        path: githubEditPath(page.absolutePath),
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      {showLLMCopy && !isFullWidth && (
        <div className="flex items-center gap-2 border-b pb-4">
          <LLMCopyButton url={`${page.url}.mdx`} />
        </div>
      )}
      <DocsBody>
        <AudienceProvider audience={audience}>
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
              ChangelogTimeline,
              AudienceLabel,
              // Resolve relative MDX links against THIS mount's source.
              a: linkComponent,
            }}
          />
        </AudienceProvider>
      </DocsBody>
    </DocsPage>
  );
}
