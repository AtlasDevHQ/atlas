import { type ReactNode } from "react";

import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import { CheckIcon, Divider, GitHubIcon, SectionLabel, TopGlow } from "../components/shared";
import { StickyNav } from "../components/sticky-nav";
import { WidgetShowcase } from "../components/widget-showcase";

function FeatureCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="bg-zinc-950 p-8 md:p-10">
      <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 text-brand">
        {icon}
      </div>
      <h3 className="mb-2 font-mono text-sm font-medium tracking-wide text-zinc-100">
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-zinc-400">
        {description}
      </p>
    </div>
  );
}

function CodeBlock({ title, dots, children }: { title: string; dots?: boolean; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/50">
      <div className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-3">
        {dots && (
          <>
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
          </>
        )}
        <span className={`font-mono text-xs text-zinc-600${dots ? " ml-3" : ""}`}>{title}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function DeploymentFeature({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckIcon />
      <span className="text-sm text-zinc-400">{children}</span>
    </li>
  );
}

export default function Home() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />

      <TopGlow />
      <Nav logoHref="#" />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-24 pb-20 md:pt-36 md:pb-28">
        <div className="max-w-3xl">
          <p className="animate-fade-in-up delay-100 mb-5 font-mono text-sm tracking-wide text-brand">
            AI writes better SQL than you. Let it.
          </p>
          <h1 className="animate-fade-in-up delay-200 text-4xl leading-[1.1] font-semibold tracking-tight text-zinc-100 md:text-6xl">
            Quit copying SQL
            <br />
            from ChatGPT
            <span className="animate-blink ml-0.5 inline-block text-brand">
              _
            </span>
          </h1>
          <p className="animate-fade-in-up delay-300 mt-6 max-w-xl text-lg leading-relaxed text-zinc-400">
            You&apos;re already using AI to query your data — but ChatGPT
            doesn&apos;t know your schema, can&apos;t validate queries, and
            definitely can&apos;t run them. Atlas does all three. Connect your
            database and ask questions in plain English.
          </p>
          <div className="animate-fade-in-up delay-400 mt-10 flex flex-wrap items-center gap-4">
            <a
              href="https://app.useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-brand-hover"
            >
              Start free on Cloud
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </a>
            <a
              href="https://github.com/AtlasDevHQ/atlas"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              <GitHubIcon className="h-4 w-4" />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Quick start code */}
      <section className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <CodeBlock title="terminal" dots>
          <pre className="font-mono text-sm leading-relaxed text-zinc-400">
            <code>
              <span className="text-zinc-600">$</span>{" "}
              <span className="text-zinc-200">bun create atlas-agent my-app --demo</span>
              {"\n"}
              <span className="text-zinc-600">$</span>{" "}
              <span className="text-zinc-200">cd my-app && bun run dev</span>
              {"\n\n"}
              <span className="text-brand">{">"}</span>{" "}
              <span className="text-zinc-500">Ready on http://localhost:3000</span>
            </code>
          </pre>
        </CodeBlock>
      </section>

      <Divider />

      {/* ── Widget showcase — moved up to be the proof after the promise ── */}
      <section id="demo" className="mx-auto max-w-5xl scroll-mt-16 px-6 py-20 md:py-28">
        <div className="grid items-start gap-12 md:grid-cols-2 md:gap-8">
          <div>
            <SectionLabel>See it in action</SectionLabel>
            <h2 className="mb-4 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
              Question in, answer out
            </h2>
            <p className="mb-6 max-w-md text-zinc-400">
              This is what happens when the AI actually knows your schema.
              Question in, validated SQL out, results rendered — no
              clipboard required.
            </p>
            <p className="mb-8 text-sm text-zinc-500">
              Scripted replay from the demo database. Try it live with
              your own questions.
            </p>
            <a
              href="https://demo.useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-brand-hover"
            >
              Try the live demo
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </a>
          </div>
          <WidgetShowcase />
        </div>
      </section>

      <Divider />

      {/* ── Features — curated 5 + "see all" instead of 9 flat cards ── */}
      <section id="features" className="mx-auto max-w-5xl scroll-mt-16 px-6 py-20 md:py-28">
        <SectionLabel>What you get</SectionLabel>
        <h2 className="mb-10 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Everything to go from question to answer
        </h2>
        <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-800/40 sm:grid-cols-2 md:grid-cols-3">
          {[
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
              ),
              title: "Text-to-SQL Agent",
              description:
                "Multi-step reasoning with Vercel AI SDK. Explores your schema, writes validated SQL, runs Python analysis, and returns charts and narrative.",
            },
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.121a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                </svg>
              ),
              title: "Semantic Layer",
              description:
                "YAML-based entity definitions with auto-profiling, glossary terms, metrics, and LLM enrichment. The agent reads this — not raw schema.",
            },
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0h.375a2.625 2.625 0 010 5.25H3.375a2.625 2.625 0 010-5.25H3.75" />
                </svg>
              ),
              title: "Deploy Anywhere",
              description:
                "Self-host with Docker, Railway, or Vercel. Or skip infrastructure entirely with Atlas Cloud. One command to scaffold.",
            },
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z" />
                </svg>
              ),
              title: "20+ Plugins",
              description:
                "Datasource, sandbox, interaction, action, and context plugins. Extend anything with the typed plugin SDK.",
            },
            {
              icon: (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                </svg>
              ),
              title: "Dynamic Learning",
              description:
                "Gets smarter with every query. Learns patterns, suggests questions, and builds a prompt library — all auditable YAML, not opaque embeddings.",
            },
          ].map((feature) => (
            <FeatureCard key={feature.title} {...feature} />
          ))}
          {/* 6th slot — link to all features */}
          <a
            href="https://docs.useatlas.dev"
            className="group flex flex-col items-center justify-center gap-3 bg-zinc-950 p-8 text-center transition-colors hover:bg-zinc-900/50 md:p-10"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 text-zinc-500 transition-colors group-hover:border-zinc-700 group-hover:text-zinc-300">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </div>
            <span className="font-mono text-sm font-medium tracking-wide text-zinc-500 transition-colors group-hover:text-zinc-300">
              All features
            </span>
          </a>
        </div>
      </section>

      <Divider />

      {/* ── How it works ── */}
      <section id="how-it-works" className="mx-auto max-w-5xl scroll-mt-16 px-6 py-20 md:py-28">
        <SectionLabel>How it works</SectionLabel>
        <div className="grid gap-12 md:grid-cols-3 md:gap-8">
          {[
            {
              step: "01",
              title: "Connect your database",
              description:
                "Point Atlas at any PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, BigQuery, or Salesforce source. Read-only access enforced at every layer.",
              code: "ATLAS_DATASOURCE_URL=postgresql://...",
            },
            {
              step: "02",
              title: "Generate semantic layer",
              description:
                "Auto-profile tables, detect joins, enumerate values, generate glossary and metrics. Optionally enrich with LLM.",
              code: "bun run atlas -- init --enrich",
            },
            {
              step: "03",
              title: "Ask questions",
              description:
                "No more describing your schema to ChatGPT from memory. Atlas already knows your tables, columns, and joins. Just ask.",
              code: '"What were our top 10 accounts last quarter?"',
            },
          ].map((step) => (
            <div key={step.step} className="flex flex-col">
              <span className="font-mono text-[11px] font-semibold tracking-wider text-zinc-600">
                {step.step}
              </span>
              <h3 className="mt-2 mb-2 text-base font-medium text-zinc-100">
                {step.title}
              </h3>
              <p className="mb-4 text-sm leading-relaxed text-zinc-400">
                {step.description}
              </p>
              <div className="mt-auto rounded-md border border-zinc-800/60 bg-zinc-900/50 px-3.5 py-2.5">
                <code className="font-mono text-xs text-zinc-400">
                  {step.code}
                </code>
              </div>
            </div>
          ))}
        </div>
      </section>

      <Divider />

      {/* ── Two ways to run ── */}
      <section id="deploy" className="mx-auto max-w-5xl scroll-mt-16 px-6 py-20 md:py-28">
        <SectionLabel>Two ways to run Atlas</SectionLabel>
        <p className="mb-10 max-w-xl text-zinc-400">
          Self-host the open-source project for free, or let us handle the
          infrastructure with Atlas Cloud.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          {/* Self-hosted */}
          <div className="flex flex-col rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-8 md:p-10">
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
                <svg className="h-4 w-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0h.375a2.625 2.625 0 010 5.25H3.375a2.625 2.625 0 010-5.25H3.75" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-zinc-100">Self-hosted</h3>
            </div>
            <p className="mb-6 text-sm leading-relaxed text-zinc-400">
              Run Atlas on your own infrastructure. Full source access,
              all core features, no usage limits.
            </p>
            <ul className="mb-8 space-y-3">
              <DeploymentFeature>Full source access (AGPL-3.0)</DeploymentFeature>
              <DeploymentFeature>Docker, Railway, or Vercel</DeploymentFeature>
              <DeploymentFeature>All databases and plugins</DeploymentFeature>
              <DeploymentFeature>Admin console and API</DeploymentFeature>
              <DeploymentFeature>Community support</DeploymentFeature>
            </ul>
            <div className="mt-auto">
            <a
              href="https://docs.useatlas.dev/getting-started"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-600 hover:text-zinc-100"
            >
              Read the docs
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </a>
            </div>
          </div>

          {/* Atlas Cloud */}
          <div className="cloud-glow flex flex-col rounded-xl bg-zinc-900/50 p-8 md:p-10">
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-brand/30 bg-brand/10">
                <svg className="h-4 w-4 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-zinc-100">Atlas Cloud</h3>
            </div>
          <p className="mb-6 text-sm leading-relaxed text-zinc-400">
              We handle infrastructure, security, and scaling.
              Includes enterprise features not available in self-hosted.
            </p>
            <ul className="mb-8 space-y-3">
              <DeploymentFeature>Everything in self-hosted</DeploymentFeature>
              <DeploymentFeature>SSO & SCIM provisioning</DeploymentFeature>
              <DeploymentFeature>Custom domains & white-labeling</DeploymentFeature>
              <DeploymentFeature>Approval workflows & compliance</DeploymentFeature>
              <DeploymentFeature>SLA monitoring & backups</DeploymentFeature>
              <DeploymentFeature>Priority support</DeploymentFeature>
            </ul>
            <div className="mt-auto">
            <a
              href="https://app.useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-brand-hover"
            >
              Start free trial
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Embed in your app ── */}
      <section id="embed" className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <SectionLabel>Embed in your app</SectionLabel>
        <p className="mb-8 max-w-xl text-zinc-400">
          Give every user a data analyst instead of a Jira ticket to the
          data team. One script tag, no build step. Or use the React
          component for full control.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <CodeBlock title="Script tag">
            <pre className="font-mono text-xs leading-relaxed text-zinc-400">
              <code>{`<script
  src="/widget.js"
  data-api-url="https://your-atlas.example.com"
  data-theme="dark"
></script>`}</code>
            </pre>
          </CodeBlock>
          <CodeBlock title="React component">
            <pre className="font-mono text-xs leading-relaxed text-zinc-400">
              <code>{`import { AtlasChat } from "@useatlas/react";

export default function App() {
  return <AtlasChat apiUrl="..." />;
}`}</code>
            </pre>
          </CodeBlock>
        </div>
        <div className="mt-6 flex flex-wrap gap-2.5">
          {[
            "Programmatic API",
            "Event callbacks",
            "Theme support",
            "Auth tokens",
            "Conversation sharing",
            "CSV & Excel export",
            "React / Vite",
            "Next.js",
            "Nuxt",
            "SvelteKit",
            "TanStack Start",
            "Bring your own",
          ].map((item) => (
            <span
              key={item}
              className="rounded-md border border-zinc-800/50 bg-zinc-900/20 px-3 py-1.5 font-mono text-xs text-zinc-500"
            >
              {item}
            </span>
          ))}
        </div>
      </section>

      <Divider />

      {/* ── Built for production — databases + integrations + security ── */}
      <section id="production" className="mx-auto max-w-5xl scroll-mt-16 px-6 py-20 md:py-28">
        <SectionLabel>Built for production</SectionLabel>
        <h2 className="mb-12 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          7 databases. 20+ integrations. Enterprise security.
        </h2>

        {/* Databases */}
        <div className="mb-14">
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Databases</h3>
          <p className="mb-6 max-w-xl text-sm text-zinc-400">
            Native adapters with read-only enforcement, connection pooling, and
            schema-aware profiling.
          </p>
          <div className="flex flex-wrap gap-3">
            {[
              "PostgreSQL",
              "MySQL",
              "ClickHouse",
              "Snowflake",
              "DuckDB",
              "BigQuery",
              "Salesforce",
            ].map((db) => (
              <div
                key={db}
                className="flex items-center gap-2.5 rounded-full border border-zinc-800/60 bg-zinc-900/30 px-4 py-2"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-brand/60" />
                <span className="font-mono text-xs font-medium text-zinc-300">
                  {db}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Integrations — compact list, not identical cards */}
        <div className="mb-14">
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Integrations</h3>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {[
              {
                name: "Slack",
                detail: "Slash commands, threaded follow-ups, action approvals",
                icon: (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 8.25h15m-16.5 7.5h15m-1.8-13.5l-3.9 19.5m-2.1-19.5l-3.9 19.5" />
                  </svg>
                ),
              },
              {
                name: "Microsoft Teams",
                detail: "Bot Framework, Adaptive Cards, JWT verification",
                icon: (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                  </svg>
                ),
              },
              {
                name: "Discord",
                detail: "Slash commands, thread conversations, rich embeds",
                icon: (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                  </svg>
                ),
              },
              {
                name: "MCP Server",
                detail: "Claude Desktop, Cursor, any MCP-compatible client",
                icon: (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                  </svg>
                ),
              },
              {
                name: "TypeScript SDK",
                detail: "Programmatic query, chat, and conversation management",
                icon: (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                  </svg>
                ),
              },
              {
                name: "Webhooks & more",
                detail: "Google Chat, Telegram, GitHub, Jira, email digest",
                icon: (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                  </svg>
                ),
              },
            ].map((item) => (
              <div
                key={item.name}
                className="flex items-start gap-3 rounded-lg border border-zinc-800/40 bg-zinc-900/20 px-4 py-3"
              >
                <div className="mt-0.5 text-brand/70">{item.icon}</div>
                <div>
                  <span className="font-mono text-xs font-medium text-zinc-300">
                    {item.name}
                  </span>
                  <p className="mt-0.5 text-xs leading-snug text-zinc-500">
                    {item.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Security — grouped from 13 to 6 */}
        <div>
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Security</h3>
          <p className="mb-6 max-w-xl text-sm text-zinc-400">
            The reason you can&apos;t just give ChatGPT your database connection
            string. Atlas enforces read-only access, validates every query, and
            keeps credentials on your infrastructure.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              "Read-only + AST-validated queries",
              "Table whitelisting",
              "Sandboxed execution",
              "Row-level security & rate limiting",
              "Encrypted credentials & secret redaction",
              "Audit logging & multi-tenant isolation",
            ].map((item) => (
              <div
                key={item}
                className="flex items-start gap-2.5 rounded-lg border border-zinc-800/40 bg-zinc-900/30 px-4 py-3"
              >
                <CheckIcon />
                <span className="text-xs font-medium leading-snug text-zinc-400">
                  {item}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
