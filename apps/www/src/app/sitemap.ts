import type { MetadataRoute } from "next";

import { LEGAL_STAMPS, legalLastModified, type LegalSlug } from "../data/legal";
import { POSTS } from "../data/posts";

const baseUrl = "https://www.useatlas.dev";

export const dynamic = "force-static";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [
    { url: baseUrl, changeFrequency: "daily", priority: 1.0 },
    { url: `${baseUrl}/why-atlas`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/pricing`, changeFrequency: "daily", priority: 0.9 },
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(POSTS[0].isoDate),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...POSTS.map((post) => ({
      url: `${baseUrl}/blog/${post.slug}`,
      lastModified: new Date(post.isoDate),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    { url: `${baseUrl}/security`, changeFrequency: "monthly", priority: 0.7 },
    // Marketing pages above omit lastModified — an always-fresh build
    // timestamp teaches crawlers to ignore the field.
    ...(Object.keys(LEGAL_STAMPS) as LegalSlug[]).map((slug) => ({
      url: `${baseUrl}/${slug}`,
      lastModified: legalLastModified(slug),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
  ];
}
