import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { selfHostedSource } from "@/lib/source";
import { sectionTabs, siteNavLinks } from "@/lib/nav";
import type { ReactNode } from "react";

// Self-hosted section — served at /self-hosted. The sidebar shows only the
// self-hosted tree (self-hosted + shared). The cross-section switcher and site
// links are shared with the root layout so the two sections never drift.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={selfHostedSource.getPageTree()}
      nav={{
        title: "Atlas",
        url: "/self-hosted",
      }}
      sidebar={{ tabs: sectionTabs() }}
      links={siteNavLinks}
    >
      {children}
    </DocsLayout>
  );
}
