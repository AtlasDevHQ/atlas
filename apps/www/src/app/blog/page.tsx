import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { ArrowIcon, Divider, TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Blog — Atlas",
  description:
    "Updates, announcements, and technical deep dives from the Atlas team.",
  openGraph: {
    title: "Blog — Atlas",
    description:
      "Updates, announcements, and technical deep dives from the Atlas team.",
    url: "https://www.useatlas.dev/blog",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Post {
  slug: string;
  title: string;
  description: string;
  date: string;
  tag: string;
}

const POSTS: Post[] = [
  {
    slug: "announcing-atlas",
    title: "Announcing Atlas: open-source text-to-SQL with a semantic layer",
    description:
      "Atlas is in open beta. Connect your database, auto-generate a semantic layer, and let an AI agent query your data — self-hosted or on Atlas Cloud.",
    date: "2026-03-25",
    tag: "Launch",
  },
];

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function PostCard({ post }: { post: Post }) {
  return (
    <a
      href={`/blog/${post.slug}`}
      className="group block rounded-xl border border-border bg-bg-raised p-8 transition-colors hover:border-border-strong hover:bg-bg-sunken"
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-full border border-accent/20 bg-accent-quiet px-2.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-accent uppercase">
          {post.tag}
        </span>
        <time dateTime={post.date} className="font-mono text-xs text-fg-faint">{post.date}</time>
      </div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-fg group-hover:text-accent">
        {post.title}
      </h2>
      <p className="mb-6 text-sm leading-relaxed text-fg-muted">
        {post.description}
      </p>
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-accent">
        Read post
        <ArrowIcon className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BlogIndex() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <section className="mx-auto max-w-3xl px-6 pt-24 pb-20 md:pt-36 md:pb-28">
        <p className="animate-fade-in-up delay-100 mb-4 font-mono text-sm tracking-wide text-accent">
          Blog
        </p>
        <h1 className="animate-fade-in-up delay-200 mb-6 text-3xl font-semibold tracking-tight text-fg md:text-4xl">
          Updates & announcements
        </h1>
        <p className="animate-fade-in-up delay-300 mb-16 max-w-xl text-fg-muted">
          Product launches, technical deep dives, and the occasional opinion
          about text-to-SQL.
        </p>

        <div className="animate-fade-in-up delay-400 flex flex-col gap-6">
          {POSTS.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </section>

      <Divider />
      <Footer />
    </div>
  );
}
