export default function Home() {
  return (
    <div className="relative min-h-screen">
      {/* Top gradient glow */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 -z-10 h-[600px] w-[800px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, oklch(0.765 0.177 163.22 / 0.06) 0%, transparent 70%)",
        }}
      />

      {/* Nav */}
      <nav className="animate-fade-in mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 256 256" fill="none" className="h-6 w-6" aria-hidden="true">
            <path d="M128 24 L232 208 L24 208 Z" stroke="#23CE9E" strokeWidth="14" fill="none" strokeLinejoin="round"/>
            <circle cx="128" cy="28" r="16" fill="#23CE9E"/>
          </svg>
          <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">
            atlas
          </span>
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-emerald-400 uppercase">
            beta
          </span>
        </div>
        <div className="flex items-center gap-6">
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
          <p className="animate-fade-in-up delay-100 mb-5 font-mono text-sm tracking-wide text-emerald-400">
            Text-to-SQL agent
          </p>
          <h1 className="animate-fade-in-up delay-200 text-4xl leading-[1.1] font-semibold tracking-tight text-zinc-100 md:text-6xl">
            Ask your data
            <br />
            anything
            <span className="animate-blink ml-0.5 inline-block text-emerald-400">
              _
            </span>
          </h1>
          <p className="animate-fade-in-up delay-300 mt-6 max-w-xl text-lg leading-relaxed text-zinc-400">
            Connect your database, auto-generate a semantic layer, and query
            your data in plain English. Atlas validates every query, enforces
            read-only access, and deploys anywhere.
          </p>
          <div className="animate-fade-in-up delay-400 mt-10 flex flex-wrap items-center gap-4">
            <a
              href="https://app.useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-emerald-400"
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
          ].map((feature, i) => (
            <div key={i} className="bg-zinc-950 p-8 md:p-10">
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 text-emerald-400">
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
        <h2 className="mb-4 font-mono text-xs tracking-widest text-emerald-400/80 uppercase">
          How it works
        </h2>
        <div className="grid gap-12 md:grid-cols-3 md:gap-8">
          {[
            {
              step: "01",
              title: "Connect your database",
              description:
                "Point Atlas at any PostgreSQL or MySQL database. Read-only access enforced at every layer.",
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

      {/* Security */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <h2 className="mb-4 font-mono text-xs tracking-widest text-emerald-400/80 uppercase">
          Security
        </h2>
        <p className="mb-10 max-w-xl text-zinc-400">
          Every query runs through a 4-layer validation pipeline. No data ever
          leaves your infrastructure.
        </p>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[
            "Read-only queries",
            "AST validation",
            "Table whitelisting",
            "Sandboxed execution",
            "Statement timeouts",
          ].map((item) => (
            <div
              key={item}
              className="flex items-start gap-2.5 rounded-lg border border-zinc-800/40 bg-zinc-900/30 px-4 py-3"
            >
              <svg
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500"
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
              {/* Muted footer mark: favicon geometry with reduced opacity stroke */}
              <svg viewBox="0 0 256 256" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M128 28 L228 212 L28 212 Z" fill="#23CE9E" opacity="0.4"/>
                <path d="M128 28 L228 212 L28 212 Z" stroke="#23CE9E" strokeWidth="18" fill="none" strokeLinejoin="round" opacity="0.4"/>
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
