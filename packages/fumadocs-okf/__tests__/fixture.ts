/**
 * A synthetic NON-ATLAS Fumadocs site ("Acme Metrics" product docs) — the
 * acceptance-criteria fixture proving the adapter works from the loader
 * surface alone, not from the Atlas portal's content layout. The shapes
 * mirror what `loader()` + fumadocs-mdx produce: `path` relative to the
 * content dir, `url`, `data.{title,description,tags}` and the
 * `getText("processed")` doc method.
 */

import type { FumadocsOkfPage, FumadocsOkfSource } from "../src/index";

export function page(
  path: string,
  body: string,
  data: {
    title?: string;
    description?: string;
    tags?: unknown;
    /** Simulate a site without `postprocess.includeProcessedMarkdown`. */
    missingProcessed?: boolean;
    /** Drop `getText` entirely (a non-fumadocs-mdx source). */
    noGetText?: boolean;
  } = {},
): FumadocsOkfPage {
  const { missingProcessed, noGetText, ...fm } = data;
  return {
    path,
    url: `/${path.replace(/\.(mdx|md)$/i, "").replace(/(^|\/)index$/i, "")}`,
    data: {
      ...fm,
      getText: noGetText
        ? undefined
        : async (type: "processed" | "raw") => {
            if (type === "processed" && missingProcessed) {
              // fumadocs-mdx's verbatim error for the missing config opt-in.
              throw new Error(
                "getText('processed') requires `includeProcessedMarkdown` to be enabled in your collection config.",
              );
            }
            return body;
          },
    },
  };
}

export function sourceOf(pages: readonly FumadocsOkfPage[]): FumadocsOkfSource {
  return { getPages: () => pages };
}

/** The default Acme fixture: landings, nested sections, reserved names, stubs. */
export function acmeSource(): FumadocsOkfSource {
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
    page(
      "guides/index.mdx",
      "All guides live here, organized by workload.",
      { title: "Guides" },
    ),
    page(
      "guides/dashboards.mdx",
      "Dashboards are built from saved queries.\n\n```sql\nSELECT 1;\n```",
      { title: "Dashboards", tags: ["viz", "setup"] },
    ),
    // A real content page that happens to carry a reserved OKF basename.
    page("ops/log.mdx", "How Acme writes an audit log entry for every query.", {
      title: "Audit log",
    }),
    // Auto-generated API-reference stub (built-in skip).
    page("api-reference/create-widget.mdx", "<APIPage operations={[1]} />", {
      title: "POST /widgets",
    }),
    // Component-only page (contentless skip).
    page("changelog.mdx", "<ChangelogTimeline />", { title: "Changelog" }),
  ]);
}
