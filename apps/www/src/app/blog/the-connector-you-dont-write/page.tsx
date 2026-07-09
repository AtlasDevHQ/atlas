import type { Metadata } from "next";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import {
  Article,
  BackToBlog,
  CodeBlock,
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
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "The connector you don't write",
  description:
    "A Knowledge Base connector is two methods and a converter. It never schedules itself, backs off a rate limit, or decides when to delete a document — the engine keeps all of that. Here's the seam, and why it let the OKF pillar go from a blog post to connectors for Notion, Confluence, and GitBook in days.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "The connector you don't write",
    description:
      "A Knowledge Base connector is two methods and a converter. It never schedules itself, backs off a rate limit, or decides when to delete a document — the engine keeps all of that. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/the-connector-you-dont-write",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-09",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "The connector you don't write",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "The connector you don't write",
    description:
      "A Knowledge Base connector is two methods and a converter. The engine keeps everything that can hurt your data.",
    images: ["/og.png"],
  },
  alternates: {
    canonical: "https://www.useatlas.dev/blog/the-connector-you-dont-write",
  },
};

export default function TheConnectorYouDontWrite() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("the-connector-you-dont-write")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-09"
          dateLabel="July 9, 2026"
          readingTime="6 min read"
          title="The connector you don't write"
          dek="A Knowledge Base connector pulls a customer's Notion or Confluence into Atlas. Writing one means implementing two methods and a converter. Everything that could damage their data lives somewhere else, on purpose."
        />

        <Lead>
          Atlas can mirror a customer&apos;s Notion workspace or Confluence
          spaces into its Knowledge Base, pulling their docs in on a schedule so
          the agent can read them. The code that teaches Atlas a new source of
          truth like that is called a connector. Writing one is a smaller job
          than you would guess, and what makes it small is the part you never
          have to write.
        </Lead>

        <StatStrip
          items={[
            { value: "2", label: "methods per connector" },
            { value: "1", label: "place a delete can happen" },
            { value: "3 days", label: "OKF post to first connector" },
          ]}
        />

        <H2>What a connector actually is</H2>
        <P>
          Every vendor talks a different dialect. Notion&apos;s change feed is a
          search that is officially allowed to skip results; Confluence has no
          markdown output at all and throttles you on a point budget. If each
          connector coped with its own vendor <em>and</em> ran its own
          scheduling, retries, and deletion logic, they would each be a small
          program, and each would carry its own version of the same dangerous
          bugs.
        </P>
        <P>
          So a connector is three parts with a hard line drawn between them. The
          first is a vendor client, and it is the entire surface a new vendor
          author fills in:
        </P>
        <CodeBlock title="the whole vendor-facing interface">{`interface ConnectorVendorClient {
  // changed documents since a timestamp
  fetchChanges(params: FetchSince): Promise<ConnectorChanges>;
  // the full current set, for a reconciliation crawl
  fetchAll(): Promise<ConnectorChanges>;
}`}</CodeBlock>
        <P>
          Two methods. Both return documents already in Atlas&apos;s own format,
          never raw vendor payloads. Turning a vendor payload into that format
          is the second part, a converter: pure functions, no network, the same
          input always producing the same output. The engine never sees a
          vendor&apos;s dialect, because the converter has already erased it.
        </P>
        <P>
          Confluence is the sharp example. Its API hands back storage-format
          XHTML, Atlassian&apos;s own tag soup of{" "}
          <InlineCode>&lt;ac:&gt;</InlineCode> and{" "}
          <InlineCode>&lt;ri:&gt;</InlineCode> macros, and the converter turns
          that into clean markdown. When it meets a macro it cannot represent, it
          does not drop it and move on. It leaves a visible placeholder linking
          back to the source page and counts that macro by name, so a sync can
          report that it degraded, say, three <InlineCode>jira</InlineCode>{" "}
          macros rather than pretending the page came through whole. A silent
          gap in a document the agent will later cite is worse than a labeled
          one.
        </P>

        <H2>What the engine keeps</H2>
        <P>
          The third part is a single shared engine, and it holds everything the
          two methods above do not. A vendor author writes none of this and
          cannot get any of it wrong:
        </P>
        <DefList>
          <DefItem term="Scheduling">
            Whether a given cycle is a cheap incremental fetch or a full
            reconciliation crawl is decided per collection, per run, by the
            engine.
          </DefItem>
          <DefItem term="Where to resume">
            The engine tracks a high-water mark and rewinds it by a five-minute
            overlap window on each fetch, so a vendor with a skewed clock or a
            minute-granular feed cannot drop a change through the crack. Re-fetched
            unchanged documents cost a little bandwidth and nothing else.
          </DefItem>
          <DefItem term="Rate limits">
            A vendor client throws when it gets a 429; the engine waits out the{" "}
            <InlineCode>Retry-After</InlineCode> (capped at a minute so an
            hour-long backoff cannot wedge the run) and retries up to three
            times total before recording that collection as failed.
          </DefItem>
          <DefItem term="Caps and ingest">
            Per-document size limits, the whole-set count cap, and the
            upsert-by-path write into the Knowledge Base all live in one
            transaction the engine owns.
          </DefItem>
        </DefList>
        <P>
          A failure in one collection is isolated: the cycle walks on to the next
          one. And the bookkeeping only moves forward on success. A failed cycle
          passes nulls, and the write coalesces the previous values back in, so a
          run that fell over can never quietly mark the changes it missed as
          already handled.
        </P>

        <H2>Why deletions live in exactly one place</H2>
        <P>
          Everything above exists to make one operation safe. A connector can
          remove documents from a Knowledge Base collection when they vanish
          from the source. That is the single most dangerous thing it does, and
          it is allowed to happen in exactly one situation: a reconciliation
          crawl that enumerated the full current set and can vouch for it.
        </P>
        <P>
          Incremental fetches never delete anything. They cannot, because the
          two launch vendors both lie by omission: Notion&apos;s search feed is
          documented as non-exhaustive, and Confluence&apos;s query language has
          edges where a changed page simply will not appear. A document archived
          because a feed forgot to mention it is a correctness bug with a
          customer staring at the blast radius. Deletions belong to the crawl
          that provably saw everything, and nowhere else.
        </P>
        <P>
          Even the crawl is not trusted blindly. A vendor client that had to cap
          its own descent, or skipped a malformed page, returns its documents
          with a flag that says <em>this enumeration was incomplete</em>. The
          engine still saves what it fetched, but it archives nothing and it
          holds the reconciliation clock, so a clean crawl is still due and the
          skipped deletions wait for it. That flag came out of a review pass over
          this milestone: without it, a depth-capped crawl would report as
          complete and archive every live document it never reached, behind a
          green checkmark. An empty crawl is the starkest case: it is always an
          error, and it archives nothing, because one bad vendor response must
          never be able to empty a collection.
        </P>

        <PullQuote>
          A connector can&apos;t archive your live docs, because connectors don&apos;t
          archive anything. The engine does, once, where it can be checked.
        </PullQuote>

        <H2>It cannot publish, either</H2>
        <P>
          One more line the engine draws. Every document a connector ingests is
          stamped with which vendor wrote it, a source value like{" "}
          <InlineCode>connector:confluence</InlineCode>. The Knowledge
          Base&apos;s publish step, the one that promotes a draft to something
          the agent will actually serve, only accepts documents whose source is a
          human upload. Adding a new connector widens the set of possible source
          values and can never widen the set that is allowed to publish. So
          everything a connector pulls in lands as a draft, waiting behind the
          same review gate a human&apos;s upload would. A connector can pull your
          docs in every night and still never push a word of them live.
        </P>

        <H2>From a blog post to three vendors in a week</H2>
        <P>
          A week and a half ago I argued that the{" "}
          <a href="/blog/why-the-semantic-layer-is-yaml" className="link-accent">
            semantic layer should be a plain file
          </a>
          , and found out the day after it went up that Google had already
          shipped the Open Knowledge Format on the same idea. I wrote about{" "}
          <a href="/blog/atlas-speaks-okf" className="link-accent">
            what Atlas did with it
          </a>
          : import, export, and a new Knowledge Base pillar built on the format.
          A pillar is only worth as much as what fills it, though, and the day
          that post went up nothing did.
        </P>
        <P>
          Three days later the first connector was feeding it. Within the week
          there were connectors for Notion, Confluence in both its Cloud and Data
          Center editions, and GitBook, each pulling a real portal into the
          Knowledge Base as reviewable OKF drafts. That pace comes straight from
          the shape above: a new vendor is two methods and a converter, so the
          work is adapter-sized, and the parts
          that could quietly corrupt a customer&apos;s data were written and
          reviewed one time, in the engine, instead of being reargued in every
          vendor that came after. The connector you write is small precisely
          because the connector you don&apos;t write is carrying the weight.
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
