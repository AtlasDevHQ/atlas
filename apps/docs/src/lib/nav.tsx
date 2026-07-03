import { Book, Braces, Server } from "lucide-react";
import { source, selfHostedSource } from "@/lib/source";

/**
 * The cross-section switcher shown in every human section's sidebar
 * (SaaS root ↔ Self-Hosted ↔ API Reference). Built once from the section
 * sources and reused by both human layouts so the switcher is identical
 * everywhere and each section's sidebar still shows only its own tree.
 *
 * `urls` sets drive active-tab detection on sub-pages (Fumadocs matches a tab's
 * `url` only exactly, so sub-pages need an explicit URL set — the pattern the
 * previous Docs/API split already used). Clicking a tab whose pages live in a
 * different route group simply navigates there.
 */
export function sectionTabs() {
  const rootPages = source.getPages();
  // SaaS root = everything in the root source that isn't the API reference
  // (i.e. saas + shared). The API reference stays its own tab at /api-reference.
  const saasUrls = new Set(
    rootPages
      .filter((p) => !p.url.startsWith("/api-reference"))
      .map((p) => p.url),
  );
  const apiUrls = new Set(
    rootPages
      .filter((p) => p.url.startsWith("/api-reference"))
      .map((p) => p.url),
  );
  const selfHostedUrls = new Set(
    selfHostedSource.getPages().map((p) => p.url),
  );

  return [
    {
      title: "Docs",
      description: "Cloud / SaaS guides, configuration, and concepts",
      icon: <Book />,
      url: "/",
      urls: saasUrls,
    },
    {
      title: "Self-Hosted",
      description: "Deploy and operate Atlas on your own infrastructure",
      icon: <Server />,
      url: "/self-hosted",
      urls: selfHostedUrls,
    },
    {
      title: "API Reference",
      description: "REST API endpoints and request/response schemas",
      icon: <Braces />,
      url: "/api-reference",
      urls: apiUrls,
    },
  ];
}

/**
 * Top-nav links shared by every section layout (external product + machine-
 * readable surfaces + GitHub). Kept in one place so the sections never drift.
 */
export const siteNavLinks = [
  {
    text: "Home",
    url: "https://www.useatlas.dev",
    external: true,
  },
  {
    text: "App",
    url: "https://app.useatlas.dev",
    external: true,
  },
  {
    text: "llms.txt",
    url: "/llms.txt",
    external: true,
  },
  {
    text: "llms-full.txt",
    url: "/llms-full.txt",
    external: true,
  },
  {
    type: "icon" as const,
    text: "GitHub",
    url: "https://github.com/AtlasDevHQ/atlas",
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
      </svg>
    ),
  },
];
