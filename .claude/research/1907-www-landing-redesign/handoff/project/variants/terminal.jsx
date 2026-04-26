/* Variant A — Terminal / IDE
 * Asymmetric three-column "editor" layout. Anti-marketing-page.
 * The page IS the product: file tree, code, results panel.
 */

const TerminalVariant = () => {
  return (
    <div style={termStyles.root}>
      {/* TOP STATUS BAR */}
      <div style={termStyles.statusBar}>
        <div style={termStyles.statusLeft}>
          <AtlasMark size={16} />
          <span style={termStyles.brand}>atlas</span>
          <span style={termStyles.path}>/ www.useatlas.dev</span>
        </div>
        <div style={termStyles.statusCenter}>
          <span style={termStyles.tab}>landing.atlas</span>
          <span style={termStyles.tabInactive}>pricing.atlas</span>
          <span style={termStyles.tabInactive}>docs.atlas</span>
        </div>
        <div style={termStyles.statusRight}>
          <span style={termStyles.dot} />
          <span style={termStyles.statusText}>connected · production</span>
          <span style={termStyles.kbd}>⌘K</span>
        </div>
      </div>

      {/* MAIN BODY: rail + canvas + inspector */}
      <div style={termStyles.body}>
        {/* LEFT RAIL — file tree */}
        <aside style={termStyles.rail}>
          <div style={termStyles.railSection}>EXPLORER</div>
          <TreeNode label="atlas/" expanded>
            <TreeNode label="hero" file active />
            <TreeNode label="proof" file />
            <TreeNode label="primitives" file />
            <TreeNode label="how_it_works" file />
            <TreeNode label="deploy" file />
            <TreeNode label="pricing" file />
          </TreeNode>
          <TreeNode label="semantic_layer/" expanded>
            <TreeNode label="entities.yaml" file mono />
            <TreeNode label="metrics.yaml" file mono />
            <TreeNode label="glossary.yaml" file mono />
          </TreeNode>
          <TreeNode label="validators/">
            <TreeNode label="ast_check.ts" file mono />
            <TreeNode label="permissions.ts" file mono />
            <TreeNode label="row_limit.ts" file mono />
          </TreeNode>

          <div style={{ ...termStyles.railSection, marginTop: 32 }}>OUTLINE</div>
          <OutlineLink num="01" label="Quit copying SQL" />
          <OutlineLink num="02" label="What it is" />
          <OutlineLink num="03" label="Six primitives" />
          <OutlineLink num="04" label="The validation pipeline" />
          <OutlineLink num="05" label="Cloud or self-host" />
          <OutlineLink num="06" label="Pricing" />

          <div style={termStyles.railFooter}>
            <div style={termStyles.railFooterRow}>
              <span style={termStyles.kbdSm}>⌘</span>
              <span style={termStyles.kbdSm}>K</span>
              <span style={termStyles.railFooterLabel}>command palette</span>
            </div>
            <div style={termStyles.railFooterRow}>
              <span style={termStyles.kbdSm}>g</span>
              <span style={termStyles.kbdSm}>d</span>
              <span style={termStyles.railFooterLabel}>read the docs</span>
            </div>
          </div>
        </aside>

        {/* CENTER — main canvas */}
        <main style={termStyles.canvas}>
          {/* HERO */}
          <section style={termStyles.hero}>
            <div style={termStyles.heroMeta}>
              <span style={termStyles.heroMetaItem}>// hero.atlas</span>
              <span style={termStyles.heroMetaItem}>L1</span>
              <span style={termStyles.heroMetaItem}>v0.94.2</span>
            </div>
            <h1 style={termStyles.h1}>
              <span style={termStyles.lineNo}>01</span>
              The data analyst<br />
              <span style={termStyles.lineNo}>02</span>
              <span style={termStyles.dim}>that knows your</span> schema<span style={termStyles.cursor}>_</span>
            </h1>

            <div style={termStyles.heroBelow}>
              <div style={termStyles.heroLede}>
                <p style={termStyles.ledeText}>
                  ChatGPT writes SQL against an imaginary database. <strong style={termStyles.strong}>Atlas</strong> reads
                  your semantic layer, validates every statement through 7 layers, and runs read-only against your warehouse.
                </p>
                <div style={termStyles.ctaRow}>
                  <button style={termStyles.btnPrimary}>
                    <span style={termStyles.btnPrompt}>$</span>
                    bun create @useatlas
                    <span style={termStyles.copy}>copy</span>
                  </button>
                  <button style={termStyles.btnGhost}>book a demo →</button>
                </div>
                <div style={termStyles.disclaimer}>
                  MIT-licensed · self-host is free, every feature, no limits
                </div>
              </div>

              <div style={termStyles.heroSpec}>
                <SpecRow k="version" v="0.94.2" />
                <SpecRow k="runtime" v="Bun · Node · Deno" />
                <SpecRow k="warehouses" v="Postgres · Snowflake · BigQuery · DuckDB" />
                <SpecRow k="models" v="Claude · GPT · Gemini · Llama (BYO)" />
                <SpecRow k="license" v="MIT" />
                <SpecRow k="latest_commit" v="a8e20cf · 2h ago" last />
              </div>
            </div>
          </section>

          {/* PIPELINE — the live demo */}
          <section style={termStyles.pipeline}>
            <SectionHead num="02" name="// pipeline.atlas" title="Watch one query travel through the system." />

            <div style={termStyles.pipeFrame}>
              {/* INPUT */}
              <div style={termStyles.pipeStage}>
                <PipeLabel idx="01" name="prompt" />
                <div style={termStyles.userBubble}>
                  Top 5 accounts by ARR this quarter, with QoQ growth.
                </div>
              </div>

              {/* RESOLVE */}
              <div style={termStyles.pipeStage}>
                <PipeLabel idx="02" name="resolve / semantic" />
                <div style={termStyles.resolveGrid}>
                  <Chip label="accounts" type="entity" />
                  <Chip label="arr" type="metric" />
                  <Chip label="quarter" type="dimension" />
                  <Chip label="qoq_growth" type="metric" />
                </div>
                <div style={termStyles.resolveNote}>
                  4 references resolved against entities.yaml · 0 hallucinations
                </div>
              </div>

              {/* COMPILE */}
              <div style={termStyles.pipeStage}>
                <PipeLabel idx="03" name="compile" />
                <pre style={termStyles.codeBlock}>
<span style={termStyles.cm}>{`-- 7 validations · read-only · scoped to analytics`}</span>{`\n`}
<span style={termStyles.kw}>SELECT</span>{` a.name,
       a.arr,
       `}<span style={termStyles.fn}>ROUND</span>{`((a.arr - prev.arr) / prev.arr * `}<span style={termStyles.num}>100</span>{`, `}<span style={termStyles.num}>1</span>{`) `}<span style={termStyles.kw}>AS</span>{` qoq_pct
  `}<span style={termStyles.kw}>FROM</span>{` accounts a
  `}<span style={termStyles.kw}>JOIN</span>{` account_snapshots prev
    `}<span style={termStyles.kw}>ON</span>{` prev.account_id = a.id
   `}<span style={termStyles.kw}>AND</span>{` prev.quarter = `}<span style={termStyles.str}>'2026-Q1'</span>{`
 `}<span style={termStyles.kw}>ORDER BY</span>{` a.arr `}<span style={termStyles.kw}>DESC LIMIT</span>{` `}<span style={termStyles.num}>5</span>{`;`}
                </pre>
              </div>

              {/* VALIDATE */}
              <div style={termStyles.pipeStage}>
                <PipeLabel idx="04" name="validate" />
                <div style={termStyles.gates}>
                  <Gate label="AST parse" pass />
                  <Gate label="read-only check" pass />
                  <Gate label="row limit ≤ 10k" pass />
                  <Gate label="permissions / RLS" pass />
                  <Gate label="join cardinality" pass />
                  <Gate label="metric whitelist" pass />
                  <Gate label="cost estimate" pass />
                </div>
              </div>

              {/* RUN */}
              <div style={termStyles.pipeStage}>
                <PipeLabel idx="05" name="run · read-only" />
                <div style={termStyles.resultTable}>
                  <div style={termStyles.tableHead}>
                    <span>account</span><span>arr</span><span>qoq</span>
                  </div>
                  {[
                    ["Northwind Trading", "$2.40M", "+18.4%", "up"],
                    ["Gemini Robotics", "$1.92M", "+9.1%", "up"],
                    ["Helios Aerospace", "$1.71M", "+5.8%", "up"],
                    ["Kite & Key Capital", "$1.55M", "+22.7%", "up"],
                    ["Orca Logistics", "$1.41M", "−2.3%", "down"],
                  ].map(([n, a, q, dir], i) => (
                    <div key={i} style={termStyles.tableRow}>
                      <span style={termStyles.tName}>{n}</span>
                      <span style={termStyles.tNum}>{a}</span>
                      <span style={dir === "up" ? termStyles.tUp : termStyles.tDown}>{q}</span>
                    </div>
                  ))}
                </div>
                <div style={termStyles.runFoot}>
                  <span>1.2s · 5 rows · 7 validations passed</span>
                  <span style={termStyles.runFootRight}>view query plan →</span>
                </div>
              </div>
            </div>
          </section>

          {/* PRIMITIVES */}
          <section style={termStyles.primitives}>
            <SectionHead num="03" name="// primitives.atlas" title="Six load-bearing pieces. Nothing else." />

            <div style={termStyles.primGrid}>
              <Primitive
                idx="01"
                name="semantic_layer"
                title="Semantic layer"
                blurb="Entities, metrics, glossary in YAML. Versioned in your repo."
                code={`entity: accounts\nprimary_key: id\nmetrics:\n  - arr\n  - mrr`}
              />
              <Primitive
                idx="02"
                name="validators"
                title="7 validation layers"
                blurb="AST-parsed, permission-checked, row-limited. Read-only by default."
                code={`✓ ast.parse\n✓ permissions\n✓ row_limit\n✓ + 4 more`}
              />
              <Primitive
                idx="03"
                name="prompt_lib"
                title="Prompt library"
                blurb="Versioned prompts. Shared across the team. TypeScript, not strings."
                code={`export const \nweeklyDigest = \n  prompt\`...\``}
              />
              <Primitive
                idx="04"
                name="widget"
                title="React widget"
                blurb="Drop into your app. Inherits your theme. Speaks your data."
                code={`<AtlasChat\n  workspace="acme"\n/>`}
              />
              <Primitive
                idx="05"
                name="warehouses"
                title="Warehouse-native"
                blurb="Postgres, Snowflake, BigQuery, DuckDB. One spec. No ETL."
                code={`db.connect({\n  type: "postgres",\n  ssl: "require"\n})`}
              />
              <Primitive
                idx="06"
                name="audit"
                title="Audit log"
                blurb="Every query, every result, every user. SSO, RBAC, exportable."
                code={`atlas audit\n  --since=24h\n  --export=csv`}
              />
            </div>
          </section>

          {/* DEPLOY */}
          <section style={termStyles.deploy}>
            <SectionHead num="04" name="// deploy.atlas" title="Two ways to run it. Same code." />

            <div style={termStyles.deployGrid}>
              <div style={termStyles.deployCol}>
                <div style={termStyles.deployHead}>
                  <span style={termStyles.deployTag}>// self-host</span>
                  <span style={termStyles.deployPrice}>free</span>
                </div>
                <h3 style={termStyles.deployH}>Your infra. Your data.</h3>
                <p style={termStyles.deployP}>
                  One command. Bun, Docker, or k8s. MIT-licensed. Every feature, no limits.
                </p>
                <pre style={termStyles.deployCode}>
<span style={termStyles.cm}>$</span> bun create @useatlas my-atlas{`\n`}
<span style={termStyles.cm}>$</span> cd my-atlas && bun run dev{`\n\n`}
<span style={termStyles.cm}>→</span> atlas booted on :3000{`\n`}
<span style={termStyles.cm}>→</span> connected · postgres://localhost
                </pre>
                <ul style={termStyles.deployList}>
                  <li>BYO model key</li>
                  <li>No telemetry</li>
                  <li>Community Discord</li>
                </ul>
              </div>

              <div style={{ ...termStyles.deployCol, ...termStyles.deployColFeat }}>
                <div style={termStyles.deployHead}>
                  <span style={{ ...termStyles.deployTag, color: "var(--atlas-brand)" }}>// atlas cloud</span>
                  <span style={termStyles.deployPrice}>$29 / seat</span>
                </div>
                <h3 style={termStyles.deployH}>Hosted. Zero ops.</h3>
                <p style={termStyles.deployP}>
                  We run it. Weekly updates, monitored connections, SLA. Live in 3 minutes.
                </p>
                <div style={termStyles.cloudUptime}>
                  <div style={termStyles.uptimeRow}>
                    <span style={termStyles.uptimeLabel}>uptime · 90d</span>
                    <span style={termStyles.uptimeNum}>99.97%</span>
                  </div>
                  <div style={termStyles.uptimeBars}>
                    {Array.from({ length: 90 }).map((_, i) => (
                      <span
                        key={i}
                        style={{
                          ...termStyles.uptimeBar,
                          background: i === 71 ? "oklch(0.7 0.18 70)" : "var(--atlas-brand)",
                          opacity: i === 71 ? 0.6 : (0.35 + (i / 90) * 0.5),
                        }}
                      />
                    ))}
                  </div>
                </div>
                <ul style={termStyles.deployList}>
                  <li>SSO · SAML · SCIM</li>
                  <li>99.9% uptime SLA</li>
                  <li>Audit log export</li>
                  <li>Priority support</li>
                </ul>
              </div>
            </div>
          </section>

          {/* FOOTER */}
          <footer style={termStyles.foot}>
            <div style={termStyles.footRow}>
              <div style={termStyles.footBrand}>
                <AtlasMark size={14} /> atlas
                <span style={termStyles.footTag}>text-to-sql, that actually runs</span>
              </div>
              <div style={termStyles.footCols}>
                <FootCol head="product" links={["features", "pricing", "changelog", "status"]} />
                <FootCol head="developers" links={["docs", "cli", "react widget", "github"]} />
                <FootCol head="company" links={["blog", "careers", "security", "privacy"]} />
              </div>
            </div>
            <div style={termStyles.footMeta}>
              <span>© 2026 Atlas Defense Corp</span>
              <span>v0.94.2 · main · a8e20cf</span>
              <span>made by humans, in San Francisco</span>
            </div>
          </footer>
        </main>

        {/* RIGHT — inspector */}
        <aside style={termStyles.inspector}>
          <div style={termStyles.inspHead}>INSPECTOR</div>

          <div style={termStyles.inspBlock}>
            <div style={termStyles.inspKey}>section</div>
            <div style={termStyles.inspVal}>hero</div>
          </div>
          <div style={termStyles.inspBlock}>
            <div style={termStyles.inspKey}>type</div>
            <div style={termStyles.inspVal}>display / cta</div>
          </div>
          <div style={termStyles.inspBlock}>
            <div style={termStyles.inspKey}>copy.headline</div>
            <div style={termStyles.inspValMono}>"The data analyst that knows your schema"</div>
          </div>

          <div style={termStyles.inspDivider} />

          <div style={termStyles.inspHead}>VITALS</div>
          <Vital label="dau" value="12,847" delta="+4.2%" />
          <Vital label="queries / day" value="184k" delta="+11%" />
          <Vital label="median latency" value="1.18s" delta="−0.04s" />
          <Vital label="validation pass" value="99.94%" delta="+0.01%" />
          <Vital label="cloud uptime" value="99.97%" delta="" />

          <div style={termStyles.inspDivider} />

          <div style={termStyles.inspHead}>RECENT QUERIES</div>
          <RecentQuery time="0.4s" txt="weekly active users by plan" />
          <RecentQuery time="0.9s" txt="payments stuck in pending > 1h" />
          <RecentQuery time="2.1s" txt="revenue by acquisition source, 30d" />
          <RecentQuery time="1.2s" txt="top customers by support volume" />
          <RecentQuery time="0.7s" txt="cohort retention, signup month" />

          <div style={termStyles.inspDivider} />

          <div style={termStyles.inspHead}>BUILT FOR</div>
          <div style={termStyles.builtRow}>data engineers</div>
          <div style={termStyles.builtRow}>analytics engineers</div>
          <div style={termStyles.builtRow}>founders / DRIs</div>
          <div style={termStyles.builtRow}>embedding teams</div>

          <div style={termStyles.inspFloor}>
            <button style={termStyles.inspCta}>start free trial →</button>
            <div style={termStyles.inspCtaSub}>14 days · no card</div>
          </div>
        </aside>
      </div>
    </div>
  );
};

/* — sub-components — */
const AtlasMark = ({ size = 18, color = "var(--atlas-brand)" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8">
    <path d="M12 3L3 20h18L12 3z" />
    <circle cx="12" cy="3" r="1.6" fill={color} />
  </svg>
);

const TreeNode = ({ label, expanded, file, mono, active, children }) => (
  <div style={termStyles.tree}>
    <div style={{
      ...termStyles.treeRow,
      ...(active ? termStyles.treeRowActive : {}),
      fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
      fontSize: mono ? 11 : 12,
    }}>
      <span style={termStyles.treeIcon}>
        {file ? "·" : (expanded ? "▾" : "▸")}
      </span>
      {label}
    </div>
    {children && expanded && <div style={termStyles.treeChildren}>{children}</div>}
  </div>
);

const OutlineLink = ({ num, label }) => (
  <div style={termStyles.outlineRow}>
    <span style={termStyles.outlineNum}>{num}</span>
    <span style={termStyles.outlineLbl}>{label}</span>
  </div>
);

const SpecRow = ({ k, v, last }) => (
  <div style={{ ...termStyles.specRow, ...(last ? { borderBottom: "none" } : {}) }}>
    <span style={termStyles.specK}>{k}</span>
    <span style={termStyles.specV}>{v}</span>
  </div>
);

const SectionHead = ({ num, name, title }) => (
  <div style={termStyles.secHead}>
    <div style={termStyles.secMeta}>
      <span style={termStyles.secNum}>{num}</span>
      <span style={termStyles.secName}>{name}</span>
    </div>
    <h2 style={termStyles.h2}>{title}</h2>
  </div>
);

const PipeLabel = ({ idx, name }) => (
  <div style={termStyles.pipeLabel}>
    <span style={termStyles.pipeIdx}>{idx}</span>
    <span style={termStyles.pipeName}>{name}</span>
    <span style={termStyles.pipeLine} />
  </div>
);

const Chip = ({ label, type }) => {
  const colors = {
    entity: { bg: "color-mix(in oklch, var(--atlas-brand) 14%, transparent)", color: "var(--atlas-brand)", border: "color-mix(in oklch, var(--atlas-brand) 30%, transparent)" },
    metric: { bg: "oklch(1 0 0 / 0.04)", color: "oklch(0.85 0.18 70)", border: "oklch(0.85 0.18 70 / 0.3)" },
    dimension: { bg: "oklch(1 0 0 / 0.04)", color: "oklch(0.78 0 0)", border: "oklch(1 0 0 / 0.12)" },
  };
  const c = colors[type];
  return (
    <span style={{ ...termStyles.chip, background: c.bg, color: c.color, borderColor: c.border }}>
      <span style={termStyles.chipType}>{type}</span>
      <span style={termStyles.chipDot}>·</span>
      <span>{label}</span>
    </span>
  );
};

const Gate = ({ label, pass }) => (
  <div style={termStyles.gate}>
    <span style={pass ? termStyles.gateOk : termStyles.gateFail}>
      {pass ? "✓" : "✗"}
    </span>
    <span style={termStyles.gateLabel}>{label}</span>
    <span style={termStyles.gateMs}>{Math.floor(Math.random() * 80 + 20)}ms</span>
  </div>
);

const Primitive = ({ idx, name, title, blurb, code }) => (
  <div style={termStyles.prim}>
    <div style={termStyles.primHead}>
      <span style={termStyles.primIdx}>{idx}</span>
      <span style={termStyles.primName}>{name}</span>
    </div>
    <h3 style={termStyles.primTitle}>{title}</h3>
    <p style={termStyles.primBlurb}>{blurb}</p>
    <pre style={termStyles.primCode}>{code}</pre>
  </div>
);

const FootCol = ({ head, links }) => (
  <div>
    <div style={termStyles.footHead}>{head}</div>
    {links.map(l => <div key={l} style={termStyles.footLink}>{l}</div>)}
  </div>
);

const Vital = ({ label, value, delta }) => (
  <div style={termStyles.vital}>
    <div style={termStyles.vitalLabel}>{label}</div>
    <div style={termStyles.vitalRow}>
      <span style={termStyles.vitalValue}>{value}</span>
      {delta && <span style={termStyles.vitalDelta}>{delta}</span>}
    </div>
  </div>
);

const RecentQuery = ({ time, txt }) => (
  <div style={termStyles.recent}>
    <span style={termStyles.recentTime}>{time}</span>
    <span style={termStyles.recentTxt}>{txt}</span>
  </div>
);

/* — styles — */
const termStyles = {
  root: {
    fontFamily: "var(--font-sans)",
    background: "#0C0C10",
    color: "oklch(0.985 0 0)",
    minHeight: "100%",
    width: 1440,
    display: "flex",
    flexDirection: "column",
  },
  statusBar: {
    height: 36,
    background: "oklch(0.18 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    padding: "0 16px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "oklch(0.556 0 0)",
  },
  statusLeft: { display: "flex", alignItems: "center", gap: 8 },
  brand: { color: "oklch(0.985 0 0)", fontWeight: 600 },
  path: { color: "oklch(0.443 0 0)" },
  statusCenter: { display: "flex", gap: 4 },
  tab: {
    padding: "4px 12px",
    background: "#0C0C10",
    border: "1px solid oklch(1 0 0 / 0.08)",
    borderBottom: "1px solid #0C0C10",
    color: "oklch(0.871 0 0)",
    borderRadius: "6px 6px 0 0",
    marginBottom: -1,
  },
  tabInactive: {
    padding: "4px 12px",
    color: "oklch(0.443 0 0)",
  },
  statusRight: { display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" },
  dot: { width: 6, height: 6, borderRadius: 999, background: "var(--atlas-brand)", boxShadow: "0 0 8px var(--atlas-brand)" },
  statusText: { color: "var(--atlas-brand)" },
  kbd: {
    padding: "2px 6px",
    border: "1px solid oklch(1 0 0 / 0.12)",
    borderRadius: 4,
    fontSize: 10,
    color: "oklch(0.708 0 0)",
  },
  body: {
    display: "grid",
    gridTemplateColumns: "236px 1fr 280px",
    flex: 1,
    minHeight: 0,
  },

  /* RAIL */
  rail: {
    background: "oklch(0.165 0 0)",
    borderRight: "1px solid oklch(1 0 0 / 0.06)",
    padding: "20px 14px",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    color: "oklch(0.708 0 0)",
  },
  railSection: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.14em",
    color: "oklch(0.443 0 0)",
    textTransform: "uppercase",
    marginBottom: 8,
    paddingLeft: 6,
  },
  tree: { marginBottom: 1 },
  treeRow: {
    padding: "4px 6px",
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "oklch(0.708 0 0)",
    cursor: "default",
    borderRadius: 4,
  },
  treeRowActive: {
    background: "color-mix(in oklch, var(--atlas-brand) 12%, transparent)",
    color: "var(--atlas-brand)",
  },
  treeIcon: { width: 10, color: "oklch(0.443 0 0)", fontSize: 10 },
  treeChildren: { paddingLeft: 14 },
  outlineRow: {
    padding: "4px 6px",
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12,
    color: "oklch(0.708 0 0)",
  },
  outlineNum: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", width: 18 },
  outlineLbl: {},
  railFooter: { marginTop: 32, paddingTop: 16, borderTop: "1px solid oklch(1 0 0 / 0.05)", display: "flex", flexDirection: "column", gap: 6 },
  railFooterRow: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "oklch(0.443 0 0)" },
  kbdSm: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    padding: "1px 5px",
    border: "1px solid oklch(1 0 0 / 0.1)",
    borderRadius: 3,
    color: "oklch(0.708 0 0)",
  },
  railFooterLabel: { marginLeft: 6 },

  /* CANVAS */
  canvas: { padding: "0", overflow: "hidden" },

  /* HERO */
  hero: { padding: "56px 72px 72px", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  heroMeta: { display: "flex", gap: 16, fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", marginBottom: 32 },
  heroMetaItem: {},
  h1: {
    fontSize: 68,
    lineHeight: 1.06,
    letterSpacing: "-0.035em",
    fontWeight: 600,
    margin: 0,
    color: "oklch(0.985 0 0)",
  },
  lineNo: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "oklch(0.32 0 0)",
    marginRight: 22,
    letterSpacing: 0,
    verticalAlign: "middle",
    fontWeight: 400,
  },
  dim: { color: "oklch(0.443 0 0)" },
  cursor: { color: "var(--atlas-brand)", animation: "termBlink 1s step-end infinite", fontWeight: 400 },
  heroBelow: {
    marginTop: 48,
    display: "grid",
    gridTemplateColumns: "1.6fr 1fr",
    gap: 56,
    alignItems: "start",
  },
  heroLede: { paddingLeft: 60 },
  ledeText: { fontSize: 17, lineHeight: 1.6, color: "oklch(0.708 0 0)", margin: "0 0 28px", maxWidth: 540 },
  strong: { color: "oklch(0.985 0 0)", fontWeight: 600 },
  ctaRow: { display: "flex", gap: 10, marginBottom: 14 },
  btnPrimary: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    padding: "10px 14px",
    background: "var(--atlas-brand)",
    color: "oklch(0.145 0 0)",
    border: "none",
    borderRadius: 8,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    cursor: "pointer",
  },
  btnPrompt: { opacity: 0.6 },
  copy: { fontSize: 10, padding: "2px 6px", background: "oklch(0.145 0 0 / 0.18)", borderRadius: 3, marginLeft: 4 },
  btnGhost: {
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    padding: "10px 16px",
    background: "transparent",
    color: "oklch(0.985 0 0)",
    border: "1px solid oklch(1 0 0 / 0.12)",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 500,
  },
  disclaimer: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "oklch(0.443 0 0)", letterSpacing: "0.05em" },
  heroSpec: {
    border: "1px solid oklch(1 0 0 / 0.08)",
    borderRadius: 10,
    background: "oklch(0.18 0 0 / 0.5)",
    overflow: "hidden",
  },
  specRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "11px 16px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    borderBottom: "1px solid oklch(1 0 0 / 0.05)",
    gap: 16,
  },
  specK: { color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },
  specV: { color: "oklch(0.871 0 0)", textAlign: "right" },

  /* PIPELINE */
  pipeline: { padding: "80px 72px", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  secHead: { marginBottom: 40 },
  secMeta: { display: "flex", gap: 14, marginBottom: 16, fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)" },
  secNum: { color: "var(--atlas-brand)", letterSpacing: "0.1em" },
  secName: {},
  h2: { fontSize: 38, fontWeight: 600, letterSpacing: "-0.025em", margin: 0, lineHeight: 1.1, maxWidth: 720 },

  pipeFrame: {
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 12,
    background: "oklch(0.18 0 0 / 0.3)",
    padding: 32,
    display: "flex",
    flexDirection: "column",
    gap: 28,
  },
  pipeStage: { display: "flex", flexDirection: "column", gap: 12 },
  pipeLabel: { display: "flex", alignItems: "center", gap: 12, marginBottom: 4 },
  pipeIdx: {
    fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--atlas-brand)",
    background: "color-mix(in oklch, var(--atlas-brand) 12%, transparent)",
    border: "1px solid color-mix(in oklch, var(--atlas-brand) 30%, transparent)",
    padding: "2px 7px", borderRadius: 4, letterSpacing: "0.1em",
  },
  pipeName: { fontFamily: "var(--font-mono)", fontSize: 12, color: "oklch(0.871 0 0)", letterSpacing: "0.04em" },
  pipeLine: { flex: 1, height: 1, background: "oklch(1 0 0 / 0.06)" },

  userBubble: {
    alignSelf: "flex-start",
    background: "color-mix(in oklch, var(--atlas-brand) 12%, transparent)",
    border: "1px solid color-mix(in oklch, var(--atlas-brand) 30%, transparent)",
    color: "oklch(0.985 0 0)",
    padding: "12px 16px",
    borderRadius: "14px 14px 14px 4px",
    fontSize: 14,
    maxWidth: 460,
    lineHeight: 1.5,
  },
  resolveGrid: { display: "flex", flexWrap: "wrap", gap: 8 },
  resolveNote: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.556 0 0)", marginTop: 4 },
  chip: {
    display: "inline-flex", gap: 8, padding: "6px 10px",
    fontFamily: "var(--font-mono)", fontSize: 11,
    border: "1px solid", borderRadius: 6,
    alignItems: "baseline",
  },
  chipType: { fontSize: 9, opacity: 0.7, letterSpacing: "0.06em", textTransform: "uppercase" },
  chipDot: { opacity: 0.4 },

  codeBlock: {
    background: "#0C0C10",
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 8,
    padding: "14px 18px",
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    lineHeight: 1.7,
    color: "oklch(0.871 0 0)",
    margin: 0,
    whiteSpace: "pre-wrap",
    overflow: "hidden",
  },
  cm: { color: "oklch(0.443 0 0)" },
  kw: { color: "var(--atlas-brand)" },
  fn: { color: "oklch(0.78 0.13 280)" },
  num: { color: "oklch(0.85 0.18 70)" },
  str: { color: "oklch(0.78 0.16 50)" },

  gates: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 },
  gate: {
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 6,
    padding: "10px 10px",
    display: "flex", flexDirection: "column", gap: 4,
    background: "oklch(0.16 0 0)",
  },
  gateOk: { color: "var(--atlas-brand)", fontFamily: "var(--font-mono)", fontSize: 13 },
  gateFail: { color: "oklch(0.7 0.18 22)", fontFamily: "var(--font-mono)", fontSize: 13 },
  gateLabel: { fontSize: 10.5, color: "oklch(0.708 0 0)", lineHeight: 1.3 },
  gateMs: { fontFamily: "var(--font-mono)", fontSize: 9.5, color: "oklch(0.443 0 0)" },

  resultTable: {
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 8,
    overflow: "hidden",
  },
  tableHead: {
    display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr",
    padding: "10px 16px",
    background: "oklch(0.18 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "oklch(0.443 0 0)",
  },
  tableRow: {
    display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr",
    padding: "10px 16px",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    borderBottom: "1px solid oklch(1 0 0 / 0.04)",
    color: "oklch(0.871 0 0)",
  },
  tName: {},
  tNum: { color: "oklch(0.985 0 0)" },
  tUp: { color: "var(--atlas-brand)" },
  tDown: { color: "oklch(0.7 0.16 22)" },
  runFoot: {
    display: "flex", justifyContent: "space-between",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "oklch(0.556 0 0)",
    paddingTop: 4,
  },
  runFootRight: { color: "var(--atlas-brand)" },

  /* PRIMITIVES */
  primitives: { padding: "80px 72px", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  primGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "oklch(1 0 0 / 0.06)", border: "1px solid oklch(1 0 0 / 0.06)", borderRadius: 12, overflow: "hidden" },
  prim: {
    background: "#0C0C10",
    padding: 28,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  primHead: { display: "flex", gap: 10, alignItems: "center" },
  primIdx: { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--atlas-brand)", letterSpacing: "0.12em" },
  primName: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)" },
  primTitle: { fontSize: 18, fontWeight: 600, margin: 0, color: "oklch(0.985 0 0)" },
  primBlurb: { fontSize: 13, color: "oklch(0.708 0 0)", margin: 0, lineHeight: 1.6 },
  primCode: {
    background: "oklch(0.18 0 0)",
    border: "1px solid oklch(1 0 0 / 0.05)",
    borderRadius: 6,
    padding: "10px 12px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    lineHeight: 1.65,
    color: "oklch(0.708 0 0)",
    margin: 0,
    marginTop: 4,
    whiteSpace: "pre",
  },

  /* DEPLOY */
  deploy: { padding: "80px 72px", borderBottom: "1px solid oklch(1 0 0 / 0.05)" },
  deployGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  deployCol: {
    border: "1px solid oklch(1 0 0 / 0.08)",
    borderRadius: 14,
    padding: 32,
    background: "oklch(0.18 0 0 / 0.3)",
  },
  deployColFeat: {
    borderColor: "color-mix(in oklch, var(--atlas-brand) 35%, transparent)",
    background: "color-mix(in oklch, var(--atlas-brand) 4%, oklch(0.18 0 0 / 0.4))",
  },
  deployHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20 },
  deployTag: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.556 0 0)", letterSpacing: "0.12em", textTransform: "uppercase" },
  deployPrice: { fontFamily: "var(--font-mono)", fontSize: 12, color: "oklch(0.708 0 0)" },
  deployH: { fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", margin: "0 0 10px" },
  deployP: { fontSize: 14, color: "oklch(0.708 0 0)", lineHeight: 1.6, margin: "0 0 22px" },
  deployCode: {
    background: "#0C0C10",
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 8,
    padding: "12px 14px",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "oklch(0.871 0 0)",
    margin: "0 0 22px",
    whiteSpace: "pre-wrap",
    lineHeight: 1.7,
  },
  deployList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8, fontSize: 13, color: "oklch(0.871 0 0)" },

  cloudUptime: {
    background: "#0C0C10",
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 8,
    padding: 14,
    marginBottom: 22,
  },
  uptimeRow: { display: "flex", justifyContent: "space-between", marginBottom: 10, fontFamily: "var(--font-mono)", fontSize: 11 },
  uptimeLabel: { color: "oklch(0.443 0 0)", letterSpacing: "0.08em", textTransform: "uppercase" },
  uptimeNum: { color: "var(--atlas-brand)", fontWeight: 600 },
  uptimeBars: { display: "flex", gap: 1.5, alignItems: "flex-end", height: 24 },
  uptimeBar: { flex: 1, height: "100%", borderRadius: 1 },

  /* FOOTER */
  foot: { padding: "48px 72px", display: "flex", flexDirection: "column", gap: 32 },
  footRow: { display: "grid", gridTemplateColumns: "1.4fr 2.6fr", gap: 32 },
  footBrand: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: "oklch(0.985 0 0)", fontSize: 16 },
  footTag: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.443 0 0)", marginLeft: 12, fontWeight: 400 },
  footCols: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 },
  footHead: { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", color: "oklch(0.443 0 0)", textTransform: "uppercase", marginBottom: 12 },
  footLink: { fontSize: 13, color: "oklch(0.708 0 0)", padding: "4px 0", cursor: "pointer" },
  footMeta: { display: "flex", justifyContent: "space-between", paddingTop: 24, borderTop: "1px solid oklch(1 0 0 / 0.05)", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },

  /* INSPECTOR */
  inspector: {
    background: "oklch(0.165 0 0)",
    borderLeft: "1px solid oklch(1 0 0 / 0.06)",
    padding: "20px 18px 28px",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    color: "oklch(0.708 0 0)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  inspHead: {
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em",
    color: "oklch(0.443 0 0)", textTransform: "uppercase",
    marginBottom: 10,
  },
  inspBlock: { marginBottom: 10 },
  inspKey: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", letterSpacing: "0.04em" },
  inspVal: { fontSize: 13, color: "oklch(0.985 0 0)" },
  inspValMono: { fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.871 0 0)", lineHeight: 1.5 },
  inspDivider: { height: 1, background: "oklch(1 0 0 / 0.05)", margin: "12px 0" },
  vital: { display: "flex", flexDirection: "column", gap: 2, padding: "6px 0" },
  vitalLabel: { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", color: "oklch(0.443 0 0)", textTransform: "uppercase" },
  vitalRow: { display: "flex", alignItems: "baseline", gap: 8 },
  vitalValue: { fontFamily: "var(--font-mono)", fontSize: 16, color: "oklch(0.985 0 0)", fontWeight: 500 },
  vitalDelta: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--atlas-brand)" },
  recent: { display: "flex", gap: 10, padding: "6px 0", fontSize: 11.5, alignItems: "baseline" },
  recentTime: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", width: 32, flexShrink: 0 },
  recentTxt: { color: "oklch(0.871 0 0)", lineHeight: 1.4 },
  builtRow: { padding: "5px 0", fontSize: 12.5, color: "oklch(0.871 0 0)" },
  inspFloor: { marginTop: "auto", paddingTop: 24, borderTop: "1px solid oklch(1 0 0 / 0.05)" },
  inspCta: {
    width: "100%",
    background: "var(--atlas-brand)", color: "oklch(0.145 0 0)",
    border: "none", borderRadius: 8,
    padding: "10px 14px", fontWeight: 600, fontSize: 13,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  },
  inspCtaSub: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", marginTop: 6, textAlign: "center", letterSpacing: "0.04em" },
};

window.TerminalVariant = TerminalVariant;
