import { type CSSProperties } from "react";

function SelfHostCard() {
  return (
    <div
      className="flex flex-col rounded-[14px] border border-white/10 p-8"
      style={{ background: "oklch(0.18 0 0 / 0.35)" }}
    >
      <header className="mb-4 flex items-start justify-between">
        <div>
          <p className="mb-2.5 font-mono text-[11px] tracking-[0.06em] text-zinc-400">
            // self-host
          </p>
          <p className="text-[38px] font-semibold leading-none tracking-[-0.03em] text-zinc-50">
            free
          </p>
          <p className="mt-2 text-sm text-zinc-200">Your infra. Your data.</p>
        </div>
        <span className="text-[38px] font-semibold tracking-[-0.03em] text-zinc-400">
          $0
        </span>
      </header>

      <p className="m-0 mb-5 text-sm leading-[1.6] text-zinc-400">
        One command. Bun, Docker, or k8s. AGPL-3.0.
        <br />
        Every feature, no limits.
      </p>

      <div
        className="mb-5 overflow-hidden rounded-lg border border-white/10"
        style={{ background: "oklch(0.12 0 0)" }}
      >
        <div
          className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2"
          style={{ background: "oklch(0.16 0 0)" }}
        >
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "oklch(0.65 0.18 22)" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "oklch(0.78 0.16 70)" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "oklch(0.7 0.16 140)" }}
          />
          <span className="ml-2 font-mono text-[11px] text-zinc-400">
            ~/projects — bash
          </span>
        </div>
        <pre className="m-0 px-4 py-3.5 font-mono text-[12.5px] leading-[1.7]">
          <span className="text-zinc-200">
            <span className="mr-1.5 text-zinc-400">$</span>
            bun create <span className="text-brand">@useatlas</span> my-atlas
          </span>
          {"\n"}
          <span className="text-zinc-200">
            <span className="mr-1.5 text-zinc-400">$</span>
            cd my-atlas <span className="text-zinc-400">&amp;&amp;</span> bun run dev
          </span>
          {"\n"}
          <span className="text-zinc-400">
            <span className="mr-1.5 text-brand">→</span>
            atlas booted on :3000
          </span>
          {"\n"}
          <span className="text-zinc-400">
            <span className="mr-1.5 text-brand">→</span>
            connected · <span className="text-brand">postgres://localhost</span>
          </span>
          {"\n"}
          <span className="text-zinc-200">
            <span className="mr-1.5 text-zinc-400">$</span>
            <span className="term-caret text-brand">▌</span>
          </span>
        </pre>
      </div>

      <ul className="m-0 mb-6 flex list-none flex-col gap-2 p-0">
        {["BYO model key", "No telemetry", "Community Discord"].map((item) => (
          <li key={item} className="flex items-center gap-2.5 text-[13.5px] text-zinc-200">
            <span className="font-mono text-[12px] text-brand">✓</span>
            {item}
          </li>
        ))}
      </ul>

      <a
        href="https://docs.useatlas.dev/getting-started"
        className="mt-auto inline-flex items-center justify-center rounded-lg border border-white/15 bg-transparent px-4 py-3 text-[13.5px] font-medium text-zinc-50 transition-colors hover:border-white/30"
      >
        read the docs →
      </a>
    </div>
  );
}

function CloudCard() {
  const cardStyle: CSSProperties = {
    background:
      "color-mix(in oklch, var(--atlas-brand) 4%, oklch(0.18 0 0 / 0.4))",
  };
  return (
    <div
      className="flex flex-col rounded-[14px] border p-8"
      style={{
        ...cardStyle,
        borderColor: "color-mix(in oklch, var(--atlas-brand) 38%, transparent)",
      }}
    >
      <header className="mb-4 flex items-start justify-between">
        <div>
          <p className="mb-2.5 font-mono text-[11px] tracking-[0.06em] text-brand">
            // atlas cloud
          </p>
          <p className="text-[38px] font-semibold leading-none tracking-[-0.03em] text-zinc-50">
            $29
            <span className="ml-1 text-base font-normal text-zinc-400">/ seat</span>
          </p>
          <p className="mt-2 text-sm text-zinc-200">Hosted. Zero ops.</p>
        </div>
        <span className="rounded-full border border-brand px-2 py-1 font-mono text-[10px] tracking-[0.08em] uppercase text-brand">
          recommended
        </span>
      </header>

      <p className="m-0 mb-5 text-sm leading-[1.6] text-zinc-400">
        We run it. Weekly updates, monitored connections, SLA.
        <br />
        Live in 3 minutes.
      </p>

      <a
        href="https://atlas.openstatus.dev"
        target="_blank"
        rel="noreferrer"
        className="mb-5 flex items-center justify-between rounded-lg border border-white/10 px-[18px] py-4 transition-colors hover:border-white/20"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: "var(--atlas-brand)" }}
            aria-hidden="true"
          />
          <span className="font-mono text-[11px] tracking-[0.04em] text-zinc-400">
            live status
          </span>
        </div>
        <span className="text-[13px] font-medium text-zinc-200">
          atlas.openstatus.dev →
        </span>
      </a>

      <ul className="m-0 mb-6 flex list-none flex-col gap-2 p-0">
        {[
          "SSO · SAML · SCIM",
          "99.9% uptime SLA",
          "Audit log export",
          "Priority support",
        ].map((item) => (
          <li key={item} className="flex items-center gap-2.5 text-[13.5px] text-zinc-200">
            <span className="font-mono text-[12px] text-brand">✓</span>
            {item}
          </li>
        ))}
      </ul>

      <a
        href="https://app.useatlas.dev"
        className="mt-auto inline-flex items-center justify-center rounded-lg bg-brand px-4 py-3 text-[13.5px] font-semibold text-zinc-950 transition-colors hover:bg-brand-hover"
      >
        start free trial →
      </a>
    </div>
  );
}

export function Deploy() {
  return (
    <section
      id="deploy"
      className="scroll-mt-20 border-b border-white/5 px-6 pt-20 pb-16 md:px-16 md:pt-[88px] md:pb-[72px]"
    >
      <header className="mb-10 max-w-[720px]">
        <p className="mb-4 font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // deployment topology
        </p>
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-50">
          Two ways to run it. Same code.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-zinc-400">
          Cloud, or your VPC. Same Atlas, same primitives, same upgrade path.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <SelfHostCard />
        <CloudCard />
      </div>
    </section>
  );
}
