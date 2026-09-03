import { CopyCommand } from "../copy-command";
import { DEMO_EXCHANGE, DEMO_QUESTION, MCP_DEMO_COMMAND, SENTENCE, TRUST_TIERS } from "./data";

/**
 * The hero visual: the demo exchange, rendered as the hosted NovaMart corpus
 * answers it. It stands in the slot the recording (#5605) takes; when the
 * dated GIF lands it replaces this card in one commit and the card's copy
 * moves nowhere, because the recording shows the same exchange.
 */
function DemoExchange() {
  const { attested, contradiction } = DEMO_EXCHANGE;
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-white/10 shadow-pane"
      style={{ background: "oklch(0.14 0 0)" }}
    >
      <div
        className="flex items-center gap-2 border-b border-white/5 px-3.5 py-2.5"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--atlas-spark)" }} />
        <span className="font-mono text-[11px] text-zinc-400">claude desktop · atlas-demo</span>
        <span className="ml-auto rounded border border-white/10 px-2 py-[2px] font-mono text-[10px] text-zinc-400">
          searchAtlas
        </span>
      </div>

      <div className="flex flex-col gap-4 px-4 py-5">
        <div>
          <p className="mb-1.5 font-mono text-[11px] tracking-[0.06em] text-brand">// you ask</p>
          <p className="m-0 text-[15px] leading-snug text-zinc-100">{DEMO_QUESTION}</p>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400">// the answer, with a name on it</p>
          <div
            className="rounded-md border border-white/10 px-3 py-3"
            style={{ background: "oklch(0.10 0 0)" }}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded border border-brand/40 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.06em] text-brand">
                Attested
              </span>
              <span className="font-mono text-[11px] text-zinc-400">
                {attested.speaker} · {attested.role} · {attested.channel} · {attested.date}
              </span>
            </div>
            <p className="m-0 text-[14px] leading-snug text-zinc-100">{attested.claim}</p>
            <p className="m-0 mt-2 font-mono text-[11px] text-zinc-400">
              approved by a named person · source and date on the record
            </p>
          </div>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400">// also on the record — Atlas picks neither</p>
          <div
            className="rounded-md border border-amber-300/25 px-3 py-3"
            style={{ background: "oklch(0.10 0 0)" }}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded border border-amber-300/40 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.06em] text-amber-200/90">
                Contradiction
              </span>
              <span className="font-mono text-[11px] text-zinc-400">
                {contradiction.speaker} · {contradiction.role} · {contradiction.channel} · {contradiction.date}
              </span>
            </div>
            <p className="m-0 text-[14px] leading-snug text-zinc-100">{contradiction.claim}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The three kinds of thing that live in the Atlas, in the PRD's language.
 * Sits under the fold as the first thing a reader meets after the exchange,
 * so the chip on the card above ("Attested") is explained one screen later.
 */
function TierStrip() {
  return (
    <div className="animate-fade-in-up delay-400 mt-12 md:mt-16">
      <p className="mb-3.5 font-mono text-[11px] tracking-[0.04em] text-fg-muted">
        // three kinds of thing live in the Atlas — every answer says which it is drawing on
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {TRUST_TIERS.map((tier) => (
          <div
            key={tier.name}
            className="flex flex-col gap-1.5 rounded-lg border px-4 py-3.5"
            style={{
              background: tier.name === "Surveyed" ? "var(--accent-quiet)" : "var(--bg-raised)",
              borderColor: tier.name === "Surveyed" ? "var(--accent)" : "var(--border)",
            }}
          >
            <span className="text-[13px] font-semibold text-fg">{tier.name}</span>
            <span className="text-[12.5px] leading-[1.5] text-fg">{tier.what}</span>
            <span className="text-[12px] leading-[1.5] text-fg-muted">{tier.why}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-fg-muted">
        Surveyed outranks Attested wherever they overlap: a recollection never overwrites the data.
        Nothing becomes Attested without a person approving it, and there is no setting that turns that off.
      </p>
    </div>
  );
}

const [SENTENCE_HEAD, SENTENCE_TAIL] = (() => {
  const i = SENTENCE.indexOf(":");
  return [SENTENCE.slice(0, i + 1), SENTENCE.slice(i + 1).trim()];
})();

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border-soft px-content pt-14 pb-16 md:pt-20 md:pb-20">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 right-0 h-[560px] w-[560px] rounded-full"
        style={{
          background: "radial-gradient(circle, var(--glow), transparent 70%)",
        }}
      />

      {/*
        The above-the-fold text (h1, command, links) paints immediately — no
        `animate-fade-in-up`. That keyframe starts at `opacity: 0`, and
        Chrome's LCP algorithm won't register an element painted transparent
        as an LCP candidate at its paint time (Lighthouse reported `NO_LCP`
        when the headline faded in). Entrance polish stays below the fold
        (TierStrip); the DemoExchange also paints immediately so it can't
        become a late LCP candidate on narrow viewports.
      */}
      <div className="relative grid gap-10 md:grid-cols-2 md:items-center md:gap-12">
        <div className="max-w-[560px]">
          <h1 className="m-0 text-[30px] sm:text-[36px] md:text-[40px] font-semibold leading-[1.12] tracking-[-0.03em] text-fg">
            <span className="block">{SENTENCE_HEAD}</span>
            <span className="block text-fg-muted">{SENTENCE_TAIL}</span>
          </h1>

          <p className="mt-6 text-[13px] text-fg-muted">
            One command into Claude Desktop, Cursor or Continue. No account, no email. Then ask:{" "}
            <em className="text-fg">{DEMO_QUESTION}</em>
          </p>
          <CopyCommand command={MCP_DEMO_COMMAND} className="mt-3" />

          <p className="mt-4 text-[13px] text-fg-muted">
            <a href="https://app.useatlas.dev/demo" className="text-fg underline decoration-border-strong underline-offset-4 hover:text-accent">
              Try it in the browser
            </a>
            <span aria-hidden className="mx-2 text-border-strong">·</span>
            <a href="https://docs.useatlas.dev/self-hosted/getting-started/quick-start" className="text-fg underline decoration-border-strong underline-offset-4 hover:text-accent">
              Self-host it
            </a>
            <span aria-hidden className="mx-2 text-border-strong">·</span>
            <a href="https://docs.useatlas.dev/guides/mcp" className="text-fg underline decoration-border-strong underline-offset-4 hover:text-accent">
              MCP guide
            </a>
          </p>
        </div>

        <div className="relative">
          <DemoExchange />
        </div>
      </div>

      <TierStrip />
    </section>
  );
}
