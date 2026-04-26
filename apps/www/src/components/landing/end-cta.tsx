export function EndCta() {
  return (
    <section
      className="relative overflow-hidden border-b border-white/5 px-6 py-24 md:px-16 md:py-[140px]"
      style={{
        background: [
          "radial-gradient(ellipse at 50% 60%, color-mix(in oklch, var(--atlas-brand) 14%, transparent), transparent 55%)",
          "linear-gradient(to bottom, transparent, oklch(0.10 0 0))",
        ].join(", "),
      }}
    >
      <div className="mx-auto max-w-[720px] text-center">
        <p className="mb-4 font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // ship it
        </p>
        <h2 className="m-0 mb-8 text-[40px] md:text-[56px] font-semibold leading-[1.05] tracking-[-0.035em] text-zinc-50">
          <span className="block">Stop reviewing AI-written SQL.</span>
          <em className="block font-semibold text-brand">
            Start running it.
          </em>
        </h2>
        <div className="flex flex-wrap justify-center gap-2.5">
          <a
            href="https://app.useatlas.dev"
            className="inline-flex items-center rounded-lg bg-brand px-[18px] py-[11px] text-[13.5px] font-semibold text-zinc-950 transition-colors hover:bg-brand-hover"
          >
            Start 14-day trial →
          </a>
          <a
            href="https://app.useatlas.dev/demo"
            className="inline-flex items-center rounded-lg border border-white/10 bg-zinc-900 px-3.5 py-2.5 text-[13.5px] text-zinc-50 transition-colors hover:border-white/20"
          >
            book 15-min demo
          </a>
        </div>
        <p className="mt-3.5 font-mono text-[11px] tracking-[0.04em] text-zinc-400">
          14-day trial · no card · cancel any time
        </p>
      </div>
    </section>
  );
}
