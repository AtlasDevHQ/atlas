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
  Step,
  Steps,
} from "../../../components/prose";
import { Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";
import { JsonLd } from "../../../components/json-ld";
import { blogPostingJsonLd } from "../../../lib/seo";

export const metadata: Metadata = {
  title: "The Road to Launch: Everything I Shipped in Atlas's Beta",
  description:
    "Atlas goes GA in July 2026. A recap of the first half of the year — SQL safety, new datasources, a smarter agent, a grown-up MCP server, dashboards, and Atlas Cloud, across nearly 4,000 issues and pull requests.",
  authors: [{ name: "Matt Sywulak" }],
  openGraph: {
    title: "The Road to Launch: Everything I Shipped in Atlas's Beta",
    description:
      "Atlas goes GA in July 2026. A recap of the first half of 2026 — a run of internal milestones from 0.1 through 1.6, then twenty-nine public releases in under a month. By Matt Sywulak.",
    url: "https://www.useatlas.dev/blog/announcing-atlas",
    siteName: "Atlas",
    type: "article",
    publishedTime: "2026-06-25",
    authors: ["Matt Sywulak"],
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "The road to launch: everything I shipped in beta",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "The Road to Launch: Everything I Shipped in Atlas's Beta",
    description:
      "Atlas goes GA in July 2026. A recap of the first half of 2026 — a run of internal milestones from 0.1 through 1.6, then twenty-nine public releases in under a month.",
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/blog/announcing-atlas" },
};

export default function AnnouncingAtlas() {
  return (
    <div className="relative min-h-screen">
      <JsonLd data={blogPostingJsonLd("announcing-atlas")} />
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <Article>
        <PostHeader
          tag="Road to launch"
          isoDate="2026-06-25"
          dateLabel="June 25, 2026"
          readingTime="6 min read"
          title="The road to launch: everything I shipped in beta"
          dek="Atlas goes GA in July. Here's the recap of the first half of 2026, from a single commit to a hosted cloud you can trust in production."
        />

        <H2>Where I started</H2>
        <Lead>
          A few months ago I announced Atlas with a simple argument: text-to-SQL
          should be safe, accurate, and deployable infrastructure. A data
          analyst you embed in your own product, one that writes SQL it can
          actually run, validate, and audit, and answers straight from your
          database instead of sending people off to a separate BI tool.
        </Lead>
        <P>
          Since then, I&apos;ve shipped without letting up. Atlas began as a
          single commit in February; by the time I cut the first public release
          tag in late May, it had already grown a semantic layer, multi-tenancy,
          and a hosted SaaS platform across a run of internal milestones from{" "}
          <InlineCode>0.1</InlineCode> through <InlineCode>1.6</InlineCode>. The
          public train that followed sits on top of all of it.
        </P>

        <StatStrip
          items={[
            { value: "29", label: "releases in 27 days" },
            { value: "~4,000", label: "issues & pull requests" },
            { value: "1,300+", label: "commits" },
          ]}
        />

        <P>
          Underneath the numbers: the agent got smarter, the datasource list
          grew, the MCP server grew up, and Atlas Cloud became a real hosted
          product with billing, trials, and enterprise controls.
        </P>
        <P>
          A note on the pace, since I keep writing &ldquo;I&rdquo; and not
          &ldquo;we&rdquo;: it&apos;s been me and an AI coding agent the whole
          way, no team hiding behind the corporate plural. There&apos;s a thesis
          in that. Atlas is a data analyst you run as an agent against your
          database, and it got built by one person running an agent against a
          codebase. I wrote up how that actually worked, the commands, the loops,
          and the memory, in{" "}
          <a href="/blog/out-of-the-runtime" className="link-accent">
            Out of the runtime
          </a>
          .
        </P>

        <PullQuote>Same wager, both ends.</PullQuote>

        <P>
          It&apos;s also the first side project I&apos;ve ever shipped. My
          GitHub is a graveyard of half-built repos, including one security
          product I rebuilt a dozen times and never shipped. I wrote about why
          this one made it over the line, and the rest didn&apos;t, in{" "}
          <a href="/blog/why-this-one-stuck" className="link-accent">
            Why this one stuck
          </a>
          .
        </P>
        <P>
          Here&apos;s the recap of the changes that matter, ahead of the{" "}
          <InlineCode>v0.1.0</InlineCode> public launch in July.
        </P>

        <H2>The safety core, deeper</H2>
        <P>
          The thing that made Atlas worth trusting on day one is still the thing
          I hardened most. Every query the agent writes passes through a 7-layer
          validation pipeline before it reaches your database:
        </P>
        <Steps>
          <Step n={1} title="Empty check">rejects blank input</Step>
          <Step n={2} title="Regex mutation guard">
            blocks INSERT, UPDATE, DELETE, DROP
          </Step>
          <Step n={3} title="AST parse">confirms a single SELECT statement</Step>
          <Step n={4} title="Table whitelist">
            only tables in your semantic layer are queryable
          </Step>
          <Step n={5} title="RLS injection">
            optional WHERE clauses for tenant isolation
          </Step>
          <Step n={6} title="Auto LIMIT">caps unbounded result sets</Step>
          <Step n={7} title="Statement timeout">kills runaway queries</Step>
        </Steps>
        <P>
          Reads only. No writes, no shell escapes, no surprises. I also made
          that story easy to check for anyone evaluating Atlas: there&apos;s now
          a public{" "}
          <a href="https://www.useatlas.dev/security" className="link-accent">
            security page
          </a>{" "}
          that lays out the read-only, SELECT-only model in plain language, and
          a production-observability pass means request traces and metrics now
          export to a collector so operators can actually see what the agent is
          doing.
        </P>

        <H2>From two databases to a dozen sources</H2>
        <P>
          Atlas launched with PostgreSQL and MySQL. It now connects to BigQuery,
          ClickHouse, Snowflake, DuckDB, Salesforce, and Elasticsearch/OpenSearch
          through datasource plugins, and to{" "}
          <span className="text-fg">any REST service</span> that publishes an
          OpenAPI 3.x spec, as a first-class datasource the agent queries right
          alongside your SQL connections. Twenty, Stripe, GitHub, and Notion
          ship as ready-made connectors on that same primitive.
        </P>
        <P>
          Just as important, onboarding a datasource no longer means a trip to
          the terminal. Add a connection and Atlas profiles its schema into a
          queryable semantic layer in-product, through the install wizard, the
          CLI, or the MCP server alike. The rule underneath is now simply:{" "}
          <span className="text-fg">if Atlas can connect to it, it can profile it.</span>
        </P>

        <H2>A semantic layer that builds itself</H2>
        <P>
          The semantic layer is what lets Atlas write correct SQL instead of
          guessing from column names. Generating one used to be a manual step;
          now it&apos;s two phases. First, an instant, free, no-AI mechanical
          baseline you can query immediately. Then optional per-table
          enrichment, AI-written descriptions, business terms, and known query
          patterns, that never runs by accident and always shows the cost first.
        </P>
        <P>
          The layer also learned about performance. The profiler now harvests
          index metadata and column cardinality, so the agent knows which
          predicates are sargable and which columns are selective before it
          writes a query. Correctness was always the floor; now the generated
          SQL is tuned to run fast as well.
        </P>
        <P>
          I made the case for why that file is plain YAML, and the most
          important thing in Atlas, in{" "}
          <a href="/blog/why-the-semantic-layer-is-yaml" className="link-accent">
            Why the semantic layer is a YAML file
          </a>
          .
        </P>

        <H2>A smarter agent</H2>
        <DefList>
          <DefItem term="Cross-source reach">
            Ask one question and Atlas composes the answer across every
            connected datasource in a single turn, correlating the separate
            result sets and telling you which source each part came from. If it
            can&apos;t reach a source, the answer is reported as partial, never
            silently narrowed to one.
          </DefItem>
          <DefItem term="Performance-aware patterns">
            Learned query patterns now carry a rolling latency average, scoring
            favors the patterns that actually run fast, and a nightly job
            auto-promotes the winners and decays stale ones.
          </DefItem>
          <DefItem term="Durable long-running turns">
            The long, multi-step turns that real analysis sometimes needs now
            checkpoint per step and resume after a crash, and a turn that hits
            an approval gate parks instead of failing, then auto-resumes once
            approved. Context compaction keeps long turns inside the
            model&apos;s window. All opt-in, all degrading cleanly to
            today&apos;s behavior.
          </DefItem>
        </DefList>

        <H2>The MCP server grew up</H2>
        <P>
          Atlas&apos;s MCP server went from a read-only data analyst to a
          complete, production-grade surface AI assistants can safely act
          through. It speaks the latest MCP spec, tool annotations, structured
          results, progress and cancellation, pagination, resource
          subscriptions, and sits on a real security spine: roles resolved
          against the live database, an explicit <InlineCode>mcp:write</InlineCode>{" "}
          scope for mutations, an approval gate on sensitive actions, and a
          per-workspace action policy that can only be tightened, never
          loosened. You can even provision, profile, and manage datasources
          end-to-end from an MCP client, with credentials gathered through
          masked forms so secrets never pass through the model.
        </P>
        <P>
          And the front door opens straight from an AI client: a{" "}
          <InlineCode>start_trial</InlineCode> tool at{" "}
          <a href="https://mcp.useatlas.dev" className="link-accent">
            mcp.useatlas.dev
          </a>{" "}
          provisions a trial workspace on the spot and hands back a connect URL,
          business-email-only, abuse-protected, and claimed on the web with a
          one-time passcode.
        </P>

        <H2>Dashboards became a BI surface</H2>
        <P>
          The dashboard surface grew from a saved-query gallery toward a real BI
          tool. KPI cards gained period-over-period deltas, value formatting,
          and inline sparklines; charts carry goal lines, thresholds, and event
          annotations to mark releases or incidents on the timeline. Dashboards
          became explorable too: click a data point to drill down, filter every
          card from one with cross-filtering, and export a single card to CSV or
          a whole dashboard to PDF. You can even edit a dashboard from chat, with
          every change landing in your personal draft until you publish.
        </P>

        <H2>Atlas Cloud became a real product</H2>
        <P>
          Self-hosting Atlas was always free and complete. What landed during
          beta is the hosted option for teams that don&apos;t want to run
          infrastructure:{" "}
          <a href="https://app.useatlas.dev" className="link-accent">
            Atlas Cloud
          </a>
          . Pick a plan and pay from the billing page, subscriptions scope to
          your organization rather than the admin who clicked, a failed payment
          starts a recovery sequence instead of an abrupt lockout, and usage
          accounting lines up exactly across the usage page, the billing page,
          and live enforcement. Here&apos;s the snapshot of what ships today:
        </P>
        <DefList>
          <DefItem term="Eight databases & warehouses">
            PostgreSQL, MySQL, BigQuery, ClickHouse, Snowflake, DuckDB,
            Salesforce, and Elasticsearch/OpenSearch, plus any REST/OpenAPI
            service
          </DefItem>
          <DefItem term="Six LLM providers">
            Anthropic, OpenAI, Bedrock, Ollama, OpenAI-compatible endpoints, and
            the Vercel AI Gateway. Bring your own keys or use Atlas Cloud&apos;s
            managed tokens
          </DefItem>
          <DefItem term="24 plugins">
            Datasource adapters, sandbox backends, chat-platform channels,
            action triggers, and context providers. Build your own with the
            Plugin SDK
          </DefItem>
          <DefItem term="Embeddable everywhere">
            A script-tag widget, a React component, a TypeScript SDK, the
            headless API, and the MCP server
          </DefItem>
          <DefItem term="Eight integrations">
            Six chat platforms — Slack, Teams, Discord, Telegram, and WhatsApp
            live today; Google Chat coming soon — plus Linear and GitHub, also
            live
          </DefItem>
          <DefItem term="Enterprise controls">
            SSO (SAML/OIDC), SCIM provisioning, custom roles, IP allowlists,
            approval workflows, audit-log retention and export, and data
            residency
          </DefItem>
        </DefList>

        <H2>A new look</H2>
        <P>
          Atlas also got a new brand, warm cream and deep forest green,
          light-first, across every surface: the landing site, the docs, and
          the product. It trades the saturated dark dev-tool default for
          something calmer and easier to read during the dense work of staring
          at data.
        </P>

        <H2>What&apos;s next: July</H2>
        <P>
          <InlineCode>v0.1.0</InlineCode> is the public launch, and it lands in
          July. A short list is still in flight, a final live security pass and
          finishing multi-region data-residency routing, and then I cut it. The
          fastest way to see where things are right now is the live demo: no
          signup, no installation, connected to a realistic e-commerce dataset
          with dozens of tables and hundreds of thousands of messy rows.
        </P>

        <PostActions />

        <div className="mt-12">
          <P>
            Or run it yourself. Self-hosting is free and complete under
            AGPL-3.0, no artificial limits:
          </P>
        </div>

        <CodeBlock title="terminal">{`$ bun create atlas-agent my-app
$ cd my-app
$ cp .env.example .env   # add your ANTHROPIC_API_KEY + ATLAS_DATASOURCE_URL
$ bun run dev`}</CodeBlock>

        <P>
          Read the{" "}
          <a href="https://docs.useatlas.dev/getting-started/quick-start" className="link-accent">
            quick start guide
          </a>{" "}
          for the full walkthrough, or jump straight to{" "}
          <a href="https://docs.useatlas.dev/getting-started/connect-your-data" className="link-accent">
            connecting your database
          </a>
          .
        </P>
        <P>
          If you try it, I&apos;d genuinely like to hear what breaks. Open an
          issue on{" "}
          <a href="https://github.com/AtlasDevHQ/atlas" className="link-accent">
            GitHub
          </a>{" "}
          and it reaches me directly. See you at the launch.
        </P>
        <Signoff />

        <BackToBlog />
      </Article>

      <Divider />
      <Footer />
    </div>
  );
}
