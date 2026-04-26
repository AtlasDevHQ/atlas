/* Scrubbable Query Trace
 * Timeline plays through 11 steps; SQL/result populate live; gates clickable.
 */

const TRACE_STEPS = [
  { t: 0.000, k: "prompt",          v: 'Top 5 accounts by ARR this quarter, with QoQ growth.', kind: "input" },
  { t: 0.041, k: "resolve",         v: "accounts, arr, quarter, qoq_growth", kind: "info",
    detail: "Maps prompt terms → entities + metrics defined in semantic_layer.yaml. No invented columns." },
  { t: 0.124, k: "compile",         v: "78 lines · 1 join · 5 columns", kind: "info",
    detail: "AST → SQL. Atlas writes deterministic SQL from the entity graph; no LLM-generated joins." },
  { t: 0.142, k: "ast.parse",       v: "ok · 18ms", kind: "gate", n: 1,
    detail: "Statement parses cleanly to a single SELECT with one CTE. Anything unparseable is rejected before reaching the warehouse." },
  { t: 0.146, k: "read_only",       v: "ok · no mutations", kind: "gate", n: 2,
    detail: "Statement type ∈ {SELECT, WITH}. INSERT, UPDATE, DELETE, DROP, ALTER, GRANT — all rejected. Zero exceptions." },
  { t: 0.168, k: "permissions",     v: "ok · select on accounts, snapshots", kind: "gate", n: 3,
    detail: "Every referenced table is checked against the operator's role. Atlas mirrors warehouse RBAC; if you can't query it directly, you can't query it through Atlas." },
  { t: 0.174, k: "row_limit",       v: "ok · ≤ 10k", kind: "gate", n: 4,
    detail: "Inferred or explicit LIMIT enforced before execution. Default cap 10k rows; configurable per-role." },
  { t: 0.205, k: "join_check",      v: "ok · declared keys", kind: "gate", n: 5,
    detail: "Joins must use keys declared in semantic_layer.yaml. No cartesian products, no fuzzy joins, no surprises." },
  { t: 0.217, k: "metric_whitelist",v: "ok · arr, qoq_growth", kind: "gate", n: 6,
    detail: "Computed metrics must come from the metric registry. Inline calculations are flagged for review." },
  { t: 0.306, k: "cost_estimate",   v: "ok · 0.0021 credits", kind: "gate", n: 7,
    detail: "EXPLAIN run server-side; bytes-scanned vs. budget. Queries above the per-role ceiling require approval." },
  { t: 1.180, k: "execute",         v: "5 rows · scoped to analytics", kind: "result",
    detail: "Read-only connection, role-scoped session, results streamed back to the widget." },
];

const SQL_TOKENS = [
  { k: "cm",   v: "-- session.4f8e · 7 validations passed\n" },
  { k: "cm",   v: "-- read-only · scoped to analytics.public\n\n" },
  { k: "kw",   v: "SELECT" }, { k: "t", v: " a.name,\n       a.arr,\n       " },
  { k: "fn",   v: "ROUND" }, { k: "t", v: "(\n         (a.arr - p.arr) / p.arr * " },
  { k: "num",  v: "100" }, { k: "t", v: ",\n         " },
  { k: "num",  v: "1" }, { k: "t", v: "\n       ) " },
  { k: "kw",   v: "AS" }, { k: "t", v: " qoq_pct\n  " },
  { k: "kw",   v: "FROM" }, { k: "t", v: " accounts a\n  " },
  { k: "kw",   v: "JOIN" }, { k: "t", v: " account_snapshots p\n    " },
  { k: "kw",   v: "ON" }, { k: "t", v: " p.account_id = a.id\n   " },
  { k: "kw",   v: "AND" }, { k: "t", v: " p.quarter = " },
  { k: "str",  v: "'2026-Q1'" }, { k: "t", v: "\n " },
  { k: "kw",   v: "ORDER BY" }, { k: "t", v: " a.arr " },
  { k: "kw",   v: "DESC LIMIT" }, { k: "t", v: " " },
  { k: "num",  v: "5" }, { k: "t", v: ";" },
];

const RESULT_ROWS = [
  ["Northwind Trading",   "$2.40M", "+18.4%"],
  ["Gemini Robotics",     "$1.92M",  "+9.1%"],
  ["Helios Aerospace",    "$1.71M",  "+5.8%"],
  ["Kite & Key Capital",  "$1.55M", "+22.7%"],
  ["Orca Logistics",      "$1.41M",  "−2.3%"],
];

const ScrubbableTrace = ({ autoplay = false }) => {
  const [idx, setIdx] = React.useState(autoplay ? 0 : TRACE_STEPS.length - 1);
  const [playing, setPlaying] = React.useState(false);
  const [hasAutoPlayed, setHasAutoPlayed] = React.useState(false);
  const playRef = React.useRef();
  const rootRef = React.useRef();

  // Auto-start when scrolled into view (or on mount if autoplay=true)
  React.useEffect(() => {
    if (!autoplay || hasAutoPlayed) return;
    if (!rootRef.current) return;
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting && !hasAutoPlayed) {
          setHasAutoPlayed(true);
          setIdx(0);
          setTimeout(() => setPlaying(true), 400);
        }
      });
    }, { threshold: 0.3 });
    obs.observe(rootRef.current);
    return () => obs.disconnect();
  }, [autoplay, hasAutoPlayed]);

  // Auto-advance when playing
  React.useEffect(() => {
    if (!playing) return;
    if (idx >= TRACE_STEPS.length - 1) { setPlaying(false); return; }
    const cur = TRACE_STEPS[idx].t;
    const nxt = TRACE_STEPS[idx + 1].t;
    const dwell = Math.max(120, Math.min(900, (nxt - cur) * 800));
    playRef.current = setTimeout(() => setIdx(i => i + 1), dwell);
    return () => clearTimeout(playRef.current);
  }, [playing, idx]);

  const onPlay = () => {
    if (idx >= TRACE_STEPS.length - 1) setIdx(0);
    setPlaying(p => !p);
  };

  const cur = TRACE_STEPS[idx];
  const elapsed = cur.t;
  const totalT = TRACE_STEPS[TRACE_STEPS.length - 1].t;

  // Reveal SQL gradually after compile (idx >= 2)
  const sqlReveal = idx < 2 ? 0 : Math.min(1, (idx - 1) / 8);
  const visibleSqlChars = Math.floor(SQL_TOKENS.reduce((a, t) => a + t.v.length, 0) * sqlReveal);
  const sqlNodes = (() => {
    let used = 0;
    const out = [];
    for (let i = 0; i < SQL_TOKENS.length; i++) {
      const tok = SQL_TOKENS[i];
      if (used >= visibleSqlChars) break;
      const remaining = visibleSqlChars - used;
      const slice = tok.v.slice(0, remaining);
      out.push(<span key={i} style={traceStyles[tok.k] || {}}>{slice}</span>);
      used += slice.length;
    }
    return out;
  })();

  // Result rows reveal after execute
  const resultsVisible = idx >= TRACE_STEPS.length - 1 ? RESULT_ROWS.length : 0;

  return (
    <div ref={rootRef} style={traceStyles.frame}>
      {/* Header */}
      <div style={traceStyles.head}>
        <div style={traceStyles.headLeft}>
          <span style={traceStyles.dot} />
          <span style={traceStyles.title}>session.4f8e · production.analytics</span>
        </div>
        <div style={traceStyles.headRight}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{elapsed.toFixed(3)}s / {totalT.toFixed(2)}s</span>
          <span style={traceStyles.div}>·</span>
          <span>{Math.min(7, Math.max(0, idx - 2))} / 7 gates</span>
          <span style={traceStyles.div}>·</span>
          <span style={idx === TRACE_STEPS.length - 1 ? traceStyles.ok : traceStyles.pend}>
            {idx === TRACE_STEPS.length - 1 ? "● ok" : "● running"}
          </span>
        </div>
      </div>

      {/* Body: timeline + viewer */}
      <div style={traceStyles.body}>
        {/* TIMELINE */}
        <div style={traceStyles.timeline}>
          {TRACE_STEPS.map((s, i) => {
            const past = i < idx, active = i === idx, future = i > idx;
            const accent = s.kind === "gate" ? "var(--atlas-brand)"
                         : s.kind === "input" ? "oklch(0.85 0.18 70)"
                         : s.kind === "result" ? "var(--atlas-brand)"
                         : "oklch(0.78 0.13 280)";
            return (
              <button
                key={i}
                onClick={() => { setPlaying(false); setIdx(i); }}
                style={{
                  ...traceStyles.tlRow,
                  ...(active ? traceStyles.tlActive : {}),
                  opacity: future ? 0.4 : 1,
                  cursor: "pointer",
                }}
              >
                <span style={traceStyles.tlT}>{s.t.toFixed(3)}s</span>
                <span style={{ ...traceStyles.tlK, color: active ? accent : (past ? "oklch(0.871 0 0)" : "oklch(0.443 0 0)") }}>
                  {s.kind === "gate" && <span style={traceStyles.gateNum}>{s.n}</span>}
                  {s.k}
                </span>
                <span style={traceStyles.tlV}>{s.v}</span>
                {past && <span style={traceStyles.tlCheck}>✓</span>}
              </button>
            );
          })}
        </div>

        {/* VIEWER */}
        <div style={traceStyles.viewer}>
          <div style={traceStyles.viewerTabs}>
            <span style={traceStyles.tabActive}>sql</span>
            <span style={traceStyles.tabIn}>plan</span>
            <span style={traceStyles.tabIn}>result</span>
            <span style={traceStyles.tabIn}>raw</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--atlas-brand)", letterSpacing: "0.06em" }}>
              {cur.kind === "gate" ? `gate ${cur.n} of 7` : cur.kind}
            </span>
          </div>

          {/* Step detail strip */}
          <div style={traceStyles.detail}>
            <div style={traceStyles.detailK}>{cur.k}</div>
            <div style={traceStyles.detailV}>{cur.detail || cur.v}</div>
          </div>

          <pre style={traceStyles.code}>
            {sqlNodes.length === 0 ? (
              <span style={traceStyles.cm}>// awaiting compile…</span>
            ) : sqlNodes}
            {sqlReveal < 1 && sqlNodes.length > 0 && <span style={traceStyles.caret}>▌</span>}
          </pre>

          <div style={traceStyles.result}>
            <div style={traceStyles.resHead}>
              <span>account</span><span>arr</span><span>qoq</span>
            </div>
            {resultsVisible === 0 ? (
              <div style={traceStyles.resEmpty}>
                <span style={traceStyles.cm}>// {idx >= TRACE_STEPS.length - 2 ? "executing…" : "awaiting validation"}</span>
              </div>
            ) : (
              RESULT_ROWS.slice(0, resultsVisible).map(([n, a, q], i) => (
                <div key={i} style={traceStyles.resRow}>
                  <span>{n}</span>
                  <span style={{ color: "oklch(0.985 0 0)" }}>{a}</span>
                  <span style={{ color: q.startsWith("−") ? "oklch(0.7 0.16 22)" : "var(--atlas-brand)" }}>{q}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Scrubber */}
      <div style={traceStyles.scrub}>
        <button onClick={onPlay} style={traceStyles.playBtn} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div style={traceStyles.scrubTrack}>
          <div style={{ ...traceStyles.scrubFill, width: `${(idx / (TRACE_STEPS.length - 1)) * 100}%` }} />
          {TRACE_STEPS.map((s, i) => (
            <button
              key={i}
              onClick={() => { setPlaying(false); setIdx(i); }}
              style={{
                ...traceStyles.scrubTick,
                left: `${(i / (TRACE_STEPS.length - 1)) * 100}%`,
                background: i <= idx ? "var(--atlas-brand)" : "oklch(0.32 0 0)",
                transform: i === idx ? "translate(-50%, -50%) scale(1.6)" : "translate(-50%, -50%)",
              }}
              aria-label={`step ${i + 1}: ${s.k}`}
            />
          ))}
        </div>
        <div style={traceStyles.scrubLabel}>
          step {idx + 1}/{TRACE_STEPS.length} · <span style={{ color: "oklch(0.871 0 0)" }}>{cur.k}</span>
        </div>
      </div>
    </div>
  );
};

const traceStyles = {
  frame: {
    border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 12,
    background: "oklch(0.145 0 0)",
    overflow: "hidden",
  },
  head: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 18px",
    background: "oklch(0.18 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)", fontSize: 11.5, color: "oklch(0.708 0 0)",
  },
  headLeft: { display: "flex", alignItems: "center", gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 999, background: "var(--atlas-brand)", boxShadow: "0 0 8px var(--atlas-brand)" },
  title: { color: "oklch(0.871 0 0)" },
  headRight: { display: "flex", alignItems: "center", gap: 10 },
  div: { color: "oklch(0.32 0 0)" },
  ok: { color: "var(--atlas-brand)" },
  pend: { color: "oklch(0.85 0.18 70)" },

  body: { display: "grid", gridTemplateColumns: "440px 1fr", minHeight: 480 },

  timeline: {
    padding: "14px 14px", borderRight: "1px solid oklch(1 0 0 / 0.06)",
    display: "flex", flexDirection: "column", gap: 1,
    background: "oklch(0.16 0 0 / 0.5)",
  },
  tlRow: {
    display: "grid", gridTemplateColumns: "60px 160px 1fr 14px",
    padding: "9px 8px", borderRadius: 5, gap: 8,
    fontFamily: "var(--font-mono)", fontSize: 11, alignItems: "center",
    background: "transparent", border: "none", color: "inherit",
    textAlign: "left", transition: "background 120ms",
  },
  tlActive: {
    background: "color-mix(in oklch, var(--atlas-brand) 10%, transparent)",
    boxShadow: "inset 2px 0 0 var(--atlas-brand)",
  },
  tlT: { color: "oklch(0.443 0 0)", fontVariantNumeric: "tabular-nums" },
  tlK: { fontWeight: 500, display: "flex", alignItems: "center", gap: 6 },
  tlV: { color: "oklch(0.708 0 0)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tlCheck: { color: "var(--atlas-brand)", fontSize: 10 },
  gateNum: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 14, height: 14, borderRadius: 3,
    background: "color-mix(in oklch, var(--atlas-brand) 18%, transparent)",
    color: "var(--atlas-brand)", fontSize: 9, fontWeight: 600,
  },

  viewer: { display: "flex", flexDirection: "column", minWidth: 0 },
  viewerTabs: {
    display: "flex", gap: 16, padding: "10px 22px", alignItems: "center",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    fontFamily: "var(--font-mono)", fontSize: 11,
  },
  tabActive: { color: "var(--atlas-brand)", paddingBottom: 6, marginBottom: -6, borderBottom: "1px solid var(--atlas-brand)", letterSpacing: "0.06em" },
  tabIn: { color: "oklch(0.443 0 0)", letterSpacing: "0.06em" },

  detail: {
    padding: "14px 22px",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    background: "oklch(0.16 0 0 / 0.4)",
  },
  detailK: {
    fontFamily: "var(--font-mono)", fontSize: 11,
    color: "var(--atlas-brand)", letterSpacing: "0.06em",
    marginBottom: 4,
  },
  detailV: { fontSize: 13, lineHeight: 1.55, color: "oklch(0.871 0 0)" },

  code: {
    padding: "16px 22px", margin: 0,
    fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7,
    color: "oklch(0.871 0 0)", whiteSpace: "pre-wrap",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    minHeight: 200,
  },
  cm: { color: "oklch(0.443 0 0)" },
  kw: { color: "var(--atlas-brand)" },
  fn: { color: "oklch(0.78 0.13 280)" },
  num: { color: "oklch(0.85 0.18 70)" },
  str: { color: "oklch(0.78 0.16 50)" },
  caret: { color: "var(--atlas-brand)", animation: "termBlink 1s infinite" },

  result: { padding: "12px 22px 18px" },
  resHead: {
    display: "grid", gridTemplateColumns: "2fr 1fr 1fr",
    padding: "8px 0", borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "oklch(0.443 0 0)",
  },
  resRow: {
    display: "grid", gridTemplateColumns: "2fr 1fr 1fr",
    padding: "8px 0", fontFamily: "var(--font-mono)", fontSize: 12,
    color: "oklch(0.871 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.04)",
  },
  resEmpty: { padding: "16px 0", fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)" },

  scrub: {
    display: "grid", gridTemplateColumns: "auto 1fr 200px",
    alignItems: "center", gap: 16,
    padding: "14px 22px",
    background: "oklch(0.18 0 0)",
    borderTop: "1px solid oklch(1 0 0 / 0.06)",
  },
  playBtn: {
    width: 32, height: 32, borderRadius: 999,
    background: "var(--atlas-brand)", color: "oklch(0.145 0 0)",
    border: "none", cursor: "pointer", fontSize: 11,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontWeight: 700,
  },
  scrubTrack: {
    position: "relative", height: 4, borderRadius: 2,
    background: "oklch(0.25 0 0)",
  },
  scrubFill: {
    position: "absolute", left: 0, top: 0, bottom: 0,
    background: "var(--atlas-brand)", borderRadius: 2,
    transition: "width 200ms ease",
  },
  scrubTick: {
    position: "absolute", top: "50%",
    width: 8, height: 8, borderRadius: 999,
    border: "none", padding: 0, cursor: "pointer",
    transition: "transform 200ms, background 200ms",
  },
  scrubLabel: {
    fontFamily: "var(--font-mono)", fontSize: 11,
    color: "oklch(0.443 0 0)", textAlign: "right",
    letterSpacing: "0.04em",
  },
};

window.ScrubbableTrace = ScrubbableTrace;
