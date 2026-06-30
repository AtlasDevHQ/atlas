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

export const metadata: Metadata = {
  title: "Why the Semantic Layer Is a YAML File",
  description:
    "Ask a text-to-SQL agent what your revenue is and it picks a number. Atlas reads a file first — plain YAML, the kind you can open and edit — that says what your data actually means. Here's why that file is the most important thing in the system.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Why the Semantic Layer Is a YAML File",
    description:
      "The smartest thing in a text-to-SQL agent isn't the model — it's a YAML file a human can read. Why Atlas's semantic layer is a plain text file, and not embeddings, fine-tuning, or a schema crawl. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/why-the-semantic-layer-is-yaml",
    siteName: "Atlas",
    type: "article",
    authors: ["Matt Sywulak"],
  },
};

export default function WhyTheSemanticLayerIsYaml() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-06-29"
          dateLabel="June 29, 2026"
          readingTime="6 min read"
          title="Why the semantic layer is a YAML file"
          dek="Ask a text-to-SQL agent what your revenue is and it picks a number. Atlas reads a file first — plain YAML, the kind you can open and edit — that says what your data actually means."
        />

        <Lead>
          Ask Atlas &ldquo;what&apos;s our revenue?&rdquo; and it does something
          a demo would never do: it asks you back.
        </Lead>
        <P>
          GMV, the total value of every order placed? Net revenue, after
          refunds? Or what a marketplace seller actually keeps once you subtract
          the platform&apos;s commission? Those are three different numbers, and
          the word &ldquo;revenue&rdquo; points at all of them. A model that
          answers instantly has to quietly pick one and hope it&apos;s the one
          you meant. Atlas stops and asks.
        </P>
        <P>
          It can do that because the meaning of &ldquo;revenue&rdquo; is written
          down. There&apos;s a file that sits between your database and the
          agent and spells out what your data means: plain{" "}
          <InlineCode>YAML</InlineCode>, the kind a person reads over coffee.
          That file is the semantic layer, and it is the most important thing in
          Atlas.
        </P>

        <H2>A real database is mostly noise</H2>
        <P>
          Point a text-to-SQL tool straight at a production database and the
          trouble starts before you write any SQL: the schema lies by
          omission. Real databases accumulate junk the way an attic does:
          abandoned tables from a migration three years ago, columns nobody fills
          in anymore, two spellings of the same category, a backup somebody made
          &ldquo;just in case&rdquo; and never deleted. The industry has a name
          for the wider version of this. Splunk&apos;s 2019{" "}
          <a
            href="https://www.splunk.com/en_us/form/the-state-of-dark-data.html"
            className="link-accent"
          >
            dark-data survey
          </a>{" "}
          estimated that 55% of an organization&apos;s data is &ldquo;dark&rdquo;:
          collected and stored, but never used, and sometimes not even known to
          exist.
        </P>
        <P>
          That&apos;s why the demo dataset looks the way it does. I built
          NovaMart, the fictional e-commerce brand behind the live demo, to carry
          the same silt a real database does, on purpose. It has fifty-two
          tables, and four of them are deadweight:{" "}
          <InlineCode>old_orders_v1</InlineCode>,{" "}
          <InlineCode>temp_product_import_2023</InlineCode>, a backup of payment
          methods, a dead analytics table. A clean toy schema flatters the agent
          and proves nothing; a messy one shows whether it actually works.
        </P>

        <StatStrip
          items={[
            { value: "52", label: "tables in the demo database" },
            { value: "13", label: "that actually matter" },
            { value: "4", label: "abandoned landmines" },
          ]}
        />

        <P>
          A crawler that reads the schema learns all fifty-two tables, junk
          included, with no way to know which four will quietly poison an answer.
          The semantic layer is the editorial pass the schema can&apos;t do for
          itself: it covers the thirteen entities that are real, leaves the
          deadweight out, and steers the agent clear of the junk.
        </P>

        <H2>A column name is not a fact</H2>
        <P>
          Even inside the tables that matter, the names mislead. There&apos;s a
          column on the orders table called <InlineCode>shipping_cost</InlineCode>.
          Ask what NovaMart spends on shipping and the obvious move is to{" "}
          <InlineCode>SUM</InlineCode> it. The answer comes out wrong, sometimes
          by a factor of a hundred, because some rows are recorded in dollars and
          others in cents, and the column type, a plain number, says nothing
          about it. A model has no way to see that. A person who has worked with
          the data got burned by it once and never forgot.
        </P>
        <P>So that knowledge goes in the file, right next to the column:</P>
        <CodeBlock title="semantic/entities/orders.yml">{`- name: shipping_cost
  sql: shipping_cost
  type: number
  description: |
    WARNING: Mixed units — some rows in dollars, some in cents.
    Do not aggregate directly. See glossary for handling guidance.`}</CodeBlock>
        <P>
          The agent reads that before it writes a line of SQL, and the trap
          stops being a trap. The same file carries everything else a schema
          can&apos;t hold: that <InlineCode>total_cents</InlineCode> is the
          revenue field and <InlineCode>subtotal_cents</InlineCode> is not, which
          columns join to which, that{" "}
          <InlineCode>acquisition_source</InlineCode> stores the same value in
          inconsistent casing and wants a <InlineCode>LOWER()</InlineCode> before
          you group on it. None of that is in the database. All of it is in the
          file.
        </P>

        <H2>When the word is ambiguous, the agent asks</H2>
        <P>
          Some words don&apos;t have one right answer, and the honest move is to
          say so. The layer has a glossary, and a term can be marked ambiguous on
          purpose:
        </P>
        <CodeBlock title="semantic/glossary.yml">{`revenue:
  status: ambiguous
  note: >
    Could mean GMV (total order value from orders.total_cents),
    net revenue (GMV minus refunds), or seller revenue (after
    commission). ASK the user which definition they mean.`}</CodeBlock>
        <P>
          That&apos;s the instruction behind the question at the top of this
          post. <InlineCode>revenue</InlineCode> is flagged. So is{" "}
          <InlineCode>price</InlineCode>, which lives in dollars on one column
          and cents on another that&apos;s forty percent empty. So is{" "}
          <InlineCode>status</InlineCode>, which means one thing on orders and
          something else on payments, products, returns, and shipments. When the
          agent hits a flagged word, it stops and asks. A term with three
          meanings should produce an answer only after you&apos;ve said which one
          you want.
        </P>

        <H2>Metrics are not suggestions</H2>
        <P>
          For the numbers that carry weight, even a good guess isn&apos;t good
          enough. When someone asks for GMV there is one definition the business
          has agreed on, and the agent should use it every time instead of
          re-deriving it and hoping the SQL lands the same way twice. So the
          metrics that matter are pinned, query and all:
        </P>
        <CodeBlock title="semantic/metrics/revenue.yml">{`- id: total_gmv
  label: Total GMV
  description: Gross Merchandise Value — total value of all
    non-cancelled orders.
  sql: |-
    SELECT SUM(total_cents) / 100.0 AS total_gmv
    FROM orders
    WHERE status != 'cancelled'`}</CodeBlock>
        <P>
          That query is authoritative. The agent runs it as written rather than
          composing its own version, so GMV means the same thing in a
          Tuesday-morning Slack question as it does on the board deck. The
          definition lives in one place, and everyone reads from it, the agent
          included.
        </P>
        <P>
          Scattered definitions are a known failure mode. When a metric lives
          across a dozen dashboards instead of one file, as Benn
          Stancil wrote in the essay that made the case for a{" "}
          <a href="https://benn.substack.com/p/metrics-layer" className="link-accent">
            metrics layer
          </a>
          , &ldquo;in the best case, these calculations drift apart over time; in
          the worst case, they never match in the first place.&rdquo; Pinning the
          definition is the cheap way out.
        </P>

        <PullQuote>
          Every answer Atlas trusts traces back to a line written down in plain
          text.
        </PullQuote>

        <H2>Why I chose plain text</H2>
        <P>
          There are flashier ways to hand a model context about a database. I
          picked the plain one on purpose.
        </P>
        <DefList>
          <DefItem term="Embeddings over the schema">
            Index every table and column, retrieve the nearest matches at query
            time. Fine until the data changes, at which point the index
            confidently describes a database that no longer exists. You
            can&apos;t read it, and it gives you no signal when it&apos;s gone
            wrong.
          </DefItem>
          <DefItem term="Fine-tuning on your schema">
            Bake the knowledge into model weights. Now it&apos;s frozen at
            training time, costly to refresh, and impossible to inspect. You
            can&apos;t open a model and read what it believes about your orders
            table.
          </DefItem>
          <DefItem term="Raw schema introspection">
            Let the agent read the live schema directly. Honest about what
            exists, blind to what it means. It sees that{" "}
            <InlineCode>shipping_cost</InlineCode> is a number and has no idea
            half the rows are in the wrong unit.
          </DefItem>
          <DefItem term="A YAML file">
            You can read every word of it. You can see exactly why the agent did
            what it did, because the reason is sitting in the file. When the data
            changes, you change a line.
          </DefItem>
        </DefList>

        <H2>You can read it, and change it</H2>
        <P>
          Most teams never hand-write the YAML from scratch. You connect a
          database and Atlas scans it into a first draft with no model in the
          loop, instant and free. From there you can enrich it with an LLM,
          AI-written descriptions, business terms, and known query patterns, and
          you can edit any line yourself, through the setup wizard, the CLI, the
          MCP server, or by asking the agent to refine it in chat. On Atlas Cloud
          it lives inside the product, not a repo you maintain.
        </P>
        <P>
          What stays true underneath is that the layer is a real, readable
          artifact you can open. It keeps a version history you can diff,
          so you can see what changed and when. Edits are reviewed before they go
          live, so a new definition of &ldquo;revenue&rdquo; gets a second look
          before the agent starts answering with it. The knowledge about your
          data has a home you can open and correct, rather than being scattered
          across prompts or sealed inside a model nobody can audit.
        </P>

        <H2>The plain answer</H2>
        <P>
          Atlas answers questions by writing SQL, and the SQL is the easy part.
          Models are good at that now. The hard part is knowing that{" "}
          <InlineCode>shipping_cost</InlineCode> hides two units, that
          &ldquo;revenue&rdquo; is really three questions, that four of your
          fifty-two tables are landmines. That knowledge has to live somewhere
          the agent can read it on every turn, and somewhere a person can open
          and fix when the data shifts under it. A YAML file is an unglamorous
          place to keep it, and the right one. It&apos;s also what lets you trust
          the number that comes back.
        </P>
        <P>
          If you want the wider tour of everything Atlas does, that&apos;s in the{" "}
          <a href="/blog/announcing-atlas" className="link-accent">
            launch recap
          </a>
          . If you just want to watch the semantic layer do its job, the demo is
          live and runs on the same NovaMart data you just read about, no signup
          required.
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
