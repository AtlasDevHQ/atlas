import type { MetadataRoute } from "next";

import { POSTS } from "../data/posts";

const baseUrl = "https://www.useatlas.dev";

export const dynamic = "force-static";

// Legal pages carry the effective date shown in their footer stamp; keep in
// sync when a policy is revised. Marketing pages omit lastModified — an
// always-fresh build timestamp teaches crawlers to ignore the field.
const LEGAL_EFFECTIVE: Record<string, string> = {
  privacy: "2026-06-19",
  terms: "2026-05-02",
  dpa: "2026-05-02",
  aup: "2026-04-26",
};

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
    ...Object.entries(LEGAL_EFFECTIVE).map(([slug, effective]) => ({
      url: `${baseUrl}/${slug}`,
      lastModified: new Date(effective),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
  ];
}
