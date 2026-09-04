import type { Metadata } from "next";
import Image from "next/image";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  Article,
  BackToBlog,
  CodeBlock,
  H2,
  Lead,
  P,
  PostHeader,
  PullQuote,
  Signoff,
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { MCP_DEMO_COMMAND, SENTENCE } from "../../../components/landing/data";
import { blogPostingJsonLd } from "../../../lib/seo";

const TITLE = "A name on every fact";
const DESCRIPTION =
  "An agent said the return window was 30 days. It was 14. Nobody knew who had told it that. Atlas is the company facts your AI agents can trust, and the fix is a person's name on every one.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: TITLE,
    description: SENTENCE,
    url: "https://www.useatlas.dev/blog/a-name-on-every-fact",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-09-10",
    authors: ["Matt Sywulak"],
    images: [{ url: "/og.png", width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: SENTENCE,
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/blog/a-name-on-every-fact" },
};

/**
 * The recording's slot. The take (#5605) is a dated GIF under public/launch/;
 * this element is where it renders, so the post and the README embed the same
 * file.
 */
function Recording() {
  return (
    <figure className="my-8">
      <Image
        src="/launch/demo.gif"
        alt="Sixty seconds in Claude Desktop: one command, one question about NovaMart's return window, an answer with a name and a date on it, the contradiction beside it, and the coverage page marking a channel nobody has surveyed."
        className="w-full rounded-xl border border-code-border shadow-pane"
        width={1280}
        height={720}
        unoptimized
      />
    </figure>
  );
}

export default function ANameOnEveryFact() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("a-name-on-every-fact")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="Launch"
          isoDate="2026-09-10"
          dateLabel="September 10, 2026"
          readingTime="5 min read"
          title={TITLE}
          dek="An agent said the return window was 30 days. It was 14. Nobody knew who had told it that."
        />

        <Lead>
          Ask a coding agent a question about your own company and it answers
          with the same confidence it brings to a stack trace. Sometimes it is
          right. When it is wrong, the interesting question is not why the
          model guessed. It is why nothing in the loop could say who had stood
          behind the fact it used.
        </Lead>

        <P>
          Here is the case that made me build Atlas. A support agent, wired to
          a company&apos;s chat history, told a customer the return window was
          30 days. Finance had said so in a pinned message in July. Support had
          changed the macro to 14 days in August and said, in the same channel,
          to stop quoting 30. Both messages were in the index. The agent picked
          one, said it plainly, and moved on. Nobody could tell, afterwards,
          which message it had used, whether anyone had ever approved either as
          policy, or which other channels it had never read at all.
        </P>

        <P>
          That is the shape of the problem, and it is not a retrieval problem.
          The field that calls itself company memory has converged on one
          substrate: facts split from episodes, timestamps for when a thing
          became true and when it stopped, provenance back to a source. The
          benchmarks are saturating. Adoption is not, and the people building
          these systems say so themselves. What is missing is not a better
          score. It is a person.
        </P>

        <PullQuote>{SENTENCE}</PullQuote>

        <H2>Three kinds of thing</H2>
        <P>
          Atlas holds three kinds of thing, and every answer says which one it
          is drawing on. <strong>Surveyed</strong> facts are read straight from
          the company&apos;s own data through a semantic layer a human wrote:
          the query re-reads live rows, nobody interpreted anything, and the
          answer cannot go stale between readings. <strong>Attested</strong>{" "}
          facts were extracted from something someone wrote, then approved by a
          named person in the company who is now on the record for it.{" "}
          <strong>On the record</strong> is the raw material itself, unedited:
          trustworthy as testimony, never as fact.
        </P>
        <P>
          Two rules hold the three together. Surveyed outranks Attested
          wherever they overlap, so a recollection never overwrites the data.
          And nothing becomes Attested without a person choosing to make it so.
          There is no setting that turns that off.
        </P>

        <H2>The tier that cannot be wrong</H2>
        <P>
          The warehouse is the part of a company that already knows what
          happened, and it is the one source no extraction pipeline can improve
          on. A number read from the orders table is not an opinion about the
          orders table. It carries its own timestamps, it re-reads live on every
          question, and the proof is the SQL and the rows. Atlas runs that
          query read-only, one statement, whitelisted to the tables a human
          named, behind seven layers of validation. That tier is the spine. Everything
          written down by people sits above it, labelled, and yields to it.
        </P>

        <H2>Nothing counts until a person says so</H2>
        <P>
          Most memory systems write silently: a hook runs on every prompt, a
          fact is scored, and a conflict is resolved toward the newest message.
          It is a reasonable design and it is the one I refused. When the
          newest message wins, the intern outranks the head of finance by
          posting later. When a model resolves the conflict, the answer to
          &ldquo;who decided this was true?&rdquo; is a confidence score.
        </P>
        <P>
          In Atlas a contradiction is shown as a contradiction. The return
          window is 30 days, says Priya Natarajan in #finance, on the 14th of
          July. It is 14 days, says the support macro, on the 2nd of August.
          Both claims, both sources, both names, and Atlas has picked neither.
          A person closes it, or it stays open. And one page shows the shape
          of what is known: which parts of the company are well surveyed, which
          are thin, and which nobody has surveyed at all. It is most useful
          exactly where it is empty.
        </P>

        <H2>What this costs</H2>
        <P>
          Two things, and I am paying both on purpose. The first is breadth.
          A vendor that indexes everything will always win a connector count,
          and if your job is to make ten thousand documents findable you should
          buy that vendor. Atlas is a smaller set of facts you can actually
          trust, and losing a breadth comparison is an expected outcome, not a
          defect.
        </P>
        <P>
          The second is adoption. Consulting Atlas is always an explicit act, a
          tool call an agent makes and a person can see. Atlas does not silently
          inject itself into other tools&apos; prompts, because a fact an agent acts
          on should arrive through a door someone opened. That is slower to
          spread than a hook that fires on every prompt. I think a company
          fact with a name on it is worth the friction, and I would rather be
          argued with on that than on a benchmark. The sharpest version of the
          other position is{" "}
          <a
            href="https://news.ycombinator.com/item?id=48387095"
            className="link-accent"
          >
            Hyper&apos;s own launch thread
          </a>
          , which is worth reading whole.
        </P>

        <H2>Sixty seconds</H2>
        <P>
          One command into Claude Desktop, Cursor or Continue, against a hosted
          demo company. No account, no email.
        </P>
        <CodeBlock title="terminal">{MCP_DEMO_COMMAND}</CodeBlock>
        <P>
          Restart the client and ask what NovaMart&apos;s return window is.
          The answer arrives with a name and a date on it, the contradiction
          beside it, and neither side chosen for you. The whole of Atlas runs
          on infrastructure you control, under a license that keeps the working
          parts free.
        </P>

        <Recording />

        <Signoff />

        <BackToBlog />
      </Article>

      <Divider />
      <Footer />
    </div>
  );
}
