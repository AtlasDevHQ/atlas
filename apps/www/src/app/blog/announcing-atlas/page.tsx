import type { Metadata } from "next";

import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";
import { ArrowIcon, Divider, TopGlow } from "../../../components/shared";
import { StickyNav } from "../../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Announcing Atlas: Open-Source Text-to-SQL with a Semantic Layer",
  description:
    "Atlas 1.0 is here. Connect your database, auto-generate a semantic layer, and let an AI agent query your data. Self-hosted or on Atlas Cloud.",
  openGraph: {
    title: "Announcing Atlas: Open-Source Text-to-SQL with a Semantic Layer",
    description:
      "Atlas 1.0 is here. Connect your database, auto-generate a semantic layer, and let an AI agent query your data.",
    url: "https://useatlas.dev/blog/announcing-atlas",
    siteName: "Atlas",
    type: "article",
  },
};

// ---------------------------------------------------------------------------
// Inline components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-16 mb-6 text-xl font-semibold tracking-tight text-zinc-100 md:text-2xl">
      {children}
    </h2>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="mb-5 text-[15px] leading-relaxed text-zinc-400">{children}</p>;
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[13px] text-zinc-300">
      {children}
    </code>
  );
}

function BlockCode({ title, children }: { title: string; children: string }) {
  return (
    <div className="my-6 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/50">
      <div className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="ml-3 font-mono text-xs text-zinc-600">{title}</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed text-zinc-400">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function FeatureBullet({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="mb-4">
      <span className="font-medium text-zinc-200">{title}</span>
      <span className="text-zinc-400">: {children}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AnnouncingAtlas() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/blog" />

      <article className="mx-auto max-w-2xl px-6 pt-24 pb-20 md:pt-36 md:pb-28">
        {/* Header */}
        <header className="mb-12">
          <div className="mb-5 flex items-center gap-3">
            <span className="rounded-full border border-brand/20 bg-brand/10 px-2.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
              Launch
            </span>
            <time dateTime="2026-03-25" className="font-mono text-xs text-zinc-600">2026-03-25</time>
          </div>
          <h1 className="animate-fade-in-up delay-100 text-2xl font-semibold leading-tight tracking-tight text-zinc-100 md:text-4xl">
            Announcing Atlas: open-source text-to-SQL with a semantic layer
          </h1>
          <p className="animate-fade-in-up delay-200 mt-5 text-lg leading-relaxed text-zinc-400">
            You&apos;re already using AI to query your data. Atlas makes it
            safe, accurate, and deployable.
          </p>
        </header>

        {/* ── The problem ── */}
        <SectionHeading>The problem: everyone is already doing this</SectionHeading>
        <Paragraph>
          Every data team we talk to is using ChatGPT or Copilot to write SQL.
          Paste your schema, describe the question, copy the query back into
          your database client, and hope it works.
        </Paragraph>
        <Paragraph>
          It works surprisingly often. But it fails in ways that are hard to
          catch: silently wrong column references, missing WHERE clauses that
          filter soft-deletes, metrics calculated before discounts instead of
          after. The AI doesn&apos;t know your business rules. It guesses from
          column names like <InlineCode>fact_txn_amt</InlineCode> and{" "}
          <InlineCode>is_del_flg</InlineCode>, and it gets the semantics wrong
          often enough that you can&apos;t trust the output without reading
          every query line by line.
        </Paragraph>
        <Paragraph>
          The other problem is operational. ChatGPT can&apos;t run the query.
          It doesn&apos;t validate that the SQL is read-only. It doesn&apos;t
          enforce row-level access. There&apos;s no audit trail. You can&apos;t
          embed it in a product. It&apos;s a parlor trick, not
          infrastructure.
        </Paragraph>

        {/* ── What Atlas is ── */}
        <SectionHeading>What Atlas is</SectionHeading>
        <Paragraph>
          Atlas is a text-to-SQL agent that connects to your database,
          understands your schema through a semantic layer, validates every
          query, and runs it. All in one place. Self-host it with Docker,
          Railway, or Vercel, or use Atlas Cloud at{" "}
          <a
            href="https://app.useatlas.dev"
            className="text-brand hover:underline"
          >
            app.useatlas.dev
          </a>{" "}
          and skip infrastructure entirely.
        </Paragraph>
        <Paragraph>
          The core idea: give the AI the context it needs to write correct SQL,
          then validate the output before it touches your database. No training
          data, no vector databases, no fine-tuning. Just a YAML semantic layer
          that describes what your tables and columns actually mean.
        </Paragraph>

        <BlockCode title="terminal">{`$ bun create atlas-agent my-app --demo
$ cd my-app && bun run dev

> Ready on http://localhost:3000
> Connected to PostgreSQL - 42 tables profiled
> Semantic layer generated at ./semantic/`}</BlockCode>

        <Paragraph>
          Run <InlineCode>atlas init</InlineCode> against your database and it
          profiles every table (column types, sample values, cardinality,
          nullability) and generates YAML entity files that the agent reads
          before writing SQL. You can enrich these with descriptions, business
          terms, and known query patterns. Changes go through pull requests.
          The semantic layer lives in your repo, versioned like code.
        </Paragraph>

        {/* ── How it works ── */}
        <SectionHeading>How it works under the hood</SectionHeading>
        <Paragraph>
          When a user asks a question, the agent reads the semantic layer to
          understand what tables exist, what columns mean, how tables join, and
          what metrics are defined. Then it writes SQL. Before the query
          reaches your database, it passes through a 7-layer validation
          pipeline:
        </Paragraph>
        <ol className="mb-6 list-inside list-decimal space-y-2 text-[15px] text-zinc-400">
          <li><span className="text-zinc-300">Empty check</span>: rejects blank input</li>
          <li><span className="text-zinc-300">Regex mutation guard</span>: blocks INSERT, UPDATE, DELETE, DROP</li>
          <li><span className="text-zinc-300">AST parse</span>: confirms a single SELECT statement</li>
          <li><span className="text-zinc-300">Table whitelist</span>: only tables in the semantic layer are queryable</li>
          <li><span className="text-zinc-300">RLS injection</span>: appends WHERE clauses for tenant isolation</li>
          <li><span className="text-zinc-300">Auto LIMIT</span>: prevents unbounded result sets</li>
          <li><span className="text-zinc-300">Statement timeout</span>: kills runaway queries</li>
        </ol>
        <Paragraph>
          This is defense-in-depth. Any single layer can fail, but the pipeline
          makes it so all of them would have to fail simultaneously for a
          dangerous query to execute.
        </Paragraph>

        {/* ── What ships today ── */}
        <SectionHeading>What ships in 1.0</SectionHeading>
        <ul className="mb-6 list-none space-y-1 text-[15px]">
          <FeatureBullet title="7 databases">
            PostgreSQL, MySQL, BigQuery, ClickHouse, DuckDB, Snowflake, and
            Salesforce via datasource plugins
          </FeatureBullet>
          <FeatureBullet title="6 LLM providers">
            Anthropic, OpenAI, Bedrock, Ollama, OpenAI-compatible (vLLM, TGI,
            LiteLLM), and AI Gateway. Bring your own keys or use Atlas
            Cloud&apos;s managed tokens
          </FeatureBullet>
          <FeatureBullet title="20+ plugins">
            Datasource adapters, sandbox backends, interaction channels (Slack,
            Teams, MCP), action triggers (email, JIRA, webhooks). Build your
            own with the Plugin SDK
          </FeatureBullet>
          <FeatureBullet title="Embeddable everywhere">
            Script tag widget, React component, TypeScript SDK, headless API.
            Works with Next.js, Nuxt, SvelteKit, or any HTTP client
          </FeatureBullet>
          <FeatureBullet title="Chat SDK">
            8 platform adapters: Slack, Teams, Discord, Telegram, Google Chat,
            GitHub, Linear, and WhatsApp
          </FeatureBullet>
          <FeatureBullet title="Enterprise features">
            SSO (SAML/OIDC), SCIM provisioning, custom roles, IP allowlists,
            approval workflows, audit log retention and export, data residency
          </FeatureBullet>
          <FeatureBullet title="Effect.ts architecture">
            Key backend subsystems (SQL pipeline, rate limiting, scheduler,
            connection management) use Effect for structured concurrency,
            typed errors, graceful shutdown, and circuit breaking, with more
            migrating
          </FeatureBullet>
          <FeatureBullet title="Admin console">
            Connections, users, plugins, semantic layer browser, query
            analytics, learned patterns, and settings. All in one place
          </FeatureBullet>
        </ul>

        {/* ── How Atlas compares ── */}
        <SectionHeading>How Atlas compares</SectionHeading>
        <Paragraph>
          There are good tools in this space. Atlas is different in a few
          specific ways.
        </Paragraph>
        <Paragraph>
          <span className="text-zinc-200">vs Vanna AI:</span> Vanna is a Python
          library that learns from historical queries via RAG. Atlas uses an
          explicit YAML semantic layer. You know exactly what context the agent
          sees, and changes go through code review. Vanna is great for Python
          shops that want a library. Atlas is a deployable product with auth,
          admin, and embedding built in.
        </Paragraph>
        <Paragraph>
          <span className="text-zinc-200">vs WrenAI:</span> WrenAI is a GenBI
          platform with a UI-based semantic modeling layer. It&apos;s closer to
          &ldquo;replace Looker&rdquo; than &ldquo;embed an analyst.&rdquo;
          Atlas is designed to be a component in your application, not a
          standalone BI tool. WrenAI is also AGPL-3.0 end-to-end. Atlas&apos;s
          client libraries are MIT.
        </Paragraph>
        <Paragraph>
          <span className="text-zinc-200">vs raw MCP:</span> Connecting Claude
          Desktop directly to your database via a MCP server gives the AI raw
          schema with no business context, no validation, and no audit trail.
          Atlas has its own MCP server that provides the same semantic layer and
          validation pipeline. Context + safety, not just connectivity.
        </Paragraph>
        <Paragraph>
          <span className="text-zinc-200">vs enterprise platforms:</span>{" "}
          ThoughtSpot, Databricks AI/BI, and Looker AI are powerful but
          proprietary and locked to their ecosystems. Atlas is open-source,
          deploy-anywhere, and designed for embedding, not for replacing your
          entire BI stack.
        </Paragraph>
        <Paragraph>
          Detailed comparisons:{" "}
          <a href="https://docs.useatlas.dev/comparisons" className="text-brand hover:underline">
            docs.useatlas.dev/comparisons
          </a>
        </Paragraph>

        {/* ── Pricing ── */}
        <SectionHeading>Self-hosted is free. Cloud is for teams.</SectionHeading>
        <Paragraph>
          Atlas is AGPL-3.0 licensed. You can self-host the full product,
          every feature, no artificial limits, for free. Run{" "}
          <InlineCode>bun create atlas-agent</InlineCode>, connect your
          database, and you&apos;re done.
        </Paragraph>
        <Paragraph>
          <a href="https://app.useatlas.dev" className="text-brand hover:underline">
            Atlas Cloud
          </a>{" "}
          is the managed option for teams that don&apos;t want to run
          infrastructure. It starts with a 14-day free trial (no credit card),
          then Team and Enterprise tiers.{" "}
          <a href="/pricing" className="text-brand hover:underline">
            See pricing
          </a>.
        </Paragraph>

        {/* ── CTA ── */}
        <SectionHeading>Try it</SectionHeading>
        <Paragraph>
          The fastest way to see Atlas is the live demo. No signup, no
          installation. It&apos;s connected to a cybersecurity SaaS dataset with
          60 tables and 200K rows of realistic, messy data.
        </Paragraph>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <a
            href="https://demo.useatlas.dev"
            className="group inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-brand-hover"
          >
            Try the live demo
            <ArrowIcon />
          </a>
          <a
            href="https://app.useatlas.dev"
            className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
          >
            Start on Cloud
            <ArrowIcon />
          </a>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
          >
            GitHub
            <ArrowIcon />
          </a>
        </div>

        <BlockCode title="terminal">{`$ bun create atlas-agent my-app
$ cd my-app
$ cp .env.example .env   # add your ANTHROPIC_API_KEY + ATLAS_DATASOURCE_URL
$ bun run dev`}</BlockCode>

        <Paragraph>
          Read the{" "}
          <a href="https://docs.useatlas.dev/getting-started/quick-start" className="text-brand hover:underline">
            quick start guide
          </a>{" "}
          for the full walkthrough, or jump straight to{" "}
          <a href="https://docs.useatlas.dev/getting-started/connect-your-data" className="text-brand hover:underline">
            connecting your database
          </a>.
        </Paragraph>

        {/* Back to blog */}
        <div className="mt-16 border-t border-zinc-800/60 pt-8">
          <a
            href="/blog"
            className="inline-flex items-center gap-1.5 font-mono text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <svg className="h-3 w-3 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            Back to blog
          </a>
        </div>
      </article>

      <Divider />
      <Footer />
    </div>
  );
}
