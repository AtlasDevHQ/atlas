/**
 * Closing CTA — the page's one deep-green "drenched" band: a full-bleed forest
 * ground with cream text and the bright brand teal as the spark, echoing the
 * hero headline as a bookend. The only place the dark/green register returns on
 * the otherwise light page. See PRODUCT.md › Aesthetic Direction.
 */
export function EndCta() {
  return (
    <section
      className="relative overflow-hidden px-content py-24 md:py-[140px]"
      style={{
        background:
          "radial-gradient(ellipse at 50% 55%, var(--drench-glow), transparent 60%), var(--drench-bg)",
        color: "var(--drench-fg)",
      }}
    >
      <div className="mx-auto max-w-[720px] text-center">
        <h2 className="m-0 mb-8 text-[40px] md:text-[56px] font-semibold leading-[1.05] tracking-[-0.035em]">
          <span className="block">Ask your data anything.</span>
          <em className="block font-semibold" style={{ color: "var(--drench-accent)" }}>
            Trust the answer.
          </em>
        </h2>
        <div className="flex flex-wrap justify-center gap-2.5">
          <a
            href="https://app.useatlas.dev/demo"
            className="inline-flex items-center rounded-lg px-[18px] py-[11px] text-[13.5px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: "var(--drench-accent)", color: "var(--drench-ink)" }}
          >
            Try the NovaMart demo →
          </a>
          <a
            href="https://docs.useatlas.dev/getting-started/quick-start"
            className="inline-flex items-center rounded-lg border bg-transparent px-3.5 py-2.5 text-[13.5px] transition-colors hover:bg-white/5"
            style={{ borderColor: "oklch(1 0 0 / 0.22)", color: "var(--drench-fg)" }}
          >
            <code className="font-mono text-[12.5px]">$ bun create atlas-agent</code>
          </a>
        </div>
        <p className="mt-3.5 text-[13px]" style={{ color: "var(--drench-muted)" }}>
          Self-host is free and open source.
        </p>
      </div>
    </section>
  );
}
