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
    url: "https://useatlas.dev/blog",
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
      "Atlas 1.0 is here. Connect your database, auto-generate a semantic layer, and let an AI agent query your data — self-hosted or on Atlas Cloud.",
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
      className="group block rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-8 transition-colors hover:border-zinc-700/80 hover:bg-zinc-900/50"
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-full border border-brand/20 bg-brand/10 px-2.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
          {post.tag}
        </span>
        <time className="font-mono text-xs text-zinc-600">{post.date}</time>
      </div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-zinc-100 group-hover:text-white">
        {post.title}
      </h2>
      <p className="mb-6 text-sm leading-relaxed text-zinc-400">
        {post.description}
      </p>
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-brand">
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
        <p className="animate-fade-in-up delay-100 mb-4 font-mono text-sm tracking-wide text-brand">
          Blog
        </p>
        <h1 className="animate-fade-in-up delay-200 mb-6 text-3xl font-semibold tracking-tight text-zinc-100 md:text-4xl">
          Updates & announcements
        </h1>
        <p className="animate-fade-in-up delay-300 mb-16 max-w-xl text-zinc-400">
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
