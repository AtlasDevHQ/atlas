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
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "Hand a stranger's agent your data",
  description:
    "An AI client I've never seen can find Atlas, start its own trial, and be querying inside a minute with no human involved. Here's the security model that makes that a reasonable thing to ship: two endpoints, one tool versus sixteen, and the same pipeline a person gets.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "Hand a stranger's agent your data",
    description:
      "An AI client I've never seen can find Atlas, start its own trial, and be querying inside a minute. Here's the security model behind that.",
    url: "https://www.useatlas.dev/blog/a-strangers-agent",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-07-30",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Hand a stranger's agent your data",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Hand a stranger's agent your data",
    description:
      "An AI client I've never seen can find Atlas, start its own trial, and be querying inside a minute. Here's the security model behind that.",
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/blog/a-strangers-agent" },
};

export default function AStrangersAgent() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("a-strangers-agent")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="How it works"
          isoDate="2026-07-30"
          dateLabel="July 30, 2026"
          readingTime="6 min read"
          title="Hand a stranger's agent your data"
          dek="An AI client I've never seen can discover Atlas, provision itself a workspace, and start asking questions, with no human anywhere in the loop. That only works if the governance is the same one a person gets."
        />

        <Lead>
          Here is a thing that happens on Atlas Cloud without my involvement. An
          AI client I have never seen connects to{" "}
          <InlineCode>mcp.useatlas.dev</InlineCode>, calls a tool called{" "}
          <InlineCode>start_trial</InlineCode>, gets back a workspace and
          credentials, and is answering questions about a connected database
          about a minute later. Nobody provisioned it. Nobody approved it. I
          find out because a number moved.
        </Lead>
        <P>
          Written down like that, it sounds reckless. The reason I&apos;m
          comfortable shipping it is that an agent arriving through that door
          gets exactly the governance a human gets, and the door it comes
          through has one tool behind it.
        </P>

        <H2>Two endpoints, and what each one exposes</H2>
        <P>
          The MCP server answers on two separate mounts, and the difference
          between them is the whole security story.
        </P>
        <P>
          The onboarding endpoint carries no bearer verification, no workspace
          admission, and no residency check, because at that point there is no
          identity to check. It runs as its own MCP server with a single tool
          registered on it: <InlineCode>start_trial</InlineCode>. An anonymous
          client can call that one thing. There is nothing else on that surface
          to reach for.
        </P>

        <StatStrip
          items={[
            { value: "1", label: "tool before identity" },
            { value: "16", label: "tools after it" },
            { value: "0", label: "operators in the loop" },
          ]}
        />

        <P>
          Everything else lives behind the workspace endpoint, which is
          bearer-gated. Sixteen tools sit there: the semantic-layer readers that
          let a client discover what your data means, the query and{" "}
          <InlineCode>executeSQL</InlineCode> paths, the sandboxed{" "}
          <InlineCode>explore</InlineCode> shell, and the datasource management
          tools. Reaching any of them means holding a credential scoped to one
          workspace, obtained through OAuth 2.1 with dynamic client registration
          and PKCE, so a client that has never met me can register itself
          without a shared secret ever existing.
        </P>

        <PullQuote>
          The anonymous surface is one tool wide.
        </PullQuote>

        <H2>The same pipeline a person gets</H2>
        <P>
          A question arriving over MCP takes the identical path as one typed
          into the web chat. Same semantic layer, so the agent answers from your
          definitions. Same table whitelist, so it can only reach entities you
          published. Same seven-layer validation, so the SQL is SELECT-only,
          single-statement, row-limited, and timed out. Same row-level security
          injection when a workspace configures it.
        </P>
        <P>
          There is no MCP-specific query path, and that was deliberate. A second
          path would be a second place for a bypass to hide, and the one that
          gets less traffic is the one that rots. Every claim in{" "}
          <a href="/blog/the-live-security-pass" className="link-accent">
            yesterday&apos;s post about the security pass
          </a>{" "}
          applies to an agent exactly as it applies to a browser.
        </P>

        <H2>Actions, with a gate in front</H2>
        <P>
          Reading is the easy half. Atlas also lets an agent do things: file a
          Linear issue, send an email, hit a webhook. Those run through the
          Action Target pillar, and they are gated rather than granted. An
          action tool has to be configured and installed for the workspace
          before it exists in the tool list at all, and the sensitive ones can
          require approval before they fire, which parks the agent mid-run until
          a human decides.
        </P>
        <P>
          An agent with a workspace credential can therefore ask your data
          anything the semantic layer permits, and can take only the specific
          actions somebody deliberately turned on.
        </P>

        <H2>Software I don&apos;t ship</H2>
        <P>
          The interesting failures here came from clients I have no control
          over. Against my own tooling the server was flawless for weeks. Then
          strangers&apos; clients arrived and found three things at once: a
          connection config that advertised its transport wrong and got rejected
          before the first tool call, long queries dying at a proxy because an
          in-protocol heartbeat doesn&apos;t register as traffic one layer down,
          and an entity tool showing filenames where display names belonged. Six
          of the nine release tags I cut that week went to this surface, and I
          wrote up the whole stretch in{" "}
          <a href="/blog/the-last-mile" className="link-accent">
            The last mile
          </a>
          .
        </P>
        <P>
          Every one of those was invisible to a test suite that only ever talked
          to itself. Interoperability is a property you find out about from
          other people&apos;s software. That is an argument for opening the
          public endpoint earlier than feels comfortable.
        </P>

        <H2>Why bother</H2>
        <P>
          The closed BI tools are single-destination: the analytics live inside
          a product, and an agent working on something else can&apos;t get at
          them without scraping a UI or being handed a service account with more
          reach than it should have. Speaking MCP means the governance travels
          with the data. Your agent gets a scoped credential, a semantic layer
          that tells it what things mean, a validation pipeline it cannot route
          around, and an action list somebody curated.
        </P>
        <P>
          Tomorrow, the last one this week: what it takes for &ldquo;your data
          stays in your region&rdquo; to be a property of where the software
          runs.
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
