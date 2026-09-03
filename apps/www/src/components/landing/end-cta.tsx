import { CopyCommand } from "../copy-command";
import { MCP_DEMO_COMMAND, SENTENCE } from "./data";

/**
 * Closing CTA — the page's one deep-green "drenched" band: a full-bleed forest
 * ground with cream text and the bright brand teal as the spark, echoing the
 * sentence as a bookend. The only place the dark/green register returns on
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
      <div className="mx-auto max-w-[760px] text-center">
        <h2 className="m-0 mb-8 text-[26px] md:text-[34px] font-semibold leading-[1.2] tracking-[-0.025em]">
          {SENTENCE}
        </h2>
        <CopyCommand command={MCP_DEMO_COMMAND} className="mx-auto max-w-[560px] text-left" />
        <p className="mt-4 text-[13px]" style={{ color: "var(--drench-muted)" }}>
          No account, no email.{" "}
          <a href="https://app.useatlas.dev/signup" className="underline underline-offset-4" style={{ color: "var(--drench-fg)" }}>
            Start a hosted trial
          </a>{" "}
          — 14 days, no credit card — or{" "}
          <a href="https://docs.useatlas.dev/self-hosted/getting-started/quick-start" className="underline underline-offset-4" style={{ color: "var(--drench-fg)" }}>
            self-host
          </a>
          , free and open source.
        </p>
      </div>
    </section>
  );
}
