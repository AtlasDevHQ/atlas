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
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "Yours, anywhere: the process is the region",
  description:
    "Self-hosted Atlas is free and your data never leaves. On Atlas Cloud, residency is enforced by topology rather than by a filter: each region is its own deployment, and a cross-region query is unexpressible rather than blocked.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Yours, anywhere: the process is the region",
    description:
      "Self-hosted Atlas is free and your data never leaves. On Cloud, each region is its own deployment, and a cross-region query is unexpressible rather than blocked.",
    url: "https://www.useatlas.dev/blog/the-process-is-the-region",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-31",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Yours, anywhere: the process is the region",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Yours, anywhere: the process is the region",
    description:
      "Self-hosted Atlas is free. On Cloud, each region is its own deployment, and a cross-region query is unexpressible rather than blocked.",
    images: ["/og.png"],
  },
  alternates: {
    canonical: "https://www.useatlas.dev/blog/the-process-is-the-region",
  },
};

export default function TheProcessIsTheRegion() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("the-process-is-the-region")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-31"
          dateLabel="July 31, 2026"
          readingTime="5 min read"
          title="Yours, anywhere: the process is the region"
          dek="Most residency guarantees are a filter and a promise. Closing the week on the one Atlas makes, and the mechanism underneath it."
        />

        <Lead>
          The simplest version of owning your analyst is running it yourself.
          Atlas self-hosts on Docker, Railway, Vercel, or your own hardware, and
          the self-hosted build is free under AGPL-3.0 with no seat cap and no
          features held back. Your database never opens a connection to me. For
          a lot of teams that ends the data-governance conversation before it
          starts.
        </Lead>
        <P>
          The interesting engineering is in the other case. On Atlas Cloud I
          host the thing, and a customer in Frankfurt asks whether their data
          stays in Europe. Answering yes is easy. Building a system where the
          answer is structurally true takes a particular shape.
        </P>

        <H2>How this usually goes</H2>
        <P>
          The common implementation is one deployment, one database, and a
          region column. Requests carry a tenant, the tenant has a region, and
          queries filter on it. Every read is correct as long as every query
          remembers the filter forever.
        </P>
        <P>
          That design puts all the data in one blast radius and leans on
          discipline to keep it separated. One forgotten <InlineCode>
            WHERE
          </InlineCode>{" "}
          clause in one reporting endpoint, and EU rows are on a US screen. The
          guarantee sold to the customer is a promise about future code review.
        </P>

        <H2>Regions as separate deployments</H2>
        <P>
          Atlas Cloud runs three independent deployments, in the United States,
          the European Union, and Asia-Pacific. Each one is a full copy of the
          product with its own database, its own object storage, and its own
          process. A workspace belongs to exactly one of them.
        </P>
        <P>
          The running process knows which region it is, and it holds no
          connection string, credential, or route to any other region&apos;s
          data. There is no filter to forget, because there is no combined table
          to filter. A query that spans two regions is not something the code
          rejects.
        </P>

        <PullQuote>
          A cross-region query isn&apos;t blocked. It&apos;s unexpressible.
        </PullQuote>

        <P>
          That distinction is the entire reason to build it this way. A blocked
          operation is one where the dangerous capability exists and something
          stands in front of it, which means the guard can have a bug, and I
          spent Wednesday writing about a guard that did. An unexpressible
          operation has no capability to guard. Routing a customer to their
          region happens once, at the edge, and everything downstream is a
          process that only ever had access to one region in the first place.
        </P>

        <H2>What that buys, concretely</H2>
        <DefList>
          <DefItem term="Isolation by default">
            A bug in a reporting query in the US deployment cannot return EU
            rows, because the US process has no path to them.
          </DefItem>
          <DefItem term="Independent blast radius">
            An incident, a bad migration, or a noisy tenant stays inside one
            region. The other two never see it.
          </DefItem>
          <DefItem term="Honest data maps">
            Where a workspace&apos;s data lives is a deployment fact rather than
            a policy document, so the answer on the security page matches the
            infrastructure.
          </DefItem>
        </DefList>

        <H2>The carve-out I can&apos;t engineer away</H2>
        <P>
          One piece doesn&apos;t fit the model. The sandbox that runs the
          agent&apos;s file and Python tools is provisioned through a platform
          that only offers US capacity, so sandboxed execution happens in the
          United States regardless of where a workspace lives. What crosses is
          semantic-layer content, knowledge documents the agent opens, and for
          Python, result rows.
        </P>
        <P>
          I couldn&apos;t make that true by writing code, so it&apos;s stated
          plainly on the{" "}
          <a href="https://www.useatlas.dev/security" className="link-accent">
            security page
          </a>
          , in the residency docs, and in the data processing agreement, with
          the remediation tracked in public issues. Workspaces that need
          in-region execution today can connect their own sandbox on an account
          whose region they control.
        </P>

        <H2>Moving between regions</H2>
        <P>
          A workspace can migrate. Its data is exported, imported into the
          target region, and the copy in the source region is deleted after a
          seven-day grace period, which is the part that used to be a sentence
          in the docs with no running code behind it. Every internal table now
          declares where it belongs, a CI tripwire refuses any table that
          doesn&apos;t, and a scheduled job carries the deletions out
          transactionally. I wrote about finding that gap in{" "}
          <a href="/blog/the-last-mile" className="link-accent">
            The last mile
          </a>
          .
        </P>

        <H2>The week</H2>
        <P>
          That closes five days of going one level down on each of the things
          Atlas claims:{" "}
          <a href="/blog/grounded-in-your-context" className="link-accent">
            grounding you author
          </a>
          ,{" "}
          <a href="/blog/the-live-security-pass" className="link-accent">
            safety checked against a live system
          </a>
          ,{" "}
          <a href="/blog/a-strangers-agent" className="link-accent">
            an anonymous surface one tool wide
          </a>
          , and infrastructure that stays where you put it. The through-line is
          that each guarantee should be a property of how the system is built,
          and plain enough that someone can go check it.
        </P>
        <P>
          The demo runs without a signup, and the source is on GitHub if
          you&apos;d rather read it than trust it.
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
