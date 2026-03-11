export default function Home() {
  return (
    <div className="relative min-h-screen">
      {/* Top gradient glow */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 -z-10 h-[600px] w-[800px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, color-mix(in oklch, var(--atlas-brand) 6%, transparent) 0%, transparent 70%)",
        }}
      />

      {/* Nav */}
      <nav className="animate-fade-in mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 256 256" fill="none" className="h-6 w-6 text-brand" aria-hidden="true">
            <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="14" fill="none" strokeLinejoin="round"/>
            <circle cx="128" cy="28" r="16" fill="currentColor"/>
          </svg>
          <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">
            atlas
          </span>
          <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
            beta
          </span>
        </div>
        <div className="flex items-center gap-6">
          <a
            href="https://docs.useatlas.dev"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Docs
          </a>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            GitHub
          </a>
          <a
            href="https://app.useatlas.dev"
            className="rounded-md bg-zinc-100 px-3.5 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
          >
            Try demo
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-24 pb-20 md:pt-36 md:pb-28">
        <div className="max-w-3xl">
          <p className="animate-fade-in-up delay-100 mb-5 font-mono text-sm tracking-wide text-brand">
            Text-to-SQL agent
          </p>
          <h1 className="animate-fade-in-up delay-200 text-4xl leading-[1.1] font-semibold tracking-tight text-zinc-100 md:text-6xl">
            Ask your data
            <br />
            anything
            <span className="animate-blink ml-0.5 inline-block text-brand">
              _
            </span>
          </h1>
          <p className="animate-fade-in-up delay-300 mt-6 max-w-xl text-lg leading-relaxed text-zinc-400">
            Connect any database, auto-generate a semantic layer, and query
            your data in plain English. Atlas validates every query, enforces
            read-only access, and deploys anywhere.
          </p>
          <div className="animate-fade-in-up delay-400 mt-10 flex flex-wrap items-center gap-4">
            <a
              href="https://app.useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-brand-hover"
            >
              Try the demo
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
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="mx-auto max-w-5xl px-6">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
      </div>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-800/40 md:grid-cols-3">
          {[
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
                  />
                </svg>
              ),
              title: "Text-to-SQL Agent",
              description:
                "AI agent that explores your schema, writes validated SQL, and interprets results. Powered by the Vercel AI SDK with multi-step reasoning.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.121a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
                  />
                </svg>
              ),
              title: "Semantic Layer",
              description:
                "YAML-based entity definitions with auto-profiling, glossary terms, metric definitions, and LLM enrichment. The agent reads before it writes.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0h.375a2.625 2.625 0 010 5.25H3.375a2.625 2.625 0 010-5.25H3.75"
                  />
                </svg>
              ),
              title: "Deploy Anywhere",
              description:
                "Docker, Railway, or Vercel. Ship a full-stack app or a headless API. One command to scaffold: bun create atlas-agent.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z"
                  />
                </svg>
              ),
              title: "Plugin Ecosystem",
              description:
                "15 plugins across 5 types. Datasource, sandbox, interaction, action, and context. Build your own with bun create @useatlas/plugin.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"
                  />
                </svg>
              ),
              title: "Admin Console",
              description:
                "Monitor connections, manage users, browse your semantic layer, track queries, and configure settings. Everything from one dashboard.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              ),
              title: "Scheduled Reports",
              description:
                "Cron-based recurring queries delivered to email, Slack, or webhooks. Set it and forget it.",
            },
          ].map((feature, i) => (
            <div key={i} className="bg-zinc-950 p-8 md:p-10">
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 text-brand">
                {feature.icon}
              </div>
              <h3 className="mb-2 font-mono text-sm font-medium tracking-wide text-zinc-100">
                {feature.title}
              </h3>
              <p className="text-sm leading-relaxed text-zinc-500">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <h2 className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
          How it works
        </h2>
        <div className="grid gap-12 md:grid-cols-3 md:gap-8">
          {[
            {
              step: "01",
              title: "Connect your database",
              description:
                "Point Atlas at any PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, or Salesforce database. Read-only access enforced at every layer.",
              code: "ATLAS_DATASOURCE_URL=postgresql://...",
            },
            {
              step: "02",
              title: "Generate semantic layer",
              description:
                "Auto-profile tables, detect joins, enumerate values, generate glossary and metrics. Optionally enrich with LLM.",
              code: "atlas init --enrich",
            },
            {
              step: "03",
              title: "Ask questions",
              description:
                "Natural language in, validated SQL out. The agent reads your semantic layer before writing any query.",
              code: '"What were our top 10 accounts last quarter?"',
            },
          ].map((step) => (
            <div key={step.step}>
              <span className="font-mono text-[11px] font-semibold tracking-wider text-zinc-600">
                {step.step}
              </span>
              <h3 className="mt-2 mb-2 text-base font-medium text-zinc-100">
                {step.title}
              </h3>
              <p className="mb-4 text-sm leading-relaxed text-zinc-500">
                {step.description}
              </p>
              <div className="rounded-md border border-zinc-800/60 bg-zinc-900/50 px-3.5 py-2.5">
                <code className="font-mono text-xs text-zinc-400">
                  {step.code}
                </code>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Divider */}
      <div className="mx-auto max-w-5xl px-6">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
      </div>

      {/* Databases */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <h2 className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
          Databases
        </h2>
        <p className="mb-10 max-w-xl text-zinc-400">
          Connect to the databases you already use. Native adapters with
          read-only enforcement, connection pooling, and schema-aware profiling.
        </p>
        <div className="flex flex-wrap gap-3">
          {[
            "PostgreSQL",
            "MySQL",
            "ClickHouse",
            "Snowflake",
            "DuckDB",
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
      </section>

      {/* Integrations */}
      <section className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <h2 className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
          Integrations
        </h2>
        <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-800/40 md:grid-cols-3">
          {[
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"
                  />
                </svg>
              ),
              title: "Slack",
              description:
                "Slash commands, threaded follow-ups, and action approvals. Right where your team works.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
                  />
                </svg>
              ),
              title: "MCP Server",
              description:
                "Use Atlas as a tool in Claude Desktop, Cursor, or any MCP-compatible client.",
            },
            {
              icon: (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
                  />
                </svg>
              ),
              title: "TypeScript SDK",
              description:
                "createAtlasClient() for programmatic access. Query, chat, and manage conversations.",
            },
          ].map((item, i) => (
            <div key={i} className="bg-zinc-950 p-8 md:p-10">
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 text-brand">
                {item.icon}
              </div>
              <h3 className="mb-2 font-mono text-sm font-medium tracking-wide text-zinc-100">
                {item.title}
              </h3>
              <p className="text-sm leading-relaxed text-zinc-500">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Embed anywhere */}
      <section className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <h2 className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
          Embed anywhere
        </h2>
        <p className="mb-8 max-w-xl text-zinc-400">
          Drop Atlas into any frontend. The chat UI is a pure HTTP
          client. No server dependency.
        </p>
        <div className="flex flex-wrap gap-2.5">
          {[
            "React / Vite",
            "Next.js",
            "Nuxt",
            "SvelteKit",
            "TanStack Start",
            "Bring your own",
          ].map((fw) => (
            <span
              key={fw}
              className="rounded-md border border-zinc-800/50 bg-zinc-900/20 px-3 py-1.5 font-mono text-xs text-zinc-500"
            >
              {fw}
            </span>
          ))}
        </div>
      </section>

      {/* Divider */}
      <div className="mx-auto max-w-5xl px-6">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
      </div>

      {/* Security */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <h2 className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
          Security
        </h2>
        <p className="mb-10 max-w-xl text-zinc-400">
          Every query runs through a 7-layer validation pipeline. No data ever
          leaves your infrastructure.
        </p>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            "Read-only queries",
            "AST validation",
            "Table whitelisting",
            "Sandboxed execution",
            "Statement timeouts",
            "Row-level security",
            "Encrypted credentials",
            "Audit logging",
          ].map((item) => (
            <div
              key={item}
              className="flex items-start gap-2.5 rounded-lg border border-zinc-800/40 bg-zinc-900/30 px-4 py-3"
            >
              <svg
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4.5 12.75l6 6 9-13.5"
                />
              </svg>
              <span className="text-xs leading-snug font-medium text-zinc-400">
                {item}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto max-w-5xl px-6 pb-12">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
        <div className="flex items-center justify-between pt-8">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {/* Muted footer mark: favicon geometry with reduced opacity fill + stroke */}
              <svg viewBox="0 0 256 256" fill="none" className="h-4 w-4 text-brand" aria-hidden="true">
                <path d="M128 28 L228 212 L28 212 Z" fill="currentColor" opacity="0.4"/>
                <path d="M128 28 L228 212 L28 212 Z" stroke="currentColor" strokeWidth="18" fill="none" strokeLinejoin="round" opacity="0.4"/>
              </svg>
              <span className="font-mono text-sm text-zinc-600">
                atlas
              </span>
            </div>
            <a
              href="https://github.com/AtlasDevHQ/atlas"
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800/60 px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-400"
            >
              <svg
                className="h-3 w-3"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              Open source
            </a>
          </div>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            className="text-xs text-zinc-600 transition-colors hover:text-zinc-400"
          >
            Built by @msywulak
          </a>
        </div>
      </footer>
    </div>
  );
}
