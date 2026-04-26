"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

type TraceKind = "input" | "info" | "gate" | "result";

type TraceStep = {
  t: number;
  k: string;
  v: string;
  kind: TraceKind;
  /** Gate index (1..7). Only set when `kind === "gate"`. */
  n?: number;
  /** Long-form copy shown in the viewer's detail strip when this step is active. */
  detail?: string;
};

const TRACE_STEPS: TraceStep[] = [
  { t: 0.0, k: "prompt", v: "Top 5 accounts by ARR this quarter, with QoQ growth.", kind: "input" },
  {
    t: 0.041,
    k: "resolve",
    v: "accounts, arr, quarter, qoq_growth",
    kind: "info",
    detail:
      "Maps prompt terms → entities + metrics defined in semantic_layer.yaml. No invented columns.",
  },
  {
    t: 0.124,
    k: "compile",
    v: "78 lines · 1 join · 5 columns",
    kind: "info",
    detail:
      "AST → SQL. Atlas writes deterministic SQL from the entity graph; no LLM-generated joins.",
  },
  {
    t: 0.142,
    k: "ast.parse",
    v: "ok · 18ms",
    kind: "gate",
    n: 1,
    detail:
      "Statement parses cleanly to a single SELECT with one CTE. Anything unparseable is rejected before reaching the warehouse.",
  },
  {
    t: 0.146,
    k: "read_only",
    v: "ok · no mutations",
    kind: "gate",
    n: 2,
    detail:
      "Statement type ∈ {SELECT, WITH}. INSERT, UPDATE, DELETE, DROP, ALTER, GRANT — all rejected. Zero exceptions.",
  },
  {
    t: 0.168,
    k: "permissions",
    v: "ok · select on accounts, snapshots",
    kind: "gate",
    n: 3,
    detail:
      "Every referenced table is checked against the operator's role. Atlas mirrors warehouse RBAC; if you can't query it directly, you can't query it through Atlas.",
  },
  {
    t: 0.174,
    k: "row_limit",
    v: "ok · ≤ 10k",
    kind: "gate",
    n: 4,
    detail:
      "Inferred or explicit LIMIT enforced before execution. Default cap 10k rows; configurable per-role.",
  },
  {
    t: 0.205,
    k: "join_check",
    v: "ok · declared keys",
    kind: "gate",
    n: 5,
    detail:
      "Joins must use keys declared in semantic_layer.yaml. No cartesian products, no fuzzy joins, no surprises.",
  },
  {
    t: 0.217,
    k: "metric_whitelist",
    v: "ok · arr, qoq_growth",
    kind: "gate",
    n: 6,
    detail:
      "Computed metrics must come from the metric registry. Inline calculations are flagged for review.",
  },
  {
    t: 0.306,
    k: "cost_estimate",
    v: "ok · 0.0021 credits",
    kind: "gate",
    n: 7,
    detail:
      "EXPLAIN run server-side; bytes-scanned vs. budget. Queries above the per-role ceiling require approval.",
  },
  {
    t: 1.18,
    k: "execute",
    v: "5 rows · scoped to analytics",
    kind: "result",
    detail:
      "Read-only connection, role-scoped session, results streamed back to the widget.",
  },
];

const LAST_INDEX = TRACE_STEPS.length - 1;

type SqlTokenKind = "cm" | "kw" | "fn" | "num" | "str" | "t";

type SqlToken = { k: SqlTokenKind; v: string };

const SQL_TOKENS: SqlToken[] = [
  { k: "cm", v: "-- session.4f8e · 7 validations passed\n" },
  { k: "cm", v: "-- read-only · scoped to analytics.public\n\n" },
  { k: "kw", v: "SELECT" },
  { k: "t", v: " a.name,\n       a.arr,\n       " },
  { k: "fn", v: "ROUND" },
  { k: "t", v: "(\n         (a.arr - p.arr) / p.arr * " },
  { k: "num", v: "100" },
  { k: "t", v: ",\n         " },
  { k: "num", v: "1" },
  { k: "t", v: "\n       ) " },
  { k: "kw", v: "AS" },
  { k: "t", v: " qoq_pct\n  " },
  { k: "kw", v: "FROM" },
  { k: "t", v: " accounts a\n  " },
  { k: "kw", v: "JOIN" },
  { k: "t", v: " account_snapshots p\n    " },
  { k: "kw", v: "ON" },
  { k: "t", v: " p.account_id = a.id\n   " },
  { k: "kw", v: "AND" },
  { k: "t", v: " p.quarter = " },
  { k: "str", v: "'2026-Q1'" },
  { k: "t", v: "\n " },
  { k: "kw", v: "ORDER BY" },
  { k: "t", v: " a.arr " },
  { k: "kw", v: "DESC LIMIT" },
  { k: "t", v: " " },
  { k: "num", v: "5" },
  { k: "t", v: ";" },
];

const SQL_TOTAL = SQL_TOKENS.reduce((sum, tok) => sum + tok.v.length, 0);

const RESULT_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["Northwind Trading",  "$2.40M", "+18.4%"],
  ["Gemini Robotics",    "$1.92M", "+9.1%"],
  ["Helios Aerospace",   "$1.71M", "+5.8%"],
  ["Kite & Key Capital", "$1.55M", "+22.7%"],
  ["Orca Logistics",     "$1.41M", "−2.3%"],
];

const SQL_KIND_STYLE: Record<SqlTokenKind, CSSProperties> = {
  cm:  { color: "oklch(0.65 0 0)" },
  kw:  { color: "var(--atlas-brand)" },
  fn:  { color: "oklch(0.78 0.13 280)" },
  num: { color: "oklch(0.85 0.18 70)" },
  str: { color: "oklch(0.78 0.16 50)" },
  t:   {},
};

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stepAccent(kind: TraceKind): string {
  switch (kind) {
    case "gate":   return "var(--atlas-brand)";
    case "input":  return "oklch(0.85 0.18 70)";
    case "result": return "var(--atlas-brand)";
    case "info":   return "oklch(0.78 0.13 280)";
  }
}

export function Trace() {
  // Default to the final state so SSR / no-JS / reduced-motion users see the
  // fully-revealed trace, not an empty viewer.
  const [idx, setIdx] = useState(LAST_INDEX);
  const [playing, setPlaying] = useState(false);
  const [hasAutoPlayed, setHasAutoPlayed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-play when scrolled into view, but only once and only if the user
  // hasn't asked us to stop moving things.
  useEffect(() => {
    if (hasAutoPlayed || prefersReducedMotion() || !rootRef.current) return;

    let kickoffTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !hasAutoPlayed) {
            setHasAutoPlayed(true);
            setIdx(0);
            kickoffTimer = setTimeout(() => setPlaying(true), 400);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(rootRef.current);
    return () => {
      observer.disconnect();
      if (kickoffTimer) clearTimeout(kickoffTimer);
    };
  }, [hasAutoPlayed]);

  useEffect(() => {
    if (!playing) return;
    if (idx >= LAST_INDEX) {
      setPlaying(false);
      return;
    }
    const cur = TRACE_STEPS[idx]!.t;
    const nxt = TRACE_STEPS[idx + 1]!.t;
    const dwell = Math.max(120, Math.min(900, (nxt - cur) * 800));
    // Capture the local id so cleanup clears *this* run's timer, not whichever
    // one happens to be in `playTimer.current` when cleanup runs.
    const id = setTimeout(() => setIdx((i) => i + 1), dwell);
    playTimer.current = id;
    return () => clearTimeout(id);
  }, [playing, idx]);

  const onPlay = () => {
    if (idx >= LAST_INDEX) setIdx(0);
    setPlaying((p) => !p);
  };

  const cur = TRACE_STEPS[idx]!;
  const totalT = TRACE_STEPS[LAST_INDEX]!.t;

  const sqlReveal = idx < 2 ? 0 : Math.min(1, (idx - 1) / 8);
  const visibleSqlChars = Math.floor(SQL_TOTAL * sqlReveal);

  const sqlNodes: React.ReactNode[] = [];
  let used = 0;
  for (let i = 0; i < SQL_TOKENS.length && used < visibleSqlChars; i++) {
    const tok = SQL_TOKENS[i]!;
    const remaining = visibleSqlChars - used;
    const slice = tok.v.slice(0, remaining);
    sqlNodes.push(
      <span key={i} style={SQL_KIND_STYLE[tok.k]}>
        {slice}
      </span>,
    );
    used += slice.length;
  }

  const resultsVisible = idx >= LAST_INDEX ? RESULT_ROWS.length : 0;
  const gatesPassed = Math.min(7, Math.max(0, idx - 2));
  const isDone = idx >= LAST_INDEX;

  return (
    <div
      ref={rootRef}
      className="overflow-hidden rounded-xl border border-white/10"
      style={{ background: "oklch(0.145 0 0)" }}
    >
      {/* HEADER */}
      <div
        className="flex items-center justify-between px-[18px] py-3 font-mono text-[11.5px] text-zinc-400 border-b border-white/5"
        style={{ background: "oklch(0.18 0 0)" }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="h-2 w-2 rounded-full bg-brand"
            style={{ boxShadow: "0 0 8px var(--atlas-brand)" }}
          />
          <span className="text-zinc-200">session.4f8e · production.analytics</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {cur.t.toFixed(3)}s / {totalT.toFixed(2)}s
          </span>
          <span className="text-zinc-700">·</span>
          <span>{gatesPassed} / 7 gates</span>
          <span className="text-zinc-700">·</span>
          <span className={isDone ? "text-brand" : "text-amber-400"}>
            {isDone ? "● ok" : "● running"}
          </span>
        </div>
      </div>

      {/* BODY */}
      <div className="grid min-h-[480px] grid-cols-1 lg:[grid-template-columns:440px_1fr]">
        {/* TIMELINE */}
        <div
          className="flex flex-col gap-px border-b border-white/5 p-3.5 lg:border-r lg:border-b-0"
          style={{ background: "oklch(0.16 0 0 / 0.5)" }}
        >
          {TRACE_STEPS.map((step, i) => {
            const past = i < idx;
            const active = i === idx;
            const future = i > idx;
            const accent = stepAccent(step.kind);
            return (
              <button
                key={step.k}
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setIdx(i);
                }}
                className="grid items-center gap-2 rounded-md border-0 bg-transparent px-2 py-[9px] text-left font-mono text-[11px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                style={{
                  gridTemplateColumns: "60px 160px 1fr 14px",
                  opacity: future ? 0.4 : 1,
                  background: active
                    ? "color-mix(in oklch, var(--atlas-brand) 10%, transparent)"
                    : undefined,
                  boxShadow: active ? "inset 2px 0 0 var(--atlas-brand)" : undefined,
                }}
                aria-current={active ? "step" : undefined}
              >
                <span
                  className="text-zinc-400"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {step.t.toFixed(3)}s
                </span>
                <span
                  className="flex items-center gap-1.5 font-medium"
                  style={{
                    color: active
                      ? accent
                      : past
                        ? "oklch(0.871 0 0)"
                        : "oklch(0.65 0 0)",
                  }}
                >
                  {step.kind === "gate" && step.n != null && (
                    <span
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[9px] font-semibold text-brand"
                      style={{
                        background:
                          "color-mix(in oklch, var(--atlas-brand) 18%, transparent)",
                      }}
                    >
                      {step.n}
                    </span>
                  )}
                  {step.k}
                </span>
                <span className="overflow-hidden text-[10.5px] text-ellipsis whitespace-nowrap text-zinc-400">
                  {step.v}
                </span>
                {past && <span className="text-[10px] text-brand">✓</span>}
              </button>
            );
          })}
        </div>

        {/* VIEWER */}
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-4 border-b border-white/5 px-[22px] py-2.5 font-mono text-[11px]">
            <span className="-mb-1.5 border-b border-brand pb-1.5 tracking-[0.06em] text-brand">
              sql
            </span>
            <span className="tracking-[0.06em] text-zinc-400">plan</span>
            <span className="tracking-[0.06em] text-zinc-400">result</span>
            <span className="tracking-[0.06em] text-zinc-400">raw</span>
            <span className="ml-auto text-[10.5px] tracking-[0.06em] text-brand">
              {cur.kind === "gate" && cur.n != null ? `gate ${cur.n} of 7` : cur.kind}
            </span>
          </div>

          {/* Step detail strip */}
          <div
            className="border-b border-white/5 px-[22px] py-3.5"
            style={{ background: "oklch(0.16 0 0 / 0.4)" }}
          >
            <div className="mb-1 font-mono text-[11px] tracking-[0.06em] text-brand">
              {cur.k}
            </div>
            <div className="text-[13px] leading-[1.55] text-zinc-200">
              {cur.detail ?? cur.v}
            </div>
          </div>

          <pre
            className="m-0 min-h-[200px] border-b border-white/5 px-[22px] py-4 font-mono text-[12.5px] leading-[1.7] whitespace-pre-wrap text-zinc-200"
          >
            {sqlNodes.length === 0 ? (
              <span style={SQL_KIND_STYLE.cm}>{"// awaiting compile…"}</span>
            ) : (
              sqlNodes
            )}
            {sqlReveal < 1 && sqlNodes.length > 0 && (
              <span className="term-caret text-brand">▌</span>
            )}
          </pre>

          <div className="px-[22px] pt-3 pb-4.5">
            <div
              className="grid border-b border-white/5 py-2 font-mono text-[10px] tracking-[0.1em] uppercase text-zinc-400"
              style={{ gridTemplateColumns: "2fr 1fr 1fr" }}
            >
              <span>account</span>
              <span>arr</span>
              <span>qoq</span>
            </div>
            {resultsVisible === 0 ? (
              <div className="px-0 py-4 font-mono text-[11px] text-zinc-400">
                {idx >= LAST_INDEX - 1 ? "// executing…" : "// awaiting validation"}
              </div>
            ) : (
              RESULT_ROWS.slice(0, resultsVisible).map(([name, arr, qoq]) => (
                <div
                  key={name}
                  className="grid py-2 font-mono text-[12px] text-zinc-200"
                  style={{
                    gridTemplateColumns: "2fr 1fr 1fr",
                    borderBottom: "1px solid oklch(1 0 0 / 0.04)",
                  }}
                >
                  <span>{name}</span>
                  <span className="text-zinc-50">{arr}</span>
                  <span style={{ color: qoq.startsWith("−") ? "oklch(0.7 0.16 22)" : "var(--atlas-brand)" }}>
                    {qoq}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* SCRUBBER */}
      <div
        className="grid items-center gap-4 border-t border-white/5 px-[22px] py-3.5"
        style={{
          gridTemplateColumns: "auto 1fr 200px",
          background: "oklch(0.18 0 0)",
        }}
      >
        <button
          type="button"
          onClick={onPlay}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-zinc-950 transition-colors hover:bg-brand-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div
          className="relative h-1 rounded"
          style={{ background: "oklch(0.25 0 0)" }}
          role="presentation"
        >
          <div
            className="absolute inset-y-0 left-0 rounded bg-brand transition-[width] duration-200 ease-out"
            style={{ width: `${(idx / LAST_INDEX) * 100}%` }}
          />
          {TRACE_STEPS.map((step, i) => (
            <button
              key={step.k}
              type="button"
              onClick={() => {
                setPlaying(false);
                setIdx(i);
              }}
              aria-label={`step ${i + 1}: ${step.k}`}
              className="absolute top-1/2 h-2 w-2 cursor-pointer rounded-full border-0 p-0 transition-transform duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              style={{
                left: `${(i / LAST_INDEX) * 100}%`,
                background: i <= idx ? "var(--atlas-brand)" : "oklch(0.32 0 0)",
                transform:
                  i === idx
                    ? "translate(-50%, -50%) scale(1.6)"
                    : "translate(-50%, -50%)",
              }}
            />
          ))}
        </div>
        <div className="text-right font-mono text-[11px] tracking-[0.04em] text-zinc-400">
          step {idx + 1}/{TRACE_STEPS.length} ·{" "}
          <span className="text-zinc-200">{cur.k}</span>
        </div>
      </div>
    </div>
  );
}
