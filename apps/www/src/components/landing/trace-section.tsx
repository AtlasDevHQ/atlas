import { Trace } from "./trace";

export function TraceSection() {
  return (
    <section
      id="trace"
      className="scroll-mt-20 border-b border-white/5 px-6 pt-20 pb-16 md:px-16 md:pt-[100px] md:pb-20"
      style={{ background: "oklch(0.10 0 0)" }}
    >
      <header className="mb-10 max-w-[720px]">
        <p className="mb-4 font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // trace one query
        </p>
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-50">
          One question, end to end.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-zinc-400">
          Watch it run. Click any gate to see what it checks. This is the same panel
          the operator sees in the chat UI — every step is a real artifact, every gate
          is the real check.
        </p>
      </header>

      <Trace />

      <div className="mt-4 flex flex-wrap gap-3 font-mono text-[11px] tracking-[0.04em] text-zinc-400">
        <span className="text-brand">// playback</span>
        <span>autoplays on scroll · click any step or gate to inspect</span>
      </div>
    </section>
  );
}
