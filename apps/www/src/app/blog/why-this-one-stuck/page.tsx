import type { Metadata } from "next";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  Article,
  BackToBlog,
  H2,
  InlineCode,
  Lead,
  P,
  PostActions,
  PostHeader,
  PullQuote,
  Signoff,
  StatStrip,
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "Why This One Stuck",
  description:
    "Thirty-two repositories since 2023, most dead within two weeks. Why Atlas is the first one I got over the line, and the first I built end to end with an AI agent.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Why This One Stuck",
    description:
      "Thirty-two repositories since 2023, most dead within two weeks. Why Atlas is the first one I got over the line, and the first I built end to end with an AI agent. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/why-this-one-stuck",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-06-25",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Why this one stuck",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Why This One Stuck",
    description:
      "Thirty-two repositories since 2023, most dead within two weeks. Why Atlas is the first one I got over the line, and the first I built end to end with an AI agent.",
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/blog/why-this-one-stuck" },
};

export default function WhyThisOneStuck() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("why-this-one-stuck")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="Founder note"
          isoDate="2026-06-25"
          dateLabel="June 25, 2026"
          readingTime="3 min read"
          title="Why this one stuck"
          dek="Thirty-two repositories since 2023. Most died within two weeks. Atlas is the first one I got over the line, and the first I built end to end with an AI agent."
        />

        <Lead>
          Atlas is the first side project I&apos;ve ever shipped. I&apos;ve
          started a lot of them.
        </Lead>
        <P>
          Scroll back through my GitHub and it reads like a graveyard. A burst
          of energy, a README, half a prototype, then silence. Only a handful
          ever made it past two months.
        </P>

        <StatStrip
          items={[
            { value: "32", label: "repos since 2023" },
            { value: "22", label: "died in < 2 weeks" },
            { value: "1", label: "shipped" },
          ]}
        />

        <H2>The same idea, a dozen times</H2>
        <P>
          The worst example is a security tool I kept calling Tide. I started
          it, scrapped it, and rebuilt it from scratch more times than I want to
          admit: <InlineCode>easy-casb</InlineCode>, then{" "}
          <InlineCode>securitytides</InlineCode>, then{" "}
          <InlineCode>tidesecurity</InlineCode>, then{" "}
          <InlineCode>tide-appdir</InlineCode>, then{" "}
          <InlineCode>tide-security</InlineCode>, then{" "}
          <InlineCode>tide-ai</InlineCode>, then just{" "}
          <InlineCode>tide</InlineCode>, then{" "}
          <InlineCode>tide-monorepo</InlineCode>. A dozen repositories, the same
          idea, three years.
        </P>
        <P>
          A few got real. One got genuinely big before I walked away. I&apos;d
          get close, close enough to see the end, and then I&apos;d lose the
          thread. A refactor I couldn&apos;t land. A rewrite that looked
          cleaner. A week off that turned into a month. The momentum would go
          cold, and picking it back up always felt harder than starting fresh.
        </P>

        <PullQuote>So I&apos;d start over. Again.</PullQuote>

        <H2>What was actually broken</H2>
        <P>
          For years I told myself I just didn&apos;t have the follow-through.
          That never quite fit.
          I&apos;ve spent most of the last decade in security: I started out as
          a signals-intelligence analyst in the Army, moved into cybersecurity,
          and spent years building and selling email-security products. At work
          I ship constantly. But I ship with a team around me, people who keep
          the thing moving when I step away for a day. On my own, after hours,
          every project hit the same wall.
        </P>
        <P>
          It was the middle that got me, every time. The unglamorous stretch
          between a prototype that works and a product that&apos;s actually
          done. Solo, that stretch is brutal. You lose context between sessions,
          you lose your nerve, and nobody keeps the thing warm while you sleep.
          A clean rewrite is always sitting right there, and it looks like a
          lot more fun than slogging to the end.
        </P>

        <H2>What changed</H2>
        <P>
          Atlas is the first project I built end to end with an AI agent.
          It held the whole codebase in its head, kept the thread when I lost
          it, and carried the work through the exact stretch where I always
          quit. I pointed it at problems and reviewed what came back. It did the
          heavy lifting. The project never sat cold long enough for me to talk
          myself into starting over. For once, the middle had someone else in
          it.
        </P>
        <P>
          I didn&apos;t plan the symmetry, but I like it. Atlas is a data
          analyst you run against your database as an agent. I built it by
          running an agent against a codebase. The bet is the same on both ends,
          and this is the first time mine has paid off.
        </P>

        <H2>Over the line</H2>
        <P>
          Atlas goes GA in July. After thirty-one false starts, that sentence
          still feels strange to type. If you want the product side, everything
          that shipped on the way here, it&apos;s in the{" "}
          <a href="/blog/announcing-atlas" className="link-accent">
            launch recap
          </a>
          . If you just want to see it work, the demo is live, with no signup
          and nothing to install.
        </P>

        <PostActions />
        <Signoff />

        <BackToBlog />
      </Article>

      <Divider />
      <Footer />
    </div>
  );
}
