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
  title: "Out of the Runtime",
  description:
    "Atlas got built by one person and an agent. Here's the part the launch recap skipped: the commands, the work queue, and the memory I built around the agent, and how they went from copy-paste at midnight to a loop that ships a milestone while I sleep.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Out of the Runtime",
    description:
      "How I built Atlas with an AI agent: a control plane of commands, a GitHub-issue work queue, and a memory of its own, evolved from hand-running prompts to overnight ship loops. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/out-of-the-runtime",
    siteName: "Atlas",
    type: "article",
    authors: ["Matt Sywulak"],
  },
};

export default function OutOfTheRuntime() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How I build"
          isoDate="2026-06-26"
          dateLabel="June 26, 2026"
          readingTime="7 min read"
          title="Out of the runtime"
          dek="Atlas got built by one person and an agent. This is the part the launch recap skipped: the commands, the work queue, and the memory I built around the agent, and how they went from copy-paste at midnight to a loop that ships a milestone while I sleep."
        />

        <Lead>
          In the launch recap I said Atlas got built by one person running an
          agent against a codebase. That&apos;s true, and it skips the part I
          find most interesting.
        </Lead>
        <P>
          The agent didn&apos;t freelance. It ran on rails: a set of{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/tree/main/.claude/commands"
            className="link-accent"
          >
            commands
          </a>
          , a queue of work it read like a to-do list, and a memory of its own. I
          built those rails, and I kept rebuilding them, because the work kept
          outgrowing whatever version I had. This is how they changed shape, and
          why the shape is the whole story.
        </P>

        <H2>The good mornings</H2>
        <P>
          The best mornings this spring, I opened my laptop and the milestone
          had moved without me. Two or three pull requests merged overnight,
          each one an issue I hadn&apos;t opened a single file for. Each had been
          written, read by four separate critics, run through the full test
          suite, and merged, while I slept.
        </P>
        <P>
          I didn&apos;t write that code. I wrote the thing that wrote it, and the
          thing that reviewed it, and the thing that picked what to build next.
          It took four months to get there, and it started with me pasting
          prompts into a terminal at midnight.
        </P>

        <StatStrip
          items={[
            { value: "30", label: "custom commands" },
            { value: "114", label: "facts in memory" },
            { value: "97", label: "refactors logged" },
          ]}
        />

        <H2>I was the runtime</H2>
        <P>
          Atlas began as a commit in February, co-authored with the agent from
          line one. I didn&apos;t arrive empty-handed. I brought over a handful
          of commands from the previous project I&apos;d just walked away from:{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/next.md"
            className="link-accent"
          >
            one to decide what to work on next
          </a>
          , one to research the codebase, one to check its health. Three small
          text files. That was the whole system.
        </P>
        <P>
          Everything between those commands was manual, and I was the part that
          made it go. Run the command to see what mattered most. Open a session.
          Paste the prompt. Wait for the code. Read it. Ask for changes. Run the
          tests. Open the pull request. Merge it. Run the command again. I was a
          slow, error-prone scheduler moving work between steps by copy-paste.
        </P>
        <P>
          I&apos;ve written before about why{" "}
          <a href="/blog/why-this-one-stuck" className="link-accent">
            this is the first side project I ever got over the line
          </a>
          . The short version: on my own, I always died in the middle, the
          unglamorous middle, the long grind between a working prototype and a
          finished thing. A loop is the answer to that. As long as
          something keeps the work moving while I&apos;m asleep or at my day job,
          the project never goes cold long enough for me to talk myself into
          starting over. So I spent the next few months turning myself, the slow
          scheduler, into software.
        </P>

        <H2>First, a queue</H2>
        <P>
          Before any code gets written, the real work is deciding what the work
          is. A conversation about a feature becomes a written spec; the spec
          becomes a milestone of small issues, each one sized to a single
          vertical slice you could ship on its own. I have commands for each of
          those steps, so the path from &ldquo;I have an idea&rdquo; to
          &ldquo;here are twelve tracked issues&rdquo; is a few minutes, not an
          afternoon.
        </P>
        <P>
          The issues live in GitHub, and that turned out to matter more than I
          expected. Every issue records its dependencies in plain text:{" "}
          <InlineCode>Depends on #142</InlineCode>. That one convention turns a
          pile of tickets into a graph. An issue is <em>ready</em> only when
          everything it depends on has merged, and the set of ready, unblocked
          issues is the frontier everything else pulls from. The tracker stopped
          being a list I maintained and became the queue the agent works off.
        </P>

        <H2>Then, three at once</H2>
        <P>
          Once a command could reliably pick the next thing, the obvious move
          was to run more than one. Three sessions, three different issues, going
          at the same time, sometimes from my desk, sometimes from the web app on
          a different machine. The throughput jumped. So did the chaos.
        </P>
        <P>
          They all shared one checkout. Three agents editing the same working
          tree means one can commit onto another&apos;s branch, and a careless{" "}
          <InlineCode>git add</InlineCode> can sweep up a neighbor&apos;s
          half-written files. I learned that the painful way. So the selection
          command grew a discipline: every prompt it hands out now opens with a
          loud banner telling that session to carve out its own private worktree
          before it touches anything. The rails grew a guardrail because I got
          burned without one. Most of them did.
        </P>

        <H2>Then, out of the loop</H2>
        <P>
          For a long time I was still the dispatcher, copying those prompts into
          fresh sessions by hand. In June I wired that up too. One command now
          takes a single issue from nothing to a merged pull request on its own:
          it reads the issue, picks the right craft loop, diagnosing first if
          it&apos;s a bug, test-driving if it&apos;s a feature, runs an internal
          review, passes CI, opens the PR, and then works every reviewer comment
          until the thing is green and merged.
        </P>
        <P>
          The review step is four critics, not one. Before a PR even opens,{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/tree/main/.claude/agents"
            className="link-accent"
          >
            four specialist reviewers
          </a>{" "}
          read the diff in fresh context, each tuned to a
          single way code goes wrong here: swallowed errors, weak types, thin
          tests, comments that lie. They hand findings back to the implementer,
          which fixes them and re-runs the panel until it&apos;s clean. Then the
          external review bots and CI take their own pass once the PR is up. The
          point is to catch things before a human ever has to, and to catch the
          same things every time.
        </P>
        <P>
          That single-issue loop{" "}
          <a
            href="https://github.com/AtlasDevHQ/atlas/blob/main/docs/agents/loops.md"
            className="link-accent"
          >
            composes into bigger ones
          </a>
          :
        </P>
        <DefList>
          <DefItem
            term={
              <a
                href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ship-issue.md"
                className="link-accent font-mono"
              >
                ship-issue
              </a>
            }
          >
            One issue, nothing to merged. Picks the craft loop, runs the panel,
            passes CI, opens the PR, services every comment until it lands.
          </DefItem>
          <DefItem
            term={
              <a
                href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ship-batch.md"
                className="link-accent font-mono"
              >
                ship-batch
              </a>
            }
          >
            A handful at once. The top few ready issues, each dispatched to its
            own isolated worktree agent, then collected when they finish.
          </DefItem>
          <DefItem
            term={
              <a
                href="https://github.com/AtlasDevHQ/atlas/blob/main/.claude/commands/ship-milestone.md"
                className="link-accent font-mono"
              >
                ship-milestone
              </a>
            }
          >
            The whole thing, on a heartbeat. It grinds an entire milestone to
            merged, waking itself each time a PR lands to dispatch the next
            unblocked issue. This is the one behind the good mornings.
          </DefItem>
        </DefList>
        <P>
          The dispatcher I used to be is a command now. So is the reviewer, and
          the scheduler, and the person who used to sit refreshing a PR for six
          hours answering review comments.
        </P>

        <PullQuote>I was the runtime. Now I&apos;m the operator.</PullQuote>

        <H2>A memory of its own</H2>
        <P>
          An agent wakes up to every session knowing nothing about the last one.
          Early on that meant it tripped over the same things on a loop: the same
          deploy-config quirk, the same way of pushing release tags that quietly
          published nothing at all. Watching it relearn a lesson I&apos;d already
          taught it was the most maddening part of the whole setup.
        </P>
        <P>
          So I gave it a memory. It&apos;s a directory of small fact-files the
          agent reads at the start of every session and writes to whenever it
          learns something durable, one lesson per file: a deploy gotcha, a
          test-runner footgun, a preference of mine, a hard-won fix it should
          never have to rediscover. There are 114 of them now. The system stopped
          repeating itself, because it finally had somewhere to keep what it
          knew.
        </P>
        <P>
          One command works the codebase itself. It hunts for duplication and
          tangled modules, proposes a refactor that makes the code simpler to
          navigate, and logs the before and after every time one ships. That log
          is 97 entries deep. The codebase got easier for the agent to reason
          about on purpose, one refactor at a time.
        </P>

        <H2>The line it won&apos;t cross</H2>
        <P>
          Running a loop unattended overnight only works because the dangerous
          actions are fenced off. The rule is short: the agent can do anything up
          to the merge gate on its own branches, and it stops for me at every
          boundary that&apos;s hard to undo. Merging code from an outside
          contributor&apos;s fork needs a human. Cutting a release to production
          is a separate step I run by hand. Merging to the main branch only ever
          reaches staging.
        </P>
        <P>
          Because the irreversible steps are gated, the worst a runaway loop can
          do overnight is waste tokens. That ceiling is the entire reason I can
          start one and go to sleep. A loop I had to watch every second would
          have bought me nothing; a loop with a hard floor under it is what let
          me step away.
        </P>

        <H2>Back to that morning</H2>
        <P>
          When I wake up and the milestone has moved, that&apos;s the rails doing
          the jobs I used to do at midnight: choosing the work, writing it,
          reviewing it, merging it, and remembering what they learned for next
          time. I still make the calls that matter, what to build, where the
          lines are, whether a tradeoff is the right one. The agent does the
          rest, including the part in the middle where everything I tried before
          this one died.
        </P>
        <P>
          Atlas answers data questions by running as an agent against your
          database. It got built by running an agent against its own codebase, on
          rails that kept getting better. And the rails matter more than the
          agent. A capable agent with no system around it stalls in exactly the
          place I always did. The system is what carried it through.
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
