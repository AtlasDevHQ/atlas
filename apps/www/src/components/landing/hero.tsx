import { Fragment } from "react";

import { CATEGORY_ROWS, TOP_CATEGORY_QUESTION } from "./data";

const HEADLINE_LINES = ["Ask your data anything.", "Trust the answer."] as const;
const ITALIC_LINE_INDEX = 1;

const SUBHEAD =
  "Atlas is an AI data analyst that turns plain-English questions into safe, validated SQL, grounded in a semantic layer you control.";

/**
 * The hero's payload: a plain-English question and the validated answer it
 * returns. No SQL here — the mechanism (YAML + generated SQL) lives in the
 * YAML section below, so the two surfaces don't duplicate.
 */
function AnswerCard() {
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-white/10"
      style={{ background: "oklch(0.14 0 0)" }}
    >
      <div
        className="flex items-center gap-2 border-b border-white/5 px-3.5 py-2.5"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--atlas-brand)" }} />
        <span className="font-mono text-[11px] text-zinc-400">atlas · agent reply</span>
        <span className="ml-auto rounded border border-white/10 px-2 py-[2px] font-mono text-[10px] text-zinc-400">
          chat · mcp · widget
        </span>
      </div>

      <div className="flex flex-col gap-4 px-4 py-5">
        <div>
          <p className="mb-1.5 font-mono text-[11px] tracking-[0.06em] text-brand">
            // asked in plain english
          </p>
          <p className="m-0 text-[15px] leading-snug text-zinc-100">{TOP_CATEGORY_QUESTION}</p>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400">
            // validated answer
          </p>
          <div
            className="overflow-hidden rounded-md border border-white/10"
            style={{ background: "oklch(0.10 0 0)" }}
          >
            <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-white/5 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-zinc-400">
              <span>category</span>
              <span className="text-right">gmv</span>
              <span className="text-right">orders</span>
            </div>
            {CATEGORY_ROWS.slice(0, 3).map((row, i) => (
              <div
                key={row.category}
                className="grid grid-cols-[1fr_auto_auto] gap-4 px-3 py-2 font-mono text-[12.5px] text-zinc-200"
                style={{ background: i % 2 ? "oklch(0.12 0 0)" : "transparent" }}
              >
                <span>{row.category}</span>
                <span className="text-right text-brand">{row.gmv}</span>
                <span className="text-right text-zinc-400">{row.orders}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[11px] text-zinc-400">
          <span className="flex items-center gap-1.5 text-brand">
            <span aria-hidden>✓</span> 7 validators
          </span>
          <span className="text-zinc-700">·</span>
          <span>read-only</span>
          <span className="text-zinc-700">·</span>
          <span>row-limited</span>
          <span className="text-zinc-700">·</span>
          <span>audited</span>
        </div>
      </div>
    </div>
  );
}

type Stage = { readonly label: string; readonly value: string; readonly highlight: boolean };

const STAGES: ReadonlyArray<Stage> = [
  { label: "ask",            value: '"top category by gmv…"', highlight: false },
  { label: "semantic layer", value: "your YAML",              highlight: false },
  { label: "validate",       value: "7 checks · read-only",   highlight: false },
  { label: "answer",         value: "grounded · audited",     highlight: true  },
];

/**
 * The four-stage path: ask → semantic layer → validate → answer. One straight
 * read left-to-right; the highlight lands on the answer to reinforce the
 * headline's promise (a grounded, audited result you can trust).
 */
function PipelineStrip() {
  return (
    <div className="mt-12 md:mt-16">
      <p className="mb-3.5 font-mono text-[11px] tracking-[0.04em] text-zinc-500">
        // every question takes the same path
      </p>
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-center">
        {STAGES.map((stage, i) => (
          <Fragment key={stage.label}>
            <div
              className="flex flex-col gap-1 rounded-lg border px-4 py-3.5"
              style={{
                background: "oklch(0.16 0 0)",
                borderColor: stage.highlight
                  ? "color-mix(in oklch, var(--atlas-brand) 35%, transparent)"
                  : "oklch(1 0 0 / 0.1)",
              }}
            >
              <span className="text-[13px] font-semibold text-zinc-50">{stage.label}</span>
              <span className="font-mono text-[11px] text-zinc-400">{stage.value}</span>
            </div>
            {i < STAGES.length - 1 && (
              <span aria-hidden className="hidden justify-center font-mono text-brand md:flex">
                →
              </span>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-white/5 px-6 pt-16 pb-16 md:px-16 md:pt-24 md:pb-20">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 right-0 h-[560px] w-[560px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklch, var(--atlas-brand) 10%, transparent), transparent 70%)",
        }}
      />

      <div className="relative grid gap-10 md:grid-cols-2 md:items-center md:gap-12">
        <div className="max-w-[520px]">
          <h1 className="m-0 text-[44px] sm:text-[56px] md:text-[64px] font-semibold leading-[1.02] tracking-[-0.035em] text-zinc-50">
            {HEADLINE_LINES.map((line, i) => (
              <span key={line} className="block">
                {i === ITALIC_LINE_INDEX ? (
                  <em className="font-semibold text-brand">{line}</em>
                ) : (
                  line
                )}
              </span>
            ))}
          </h1>
          <p className="mt-6 max-w-[460px] text-base leading-[1.6] text-zinc-400">{SUBHEAD}</p>
          <div className="mt-7 flex flex-wrap gap-2.5">
            <a
              href="https://app.useatlas.dev/demo"
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-[18px] py-[11px] text-[13.5px] font-semibold text-zinc-950 transition-colors hover:bg-brand-hover"
            >
              Try the demo →
            </a>
            <a
              href="https://docs.useatlas.dev/getting-started/quick-start"
              className="inline-flex items-center rounded-lg border border-white/10 bg-zinc-900 px-3.5 py-2.5 text-zinc-50 transition-colors hover:border-white/20"
            >
              <code className="font-mono text-[12.5px]">$ bun create atlas-agent</code>
            </a>
          </div>
          <p className="mt-3.5 text-[13px] text-zinc-500">
            Self-host is free and open source.
          </p>
        </div>

        <div className="relative">
          <AnswerCard />
        </div>
      </div>

      <PipelineStrip />
    </section>
  );
}
