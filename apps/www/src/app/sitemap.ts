import type { MetadataRoute } from "next";

const baseUrl = "https://www.useatlas.dev";

export const dynamic = "force-static";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();

  return [
    { url: baseUrl, lastModified, changeFrequency: "daily", priority: 1.0 },
    { url: `${baseUrl}/why-atlas`, lastModified, changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/pricing`, lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: `${baseUrl}/blog`, lastModified, changeFrequency: "weekly", priority: 0.7 },
    {
      url: `${baseUrl}/blog/why-the-semantic-layer-is-yaml`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/blog/out-of-the-runtime`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/blog/announcing-atlas`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/blog/why-this-one-stuck`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    { url: `${baseUrl}/security`, lastModified, changeFrequency: "monthly", priority: 0.7 },
    { url: `${baseUrl}/privacy`, lastModified, changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/terms`, lastModified, changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/dpa`, lastModified, changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/aup`, lastModified, changeFrequency: "monthly", priority: 0.5 },
  ];
}
