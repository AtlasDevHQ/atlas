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
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "Atlas is public",
  description:
    "Atlas is the AI data analyst you can run anywhere: plain-English answers over SQL warehouses and REST APIs, governed by a semantic layer you author. Self-hosted is free. Here's the whole surface, and what each day this week goes deep on.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Atlas is public",
    description:
      "The AI data analyst you can run anywhere: plain-English answers over SQL warehouses and REST APIs, governed by a semantic layer you author. Self-hosted is free.",
    url: "https://www.useatlas.dev/blog/atlas-is-public",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-27",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Atlas is public",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas is public",
    description:
      "The AI data analyst you can run anywhere: plain-English answers over SQL warehouses and REST APIs, governed by a semantic layer you author.",
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/blog/atlas-is-public" },
};

export default function AtlasIsPublic() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("atlas-is-public")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="Road to launch"
          isoDate="2026-07-27"
          dateLabel="July 27, 2026"
          readingTime="5 min read"
          title="Atlas is public"
          dek="The AI data analyst you can run anywhere. Plain-English answers over SQL warehouses and REST APIs, governed by a semantic layer you author, on infrastructure you control."
        />

        <Lead>
          Atlas is live. It&apos;s an AI data analyst you can run anywhere: ask
          a question in plain English, get an answer from your own data,
          governed by a semantic layer you write and can read.
        </Lead>
        <P>
          The security pass came back green, the load test held, and the{" "}
          <InlineCode>v0.1.0</InlineCode> tag is cut. Sixty-seven releases have
          been banked in the patch position since late May waiting for this
          one.
        </P>

        <StatStrip
          items={[
            { value: "8", label: "datasource families, plus REST" },
            { value: "24", label: "plugins across 5 types" },
            { value: "3", label: "cloud regions" },
          ]}
        />

        <H2>Sixty seconds, no signup</H2>
        <P>
          The demo runs on a seeded database with no account and nothing to
          install. Ask it something in plain English and watch the query it
          writes, the tables it chose, and the answer it gives you. Everything
          described below is running on that page, so you can check the claims
          against the thing itself.
        </P>

        <H2>What it is, in four parts</H2>
        <P>
          Atlas is built on four ideas that hold each other up. Each one gets
          its own post this week.
        </P>

        <DefList>
          <DefItem term="Grounded in your context">
            The model answers from definitions you author. A YAML semantic layer
            says what your tables mean, which joins are legal, and that the
            metric called revenue is this exact SQL. A Knowledge Base ingests
            your Notion, Confluence, and support docs as context the agent can
            search. Tuesday goes deep on this.
          </DefItem>
          <DefItem term="Trustworthy by design">
            Every query Atlas runs was written by a language model, and every
            one of them passes through a seven-layer read-only pipeline before
            it reaches your database. SELECT-only, whitelisted tables, an
            automatic row limit, a statement timeout. Wednesday covers what a
            live security pass against the running product turned up.
          </DefItem>
          <DefItem term="Agent-native">
            Atlas speaks MCP. An AI client can discover the server, authenticate
            over OAuth 2.1, and query your data through the same governed path a
            human uses. Thursday is about handing an agent you don&apos;t
            control a key that only opens one door.
          </DefItem>
          <DefItem term="Yours, anywhere">
            Deploy on Docker, Railway, Vercel, or your own infrastructure.
            Self-hosted Atlas is free under AGPL-3.0 with no seat count and no
            feature gate. On Atlas Cloud, three regions hold data where you
            choose. Friday closes the week here.
          </DefItem>
        </DefList>

        <PullQuote>
          A semantic layer humans author and agents consume.
        </PullQuote>

        <H2>The surfaces you&apos;ll actually use</H2>
        <P>
          Underneath the pillars are the things you open on a Tuesday morning.
          The chat surface answers first and shows its work underneath: the
          tables it read, the SQL it wrote, the rows that came back. Dashboards
          are draft-first, so a change stays yours until you publish it.
          Analysis that outgrows SQL runs in Python inside a sandbox. There is
          an embeddable widget for putting Atlas inside your own product, a REST
          API with a CLI on top of it, and chat that reaches your team where
          they already are, one-click on Slack and bring-your-own-bot for Teams,
          Discord, Telegram, and WhatsApp.
        </P>
        <P>
          Queries run against PostgreSQL, MySQL, ClickHouse, Snowflake,
          BigQuery, DuckDB, Elasticsearch, and Salesforce. REST and OpenAPI
          sources join the same semantic layer, so Stripe or GitHub or your own
          internal service answers questions next to your warehouse.
        </P>

        <H2>What it costs</H2>
        <P>
          Self-hosting is free and stays free. Atlas Cloud starts at{" "}
          <InlineCode>$39</InlineCode> per seat for Starter,{" "}
          <InlineCode>$69</InlineCode> for Pro, and{" "}
          <InlineCode>$149</InlineCode> for Business, each including{" "}
          <InlineCode>$20</InlineCode> per seat of AI usage at cost. Trials run
          fourteen days without a credit card.
        </P>

        <H2>The version number</H2>
        <P>
          The first minor version has been reserved for this day since the
          versioning scheme was written down. Every release since late May
          landed in the patch position, sixty-seven of them, and the minor only
          moved when Atlas went public. It just did.
        </P>
        <P>
          The month of work that cleared the last blocker is in{" "}
          <a href="/blog/the-last-mile" className="link-accent">
            The last mile
          </a>
          . Tomorrow: the grounding layer, and why the answers come from your
          definitions.
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
