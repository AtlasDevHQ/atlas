import type { Metadata } from "next";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  Article,
  BackToBlog,
  DefItem,
  DefList,
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
  title: "The price of /ci",
  description:
    "A single slash command was eating roughly a tenth of a week's token budget. The fix that cut /ci's footprint ~97% per run — and the CI drift, dead code, and flaky tests it turned up along the way.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "The price of /ci",
    description:
      "/ci was eating about 10% of a week's token budget. How one wrapper script cut its footprint ~97% per run, closed real CI drift, and reapplied to the next biggest spender the same day. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/the-price-of-ci",
    siteName: "Atlas",
    type: "article",
    authors: ["Matt Sywulak"],
  },
};

export default function ThePriceOfCi() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How I build"
          isoDate="2026-06-30"
          dateLabel="June 30, 2026"
          readingTime="4 min read"
          title="The price of /ci"
          dek="/ci is a mandatory gate wired into nearly every other shipping command here, fired once per issue by the unattended ship loops — and it was eating something like a tenth of a week's token budget. The fix cut its footprint about 97% per run, and the same pass closed real drift between what runs locally and what runs in CI."
        />

        <Lead>
          Sometime this spring I noticed <InlineCode>/ci</InlineCode> was
          eating something like a tenth of my weekly token budget, and the
          reason took a minute to track down. <InlineCode>/ci</InlineCode>{" "}
          sits as a mandatory gate inside nearly every other command that
          ships code here —{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/pr.md"
            className="link-accent font-mono"
          >
            /pr
          </a>
          ,{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/release.md"
            className="link-accent font-mono"
          >
            /release
          </a>
          ,{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/next.md"
            className="link-accent font-mono"
          >
            /next
          </a>
          , and{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ship-issue.md"
            className="link-accent font-mono"
          >
            /ship-issue
          </a>
          . Which means{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ship-batch.md"
            className="link-accent font-mono"
          >
            /ship-batch
          </a>{" "}
          and{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ship-milestone.md"
            className="link-accent font-mono"
          >
            /ship-milestone
          </a>{" "}
          run it once per issue, all night, unattended, while I sleep.
        </Lead>
        <P>
          Each of those invocations ran 16 separate gates: lint, the type
          checker, the full test suite, a dozen drift and security scripts.
          Every gate ran as its own shell call, and every one streamed its
          full output straight into the agent&apos;s context — every
          warning, every passing test, every line. Multiply that by a
          milestone&apos;s worth of issues running overnight and it adds up
          fast.
        </P>

        <H2>Free to run, expensive to read</H2>
        <P>
          The gates themselves cost nothing. They&apos;re shell scripts and
          test runners burning CPU on my own machine, no model involved. The
          bill comes from what happens after: every gate&apos;s output lands
          in the agent&apos;s context, and the agent loop re-bills that
          accumulated context on every step that follows. A fix-and-rerun
          loop doesn&apos;t read a multi-thousand-line test dump once. It
          reads it again on the next step, and the step after that, for as
          long as the session runs.
        </P>
        <P>
          I&apos;ve written before about{" "}
          <a href="/blog/out-of-the-runtime" className="link-accent">
            the rails this project runs on
          </a>{" "}
          — commands, a work queue, a memory the agent reads and writes
          between sessions. <InlineCode>/ci</InlineCode> is one of those
          commands, and because it&apos;s wired into so many of the others,
          it was the single most expensive one to invoke, by a wide margin.
        </P>

        <H2>One script, one table</H2>
        <P>
          The fix is{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/scripts/ci-local.sh"
            className="link-accent font-mono"
          >
            scripts/ci-local.sh
          </a>
          , a wrapper that didn&apos;t need to be clever, just thorough. It
          runs every required gate, redirects each one to its own log file on
          disk, and prints a single compact pass/fail table. A failing gate
          shows its tail in that table. A clean run is a few dozen lines,
          full stop.
        </P>
        <P>
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ci.md"
            className="link-accent font-mono"
          >
            /ci
          </a>{" "}
          itself changed too: instead of running the wrapper inline, it now
          hands the job to a subagent, which
          returns a short report. The full test output, the lint warnings,
          all of it, never reaches the main conversation. It sits on disk in{" "}
          <InlineCode>.ci-local/</InlineCode>, where I can go read the detail
          if a gate actually fails.
        </P>

        <StatStrip
          items={[
            { value: "97%", label: "less output per run" },
            { value: "26", label: "gates, one report" },
            { value: "10", label: "new gates closing drift" },
          ]}
        />
        <P>
          Those numbers are output volume, stripped of ANSI codes and
          converted at roughly four characters a token — a proxy for context
          cost, not a billed-token measurement. The real number is probably
          worse: the agent-loop re-billing multiplier, the part where every
          step re-reads the accumulated context, isn&apos;t counted here at
          all. Measured straight, the old <InlineCode>/ci</InlineCode>{" "}
          streamed about 41,100 tokens of output per run. The new table is
          about 420.
        </P>

        <PullQuote>
          Making it cheaper and making it correct turned out to be the same
          edit.
        </PullQuote>

        <H2>What chasing the savings turned up</H2>
        <P>
          Building the wrapper meant running every gate end to end,
          repeatedly, to make sure the table was telling the truth. That
          turned up three things that had nothing to do with token cost.
        </P>
        <DefList>
          <DefItem term="Drift closed">
            Real CI was already running 10 gates the local command had
            quietly never picked up — checks that catch a Dockerfile
            drifting from the workspace it&apos;s built from, enterprise-only
            code leaking into the open-source core, a published package
            version going out that never actually reached npm. Those gates
            run locally now, caught before a push instead of after.
          </DefItem>
          <DefItem term="Dead code, gone">
            A stale, untracked <InlineCode>plugins/slack/</InlineCode>{" "}
            directory — leftover node_modules from before Slack became a
            chat adapter — had been silently false-failing a gate every time
            I ran it locally. Nobody noticed, because the gate wasn&apos;t
            required to pass before. Now it has to.
          </DefItem>
          <DefItem term="Flakes isolated">
            The full test suite flakes under CPU contention on WSL2 — three
            tests, always the same three. They run in their own isolated
            stage now, instead of randomly taking down a clean pass.
          </DefItem>
        </DefList>

        <H2>Where it stops</H2>
        <P>
          By the end of the same day, the same move went into{" "}
          <InlineCode>/ship-issue</InlineCode>&apos;s external-review step —
          the part that used to sweep three GitHub endpoints by hand and poll
          them every 30 to 60 seconds, up to ten minutes, three rounds deep. A
          second wrapper,{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/scripts/pr-review-status.sh"
            className="link-accent font-mono"
          >
            scripts/pr-review-status.sh
          </a>
          , fetches each source once and prints a single snapshot instead.
        </P>
        <P>
          It only went partway, though. Collecting the data and comparing
          commit SHAs is mechanical, so that part distilled cleanly, same as{" "}
          <InlineCode>/ci</InlineCode>. Deciding whether a review comment is a
          real bug or a stylistic nod, and then fixing it, needs the
          conversation, so that part stayed exactly where it was, in the main
          thread.
        </P>
        <P>
          The test I&apos;d use before trying this again: is the output
          verbose, is the verdict mechanical, is the detail disposable once
          you have the verdict, and is the agent loop re-billing it on every
          step. <InlineCode>/ci</InlineCode> was four for four. The review
          loop was two. Distill what&apos;s mechanical, and leave the
          judgment where it has to live.
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
