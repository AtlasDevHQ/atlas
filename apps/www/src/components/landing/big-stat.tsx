export function BigStat() {
  return (
    <section
      className="grid items-center gap-8 border-b border-white/5 px-6 py-14 md:grid-cols-[auto_1fr] md:gap-12 md:px-16 md:py-[72px]"
      style={{ background: "oklch(0.16 0 0)" }}
    >
      <div className="text-[88px] md:text-[144px] font-semibold leading-[0.9] tracking-[-0.05em] text-brand">
        94%
      </div>
      <div className="max-w-[720px]">
        <p className="m-0 mb-3 text-xl md:text-[28px] font-medium leading-[1.3] tracking-[-0.02em] text-zinc-50">
          of AI-generated SQL fails at least one Atlas validator.
        </p>
        <p className="m-0 font-mono text-[12px] tracking-[0.04em] text-zinc-400">
          // sample of 12,481 queries · gpt-4o, claude-sonnet, llama-3.1 · against 18 production schemas
        </p>
      </div>
    </section>
  );
}
