import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { ArrowIcon, Divider, TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Blog — Atlas",
  description:
    "Launch notes, technical deep dives, and the occasional founder note, on building a text-to-SQL agent.",
  openGraph: {
    title: "Blog — Atlas",
    description:
      "Launch notes, technical deep dives, and the occasional founder note, on building a text-to-SQL agent.",
    url: "https://www.useatlas.dev/blog",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// Data — newest first. The first entry renders as the featured lead.
// ---------------------------------------------------------------------------

interface Post {
  slug: string;
  title: string;
  description: string;
  isoDate: string;
  dateLabel: string;
  readingTime: string;
  tag: string;
}

const POSTS: Post[] = [
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

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function PostMeta({ post }: { post: Post }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px]">
      <span className="rounded-full border border-accent/25 bg-accent-quiet px-2.5 py-0.5 font-medium tracking-[0.12em] text-accent uppercase">
        {post.tag}
      </span>
      <time dateTime={post.isoDate} className="tracking-[0.04em] text-fg-faint">
        {post.dateLabel}
      </time>
      <span aria-hidden className="text-border-strong">·</span>
      <span className="tracking-[0.04em] text-fg-faint">{post.readingTime}</span>
    </div>
  );
}

function FeaturedPost({ post }: { post: Post }) {
  return (
    <a href={`/blog/${post.slug}`} className="group block">
      <PostMeta post={post} />
      <h2 className="mt-4 text-[clamp(1.75rem,1.3rem+1.8vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.025em] text-balance text-fg transition-colors group-hover:text-accent">
        {post.title}
      </h2>
      <p className="mt-4 max-w-[60ch] text-[17px] leading-relaxed text-pretty text-fg-muted">
        {post.description}
      </p>
      <span className="mt-5 inline-flex items-center gap-1.5 font-mono text-xs text-accent">
        Read post
        <ArrowIcon className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </a>
  );
}

function PostRow({ post }: { post: Post }) {
  return (
    <li className="border-t border-border-soft">
      <a href={`/blog/${post.slug}`} className="group flex flex-col gap-2.5 py-7">
        <PostMeta post={post} />
        <h3 className="text-xl font-semibold tracking-[-0.015em] text-balance text-fg transition-colors group-hover:text-accent md:text-[1.375rem]">
          {post.title}
        </h3>
        <p className="max-w-[62ch] text-[15px] leading-relaxed text-pretty text-fg-muted">
          {post.description}
        </p>
      </a>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BlogIndex() {
  const [featured, ...rest] = POSTS;

  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <section className="mx-auto max-w-3xl px-6 pt-24 pb-20 md:pt-32 md:pb-28">
        <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-[0.12em] text-accent uppercase">
          Blog
        </p>
        <h1 className="animate-fade-in-up delay-200 text-[clamp(2.25rem,1.8rem+2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-balance text-fg">
          Field notes
        </h1>
        <p className="animate-fade-in-up delay-300 mt-5 max-w-[52ch] text-[17px] leading-relaxed text-pretty text-fg-muted">
          Launch notes, technical deep dives, and the occasional founder note,
          from building Atlas.
        </p>

        <div className="animate-fade-in-up delay-400 mt-16">
          <FeaturedPost post={featured} />
        </div>

        {rest.length > 0 && (
          <ul className="animate-fade-in-up delay-500 mt-14 border-b border-border-soft">
            {rest.map((post) => (
              <PostRow key={post.slug} post={post} />
            ))}
          </ul>
        )}
      </section>

      <Divider />
      <Footer />
    </div>
  );
}
