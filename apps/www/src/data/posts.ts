// ---------------------------------------------------------------------------
// Blog post index — newest first. The first entry renders as the featured
// lead on /blog. Single source of truth for the index page, the sitemap,
// and per-post BlogPosting structured data.
// ---------------------------------------------------------------------------

export interface Post {
  slug: string;
  title: string;
  description: string;
  isoDate: string;
  dateLabel: string;
  readingTime: string;
  tag: string;
}

export const POSTS: Post[] = [
  {
    slug: "the-connector-you-dont-write",
    title: "The connector you don't write",
    description:
      "Atlas can mirror a customer's Notion or Confluence into its Knowledge Base. Writing a connector for a new source means two methods and a converter — the engine keeps the scheduling, the rate-limit backoff, and the one place a document can ever be deleted. Here's the seam, and why it turned the OKF pillar into connectors for Notion, Confluence, and GitBook in a matter of days.",
    isoDate: "2026-07-09",
    dateLabel: "July 9, 2026",
    readingTime: "6 min read",
    tag: "How it works",
  },
  {
    slug: "seven-layers-and-a-sandbox",
    title: "Seven layers and a sandbox",
    description:
      "Every query Atlas runs was written by a language model. Here is each layer between that output and your database — the innocent-looking query that defeats a whitelist, the MySQL comment that executes, the one shared parse — and why the shell tools get the opposite treatment.",
    isoDate: "2026-07-05",
    dateLabel: "July 5, 2026",
    readingTime: "6 min read",
    tag: "How it works",
  },
  {
    slug: "atlas-speaks-okf",
    title: "Atlas speaks OKF",
    description:
      "Google shipped the Open Knowledge Format seventeen days before my post arguing the semantic layer should be a plain YAML file. Here's where the two agree, where a runtime has to go further, and how OKF became the native format of Atlas's new Knowledge Base pillar.",
    isoDate: "2026-07-03",
    dateLabel: "July 3, 2026",
    readingTime: "6 min read",
    tag: "How it works",
  },
  {
    slug: "the-price-of-ci",
    title: "The price of /ci",
    description:
      "One slash command was eating about a tenth of a week's token budget. Here's the fix that cut it 97% — and the CI drift, dead code, and flaky-test mess it turned up along the way.",
    isoDate: "2026-06-30",
    dateLabel: "June 30, 2026",
    readingTime: "4 min read",
    tag: "How I build",
  },
  {
    slug: "why-the-semantic-layer-is-yaml",
    title: "Why the semantic layer is a YAML file",
    description:
      "Ask a text-to-SQL agent what your revenue is and it picks a number. Atlas reads a file first — plain YAML, the kind you can open and edit — that says what your data actually means, and why a column called shipping_cost will lie to you. Here's why that file is the most important thing in the system, and not embeddings, fine-tuning, or a schema crawl.",
    isoDate: "2026-06-29",
    dateLabel: "June 29, 2026",
    readingTime: "6 min read",
    tag: "How it works",
  },
  {
    slug: "out-of-the-runtime",
    title: "Out of the runtime",
    description:
      "Atlas got built by one person and an agent. Here's the part the launch recap skipped: the commands, the work queue, and the memory I built around the agent, and how they went from copy-paste at midnight to a loop that ships a milestone while I sleep.",
    isoDate: "2026-06-26",
    dateLabel: "June 26, 2026",
    readingTime: "7 min read",
    tag: "How I build",
  },
  {
    slug: "announcing-atlas",
    title: "The road to launch: everything I shipped in beta",
    description:
      "A recap of the first half of 2026: a run of internal milestones from 0.1 through 1.6, then twenty-nine public releases in under a month, covering SQL safety, new datasources, a smarter agent, MCP, dashboards, and Atlas Cloud.",
    isoDate: "2026-06-25",
    dateLabel: "June 25, 2026",
    readingTime: "6 min read",
    tag: "Road to launch",
  },
  {
    slug: "why-this-one-stuck",
    title: "Why this one stuck",
    description:
      "Thirty-two repositories since 2023, most dead within two weeks. Why Atlas is the first one I got over the line, and the first I built end to end with an AI agent.",
    isoDate: "2026-06-25",
    dateLabel: "June 25, 2026",
    readingTime: "3 min read",
    tag: "Founder note",
  },
];

export function getPost(slug: string): Post {
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) throw new Error(`Unknown blog post slug: ${slug}`);
  return post;
}
