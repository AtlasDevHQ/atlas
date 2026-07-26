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
  Step,
  Steps,
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "Grounded in your context",
  description:
    "Ask two tools for revenue and you get two numbers. Atlas reads your definitions first: a YAML semantic layer you author, a Knowledge Base of your own docs, and the query patterns it learns as people approve them.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Grounded in your context",
    description:
      "Ask two tools for revenue and you get two numbers. Atlas reads your definitions first: a YAML semantic layer you author, a Knowledge Base of your own docs, and the patterns it learns.",
    url: "https://www.useatlas.dev/blog/grounded-in-your-context",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-28",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Grounded in your context",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Grounded in your context",
    description:
      "Ask two tools for revenue and you get two numbers. Atlas reads your definitions first.",
    images: ["/og.png"],
  },
  alternates: {
    canonical: "https://www.useatlas.dev/blog/grounded-in-your-context",
  },
};

export default function GroundedInYourContext() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("grounded-in-your-context")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-28"
          dateLabel="July 28, 2026"
          readingTime="6 min read"
          title="Grounded in your context"
          dek="Ask two tools what revenue was last quarter and you can get two different numbers. The difference is grounding, and grounding is something you write down."
        />

        <Lead>
          Point a text-to-SQL tool at a warehouse it has never seen and ask what
          revenue was last quarter. It will read your column names, guess at
          what they mean, pick a table that looks right, and hand you a number
          with total confidence. Ask a second tool and you can get a different
          number. Both queries ran. Only one matches how your company counts
          revenue, and nothing in either tool knows which.
        </Lead>
        <P>
          Every hard problem in this product reduces to that gap. A model can
          write SQL. What it cannot do is know that{" "}
          <InlineCode>shipping_cost</InlineCode> is stored negative for refunds,
          that the finance team excludes trials, or that{" "}
          <InlineCode>orders</InlineCode> has two rows per order after a 2024
          migration. That knowledge lives in your company, and Atlas asks you to
          write it down.
        </P>

        <PullQuote>
          Revenue means whatever your company decided it means.
        </PullQuote>

        <H2>The semantic layer is a file you can read</H2>
        <P>
          The center of Atlas is a directory of YAML. One file per entity, with
          the columns that matter, what they mean, sample values, which joins
          are legal, and the measures your team actually reports on. A metric
          defined there is authoritative: when someone asks for monthly
          recurring revenue, Atlas runs the SQL you wrote under that name rather
          than composing its own.
        </P>
        <P>
          Plain YAML was a deliberate choice, and I made the full argument for
          it in{" "}
          <a href="/blog/why-the-semantic-layer-is-yaml" className="link-accent">
            Why the semantic layer is a YAML file
          </a>
          . The short version: you can open it, diff it, review it in a pull
          request, and hand it to a new engineer. Embeddings and schema crawls
          give you none of those.
        </P>
        <P>
          The same file does structural work. Only tables named in the semantic
          layer are queryable at all, so the layer that teaches the model your
          business also bounds what it can touch. Wednesday&apos;s post covers
          that side of it.
        </P>

        <H2>The Knowledge Base, for everything that isn&apos;t a table</H2>
        <P>
          Plenty of context never belongs in a schema. Why the EMEA numbers
          restated in March. What the pricing migration did to the plan names.
          The runbook that explains which of two dashboards finance trusts.
          That material lives in Notion and Confluence and a support site, and
          for a long time Atlas had nowhere to put it.
        </P>
        <P>
          The Knowledge Base is the fourth product pillar and the largest thing
          added since the beta recap. Atlas mirrors your documents into
          per-workspace collections, stores them in the Open Knowledge Format,
          and serves them to the agent through a search tool that combines
          full-text matching with a single hop across the document link graph.
          The agent reads your prose the same way it reads your schema.
        </P>

        <StatStrip
          items={[
            { value: "10", label: "vendor connectors" },
            { value: "12", label: "ways to load knowledge" },
            { value: "0", label: "documents live without review" },
          ]}
        />

        <P>
          Ten of those connectors pull from a vendor on a schedule: Notion,
          Confluence Cloud and Data Center, GitBook, Zendesk Guide, Intercom,
          Front, Help Scout, Freshdesk, and Salesforce Knowledge. The other two
          paths are a direct upload and a bundle sync for content you generate
          yourself. Writing a new one is a small job because the engine keeps
          the scheduling and the rate-limit backoff, which I wrote up in{" "}
          <a href="/blog/the-connector-you-dont-write" className="link-accent">
            The connector you don&apos;t write
          </a>
          . On the format choice, and where a runtime has to go past the spec,
          see{" "}
          <a href="/blog/atlas-speaks-okf" className="link-accent">
            Atlas speaks OKF
          </a>
          .
        </P>
        <P>
          Everything a connector ingests arrives as a draft. That is enforced in
          the ingest seam rather than left to operator discipline: a synced
          document cannot reach the published state that the agent reads until
          somebody approves it. A wrong page in your wiki stays a wrong page in
          your wiki.
        </P>

        <H2>The part that compounds</H2>
        <P>
          The third source of grounding accumulates on its own. When a query
          gets approved, Atlas can keep it as a learned pattern, attributed to
          the person who blessed it, and reach for it the next time a similar
          question arrives.
        </P>

        <Steps>
          <Step n={1} title="Someone asks a hard question">
            The agent reads the semantic layer, searches the Knowledge Base, and
            writes SQL against what it found.
          </Step>
          <Step n={2} title="A human approves the answer">
            The query and the question are stored together, with the approver
            recorded alongside them.
          </Step>
          <Step n={3} title="The next asker inherits it">
            A similar question surfaces the approved pattern, so the second
            person gets the answer the first one vetted.
          </Step>
        </Steps>

        <H2>Why this is the whole game</H2>
        <P>
          A tool that infers your schema is guessing at the one thing you can
          state exactly. Atlas asks for the definitions up front, keeps them in
          files you own, surrounds them with your written context, and lets
          approved work accumulate. The answers are right because the context is
          yours.
        </P>
        <P>
          Tomorrow: what stands between a model-written query and your database,
          and what a security pass against the running product found.
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
