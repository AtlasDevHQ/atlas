/* Atlas Final Landing — Variant C, polished
 * Sections: nav · hero (schema map) · stats · primitives · scrubbable trace · deploy (self-host vs cloud) · footer
 */

const FinalLanding = () => {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS || {});

  return (
    <div style={fStyles.root}>
      {/* NAV */}
      <nav style={fStyles.nav}>
        <div style={fStyles.navLeft}>
          <FGlyph />
          <span style={fStyles.brand}>atlas</span>
          <span style={fStyles.tag}>v0.94 · MIT</span>
        </div>
        <div style={fStyles.navMid}>
          <span style={fStyles.navLink}>product</span>
          <span style={fStyles.navLink}>docs</span>
          <span style={fStyles.navLink}>pricing</span>
          <span style={fStyles.navLink}>changelog</span>
        </div>
        <div style={fStyles.navRight}>
          <span style={fStyles.navLink}>github ★ 4.2k</span>
          <span style={fStyles.navLink}>sign in</span>
          <button style={fStyles.cta}>{t.ctaLabel}</button>
        </div>
      </nav>

      {/* HERO */}
      <section style={fStyles.hero}>
        <div style={fStyles.heroHead}>
          <div style={fStyles.eye}>// the schema is the product</div>
          <h1 style={fStyles.h1}>
            {t.headline.split("|").map((line, i) => (
              <React.Fragment key={i}>
                {i === 1 ? <em style={fStyles.h1Em}>{line}</em> : line}
                {i < t.headline.split("|").length - 1 && <br />}
              </React.Fragment>
            ))}
          </h1>
          <p style={fStyles.heroP}>{t.subhead}</p>
          <div style={fStyles.ctaRow}>
            <button style={fStyles.btnPri}>{t.ctaLabel} →</button>
            <button style={fStyles.btnSec}>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>$ bun create @useatlas</code>
            </button>
          </div>
          <div style={fStyles.dis}>no card · self-host is free, every feature</div>
        </div>
        <SchemaMap />
      </section>

      {/* PROVOCATIVE STAT */}
      <section style={fStyles.bigStat}>
        <div style={fStyles.bigStatN}>94%</div>
        <div style={fStyles.bigStatBody}>
          <div style={fStyles.bigStatL}>of AI-generated SQL fails at least one Atlas validator.</div>
          <div style={fStyles.bigStatS}>// sample of 12,481 queries · gpt-4o, claude-sonnet, llama-3.1 · against 18 production schemas</div>
        </div>
      </section>

      {/* SCRUBBABLE TRACE — elevated, full-bleed, autoplays on view */}
      <section style={fStyles.trace}>
        <SecHead
          eye="// trace one query"
          title="One question, end to end."
          dek="Watch it run. Click any gate to see what it checks. This is the same panel the operator sees in the chat UI — every step is a real artifact, every gate is the real check."
        />
        <ScrubbableTrace autoplay={true} />
        <div style={fStyles.traceFoot}>
          <span style={fStyles.traceFootK}>// playback</span>
          <span style={fStyles.traceFootV}>autoplays on scroll · click any step or gate to inspect</span>
        </div>
      </section>

      {/* PRIMITIVES — now four */}
      <section style={fStyles.section}>
        <SecHead
          eye="// nodes in the system"
          title="Four primitives."
          dek="Inspectable, optional, TypeScript. No agent, no orchestration framework, no prompt salad."
        />
        <div style={fStyles.nodeGrid4}>
          <NodeCard kind="entity" name="semantic_layer"
            title="Semantic layer"
            blurb="Entities, metrics, glossary in YAML. Versioned beside your code. Atlas reads them on every prompt."
            ports={["accounts", "metrics", "glossary"]} />
          <NodeCard kind="gate" name="validators"
            title="7 validators"
            blurb="AST-parsed, permission-checked, row-limited. Read-only by default. Same in dev, same in prod."
            ports={["ast", "perms", "row_limit", "+ 4"]} />
          <NodeCard kind="db" name="warehouses"
            title="Warehouse-native"
            blurb="One connection spec. On self-host, no data leaves your network. Atlas runs in your VPC."
            ports={["postgres", "snowflake", "bigquery", "duckdb"]} />
          <NodeCard kind="audit" name="audit_log"
            title="Audit-ready"
            blurb="Every query, every result, every operator — logged, searchable, exportable. SSO, SAML, SCIM."
            ports={["sso", "saml", "scim", "csv"]} />
        </div>

        {/* Drop-in strip */}
        <div style={fStyles.dropIn}>
          <div style={fStyles.dropInHead}>// drop-in surfaces</div>
          <div style={fStyles.dropInRow}>
            <div style={fStyles.dropInItem}>
              <div style={fStyles.dropInName}>&lt;AtlasChat /&gt;</div>
              <div style={fStyles.dropInDesc}>React widget. Inherits your tokens, speaks your data.</div>
            </div>
            <div style={fStyles.dropInDiv} />
            <div style={fStyles.dropInItem}>
              <div style={fStyles.dropInName}>prompt_lib.ts</div>
              <div style={fStyles.dropInDesc}>Prompts in TypeScript, not strings in a UI. Diffed, rolled back, code-reviewed.</div>
            </div>
            <div style={fStyles.dropInDiv} />
            <div style={fStyles.dropInItem}>
              <div style={fStyles.dropInName}>$ atlas cli</div>
              <div style={fStyles.dropInDesc}>Run, test, replay queries from terminal or CI.</div>
            </div>
          </div>
        </div>
      </section>

      {/* DEPLOY — two ways to run it */}
      <section style={fStyles.section}>
        <SecHead
          eye="// deployment topology"
          title="Two ways to run it. Same code."
          dek="Cloud, or your VPC. Same Atlas, same primitives, same upgrade path."
        />

        <div style={fStyles.depGrid}>
          {/* SELF-HOST */}
          <div style={fStyles.depCard}>
            <div style={fStyles.depHead}>
              <div>
                <div style={fStyles.depKind}>// self-host</div>
                <div style={fStyles.depTitle}>free</div>
                <div style={fStyles.depSub}>Your infra. Your data.</div>
              </div>
              <div style={fStyles.depPriceL}>$0</div>
            </div>
            <p style={fStyles.depPitch}>
              One command. Bun, Docker, or k8s. MIT-licensed.<br />
              Every feature, no limits.
            </p>

            <div style={fStyles.term}>
              <div style={fStyles.termBar}>
                <span style={fStyles.termDot1} />
                <span style={fStyles.termDot2} />
                <span style={fStyles.termDot3} />
                <span style={fStyles.termTitle}>~/projects — bash</span>
              </div>
              <div style={fStyles.termBody}>
                <div style={fStyles.termLine}>
                  <span style={fStyles.termP}>$</span> bun create <span style={fStyles.termA}>@useatlas</span> my-atlas
                </div>
                <div style={fStyles.termLine}>
                  <span style={fStyles.termP}>$</span> cd my-atlas <span style={fStyles.termP}>&&</span> bun run dev
                </div>
                <div style={fStyles.termLineOut}>
                  <span style={fStyles.termOk}>→</span> atlas booted on :3000
                </div>
                <div style={fStyles.termLineOut}>
                  <span style={fStyles.termOk}>→</span> connected · <span style={fStyles.termA}>postgres://localhost</span>
                </div>
                <div style={fStyles.termLine}>
                  <span style={fStyles.termP}>$</span> <span style={fStyles.termCaret}>▌</span>
                </div>
              </div>
            </div>

            <ul style={fStyles.depList}>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> BYO model key</li>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> No telemetry</li>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> Community Discord</li>
            </ul>

            <button style={fStyles.depBtn}>read the docs →</button>
          </div>

          {/* CLOUD */}
          <div style={{ ...fStyles.depCard, ...fStyles.depCardPri }}>
            <div style={fStyles.depHead}>
              <div>
                <div style={{ ...fStyles.depKind, color: "var(--atlas-brand)" }}>// atlas cloud</div>
                <div style={fStyles.depTitle}>$29 <span style={fStyles.depSeat}>/ seat</span></div>
                <div style={fStyles.depSub}>Hosted. Zero ops.</div>
              </div>
              <div style={fStyles.depBadgePri}>recommended</div>
            </div>
            <p style={fStyles.depPitch}>
              We run it. Weekly updates, monitored connections, SLA.<br />
              Live in 3 minutes.
            </p>

            <div style={fStyles.uptimeCard}>
              <div style={fStyles.uptimeHead}>
                <span style={fStyles.uptimeLbl}>uptime · 90d</span>
                <span style={fStyles.uptimeNum}>99.97%</span>
              </div>
              <div style={fStyles.uptimeBars}>
                {Array.from({ length: 90 }).map((_, i) => {
                  const bad = i === 23 || i === 67;
                  return (
                    <span key={i} style={{
                      ...fStyles.uptimeBar,
                      background: bad ? "oklch(0.65 0.18 50)" : "var(--atlas-brand)",
                      opacity: bad ? 0.9 : (0.6 + (i % 7) * 0.05),
                    }} />
                  );
                })}
              </div>
              <div style={fStyles.uptimeFoot}>
                <span>90 days ago</span>
                <span>today</span>
              </div>
              <div style={fStyles.miniStatsRow}>
                <div style={fStyles.miniStat}>
                  <div style={fStyles.miniStatN}>1.2s</div>
                  <div style={fStyles.miniStatL}>p50 latency</div>
                </div>
                <div style={fStyles.miniStat}>
                  <div style={fStyles.miniStatN}>3.4s</div>
                  <div style={fStyles.miniStatL}>p99 latency</div>
                </div>
                <div style={fStyles.miniStat}>
                  <div style={fStyles.miniStatN}>2.1M</div>
                  <div style={fStyles.miniStatL}>queries / day</div>
                </div>
              </div>
            </div>

            <ul style={fStyles.depList}>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> SSO · SAML · SCIM</li>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> 99.9% uptime SLA</li>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> Audit log export</li>
              <li style={fStyles.depLi}><span style={fStyles.depTick}>✓</span> Priority support</li>
            </ul>

            <button style={fStyles.depBtnPri}>start free trial →</button>
          </div>
        </div>
      </section>

      {/* CTA STRIP */}
      <section style={fStyles.endCta}>
        <div style={fStyles.endCtaInner}>
          <div style={fStyles.eye}>// ship it</div>
          <h2 style={fStyles.endH}>
            Stop reviewing AI-written SQL.<br />
            <em style={fStyles.h1Em}>Start running it.</em>
          </h2>
          <div style={fStyles.ctaRow}>
            <button style={fStyles.btnPri}>{t.ctaLabel} →</button>
            <button style={fStyles.btnSec}>book 15-min demo</button>
          </div>
          <div style={fStyles.dis}>14-day trial · no card · cancel any time</div>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={fStyles.foot}>
        <div style={fStyles.footRow}>
          <div style={fStyles.footL}>
            <FGlyph />
            <span style={fStyles.footBrand}>atlas</span>
            <span style={fStyles.footTag}>text-to-sql, that actually runs</span>
          </div>
          <div style={fStyles.footCols}>
            <div>
              <div style={fStyles.footHead}>product</div>
              {["features", "pricing", "changelog", "status"].map(l => <div key={l} style={fStyles.footLink}>{l}</div>)}
            </div>
            <div>
              <div style={fStyles.footHead}>developers</div>
              {["docs", "cli", "react widget", "github"].map(l => <div key={l} style={fStyles.footLink}>{l}</div>)}
            </div>
            <div>
              <div style={fStyles.footHead}>company</div>
              {["blog", "careers", "security", "privacy"].map(l => <div key={l} style={fStyles.footLink}>{l}</div>)}
            </div>
          </div>
        </div>
        <div style={fStyles.footMeta}>
          <span>© 2026 atlas defense corp · sf</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>v0.94.2 · main · a8e20cf</span>
          <span>made by humans, for data teams</span>
        </div>
      </footer>

      {/* TWEAKS PANEL */}
      <TweaksPanel>
        <TweakSection label="Headline" />
        <TweakSelect label="Headline" value={t.headline}
          options={[
            "Your data has|structure.|Atlas reads it.",
            "ChatGPT writes SQL.|Atlas runs it.|Read-only. Audited.",
            "Text-to-SQL,|that actually|ships.",
            "Stop reviewing|AI-written SQL.|Start running it.",
          ]}
          onChange={v => setTweak("headline", v)} />
        <TweakText label="Subhead" value={t.subhead}
          onChange={v => setTweak("subhead", v)} />
        <TweakSection label="CTA" />
        <TweakRadio label="Primary CTA" value={t.ctaLabel}
          options={["start 14-day trial", "try the demo", "deploy in 3 min"]}
          onChange={v => setTweak("ctaLabel", v)} />
      </TweaksPanel>
    </div>
  );
};

/* ──────── helper components ──────── */

const Stat = ({ n, l, s }) => (
  <div style={fStyles.stat}>
    <div style={fStyles.statN}>{n}</div>
    <div style={fStyles.statL}>{l}</div>
    <div style={fStyles.statS}>{s}</div>
  </div>
);

const SecHead = ({ eye, title, dek }) => (
  <div style={fStyles.secHead}>
    <div style={fStyles.eye}>{eye}</div>
    <h2 style={fStyles.h2}>{title}</h2>
    <p style={fStyles.dek}>{dek}</p>
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
    <div style={fStyles.nodeCard}>
      <div style={fStyles.nodeHead}>
        <span style={{ ...fStyles.kindBadge, color: accent, borderColor: `color-mix(in oklch, ${accent} 30%, transparent)` }}>{kind}</span>
        <span style={fStyles.nodeName}>{name}</span>
        <span style={{ ...fStyles.nodeDot, background: accent }} />
      </div>
      <h3 style={fStyles.nodeTitle}>{title}</h3>
      <p style={fStyles.nodeBlurb}>{blurb}</p>
      <div style={fStyles.nodePorts}>
        {ports.map(p => <span key={p} style={fStyles.port}>{p}</span>)}
      </div>
    </div>
  );
};

const FGlyph = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--atlas-brand)" strokeWidth="1.8">
    <path d="M12 3L3 20h18L12 3z" />
    <circle cx="12" cy="3" r="1.6" fill="var(--atlas-brand)" />
  </svg>
);

/* ──────── hero schema map ──────── */

const SchemaMap = () => {
  const W = 1440, H = 720;
  const [seq, setSeq] = React.useState(0);

  React.useEffect(() => {
    const timers = [];
    [200, 500, 800, 1100, 1400, 1700, 2000, 2300].forEach((ms, i) => {
      timers.push(setTimeout(() => setSeq(s => Math.max(s, i + 1)), ms));
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  const nodes = [
    { id: "prompt", x: 600, y: 560, w: 220, label: "prompt", value: '"top 5 accounts by arr…"', kind: "input" },
    { id: "semantic", x: 620, y: 100, w: 240, label: "semantic_layer.yaml", value: "entities · metrics · glossary", kind: "yaml" },
    { id: "compiler", x: 640, y: 320, w: 200, label: "compiler", value: "AST → SQL", kind: "process" },
    { id: "validators", x: 900, y: 320, w: 240, label: "7 validators", value: "ast · perms · row_limit · …", kind: "gate" },
    { id: "warehouse", x: 1190, y: 200, w: 220, label: "warehouse", value: "postgres / snowflake / bq", kind: "db" },
    { id: "result", x: 1190, y: 460, w: 220, label: "result", value: "rows · read-only", kind: "result" },
    { id: "audit", x: 900, y: 560, w: 240, label: "audit_log", value: "every query · every op", kind: "audit" },
    { id: "widget", x: 640, y: 460, w: 200, label: "<AtlasChat />", value: "react widget", kind: "widget" },
  ];
  const N = Object.fromEntries(nodes.map(n => [n.id, n]));
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
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} preserveAspectRatio="xMidYMid meet">
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
      <rect width={W} height={H} fill="url(#dot-grid)" />
      <ellipse cx="980" cy="380" rx="420" ry="300" fill="url(#halo)" />

      {edges.map((e, i) => {
        const a = N[e.from], b = N[e.to];
        const ax = a.x + a.w / 2, ay = a.y + 32;
        const bx = b.x + b.w / 2, by = b.y + 32;
        const midX = (ax + bx) / 2;
        const path = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
        const lit = i < seq;
        return (
          <g key={i} style={{ opacity: lit ? 1 : 0.25, transition: "opacity 600ms ease" }}>
            <path d={path} fill="none" stroke="oklch(1 0 0 / 0.08)" strokeWidth="1" />
            <path d={path} fill="none"
              stroke={lit ? "url(#wire-grad)" : "oklch(1 0 0 / 0.06)"}
              strokeWidth={lit ? 1.4 : 1}
              strokeDasharray="2 6">
              {lit && <animate attributeName="stroke-dashoffset" from="16" to="0" dur="2s" repeatCount="indefinite" />}
            </path>
            <g transform={`translate(${midX - 14}, ${(ay + by) / 2 - 8})`}>
              <rect width="28" height="16" rx="3" fill="#0C0C10" stroke={lit ? "color-mix(in oklch, var(--atlas-brand) 40%, transparent)" : "oklch(1 0 0 / 0.1)"} />
              <text x="14" y="11" textAnchor="middle" fontSize="9" fontFamily="var(--font-mono)" fill={lit ? "var(--atlas-brand)" : "oklch(0.443 0 0)"} letterSpacing="0.06em">{e.label}</text>
            </g>
          </g>
        );
      })}
      {nodes.map((n, i) => (
        <g key={n.id} style={{ opacity: i < seq + 1 ? 1 : 0.3, transition: "opacity 500ms ease" }}>
          <SmNode {...n} />
        </g>
      ))}
    </svg>
  );
};

const SmNode = ({ x, y, w, label, value, kind }) => {
  const tints = {
    input: "color-mix(in oklch, var(--atlas-brand) 14%, transparent)",
    yaml: "oklch(0.18 0 0)", process: "oklch(0.18 0 0)",
    gate: "oklch(0.2 0.04 167)", db: "oklch(0.18 0 0)",
    result: "oklch(0.18 0 0)", audit: "oklch(0.18 0 0)", widget: "oklch(0.18 0 0)",
  };
  const accents = {
    input: "var(--atlas-brand)", yaml: "oklch(0.85 0.18 70)",
    process: "oklch(0.78 0.13 280)", gate: "var(--atlas-brand)",
    db: "oklch(0.78 0.13 280)", result: "var(--atlas-brand)",
    audit: "oklch(0.708 0 0)", widget: "oklch(0.85 0.18 70)",
  };
  const acc = accents[kind], bg = tints[kind];
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect width={w} height="74" rx="8" fill={bg} stroke="oklch(1 0 0 / 0.1)" strokeWidth="1" />
      <circle cx="14" cy="32" r="4" fill={acc} />
      <circle cx={w - 14} cy="32" r="4" fill={acc} stroke="#0C0C10" strokeWidth="2" />
      <g transform="translate(28, 18)">
        <rect width={String(kind).length * 6.5 + 12} height="14" rx="3" fill="oklch(0 0 0 / 0.4)" stroke="oklch(1 0 0 / 0.08)" />
        <text x="6" y="10" fontSize="9" fontFamily="var(--font-mono)" fill={acc} letterSpacing="0.08em">{kind.toUpperCase()}</text>
      </g>
      <text x="28" y="50" fontSize="14" fontFamily="var(--font-sans)" fill="oklch(0.985 0 0)" fontWeight="600">{label}</text>
      <text x="28" y="65" fontSize="11" fontFamily="var(--font-mono)" fill="oklch(0.556 0 0)">{value}</text>
    </g>
  );
};

/* ──────── styles ──────── */

const fStyles = {
  root: { fontFamily: "var(--font-sans)", background: "#0C0C10", color: "oklch(0.985 0 0)", width: "100%", minWidth: 1280 },

  nav: {
    display: "grid", gridTemplateColumns: "1fr auto 1fr",
    padding: "18px 40px", alignItems: "center",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    position: "sticky", top: 0, zIndex: 10,
    background: "oklch(0.12 0.005 280 / 0.85)", backdropFilter: "blur(12px)",
  },
  navLeft: { display: "flex", alignItems: "center", gap: 10 },
  brand: { fontWeight: 600, fontSize: 17 },
  tag: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "oklch(0.443 0 0)", marginLeft: 8, letterSpacing: "0.04em", padding: "2px 6px", border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 4 },
  navMid: { display: "flex", gap: 28, fontSize: 13.5, color: "oklch(0.708 0 0)" },
  navLink: { cursor: "pointer" },
  navRight: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 18, fontSize: 13, color: "oklch(0.708 0 0)" },
  cta: { background: "var(--atlas-brand)", color: "oklch(0.145 0 0)", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" },

  hero: { position: "relative", overflow: "hidden", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  heroHead: { position: "absolute", top: 80, left: 80, zIndex: 2, maxWidth: 460 },
  eye: { fontFamily: "var(--font-mono)", fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--atlas-brand)", marginBottom: 18 },
  h1: { fontSize: 64, lineHeight: 1.02, letterSpacing: "-0.035em", fontWeight: 600, margin: 0 },
  h1Em: { fontStyle: "italic", color: "var(--atlas-brand)", fontWeight: 600 },
  heroP: { marginTop: 24, fontSize: 16, lineHeight: 1.6, color: "oklch(0.708 0 0)", maxWidth: 420 },
  ctaRow: { display: "flex", gap: 10, marginTop: 28, flexWrap: "wrap" },
  btnPri: { background: "var(--atlas-brand)", color: "oklch(0.145 0 0)", border: "none", borderRadius: 8, padding: "11px 18px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", fontFamily: "var(--font-sans)" },
  btnSec: { background: "oklch(0.18 0 0)", color: "oklch(0.985 0 0)", border: "1px solid oklch(1 0 0 / 0.12)", borderRadius: 8, padding: "10px 14px", cursor: "pointer" },
  dis: { marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },

  bigStat: {
    display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 48,
    padding: "72px 64px",
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    background: "oklch(0.16 0 0)",
  },
  bigStatN: {
    fontSize: 144, fontWeight: 600, letterSpacing: "-0.05em",
    color: "var(--atlas-brand)", lineHeight: 0.9,
    fontFamily: "var(--font-sans)",
  },
  bigStatBody: { maxWidth: 720 },
  bigStatL: { fontSize: 28, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.3, marginBottom: 12, color: "oklch(0.985 0 0)" },
  bigStatS: { fontFamily: "var(--font-mono)", fontSize: 12, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },

  dropIn: {
    marginTop: 32, padding: "24px 28px",
    border: "1px dashed oklch(1 0 0 / 0.1)", borderRadius: 10,
    background: "oklch(0.16 0 0 / 0.5)",
  },
  dropInHead: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--atlas-brand)", letterSpacing: "0.06em", marginBottom: 16 },
  dropInRow: { display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", gap: 24, alignItems: "stretch" },
  dropInItem: { display: "flex", flexDirection: "column", gap: 6 },
  dropInName: { fontFamily: "var(--font-mono)", fontSize: 14, color: "oklch(0.985 0 0)", fontWeight: 500 },
  dropInDesc: { fontSize: 12.5, lineHeight: 1.55, color: "oklch(0.708 0 0)" },
  dropInDiv: { width: 1, background: "oklch(1 0 0 / 0.06)" },

  miniStatsRow: {
    display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12,
    marginTop: 16, paddingTop: 16,
    borderTop: "1px solid oklch(1 0 0 / 0.06)",
  },
  miniStat: {},
  miniStatN: { fontSize: 18, fontWeight: 600, color: "oklch(0.985 0 0)", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
  miniStatL: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", letterSpacing: "0.04em", marginTop: 2 },

  stats: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid oklch(1 0 0 / 0.05)", background: "oklch(0.16 0 0)" },
  stat: { padding: "32px 36px", borderRight: "1px solid oklch(1 0 0 / 0.05)" },
  statN: { fontSize: 48, fontWeight: 600, letterSpacing: "-0.035em", color: "var(--atlas-brand)", lineHeight: 1, marginBottom: 8 },
  statL: { fontSize: 14, color: "oklch(0.985 0 0)", fontWeight: 500, marginBottom: 4 },
  statS: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },

  section: { padding: "88px 64px 72px", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  secHead: { marginBottom: 48, maxWidth: 720 },
  h2: { fontSize: 46, fontWeight: 600, letterSpacing: "-0.03em", margin: "0 0 16px", lineHeight: 1.05 },
  dek: { fontSize: 16, lineHeight: 1.65, color: "oklch(0.708 0 0)", margin: 0 },

  nodeGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 },
  nodeGrid4: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 },
  nodeCard: { border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 10, padding: 24, background: "oklch(0.18 0 0 / 0.4)", position: "relative" },
  nodeHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 },
  kindBadge: { fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", padding: "3px 7px", border: "1px solid", borderRadius: 4 },
  nodeName: { fontFamily: "var(--font-mono)", fontSize: 12, color: "oklch(0.708 0 0)" },
  nodeDot: { width: 8, height: 8, borderRadius: 999, marginLeft: "auto" },
  nodeTitle: { fontSize: 19, fontWeight: 600, margin: "0 0 8px" },
  nodeBlurb: { fontSize: 13.5, lineHeight: 1.6, color: "oklch(0.708 0 0)", margin: "0 0 18px" },
  nodePorts: { display: "flex", flexWrap: "wrap", gap: 6 },
  port: { fontFamily: "var(--font-mono)", fontSize: 10.5, padding: "3px 8px", border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 4, color: "oklch(0.708 0 0)", background: "oklch(0.16 0 0)" },

  trace: { padding: "100px 64px 80px", borderBottom: "1px solid oklch(1 0 0 / 0.05)", background: "oklch(0.10 0 0)" },
  traceFoot: { marginTop: 16, display: "flex", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },
  traceFootK: { color: "var(--atlas-brand)" },
  traceFootV: {},

  /* DEPLOY */
  depGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  depCard: { border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 14, padding: 32, background: "oklch(0.18 0 0 / 0.35)", display: "flex", flexDirection: "column" },
  depCardPri: { border: "1px solid color-mix(in oklch, var(--atlas-brand) 38%, transparent)", background: "color-mix(in oklch, var(--atlas-brand) 4%, oklch(0.18 0 0 / 0.4))" },
  depHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  depKind: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.708 0 0)", letterSpacing: "0.06em", marginBottom: 10 },
  depTitle: { fontSize: 38, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 },
  depSeat: { fontSize: 16, color: "oklch(0.556 0 0)", fontWeight: 400 },
  depSub: { fontSize: 14, color: "oklch(0.871 0 0)", marginTop: 8 },
  depPriceL: { fontSize: 38, fontWeight: 600, color: "oklch(0.443 0 0)", letterSpacing: "-0.03em" },
  depBadgePri: { fontFamily: "var(--font-mono)", fontSize: 10, padding: "4px 8px", border: "1px solid var(--atlas-brand)", color: "var(--atlas-brand)", borderRadius: 999, letterSpacing: "0.08em", textTransform: "uppercase" },
  depPitch: { fontSize: 14, lineHeight: 1.6, color: "oklch(0.708 0 0)", margin: "0 0 22px" },

  term: { border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 8, background: "oklch(0.12 0 0)", overflow: "hidden", marginBottom: 22 },
  termBar: { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid oklch(1 0 0 / 0.06)", background: "oklch(0.16 0 0)" },
  termDot1: { width: 9, height: 9, borderRadius: 999, background: "oklch(0.65 0.18 22)" },
  termDot2: { width: 9, height: 9, borderRadius: 999, background: "oklch(0.78 0.16 70)" },
  termDot3: { width: 9, height: 9, borderRadius: 999, background: "oklch(0.7 0.16 140)" },
  termTitle: { marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)" },
  termBody: { padding: "14px 16px", fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7 },
  termLine: { color: "oklch(0.871 0 0)" },
  termLineOut: { color: "oklch(0.708 0 0)" },
  termP: { color: "oklch(0.443 0 0)", marginRight: 6 },
  termA: { color: "var(--atlas-brand)" },
  termOk: { color: "var(--atlas-brand)", marginRight: 6 },
  termCaret: { animation: "termBlink 1s infinite", color: "var(--atlas-brand)" },

  uptimeCard: { border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 8, padding: "16px 18px", background: "oklch(0.16 0 0)", marginBottom: 22 },
  uptimeHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 },
  uptimeLbl: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },
  uptimeNum: { fontSize: 22, fontWeight: 600, color: "var(--atlas-brand)", letterSpacing: "-0.02em" },
  uptimeBars: { display: "grid", gridTemplateColumns: "repeat(90, 1fr)", gap: 1.5, height: 32, marginBottom: 8 },
  uptimeBar: { borderRadius: 1, height: "100%" },
  uptimeFoot: { display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)" },

  depList: { listStyle: "none", padding: 0, margin: "0 0 24px", display: "flex", flexDirection: "column", gap: 8 },
  depLi: { fontSize: 13.5, color: "oklch(0.871 0 0)", display: "flex", alignItems: "center", gap: 10 },
  depTick: { color: "var(--atlas-brand)", fontFamily: "var(--font-mono)", fontSize: 12 },
  depBtn: { width: "100%", marginTop: "auto", background: "transparent", color: "oklch(0.985 0 0)", border: "1px solid oklch(1 0 0 / 0.15)", borderRadius: 8, padding: "12px 16px", fontWeight: 500, fontSize: 13.5, cursor: "pointer", fontFamily: "var(--font-sans)" },
  depBtnPri: { width: "100%", marginTop: "auto", background: "var(--atlas-brand)", color: "oklch(0.145 0 0)", border: "none", borderRadius: 8, padding: "12px 16px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", fontFamily: "var(--font-sans)" },

  endCta: { padding: "140px 64px", borderBottom: "1px solid oklch(1 0 0 / 0.05)", background: "radial-gradient(ellipse at 50% 60%, color-mix(in oklch, var(--atlas-brand) 14%, transparent), transparent 55%), linear-gradient(to bottom, transparent, oklch(0.10 0 0))", position: "relative", overflow: "hidden" },
  endCtaInner: { maxWidth: 720, margin: "0 auto", textAlign: "center" },
  endH: { fontSize: 56, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.05, margin: "16px 0 32px" },

  foot: { padding: "44px 64px", display: "flex", flexDirection: "column", gap: 32 },
  footRow: { display: "grid", gridTemplateColumns: "1.4fr 2fr", gap: 36 },
  footL: { display: "flex", alignItems: "center", gap: 12 },
  footBrand: { fontSize: 18, fontWeight: 600 },
  footTag: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", marginLeft: 12, letterSpacing: "0.04em" },
  footCols: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 },
  footHead: { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "oklch(0.443 0 0)", marginBottom: 12 },
  footLink: { fontSize: 13, color: "oklch(0.708 0 0)", padding: "4px 0" },
  footMeta: { paddingTop: 18, borderTop: "1px solid oklch(1 0 0 / 0.05)", display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.04em", color: "oklch(0.443 0 0)" },
};

window.FinalLanding = FinalLanding;
