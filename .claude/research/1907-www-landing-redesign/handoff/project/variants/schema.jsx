/* Variant C — Schema Map
 * The page IS a schema diagram. Sections are nodes, connections are wires.
 * Spatial, technical, ambient. The product as the visual.
 */

const SchemaVariant = () => {
  return (
    <div style={smStyles.root}>
      {/* TOP NAV */}
      <nav style={smStyles.nav}>
        <div style={smStyles.navLeft}>
          <SmGlyph />
          <span style={smStyles.brand}>atlas</span>
          <span style={smStyles.tag}>v0.94 · MIT</span>
        </div>
        <div style={smStyles.navMid}>
          <span style={smStyles.navLink}>product</span>
          <span style={smStyles.navLink}>docs</span>
          <span style={smStyles.navLink}>pricing</span>
          <span style={smStyles.navLink}>changelog</span>
        </div>
        <div style={smStyles.navRight}>
          <span style={smStyles.navLink}>github ★ 4.2k</span>
          <span style={smStyles.navLink}>sign in</span>
          <button style={smStyles.cta}>start free trial</button>
        </div>
      </nav>

      {/* HERO MAP — the core canvas */}
      <section style={smStyles.hero}>
        {/* Floating headline overlay */}
        <div style={smStyles.heroHead}>
          <div style={smStyles.eye}>// the schema is the product</div>
          <h1 style={smStyles.h1}>
            Your data has<br />
            <em style={smStyles.h1Em}>structure.</em><br />
            Atlas reads it.
          </h1>
          <p style={smStyles.heroP}>
            ChatGPT writes SQL against an imaginary database. Atlas reads your semantic
            layer, validates 7 ways, and runs read-only against your warehouse.
          </p>
          <div style={smStyles.ctaRow}>
            <button style={smStyles.btnPri}>start 14-day trial →</button>
            <button style={smStyles.btnSec}>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>$ bun create @useatlas</code>
            </button>
          </div>
          <div style={smStyles.dis}>no card · self-host is free, every feature</div>
        </div>

        {/* The map */}
        <SchemaMap />
      </section>

      {/* SCROLLED-INTO-VIEW: STAT STRIP */}
      <section style={smStyles.statStrip}>
        <Stat n="7" l="validation gates" s="every query, every time" />
        <Stat n="0" l="writes by default" s="read-only or pull-request" />
        <Stat n="4" l="warehouses" s="postgres · snowflake · bq · duckdb" />
        <Stat n="<1.5s" l="median latency" s="prompt → rendered table" />
      </section>

      {/* PRIMITIVES — node legend */}
      <section style={smStyles.section}>
        <SecHead eye="// nodes in the system" title="Six primitives." dek="Each one inspectable, each one optional, each one TypeScript. No agent, no orchestration framework, no prompt salad." />

        <div style={smStyles.nodeGrid}>
          <NodeCard
            iconType="entity"
            kind="entity"
            name="semantic_layer"
            title="Semantic layer"
            blurb="Entities, metrics, glossary in YAML. Versioned beside your code. Atlas reads them on every prompt."
            ports={["accounts", "metrics", "glossary"]}
          />
          <NodeCard
            iconType="gate"
            kind="gate"
            name="validators"
            title="7 validators"
            blurb="AST-parsed, permission-checked, row-limited. Read-only by default. Same in dev, same in prod."
            ports={["ast", "perms", "row_limit", "+ 4"]}
          />
          <NodeCard
            iconType="lib"
            kind="lib"
            name="prompt_lib"
            title="Prompt library"
            blurb="Prompts in TypeScript, not strings in a UI. Versioned, shared, rolled back like code."
            ports={["typescript", "git", "diff"]}
          />
          <NodeCard
            iconType="widget"
            kind="widget"
            name="widget"
            title="React widget"
            blurb="Drop-in component. Inherits your tokens, speaks your data. Same widget, any scope."
            ports={["<AtlasChat />", "react", "themable"]}
          />
          <NodeCard
            iconType="db"
            kind="db"
            name="warehouses"
            title="Warehouse-native"
            blurb="One connection spec. On self-host, no data leaves your network. Atlas runs in your VPC."
            ports={["postgres", "snowflake", "bigquery", "duckdb"]}
          />
          <NodeCard
            iconType="audit"
            kind="audit"
            name="audit_log"
            title="Audit-ready"
            blurb="Every query, every result, every operator — logged, searchable, exportable. SSO, SAML, SCIM."
            ports={["sso", "saml", "scim", "csv"]}
          />
        </div>
      </section>

      {/* QUERY TRACE — full-bleed visualization */}
      <section style={smStyles.trace}>
        <div style={smStyles.traceInner}>
          <SecHead eye="// trace one query" title="One question, end to end." dek="Every step is a real artifact you can inspect — same panel the operator sees in the chat UI." />

          <div style={smStyles.traceFrame}>
            {/* Header row */}
            <div style={smStyles.traceHead}>
              <div style={smStyles.traceHeadLeft}>
                <span style={smStyles.traceDot} />
                <span style={smStyles.traceTitle}>session.4f8e · production.analytics</span>
              </div>
              <div style={smStyles.traceHeadRight}>
                <span>1.18s total</span>
                <span style={smStyles.traceDiv}>·</span>
                <span>7 / 7 gates</span>
                <span style={smStyles.traceDiv}>·</span>
                <span style={smStyles.traceOk}>● ok</span>
              </div>
            </div>

            {/* Two columns: timeline + viewer */}
            <div style={smStyles.traceBody}>
              <div style={smStyles.timeline}>
                <TimelineRow t="0.000s" k="prompt" v="Top 5 accounts by ARR this quarter, with QoQ growth." active />
                <TimelineRow t="0.041s" k="resolve" v="accounts, arr, quarter, qoq_growth" />
                <TimelineRow t="0.124s" k="compile" v="78 lines · 1 join · 5 columns" />
                <TimelineRow t="0.142s" k="ast.parse" v="ok · 18ms" />
                <TimelineRow t="0.146s" k="read_only" v="ok · no mutations" />
                <TimelineRow t="0.168s" k="permissions" v="ok · select on accounts, snapshots" />
                <TimelineRow t="0.174s" k="row_limit" v="ok · ≤ 10k" />
                <TimelineRow t="0.205s" k="join_check" v="ok · declared keys" />
                <TimelineRow t="0.217s" k="metric_whitelist" v="ok · arr, qoq_growth" />
                <TimelineRow t="0.306s" k="cost_estimate" v="ok · 0.0021 credits" />
                <TimelineRow t="1.180s" k="execute" v="5 rows · read-only · scoped to analytics" />
              </div>

              <div style={smStyles.viewer}>
                <div style={smStyles.viewerTabs}>
                  <span style={smStyles.tabActive}>sql</span>
                  <span style={smStyles.tabIn}>plan</span>
                  <span style={smStyles.tabIn}>result</span>
                  <span style={smStyles.tabIn}>raw</span>
                </div>
                <pre style={smStyles.viewerCode}>
<span style={smStyles.cm}>{`-- session.4f8e · 7 validations passed`}</span>{`\n`}
<span style={smStyles.cm}>{`-- read-only · scoped to analytics.public`}</span>{`\n\n`}
<span style={smStyles.kw}>SELECT</span>{` a.name,
       a.arr,
       `}<span style={smStyles.fn}>ROUND</span>{`(
         (a.arr - p.arr) / p.arr * `}<span style={smStyles.num}>100</span>{`,
         `}<span style={smStyles.num}>1</span>{`
       ) `}<span style={smStyles.kw}>AS</span>{` qoq_pct
  `}<span style={smStyles.kw}>FROM</span>{` accounts a
  `}<span style={smStyles.kw}>JOIN</span>{` account_snapshots p
    `}<span style={smStyles.kw}>ON</span>{` p.account_id = a.id
   `}<span style={smStyles.kw}>AND</span>{` p.quarter = `}<span style={smStyles.str}>'2026-Q1'</span>{`
 `}<span style={smStyles.kw}>ORDER BY</span>{` a.arr `}<span style={smStyles.kw}>DESC LIMIT</span>{` `}<span style={smStyles.num}>5</span>;
                </pre>
                <div style={smStyles.viewerResult}>
                  <div style={smStyles.viewerResHead}>
                    <span>account</span><span>arr</span><span>qoq</span>
                  </div>
                  {[
                    ["Northwind Trading", "$2.40M", "+18.4%"],
                    ["Gemini Robotics", "$1.92M", "+9.1%"],
                    ["Helios Aerospace", "$1.71M", "+5.8%"],
                    ["Kite & Key Capital", "$1.55M", "+22.7%"],
                    ["Orca Logistics", "$1.41M", "−2.3%"],
                  ].map(([n, a, q], i) => (
                    <div key={i} style={smStyles.viewerResRow}>
                      <span>{n}</span><span style={{ color: "oklch(0.985 0 0)" }}>{a}</span>
                      <span style={{ color: q.startsWith("−") ? "oklch(0.7 0.16 22)" : "var(--atlas-brand)" }}>{q}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* DEPLOY — two side panels */}
      <section style={smStyles.section}>
        <SecHead eye="// deployment topology" title="Cloud, or your VPC." dek="Same Atlas. Same code. Different boundary lines." />

        <div style={smStyles.depGrid}>
          <DeployTopo
            title="self-host"
            subtitle="your VPC · MIT · free"
            blocks={[
              { k: "atlas core", t: "node" },
              { k: "your warehouse", t: "node-db" },
              { k: "your VPC boundary", t: "boundary" },
            ]}
            note="$ bun create @useatlas"
            cta="read the docs →"
            primary={false}
          />
          <DeployTopo
            title="atlas cloud"
            subtitle="hosted · SSO · SLA"
            blocks={[
              { k: "atlas cloud (SOC 2)", t: "node" },
              { k: "your warehouse", t: "node-db" },
              { k: "encrypted, scoped, audited", t: "boundary" },
            ]}
            note="$29 / seat / month"
            cta="start free trial →"
            primary={true}
          />
        </div>
      </section>

      {/* FOOTER */}
      <footer style={smStyles.foot}>
        <div style={smStyles.footRow}>
          <div style={smStyles.footL}>
            <SmGlyph />
            <span style={smStyles.footBrand}>atlas</span>
            <span style={smStyles.footTag}>text-to-sql, that actually runs</span>
          </div>
          <div style={smStyles.footCols}>
            <div>
              <div style={smStyles.footHead}>product</div>
              {["features", "pricing", "changelog", "status"].map(l => <div key={l} style={smStyles.footLink}>{l}</div>)}
            </div>
            <div>
              <div style={smStyles.footHead}>developers</div>
              {["docs", "cli", "react widget", "github"].map(l => <div key={l} style={smStyles.footLink}>{l}</div>)}
            </div>
            <div>
              <div style={smStyles.footHead}>company</div>
              {["blog", "careers", "security", "privacy"].map(l => <div key={l} style={smStyles.footLink}>{l}</div>)}
            </div>
          </div>
        </div>
        <div style={smStyles.footMeta}>
          <span>© 2026 atlas defense corp · sf</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>v0.94.2 · main · a8e20cf</span>
          <span>made by humans, for analysts</span>
        </div>
      </footer>
    </div>
  );
};

/* The hero schema map: a layered SVG of nodes connected by wires */
const SchemaMap = () => {
  const W = 1440, H = 720;
  // Node positions
  const nodes = [
    { id: "prompt", x: 600, y: 560, w: 220, label: "prompt", value: '"top 5 accounts by arr…"', kind: "input" },
    { id: "semantic", x: 620, y: 100, w: 240, label: "semantic_layer.yaml", value: "entities · metrics · glossary", kind: "yaml" },
    { id: "compiler", x: 640, y: 320, w: 200, label: "compiler", value: "AST → SQL", kind: "process" },
    { id: "validators", x: 920, y: 320, w: 200, label: "7 validators", value: "ast · perms · row_limit · …", kind: "gate" },
    { id: "warehouse", x: 1190, y: 200, w: 220, label: "warehouse", value: "postgres / snowflake / bq", kind: "db" },
    { id: "result", x: 1190, y: 460, w: 220, label: "result", value: "rows · read-only", kind: "result" },
    { id: "audit", x: 920, y: 560, w: 200, label: "audit_log", value: "every query · every operator", kind: "audit" },
    { id: "widget", x: 640, y: 460, w: 200, label: "<AtlasChat />", value: "react widget", kind: "widget" },
  ];

  // Recompute halo center based on shifted node positions
  const N = Object.fromEntries(nodes.map(n => [n.id, n]));

  // Edges
  const edges = [
    { from: "prompt", to: "compiler", label: "01" },
    { from: "semantic", to: "compiler", label: "02" },
    { from: "compiler", to: "validators", label: "03" },
    { from: "validators", to: "warehouse", label: "04" },
    { from: "warehouse", to: "result", label: "05" },
    { from: "result", to: "widget", label: "06" },
    { from: "validators", to: "audit", label: "log" },
    { from: "result", to: "audit", label: "log" },
  ];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", display: "block" }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="wire-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--atlas-brand)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--atlas-brand)" stopOpacity="0.2" />
        </linearGradient>
        <pattern id="dot-grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="oklch(1 0 0 / 0.06)" />
        </pattern>
        <radialGradient id="halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--atlas-brand)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--atlas-brand)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* dot grid background */}
      <rect width={W} height={H} fill="url(#dot-grid)" />
      <ellipse cx="980" cy="380" rx="420" ry="300" fill="url(#halo)" />

      {/* edges */}
      {edges.map((e, i) => {
        const a = N[e.from], b = N[e.to];
        const ax = a.x + a.w / 2, ay = a.y + 32;
        const bx = b.x + b.w / 2, by = b.y + 32;
        const midX = (ax + bx) / 2;
        const path = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
        return (
          <g key={i}>
            <path d={path} fill="none" stroke="oklch(1 0 0 / 0.08)" strokeWidth="1" />
            <path d={path} fill="none" stroke="url(#wire-grad)" strokeWidth="1.2" strokeDasharray="2 6">
              <animate attributeName="stroke-dashoffset" from="16" to="0" dur="2s" repeatCount="indefinite" />
            </path>
            {/* edge label */}
            <g transform={`translate(${midX - 14}, ${(ay + by) / 2 - 8})`}>
              <rect width="28" height="16" rx="3" fill="#0C0C10" stroke="oklch(1 0 0 / 0.1)" />
              <text x="14" y="11" textAnchor="middle" fontSize="9" fontFamily="var(--font-mono)" fill="oklch(0.708 0 0)" letterSpacing="0.06em">{e.label}</text>
            </g>
          </g>
        );
      })}

      {/* nodes */}
      {nodes.map(n => <SmNode key={n.id} {...n} />)}
    </svg>
  );
};

const SmNode = ({ x, y, w, label, value, kind }) => {
  const tints = {
    input: "color-mix(in oklch, var(--atlas-brand) 14%, transparent)",
    yaml: "oklch(0.18 0 0)",
    process: "oklch(0.18 0 0)",
    gate: "oklch(0.2 0.04 167)",
    db: "oklch(0.18 0 0)",
    result: "oklch(0.18 0 0)",
    audit: "oklch(0.18 0 0)",
    widget: "oklch(0.18 0 0)",
  };
  const accents = {
    input: "var(--atlas-brand)",
    yaml: "oklch(0.85 0.18 70)",
    process: "oklch(0.78 0.13 280)",
    gate: "var(--atlas-brand)",
    db: "oklch(0.78 0.13 280)",
    result: "var(--atlas-brand)",
    audit: "oklch(0.708 0 0)",
    widget: "oklch(0.85 0.18 70)",
  };
  const acc = accents[kind];
  const bg = tints[kind];
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect
        width={w} height="74" rx="8"
        fill={bg}
        stroke="oklch(1 0 0 / 0.1)"
        strokeWidth="1"
      />
      {/* port indicator */}
      <circle cx="14" cy="32" r="4" fill={acc} />
      <circle cx={w - 14} cy="32" r="4" fill={acc} stroke="#0C0C10" strokeWidth="2" />

      {/* kind badge */}
      <g transform="translate(28, 18)">
        <rect width={String(kind).length * 6.5 + 12} height="14" rx="3" fill="oklch(0 0 0 / 0.4)" stroke="oklch(1 0 0 / 0.08)" />
        <text x="6" y="10" fontSize="9" fontFamily="var(--font-mono)" fill={acc} letterSpacing="0.08em">{kind.toUpperCase()}</text>
      </g>
      <text x="28" y="50" fontSize="14" fontFamily="var(--font-sans)" fill="oklch(0.985 0 0)" fontWeight="600">{label}</text>
      <text x="28" y="65" fontSize="11" fontFamily="var(--font-mono)" fill="oklch(0.556 0 0)">{value}</text>
    </g>
  );
};

const SmGlyph = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--atlas-brand)" strokeWidth="1.8">
    <path d="M12 3L3 20h18L12 3z" />
    <circle cx="12" cy="3" r="1.6" fill="var(--atlas-brand)" />
  </svg>
);

const Stat = ({ n, l, s }) => (
  <div style={smStyles.stat}>
    <div style={smStyles.statN}>{n}</div>
    <div style={smStyles.statL}>{l}</div>
    <div style={smStyles.statS}>{s}</div>
  </div>
);

const SecHead = ({ eye, title, dek }) => (
  <div style={smStyles.secHead}>
    <div style={smStyles.eye}>{eye}</div>
    <h2 style={smStyles.h2}>{title}</h2>
    <p style={smStyles.dek}>{dek}</p>
  </div>
);

const NodeCard = ({ kind, name, title, blurb, ports }) => {
  const accent = {
    entity: "oklch(0.85 0.18 70)",
    gate: "var(--atlas-brand)",
    lib: "oklch(0.78 0.13 280)",
    widget: "oklch(0.85 0.18 70)",
    db: "oklch(0.78 0.13 280)",
    audit: "oklch(0.708 0 0)",
  }[kind] || "var(--atlas-brand)";

  return (
    <div style={smStyles.nodeCard}>
      <div style={smStyles.nodeHead}>
        <span style={{ ...smStyles.kindBadge, color: accent, borderColor: `color-mix(in oklch, ${accent} 30%, transparent)` }}>{kind}</span>
        <span style={smStyles.nodeName}>{name}</span>
        <span style={{ ...smStyles.nodeDot, background: accent }} />
      </div>
      <h3 style={smStyles.nodeTitle}>{title}</h3>
      <p style={smStyles.nodeBlurb}>{blurb}</p>
      <div style={smStyles.nodePorts}>
        {ports.map(p => <span key={p} style={smStyles.port}>{p}</span>)}
      </div>
    </div>
  );
};

const TimelineRow = ({ t, k, v, active }) => (
  <div style={{ ...smStyles.tlRow, ...(active ? smStyles.tlActive : {}) }}>
    <span style={smStyles.tlT}>{t}</span>
    <span style={{ ...smStyles.tlK, color: active ? "var(--atlas-brand)" : "oklch(0.708 0 0)" }}>{k}</span>
    <span style={smStyles.tlV}>{v}</span>
  </div>
);

const DeployTopo = ({ title, subtitle, blocks, note, cta, primary }) => {
  return (
    <div style={{ ...smStyles.depCard, ...(primary ? smStyles.depCardPri : {}) }}>
      <div style={smStyles.depHead}>
        <div>
          <div style={smStyles.depTitle}>{title}</div>
          <div style={smStyles.depSub}>{subtitle}</div>
        </div>
        <div style={smStyles.depPrice}>{note}</div>
      </div>
      <div style={smStyles.depTopo}>
        {blocks.map((b, i) => (
          <div key={i} style={b.t === "boundary" ? smStyles.boundary : (b.t === "node-db" ? smStyles.nodeDb : smStyles.nodeBox)}>
            {b.t === "node-db" && <span style={smStyles.dbIco}>⊟</span>}
            {b.t === "node" && <span style={smStyles.dbIco}>◆</span>}
            {b.t === "boundary" && <span style={smStyles.dbIco}>┄</span>}
            {b.k}
          </div>
        ))}
      </div>
      <button style={primary ? smStyles.depBtnPri : smStyles.depBtn}>{cta}</button>
    </div>
  );
};

const smStyles = {
  root: {
    fontFamily: "var(--font-sans)",
    background: "#0C0C10",
    color: "oklch(0.985 0 0)",
    width: 1440,
  },
  nav: {
    display: "grid", gridTemplateColumns: "1fr auto 1fr",
    padding: "18px 40px", alignItems: "center",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  navLeft: { display: "flex", alignItems: "center", gap: 10 },
  brand: { fontWeight: 600, fontSize: 17 },
  tag: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "oklch(0.443 0 0)", marginLeft: 8, letterSpacing: "0.04em", padding: "2px 6px", border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 4 },
  navMid: { display: "flex", gap: 28, fontSize: 13.5, color: "oklch(0.708 0 0)" },
  navLink: { cursor: "pointer" },
  navRight: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 18, fontSize: 13, color: "oklch(0.708 0 0)" },
  cta: {
    background: "var(--atlas-brand)", color: "oklch(0.145 0 0)",
    border: "none", borderRadius: 8, padding: "8px 14px",
    fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)",
  },

  /* HERO */
  hero: { position: "relative", overflow: "hidden", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  heroHead: {
    position: "absolute", top: 80, left: 80, zIndex: 2,
    maxWidth: 460,
  },
  eye: {
    fontFamily: "var(--font-mono)", fontSize: 11.5,
    letterSpacing: "0.16em", textTransform: "uppercase",
    color: "var(--atlas-brand)", marginBottom: 18,
  },
  h1: {
    fontSize: 64, lineHeight: 1.02, letterSpacing: "-0.035em",
    fontWeight: 600, margin: 0,
  },
  h1Em: { fontStyle: "italic", color: "var(--atlas-brand)", fontWeight: 600 },
  heroP: {
    marginTop: 24, fontSize: 16, lineHeight: 1.6,
    color: "oklch(0.708 0 0)", maxWidth: 420,
  },
  ctaRow: { display: "flex", gap: 10, marginTop: 28, flexWrap: "wrap" },
  btnPri: {
    background: "var(--atlas-brand)", color: "oklch(0.145 0 0)",
    border: "none", borderRadius: 8, padding: "11px 18px",
    fontWeight: 600, fontSize: 13.5, cursor: "pointer", fontFamily: "var(--font-sans)",
  },
  btnSec: {
    background: "oklch(0.18 0 0)", color: "oklch(0.985 0 0)",
    border: "1px solid oklch(1 0 0 / 0.12)",
    borderRadius: 8, padding: "10px 14px", cursor: "pointer",
  },
  dis: {
    marginTop: 14, fontFamily: "var(--font-mono)",
    fontSize: 11, color: "oklch(0.443 0 0)", letterSpacing: "0.04em",
  },

  /* STAT STRIP */
  statStrip: {
    display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    background: "oklch(0.16 0 0)",
  },
  stat: {
    padding: "32px 36px",
    borderRight: "1px solid oklch(1 0 0 / 0.05)",
  },
  statN: {
    fontSize: 48, fontWeight: 600, letterSpacing: "-0.035em",
    color: "var(--atlas-brand)", lineHeight: 1, marginBottom: 8,
    fontFamily: "var(--font-sans)",
  },
  statL: { fontSize: 14, color: "oklch(0.985 0 0)", fontWeight: 500, marginBottom: 4 },
  statS: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },

  /* SECTIONS */
  section: { padding: "88px 64px 72px", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  secHead: { marginBottom: 48, maxWidth: 720 },
  h2: { fontSize: 46, fontWeight: 600, letterSpacing: "-0.03em", margin: "0 0 16px", lineHeight: 1.05 },
  dek: { fontSize: 16, lineHeight: 1.65, color: "oklch(0.708 0 0)", margin: 0 },

  /* NODE GRID */
  nodeGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 },
  nodeCard: {
    border: "1px solid oklch(1 0 0 / 0.08)",
    borderRadius: 10,
    padding: 24,
    background: "oklch(0.18 0 0 / 0.4)",
    position: "relative",
  },
  nodeHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 },
  kindBadge: {
    fontFamily: "var(--font-mono)", fontSize: 9.5,
    letterSpacing: "0.12em", textTransform: "uppercase",
    padding: "3px 7px", border: "1px solid", borderRadius: 4,
  },
  nodeName: { fontFamily: "var(--font-mono)", fontSize: 12, color: "oklch(0.708 0 0)" },
  nodeDot: { width: 8, height: 8, borderRadius: 999, marginLeft: "auto" },
  nodeTitle: { fontSize: 19, fontWeight: 600, margin: "0 0 8px" },
  nodeBlurb: { fontSize: 13.5, lineHeight: 1.6, color: "oklch(0.708 0 0)", margin: "0 0 18px" },
  nodePorts: { display: "flex", flexWrap: "wrap", gap: 6 },
  port: {
    fontFamily: "var(--font-mono)", fontSize: 10.5,
    padding: "3px 8px", border: "1px solid oklch(1 0 0 / 0.08)",
    borderRadius: 4, color: "oklch(0.708 0 0)",
    background: "oklch(0.16 0 0)",
  },

  /* TRACE */
  trace: { padding: "88px 64px 80px", borderBottom: "1px solid oklch(1 0 0 / 0.05)", background: "oklch(0.16 0 0 / 0.4)" },
  traceInner: {},
  traceFrame: {
    border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 12,
    background: "oklch(0.145 0 0)",
    overflow: "hidden",
  },
  traceHead: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 18px",
    background: "oklch(0.18 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)", fontSize: 11.5, color: "oklch(0.708 0 0)",
  },
  traceHeadLeft: { display: "flex", alignItems: "center", gap: 8 },
  traceDot: { width: 8, height: 8, borderRadius: 999, background: "var(--atlas-brand)", boxShadow: "0 0 8px var(--atlas-brand)" },
  traceTitle: { color: "oklch(0.871 0 0)" },
  traceHeadRight: { display: "flex", alignItems: "center", gap: 10 },
  traceDiv: { color: "oklch(0.32 0 0)" },
  traceOk: { color: "var(--atlas-brand)" },
  traceBody: { display: "grid", gridTemplateColumns: "380px 1fr" },

  timeline: {
    padding: "16px 18px", borderRight: "1px solid oklch(1 0 0 / 0.06)",
    display: "flex", flexDirection: "column", gap: 1,
    background: "oklch(0.16 0 0 / 0.5)",
  },
  tlRow: {
    display: "grid", gridTemplateColumns: "60px 110px 1fr",
    padding: "8px 8px", borderRadius: 4, gap: 8,
    fontFamily: "var(--font-mono)", fontSize: 11, alignItems: "baseline",
  },
  tlActive: { background: "color-mix(in oklch, var(--atlas-brand) 8%, transparent)" },
  tlT: { color: "oklch(0.443 0 0)" },
  tlK: { fontWeight: 500 },
  tlV: { color: "oklch(0.871 0 0)", fontSize: 11 },

  viewer: { padding: 0, display: "flex", flexDirection: "column" },
  viewerTabs: {
    display: "flex", gap: 16, padding: "10px 22px",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    fontFamily: "var(--font-mono)", fontSize: 11,
  },
  tabActive: { color: "var(--atlas-brand)", paddingBottom: 6, borderBottom: "1px solid var(--atlas-brand)", letterSpacing: "0.06em" },
  tabIn: { color: "oklch(0.443 0 0)", letterSpacing: "0.06em" },
  viewerCode: {
    padding: "18px 22px", margin: 0,
    fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7,
    color: "oklch(0.871 0 0)", whiteSpace: "pre-wrap",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
  },
  cm: { color: "oklch(0.443 0 0)" },
  kw: { color: "var(--atlas-brand)" },
  fn: { color: "oklch(0.78 0.13 280)" },
  num: { color: "oklch(0.85 0.18 70)" },
  str: { color: "oklch(0.78 0.16 50)" },

  viewerResult: { padding: "12px 22px 18px" },
  viewerResHead: {
    display: "grid", gridTemplateColumns: "2fr 1fr 1fr",
    padding: "8px 0", borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "oklch(0.443 0 0)",
  },
  viewerResRow: {
    display: "grid", gridTemplateColumns: "2fr 1fr 1fr",
    padding: "8px 0", fontFamily: "var(--font-mono)", fontSize: 12,
    color: "oklch(0.871 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.04)",
  },

  /* DEPLOY */
  depGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  depCard: {
    border: "1px solid oklch(1 0 0 / 0.08)",
    borderRadius: 14, padding: 32,
    background: "oklch(0.18 0 0 / 0.35)",
  },
  depCardPri: {
    border: "1px solid color-mix(in oklch, var(--atlas-brand) 38%, transparent)",
    background: "color-mix(in oklch, var(--atlas-brand) 4%, oklch(0.18 0 0 / 0.4))",
  },
  depHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 24 },
  depTitle: { fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" },
  depSub: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.556 0 0)", marginTop: 4, letterSpacing: "0.04em" },
  depPrice: { fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--atlas-brand)" },
  depTopo: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 28 },
  nodeBox: {
    border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8,
    padding: "14px 18px", marginBottom: 8,
    fontFamily: "var(--font-mono)", fontSize: 13,
    color: "oklch(0.985 0 0)",
    background: "oklch(0.16 0 0)",
    display: "flex", alignItems: "center", gap: 10,
  },
  nodeDb: {
    border: "1px dashed oklch(1 0 0 / 0.18)", borderRadius: 8,
    padding: "14px 18px", marginBottom: 8,
    fontFamily: "var(--font-mono)", fontSize: 13,
    color: "oklch(0.871 0 0)",
    background: "oklch(0.18 0 0 / 0.5)",
    display: "flex", alignItems: "center", gap: 10,
  },
  boundary: {
    fontFamily: "var(--font-mono)", fontSize: 10.5,
    letterSpacing: "0.12em", textTransform: "uppercase",
    color: "oklch(0.443 0 0)",
    padding: "8px 4px", textAlign: "center",
    borderTop: "1px dashed oklch(1 0 0 / 0.12)",
    borderBottom: "1px dashed oklch(1 0 0 / 0.12)",
    marginBottom: 8,
  },
  dbIco: { color: "var(--atlas-brand)", fontFamily: "var(--font-mono)", fontSize: 14 },
  depBtn: {
    width: "100%",
    background: "transparent", color: "oklch(0.985 0 0)",
    border: "1px solid oklch(1 0 0 / 0.15)",
    borderRadius: 8, padding: "12px 16px",
    fontWeight: 500, fontSize: 13.5,
    cursor: "pointer", fontFamily: "var(--font-sans)",
  },
  depBtnPri: {
    width: "100%",
    background: "var(--atlas-brand)", color: "oklch(0.145 0 0)",
    border: "none", borderRadius: 8, padding: "12px 16px",
    fontWeight: 600, fontSize: 13.5,
    cursor: "pointer", fontFamily: "var(--font-sans)",
  },

  /* FOOTER */
  foot: { padding: "44px 64px", display: "flex", flexDirection: "column", gap: 32 },
  footRow: { display: "grid", gridTemplateColumns: "1.4fr 2fr", gap: 36 },
  footL: { display: "flex", alignItems: "center", gap: 12 },
  footBrand: { fontSize: 18, fontWeight: 600 },
  footTag: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", marginLeft: 12, letterSpacing: "0.04em" },
  footCols: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 },
  footHead: {
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em",
    textTransform: "uppercase", color: "oklch(0.443 0 0)", marginBottom: 12,
  },
  footLink: { fontSize: 13, color: "oklch(0.708 0 0)", padding: "4px 0" },
  footMeta: {
    paddingTop: 18, borderTop: "1px solid oklch(1 0 0 / 0.05)",
    display: "flex", justifyContent: "space-between",
    fontFamily: "var(--font-mono)", fontSize: 10.5,
    letterSpacing: "0.04em", color: "oklch(0.443 0 0)",
  },
};

window.SchemaVariant = SchemaVariant;
