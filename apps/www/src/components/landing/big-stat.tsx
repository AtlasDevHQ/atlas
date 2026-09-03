export function BigStat() {
  return (
    <section
      className="grid items-center gap-8 border-b border-border-soft px-content py-14 md:grid-cols-[auto_1fr] md:gap-12 md:py-[72px]"
      style={{ background: "var(--bg-raised)" }}
    >
      <div className="text-[88px] md:text-[144px] font-semibold leading-[0.9] tracking-[-0.05em] text-accent">
        0
      </div>
      <div className="max-w-[720px]">
        <p className="m-0 mb-3 text-xl md:text-[28px] font-medium leading-[1.3] tracking-[-0.02em] text-fg">
          writes. Every query Atlas runs is SELECT-only, single-statement, and
          whitelisted to your semantic layer — enforced by seven validators, not
          suggested by a prompt.
        </p>
        <p className="m-0 font-mono text-[12px] tracking-[0.04em] text-fg-muted">
          // empty check · mutation guard · AST parse · table whitelist · row-level security · auto LIMIT · statement timeout
        </p>
      </div>
    </section>
  );
}
