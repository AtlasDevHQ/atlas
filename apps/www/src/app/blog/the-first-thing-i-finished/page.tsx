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

export const metadata: Metadata = {
  title: "The First Thing I Ever Finished",
  description:
    "Thirty-two repositories since 2023, most dead within two weeks. Why Atlas is the first one I got over the line — and the first I built start-to-finish with an AI agent.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "The First Thing I Ever Finished",
    description:
      "Thirty-two repositories since 2023, most dead within two weeks. Why Atlas is the first one I got over the line — and the first I built with an AI agent. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/the-first-thing-i-finished",
    siteName: "Atlas",
    type: "article",
    authors: ["Matt Sywulak"],
  },
};

export default function FirstThingIFinished() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="Founder note"
          isoDate="2026-06-25"
          dateLabel="June 25, 2026"
          readingTime="3 min read"
          title="The first thing I ever finished"
          dek="Thirty-two repositories since 2023. Most died within two weeks. Atlas is the first one I got over the line, and the first I built start-to-finish with an AI agent."
        />

        <Lead>
          I want to tell you something about Atlas that isn&apos;t in the
          changelog. It&apos;s the first thing I&apos;ve ever actually finished.
        </Lead>
        <P>
          If you scroll back through my GitHub, it reads like a graveyard. A
          burst of energy, a README, a half-built prototype, and then silence,
          over and over. Only a handful of projects ever made it past two
          months.
        </P>

        <StatStrip
          items={[
            { value: "32", label: "repos since 2023" },
            { value: "22", label: "died in < 2 weeks" },
            { value: "1", label: "finished" },
          ]}
        />

        <H2>The same idea, a dozen times</H2>
        <P>
          The clearest tell is a security product I kept calling Tide. I started
          it, scrapped it, and rebuilt it from scratch more times than I&apos;d
          like to admit: <InlineCode>easy-casb</InlineCode>, then{" "}
          <InlineCode>securitytides</InlineCode>, then{" "}
          <InlineCode>tidesecurity</InlineCode>, then{" "}
          <InlineCode>tide-appdir</InlineCode>, then{" "}
          <InlineCode>tide-security</InlineCode>, then{" "}
          <InlineCode>tide-ai</InlineCode>, then just{" "}
          <InlineCode>tide</InlineCode>, then{" "}
          <InlineCode>tide-monorepo</InlineCode>. A dozen repositories, the same
          idea, across three years.
        </P>
        <P>
          Some of them got real. One got genuinely big before I walked away.
          I&apos;d get close, close enough to see the finish line, and then
          I&apos;d lose the thread. A refactor I couldn&apos;t finish. A rewrite
          that felt cleaner. A week away that turned into a month. The momentum
          would go cold, and starting over always felt easier than picking back
          up.
        </P>

        <PullQuote>So I&apos;d start over. Again.</PullQuote>

        <H2>What was actually broken</H2>
        <P>
          It was never the ideas. Some of them were good. It was the messy
          middle, the unglamorous stretch between a working prototype and a
          finished product, where every project I&apos;ve ever started went to
          die. Solo, that middle is brutal. You lose context, you lose nerve,
          and there&apos;s no one to keep the thing moving while you sleep. The
          rewrite is always right there, promising a clean slate, and a clean
          slate is so much more fun than finishing.
        </P>

        <H2>What changed</H2>
        <P>
          Atlas is the first project I built start-to-finish alongside an AI
          agent. Not as a fancy autocomplete, but as a collaborator that held
          the whole codebase in its head, never lost the thread, and kept the
          work moving through exactly the stretch where I always used to quit. I
          directed; it did the heavy lifting. The project never went cold long
          enough for me to talk myself into a rewrite. For the first time, the
          messy middle had someone else in it.
        </P>
        <P>
          There&apos;s a symmetry to that I didn&apos;t plan. Atlas is a data
          analyst you run as an AI agent against your database. It was built by
          one person running an AI agent against a codebase. The same bet, both
          ends, and the first one of mine that ever paid off.
        </P>

        <H2>Over the line</H2>
        <P>
          Atlas goes GA in July. After thirty-one false starts, that sentence
          still feels strange to write. If you want the product side of the
          story, everything that shipped on the road here, it&apos;s in the{" "}
          <a href="/blog/announcing-atlas" className="link-accent">
            launch recap
          </a>
          . If you just want to see it work, the demo is live: no signup, no
          installation.
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
