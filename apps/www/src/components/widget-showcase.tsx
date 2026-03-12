"use client";

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Static conversation data — cybersecurity SaaS demo dataset         */
/* ------------------------------------------------------------------ */

interface ToolCall {
  name: string;
  sql?: string;
}

interface TableResult {
  columns: string[];
  rows: string[][];
}

interface ChartBar {
  label: string;
  value: number;
}

interface Step {
  type: "user" | "assistant" | "tool" | "table" | "chart";
  content?: string;
  toolCall?: ToolCall;
  table?: TableResult;
  chart?: ChartBar[];
  /** ms before this step appears (relative to previous step completing) */
  delay: number;
}

const STEPS: Step[] = [
  {
    type: "user",
    content: "What are our top 5 accounts by annual revenue?",
    delay: 400,
  },
  {
    type: "tool",
    toolCall: { name: "executeSQL", sql: "SELECT a.name, a.annual_revenue\nFROM accounts a\nORDER BY a.annual_revenue DESC\nLIMIT 5" },
    delay: 600,
  },
  {
    type: "table",
    table: {
      columns: ["Account", "Annual Revenue"],
      rows: [
        ["Meridian Health Systems", "$4,850,000"],
        ["TechCorp Global", "$3,720,000"],
        ["Pacific Financial Group", "$2,940,000"],
        ["Atlas Defense Corp", "$2,180,000"],
        ["Summit Energy Partners", "$1,650,000"],
      ],
    },
    delay: 300,
  },
  {
    type: "assistant",
    content: "Meridian Health Systems leads with $4.85M in annual revenue, followed by TechCorp Global at $3.72M. The top 5 accounts represent $15.34M in total ARR.",
    delay: 200,
  },
  {
    type: "user",
    content: "Show that as a chart",
    delay: 1200,
  },
  {
    type: "chart",
    chart: [
      { label: "Meridian Health", value: 4850000 },
      { label: "TechCorp Global", value: 3720000 },
      { label: "Pacific Financial", value: 2940000 },
      { label: "Atlas Defense", value: 2180000 },
      { label: "Summit Energy", value: 1650000 },
    ],
    delay: 600,
  },
  {
    type: "assistant",
    content: "Here's the revenue breakdown. Meridian Health alone accounts for ~32% of top-5 revenue.",
    delay: 200,
  },
];

/* ------------------------------------------------------------------ */
/*  Typing animation hook                                              */
/* ------------------------------------------------------------------ */

function useTypewriter(text: string, active: boolean, speed = 18) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!active) {
      setDisplayed("");
      setDone(false);
      return;
    }
    let i = 0;
    setDisplayed("");
    setDone(false);
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        setDone(true);
      }
    }, speed);
    return () => clearInterval(id);
  }, [text, active, speed]);

  return { displayed, done };
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="showcase-dot h-1.5 w-1.5 rounded-full bg-zinc-500" style={{ animationDelay: "0ms" }} />
      <span className="showcase-dot h-1.5 w-1.5 rounded-full bg-zinc-500" style={{ animationDelay: "150ms" }} />
      <span className="showcase-dot h-1.5 w-1.5 rounded-full bg-zinc-500" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

function UserMessage({ text, active }: { text: string; active: boolean }) {
  const { displayed, done } = useTypewriter(text, active, 22);
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand/15 px-4 py-2.5 text-sm text-zinc-200">
        {active ? displayed : text}
        {active && !done && <span className="animate-blink ml-0.5 text-brand">|</span>}
      </div>
    </div>
  );
}

function AssistantMessage({ text, active }: { text: string; active: boolean }) {
  const { displayed, done } = useTypewriter(text, active, 12);
  return (
    <div className="flex">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-zinc-800/60 px-4 py-2.5 text-sm leading-relaxed text-zinc-300">
        {active ? displayed : text}
        {active && !done && <span className="animate-blink ml-0.5 text-zinc-500">|</span>}
      </div>
    </div>
  );
}

function ToolCallBadge({ toolCall }: { toolCall: ToolCall }) {
  return (
    <div className="flex">
      <div className="max-w-[85%] overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/50">
        <div className="flex items-center gap-2 border-b border-zinc-800/40 px-3 py-1.5">
          <svg className="h-3.5 w-3.5 text-brand/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
          </svg>
          <span className="font-mono text-[11px] font-medium text-zinc-500">{toolCall.name}</span>
        </div>
        {toolCall.sql && (
          <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-500">
            {toolCall.sql}
          </pre>
        )}
      </div>
    </div>
  );
}

function ResultTable({ table }: { table: TableResult }) {
  return (
    <div className="flex">
      <div className="max-w-[85%] overflow-hidden rounded-xl border border-zinc-800/60">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-800/60 bg-zinc-900/50">
              {table.columns.map((col) => (
                <th key={col} className="px-3 py-2 font-mono text-[11px] font-medium text-zinc-400">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-b border-zinc-800/30 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1.5 font-mono text-[11px] text-zinc-400">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BarChart({ bars }: { bars: ChartBar[] }) {
  const max = Math.max(...bars.map((b) => b.value));
  return (
    <div className="flex">
      <div className="max-w-[85%] overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
        <div className="mb-3 font-mono text-[11px] text-zinc-500">Annual Revenue — Top 5 Accounts</div>
        <div className="space-y-2">
          {bars.map((bar) => (
            <div key={bar.label} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-right font-mono text-[10px] text-zinc-500">
                {bar.label}
              </span>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-zinc-800/50">
                <div
                  className="showcase-bar absolute inset-y-0 left-0 rounded bg-brand/40"
                  style={{ width: `${(bar.value / max) * 100}%` }}
                />
              </div>
              <span className="w-14 shrink-0 font-mono text-[10px] text-zinc-400">
                ${(bar.value / 1_000_000).toFixed(1)}M
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main showcase component                                            */
/* ------------------------------------------------------------------ */

export function WidgetShowcase() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trigger playback on scroll into view
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isPlaying && !hasPlayed) {
          setIsPlaying(true);
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isPlaying, hasPlayed]);

  // Step through the conversation
  useEffect(() => {
    if (!isPlaying) return;
    if (visibleCount >= STEPS.length) {
      setIsPlaying(false);
      setHasPlayed(true);
      return;
    }

    const step = STEPS[visibleCount];
    const baseDelay = step.delay;
    // For user messages, add time for typing animation
    const typingTime = step.type === "user" && step.content ? step.content.length * 22 + 200 : 0;
    const assistantTime = step.type === "assistant" && step.content ? step.content.length * 12 + 200 : 0;

    // Show this step after its delay
    timeoutRef.current = setTimeout(
      () => {
        setVisibleCount((c) => c + 1);
      },
      visibleCount === 0 ? baseDelay : baseDelay + typingTime + assistantTime,
    );

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isPlaying, visibleCount]);

  function replay() {
    setVisibleCount(0);
    setHasPlayed(false);
    setIsPlaying(true);
  }

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-md">
      {/* Widget chrome */}
      <div className="overflow-hidden rounded-2xl border border-zinc-800/60 bg-zinc-950 shadow-2xl shadow-black/30">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-3">
          <svg viewBox="0 0 256 256" fill="none" className="h-4 w-4 text-brand" aria-hidden="true">
            <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="14" fill="none" strokeLinejoin="round"/>
            <circle cx="128" cy="28" r="16" fill="currentColor"/>
          </svg>
          <span className="font-mono text-xs font-medium text-zinc-300">Atlas</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/60" />
            <span className="text-[10px] text-zinc-600">Connected</span>
          </span>
        </div>

        {/* Chat area */}
        <div className="flex h-[420px] flex-col gap-3 overflow-hidden px-4 py-4 sm:h-[460px]">
          {/* Welcome message (always visible) */}
          <div className="flex">
            <div className="rounded-2xl rounded-bl-md bg-zinc-800/60 px-4 py-2.5 text-sm text-zinc-400">
              Ask me anything about your data.
            </div>
          </div>

          {STEPS.slice(0, visibleCount).map((step, i) => {
            const isLatest = i === visibleCount - 1 && isPlaying;

            switch (step.type) {
              case "user":
                return <UserMessage key={i} text={step.content!} active={isLatest} />;
              case "assistant":
                return <AssistantMessage key={i} text={step.content!} active={isLatest} />;
              case "tool":
                return <ToolCallBadge key={i} toolCall={step.toolCall!} />;
              case "table":
                return <ResultTable key={i} table={step.table!} />;
              case "chart":
                return <BarChart key={i} bars={step.chart!} />;
            }
          })}

          {/* Thinking indicator while playing between steps */}
          {isPlaying && visibleCount > 0 && visibleCount < STEPS.length && STEPS[visibleCount].type !== "user" && (
            <div className="flex">
              <div className="rounded-2xl rounded-bl-md bg-zinc-800/60 px-4 py-2.5">
                <TypingDots />
              </div>
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="border-t border-zinc-800/60 px-4 py-3">
          <div className="flex items-center gap-2 rounded-xl border border-zinc-800/40 bg-zinc-900/30 px-3 py-2.5">
            <span className="flex-1 text-sm text-zinc-600">Ask a question...</span>
            <svg className="h-4 w-4 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </div>
        </div>
      </div>

      {/* Replay button */}
      {hasPlayed && !isPlaying && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={replay}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-zinc-800/60 px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
            Replay
          </button>
        </div>
      )}
    </div>
  );
}
