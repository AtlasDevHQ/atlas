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
  title: "Atlas Speaks OKF",
  description:
    "Google shipped the Open Knowledge Format seventeen days before my post arguing the semantic layer should be a plain YAML file. Here's where the two agree, where a runtime has to go further, and how OKF became the native format of Atlas's new Knowledge Base.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Atlas Speaks OKF",
    description:
      "Google shipped the Open Knowledge Format seventeen days before my post arguing the semantic layer should be a plain YAML file. Where the two agree, where a runtime has to go further, and how OKF became the native format of Atlas's new Knowledge Base. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/atlas-speaks-okf",
    siteName: "Atlas",
    type: "article",
    authors: ["Matt Sywulak"],
  },
};

export default function AtlasSpeaksOkf() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-03"
          dateLabel="July 3, 2026"
          readingTime="6 min read"
          title="Atlas speaks OKF"
          dek="Google's new Open Knowledge Format lands on the same thesis as Atlas's semantic layer: plain files, in git, that agents and people both read. Here's what Atlas did about it: import, export, and a whole new pillar."
        />

        <Lead>
          Seventeen days before I published{" "}
          <a
            href="/blog/why-the-semantic-layer-is-yaml"
            className="link-accent"
          >
            a post
          </a>{" "}
          arguing that the most important thing in Atlas is a plain YAML file,
          Google Cloud shipped an open standard built on the same idea. I found
          it the day after mine went live.
        </Lead>
        <P>
          It&apos;s called the{" "}
          <a
            href="https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing"
            className="link-accent"
          >
            Open Knowledge Format
          </a>
          , OKF for short: a vendor-neutral standard for the metadata and
          context AI agents need, expressed as a directory of markdown files
          with YAML frontmatter, versioned in git. The design principles read
          like the pitch I had just hit publish on. &ldquo;Just
          markdown,&rdquo; readable in any editor. &ldquo;Just files,&rdquo;
          shippable as a tarball, hostable in any repo. &ldquo;Just YAML
          frontmatter&rdquo; for the handful of fields that need to be
          queryable. Google is explicit that it&apos;s a format rather than a
          platform: &ldquo;the value of a knowledge format comes from how many
          parties speak it, not from who owns it.&rdquo;
        </P>
        <P>
          The fun part is the convergence. Atlas has kept its semantic layer
          in plain YAML since its first commit, and in the prototype repo
          before that. Google arrived at the same place from a different
          direction, at a much bigger scale, for their own reasons. When teams
          that have never talked keep landing on plain files in git as the way
          to hand an agent context about data, that&apos;s a good sign the
          idea simply works. So rather than squint at OKF as a competitor, I
          spent the next two days teaching Atlas to speak it.
        </P>

        <StatStrip
          items={[
            { value: "Mar 5", label: "Atlas's first commit, YAML layer included" },
            { value: "Jun 12", label: "Google ships OKF v0.1" },
            { value: "Jul 2", label: "Atlas imports, exports, and hosts OKF" },
          ]}
        />

        <H2>Same file, different job</H2>
        <P>
          An OKF bundle is a tree of markdown documents, each describing one
          concept: a table, a dataset, a metric, a playbook. The only required
          frontmatter field is <InlineCode>type</InlineCode>, and it&apos;s
          free text. Everything else is prose written for a reader, whether
          that reader is a person or a model. Links between documents are plain
          markdown links; what a link means lives in the sentence around it.
        </P>
        <CodeBlock title="tables/orders.md — an OKF concept doc">{`---
type: BigQuery Table
title: Orders
description: One row per completed checkout.
tags: [sales]
---
# Schema
- \`order_id\` (STRING): Unique order identifier.
- \`total_cents\` (INT64): Order total in cents.`}</CodeBlock>
        <P>
          That looseness is deliberate, and it&apos;s what makes OKF good at
          its job. A wiki written by one team&apos;s enrichment agent can be
          read by another team&apos;s analyst agent with no translation layer
          in between. The format asks almost nothing of you, so almost anything
          can speak it.
        </P>
        <P>
          Atlas&apos;s semantic layer is also YAML in a directory, and it does
          a second job on top of describing things: it gets enforced. Every
          entity in the layer is also the table whitelist, checked on every
          query — SQL against a table the layer doesn&apos;t cover is rejected
          before it runs. A pinned metric runs exactly as written, every time.
          A glossary term marked <InlineCode>ambiguous</InlineCode> forces the
          agent to stop and ask which meaning you want. OKF hands an agent
          knowledge; the semantic layer adds the rules for acting on it, and
          the runtime holds the agent to those rules.
        </P>

        <H2>What crosses the boundary, and what can&apos;t</H2>
        <P>
          Speaking a format means two verbs.{" "}
          <InlineCode>atlas okf export</InlineCode> turns a semantic layer into
          a conformant OKF bundle: every entity, metric, and glossary term
          becomes a concept doc any OKF consumer can read, schema bullets and
          example queries included. The export is nearly total. What a foreign
          consumer loses is the enforcement, because there&apos;s nowhere in a
          descriptive format to put it:
        </P>
        <DefList>
          <DefItem term="Table whitelist">
            The entities survive, so a consumer can see which tables Atlas
            considers queryable. Nothing stops it from querying everything
            else.
          </DefItem>
          <DefItem term="Pinned metrics">
            The SQL is right there in the document. To any other reader
            it&apos;s illustrative prose, a suggestion rather than a contract.
          </DefItem>
          <DefItem term="Ambiguity gating">
            Ambiguous terms export with their possible meanings and a note
            that Atlas stops and asks. No other consumer will actually ask.
          </DefItem>
        </DefList>

        <PullQuote>The SQL travels. The authority doesn&apos;t.</PullQuote>

        <P>
          The other verb is honest about being lossy.{" "}
          <InlineCode>atlas okf import</InlineCode> reads a foreign bundle,
          Google&apos;s GA4 e-commerce sample for instance, and produces a
          first-draft semantic layer: entities from the table docs, dimensions
          from the schema lists, glossary stubs from the tagged terms. Prose is
          a blurry place to keep structure, and the import says so. Integer and
          float columns both flatten to <InlineCode>number</InlineCode>. Nested
          record columns get skipped and reported. GA4&apos;s own join
          documents describe tables by prose aliases that resolve to nothing.
          And metric SQL from a bundle is never promoted to a pinned metric; it
          lands flagged as unverified, because in Atlas a pinned query runs as
          written, and a tarball that just arrived hasn&apos;t earned that. The
          draft then flows into the same scan, enrich, and edit loop every
          Atlas semantic layer goes through.
        </P>
        <P>
          There&apos;s a free on-ramp hiding in that verb. Google ships a
          reference agent that walks a BigQuery dataset and writes an OKF
          bundle for every table and view. Run it, import the bundle, and
          you&apos;ve skipped the blank-page step of describing your warehouse
          to Atlas.
        </P>

        <H2>The documents that didn&apos;t map became a pillar</H2>
        <P>
          The importer rejects a whole category of OKF documents on purpose.
          Playbooks, runbooks, API deprecation notices — none of it is schema,
          so none of it belongs in the semantic layer. But look at that reject
          pile for a minute and it&apos;s obviously the good stuff. It&apos;s
          exactly the context people keep wishing their data tools knew:
          the business rule behind a weird filter, the runbook for the
          quarterly close, the note that says the old events table is
          deprecated after March.
        </P>
        <P>
          Atlas organizes its integrations into pillars: datasources you
          query, chat platforms you talk through, action targets you push
          results to. In{" "}
          <a
            href="https://docs.useatlas.dev/changelog"
            className="link-accent"
          >
            v0.0.40
          </a>{" "}
          that list grew a fourth: the Knowledge Base, a home for
          exactly the documents the importer turns away. Upload an OKF bundle
          into a collection and the agent reads it alongside the semantic
          layer when it answers.
        </P>
        <P>
          This is where OKF paid for itself. Hosting knowledge means picking a
          document model — some shape for titles, tags, links, and bodies that
          every uploader has to target and every reader has to parse. Instead
          of inventing one, Atlas hosts OKF as-is. Documents are
          stored byte-identical to what you uploaded; the only thing Atlas
          adds is provenance under an <InlineCode>atlas:</InlineCode>{" "}
          frontmatter key, which the spec explicitly permits and tells
          consumers to preserve. The agent reads collections with the same
          sandboxed explore tool it uses for the semantic layer, walking{" "}
          <InlineCode>index.md</InlineCode> hierarchies with{" "}
          <InlineCode>ls</InlineCode>, <InlineCode>cat</InlineCode>, and{" "}
          <InlineCode>grep</InlineCode> — reading the files the way the format
          intends, with a full-text search tool layered on top for when the
          corpus outgrows browsing. Getting your knowledge back out is a copy
          of the tree.
        </P>
        <P>
          One boundary never moves, and it&apos;s the same line the export
          section drew. Knowledge documents stay descriptive.
          Nothing in an uploaded bundle ever runs verbatim, extends the table
          whitelist, or gates the agent — that authority stays with the
          semantic layer, where a human reviews every line. And uploaded
          documents land as drafts that a person reviews and publishes before
          the agent starts reading from them.
        </P>

        <H2>Formats want company</H2>
        <P>
          Google&apos;s line about a format&apos;s value coming from how many
          parties speak it cuts both ways: it&apos;s an argument for them to
          publish the spec, and an argument for Atlas to adopt it. So Atlas
          keeps its own YAML where the guardrails live, and speaks OKF
          wherever interchange matters. Import is the way in, export is the
          way out, and anything hosted in between stays untouched. If you
          someday leave Atlas, your semantic layer exports to a spec anyone
          can implement, and your knowledge base was never in a proprietary
          shape to begin with.
        </P>
        <P>
          The YAML-file post ended by saying the semantic layer is what lets
          you trust the number that comes back. This is the other half:
          keeping that layer in an open, enforced format while the rest of the
          industry converges on open, descriptive ones. If you want to see the
          Knowledge Base end to end, the{" "}
          <a
            href="https://docs.useatlas.dev/guides/knowledge-base"
            className="link-accent"
          >
            guide
          </a>{" "}
          walks through it, and the demo is live with no signup required.
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
