/**
 * A synthetic NON-ATLAS docs corpus ("Acme Metrics" product docs) implemented
 * directly against the doc-source seam — the acceptance-criteria fixture
 * proving the core works from the interface alone (no Fumadocs, no
 * filesystem; no test reaches past the seam). Mirrors the Acme fixture the
 * Fumadocs adapter package uses, expressed as plain {@link DocSourcePage}s.
 */

import type { DocSource, DocSourcePage } from "../src/index";

export function page(
  path: string,
  body: string,
  data: {
    title?: string;
    description?: string;
    tags?: unknown;
    /** Simulate a body that fails to load (e.g. an HTTP fetch failure). */
    loadError?: string;
  } = {},
): DocSourcePage {
  const { loadError, ...fm } = data;
  return {
    path,
    url: `/${path.replace(/\.(mdx|md)$/i, "").replace(/(^|\/)index$/i, "")}`,
    ...fm,
    loadBody: async () => {
      if (loadError !== undefined) throw new Error(loadError);
      return body;
    },
  };
}

export function sourceOf(pages: readonly DocSourcePage[]): DocSource {
  return { getPages: () => pages };
}

/** The default Acme fixture: landings, nested sections, reserved names, stubs. */
export function acmeSource(): DocSource {
  return sourceOf([
    page("index.mdx", "# Acme Metrics\n\nAcme turns your warehouse into answers.", {
      title: "Acme Metrics",
      description: "Product overview",
    }),
    page("quickstart.mdx", "## Install\n\nRun `acme init` and follow the prompts.", {
      title: "Quickstart",
      description: "Zero to first query",
      tags: ["setup"],
    }),
    page("guides/index.mdx", "All guides live here, organized by workload.", {
      title: "Guides",
    }),
    page(
      "guides/dashboards.mdx",
      "Dashboards are built from saved queries.\n\n```sql\nSELECT 1;\n```",
      { title: "Dashboards", tags: ["viz", "setup"] },
    ),
    // A real content page that happens to carry a reserved OKF basename.
    page("ops/log.mdx", "How Acme writes an audit log entry for every query.", {
      title: "Audit log",
    }),
    // Hostile frontmatter: quotes, colons, and a backslash must survive the
    // OKF serialization (the JSON-encoded-scalar claim in okf.ts).
    page("faq.mdx", 'Q: does `"SELECT *"` count? A: yes\\no, it depends.', {
      title: 'FAQ: "gotchas", edge: cases',
      description: 'Answers to: "why?", "how?" — and C:\\paths too',
    }),
    // Auto-generated API-reference stub (skipped via the adapter-style predicate).
    page("api-reference/create-widget.mdx", "<APIPage operations={[1]} />", {
      title: "POST /widgets",
    }),
    // Component-only page (contentless skip).
    page("changelog.mdx", "<ChangelogTimeline />", { title: "Changelog" }),
  ]);
}

/** The adapter-style stub predicate the Acme tests pass to the core. */
export function isAcmeApiReferenceStub(p: DocSourcePage): boolean {
  return p.path.toLowerCase().startsWith("api-reference/");
}
