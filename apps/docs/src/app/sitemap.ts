import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

export const dynamic = "force-static";

// Keep in sync with metadataBase in layout.tsx
const baseUrl = "https://docs.useatlas.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: `${baseUrl}${page.url}`,
  }));
}
