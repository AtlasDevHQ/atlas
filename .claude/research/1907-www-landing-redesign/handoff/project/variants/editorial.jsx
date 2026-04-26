/* Variant B — Editorial / Newspaper
 * Asymmetric multi-column grid. Big typographic moments, marginalia,
 * running heads, footnotes. Treats the page as a long-form publication.
 */

const EditorialVariant = () => {
  return (
    <div style={edStyles.root}>
      {/* MASTHEAD */}
      <header style={edStyles.masthead}>
        <div style={edStyles.mastTop}>
          <span style={edStyles.mastDate}>vol. 1 · no. 12 · april 2026</span>
          <span style={edStyles.mastEdition}>the san francisco edition · weather: cold, foggy</span>
          <span style={edStyles.mastNav}>
            <span>docs</span>
            <span>pricing</span>
            <span>changelog</span>
            <span style={edStyles.mastCta}>start →</span>
          </span>
        </div>
        <div style={edStyles.mastBrand}>
          <AtlasGlyph />
          <span style={edStyles.mastWord}>atlas</span>
        </div>
        <div style={edStyles.mastTag}>
          A working paper on text-to-SQL, the semantic layer, and not pasting your schema into ChatGPT.
        </div>
      </header>

      {/* THE FOLD: 12-col grid */}
      <section style={edStyles.fold}>
        {/* Sidebar — table of contents */}
        <aside style={edStyles.foldSide}>
          <div style={edStyles.tocHead}>In this issue</div>
          <ol style={edStyles.toc}>
            <li><span style={edStyles.tocNum}>p.1</span><span>The schema problem</span></li>
            <li><span style={edStyles.tocNum}>p.2</span><span>Anatomy of a query</span></li>
            <li><span style={edStyles.tocNum}>p.3</span><span>Six load-bearing pieces</span></li>
            <li><span style={edStyles.tocNum}>p.4</span><span>The validation pipeline</span></li>
            <li><span style={edStyles.tocNum}>p.5</span><span>Cloud, or self-host</span></li>
            <li><span style={edStyles.tocNum}>p.6</span><span>Pricing & terms</span></li>
            <li><span style={edStyles.tocNum}>p.7</span><span>Letters from operators</span></li>
          </ol>

          <div style={edStyles.tocHead}>Quoted within</div>
          <ul style={edStyles.miniList}>
            <li>Postgres · Snowflake · BigQuery · DuckDB</li>
            <li>Claude · GPT · Gemini · Llama</li>
            <li>Bun · Docker · Kubernetes</li>
            <li>YAML · TypeScript · MIT</li>
          </ul>

          <div style={edStyles.tocHead}>Inside the issue</div>
          <div style={edStyles.callout}>
            <div style={edStyles.calloutEye}>p.4 — feature</div>
            <div style={edStyles.calloutTxt}>
              <em>"Atlas runs every statement through 7 validators before it touches your warehouse."</em>
              <span style={edStyles.calloutBy}>— interview with the lead engineer</span>
            </div>
          </div>
        </aside>

        {/* Lead — big headline + dropcap */}
        <article style={edStyles.lead}>
          <div style={edStyles.leadEye}>page 1 · the schema problem</div>
          <h1 style={edStyles.h1}>
            Stop pasting your <em style={edStyles.h1Em}>schema</em> into <span style={edStyles.h1Strike}>ChatGPT.</span>
          </h1>
          <h1 style={edStyles.h1Sub}>
            Start asking your <span style={edStyles.h1Brand}>warehouse</span> directly.
          </h1>

          <div style={edStyles.byline}>
            <span>By <span style={edStyles.bylineName}>the atlas team</span></span>
            <span style={edStyles.bylineDot}>·</span>
            <span>April 2026</span>
            <span style={edStyles.bylineDot}>·</span>
            <span>14 minute read · or 3 minute install</span>
          </div>

          <div style={edStyles.leadBody}>
            <p style={edStyles.leadP}>
              <span style={edStyles.dropcap}>E</span>very data team is, at this moment, doing the same thing: pasting columns
              into a chat window, watching it hallucinate joins, and copying the SQL back out. It works
              until it doesn't — and the moment it doesn't, it does so silently, with a confident answer
              and the wrong number. Atlas exists because that loop is unsafe, slow, and beneath you.
            </p>

            <p style={edStyles.leadP}>
              We give the model what it lacks: a <strong>semantic layer</strong> describing your entities,
              metrics, and glossary; <strong>seven validation gates</strong> AST-parsed before any statement
              touches your database; and a <strong>read-only execution path</strong> that runs against your
              warehouse — not a copy, not a sample, not a pretend one.
            </p>

            <div style={edStyles.leadCta}>
              <button style={edStyles.btnPrimary}>Start the 14-day trial</button>
              <button style={edStyles.btnSec}>
                <code style={edStyles.btnCode}>$ bun create @useatlas</code>
              </button>
              <span style={edStyles.leadDis}>
                no card · self-host is free, every feature, no limits
              </span>
            </div>
          </div>
        </article>

        {/* Right margin — pull quote + figure */}
        <aside style={edStyles.foldMargin}>
          <div style={edStyles.fig}>
            <div style={edStyles.figLabel}>fig. 1 — the diff</div>
            <div style={edStyles.diff}>
              <div style={edStyles.diffRow}>
                <span style={edStyles.diffMinus}>−</span>
                <span style={edStyles.diffOld}>copy/paste schema → chat → copy SQL → run → realize wrong table</span>
              </div>
              <div style={edStyles.diffRow}>
                <span style={edStyles.diffPlus}>+</span>
                <span style={edStyles.diffNew}>ask atlas → atlas resolves entities → 7 validators → result</span>
              </div>
            </div>
          </div>

          <blockquote style={edStyles.pull}>
            <span style={edStyles.pullMark}>"</span>
            The fastest way to ship a wrong number is to give an LLM the column names but not the&nbsp;
            <span style={edStyles.pullEm}>meaning</span> of them.
            <footer style={edStyles.pullFoot}>— from the manifesto, page 4</footer>
          </blockquote>

          <div style={edStyles.statBlock}>
            <div style={edStyles.statRow}>
              <span style={edStyles.statNum}>7</span>
              <span style={edStyles.statLbl}>validation layers run on every query, before execution</span>
            </div>
            <div style={edStyles.statRow}>
              <span style={edStyles.statNum}>0</span>
              <span style={edStyles.statLbl}>writes — atlas is read-only, by default and by design</span>
            </div>
            <div style={edStyles.statRow}>
              <span style={edStyles.statNum}>1.2s</span>
              <span style={edStyles.statLbl}>median time-to-result, prompt → rendered table</span>
            </div>
          </div>
        </aside>
      </section>

      {/* RUNNING HEAD divider */}
      <div style={edStyles.runHead}>
        <span>www.useatlas.dev</span>
        <span style={edStyles.runHeadCenter}>— continued, p.2 —</span>
        <span>vol. 1 / no. 12</span>
      </div>

      {/* PAGE 2: anatomy of a query */}
      <section style={edStyles.section}>
        <div style={edStyles.secEye}>page 2 · feature</div>
        <h2 style={edStyles.h2}>
          Anatomy of a <em style={edStyles.h2Em}>query.</em>
        </h2>
        <p style={edStyles.secDek}>
          One question, traced through the system. From the prompt the operator types, to the rows the
          warehouse returns. No black box, no agent magic — just a pipeline you can read.
        </p>

        <div style={edStyles.anatomy}>
          {/* Step strip */}
          <div style={edStyles.anatomyStrip}>
            {[
              { n: "I.", k: "prompt", l: "the operator asks" },
              { n: "II.", k: "resolve", l: "semantic layer lookup" },
              { n: "III.", k: "compile", l: "sql is generated" },
              { n: "IV.", k: "validate", l: "7 gates · AST checked" },
              { n: "V.", k: "execute", l: "read-only against db" },
              { n: "VI.", k: "render", l: "rows return to ui" },
            ].map((s, i) => (
              <div key={i} style={edStyles.anatomyCol}>
                <div style={edStyles.anNum}>{s.n}</div>
                <div style={edStyles.anKey}>{s.k}</div>
                <div style={edStyles.anLbl}>{s.l}</div>
                {i < 5 && <span style={edStyles.anLine} />}
              </div>
            ))}
          </div>

          {/* Two-up: prompt + sql */}
          <div style={edStyles.anatomyTwo}>
            <div style={edStyles.anatomyCard}>
              <div style={edStyles.anCardLbl}>I. — the operator asks</div>
              <div style={edStyles.promptText}>
                "Top 5 accounts by ARR this quarter, with QoQ growth."
              </div>
              <div style={edStyles.anFoot}>
                <span style={edStyles.anFootK}>resolved</span>
                <span style={edStyles.anFootChip}>accounts</span>
                <span style={edStyles.anFootChip}>arr</span>
                <span style={edStyles.anFootChip}>quarter</span>
                <span style={edStyles.anFootChip}>qoq_growth</span>
              </div>
            </div>
            <div style={edStyles.anatomyCard}>
              <div style={edStyles.anCardLbl}>III. — sql is generated</div>
              <pre style={edStyles.codeEd}>
<span style={edStyles.cm}>{`-- 7 validations · read-only`}</span>{`\n`}
<span style={edStyles.kw}>SELECT</span>{` a.name, a.arr,
       `}<span style={edStyles.fn}>ROUND</span>{`(
         (a.arr - p.arr)/p.arr * `}<span style={edStyles.num}>100</span>{`, `}<span style={edStyles.num}>1</span>{`
       ) `}<span style={edStyles.kw}>AS</span>{` qoq_pct
  `}<span style={edStyles.kw}>FROM</span>{` accounts a
  `}<span style={edStyles.kw}>JOIN</span>{` snapshots p `}<span style={edStyles.kw}>ON</span>{` …
 `}<span style={edStyles.kw}>ORDER BY</span>{` a.arr `}<span style={edStyles.kw}>DESC LIMIT</span>{` `}<span style={edStyles.num}>5</span>;
              </pre>
            </div>
          </div>

          {/* Validators ledger */}
          <div style={edStyles.ledger}>
            <div style={edStyles.ledgerHead}>
              <span>IV. — the validation pipeline</span>
              <span style={edStyles.ledgerSub}>each gate executed in series · failures abort the run</span>
            </div>
            <table style={edStyles.ledgerTbl}>
              <thead>
                <tr>
                  <th style={edStyles.thNum}>#</th>
                  <th style={edStyles.thName}>gate</th>
                  <th style={edStyles.thWhat}>what it checks</th>
                  <th style={edStyles.thMs}>ms</th>
                  <th style={edStyles.thStatus}>status</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["1", "ast.parse", "every statement is a valid AST", 18, "ok"],
                  ["2", "read_only", "no INSERT, UPDATE, DELETE, DROP", 4, "ok"],
                  ["3", "permissions", "user has SELECT on referenced tables", 22, "ok"],
                  ["4", "row_limit", "result ≤ configured ceiling (10k)", 6, "ok"],
                  ["5", "join_check", "joins use declared keys, not arbitrary columns", 31, "ok"],
                  ["6", "metric_whitelist", "metrics resolved from semantic layer", 12, "ok"],
                  ["7", "cost_estimate", "EXPLAIN under cost ceiling", 89, "ok"],
                ].map((r, i) => (
                  <tr key={i}>
                    <td style={edStyles.tdNum}>{r[0]}</td>
                    <td style={edStyles.tdName}>{r[1]}</td>
                    <td style={edStyles.tdWhat}>{r[2]}</td>
                    <td style={edStyles.tdMs}>{r[3]}</td>
                    <td style={edStyles.tdStat}><span style={edStyles.statOk}>● ok</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={edStyles.ledgerFoot}>total · 182 ms · 0 failures · scoped to <em>analytics.public</em></div>
          </div>

          {/* Result table */}
          <div style={edStyles.resultEd}>
            <div style={edStyles.resCap}>
              <span>fig. 2 — VI. the rows the warehouse returned</span>
              <span style={edStyles.resCapMeta}>5 rows · 1.2s · cached for 60s</span>
            </div>
            <table style={edStyles.resTbl}>
              <thead>
                <tr>
                  <th>account</th><th>arr</th><th>q-1 arr</th><th>qoq</th><th>signal</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Northwind Trading", "$2.40M", "$2.03M", "+18.4%", 84],
                  ["Gemini Robotics", "$1.92M", "$1.76M", "+9.1%", 62],
                  ["Helios Aerospace", "$1.71M", "$1.62M", "+5.8%", 48],
                  ["Kite & Key Capital", "$1.55M", "$1.26M", "+22.7%", 92],
                  ["Orca Logistics", "$1.41M", "$1.44M", "−2.3%", 18],
                ].map((r, i) => (
                  <tr key={i}>
                    <td style={edStyles.resName}>{r[0]}</td>
                    <td style={edStyles.resNum}>{r[1]}</td>
                    <td style={edStyles.resNum}>{r[2]}</td>
                    <td style={Number(r[3].replace(/[^-0-9.]/g, "")) >= 0 ? edStyles.resUp : edStyles.resDown}>{r[3]}</td>
                    <td>
                      <span style={{
                        ...edStyles.bar,
                        width: `${r[4]}%`,
                        background: Number(r[3].replace(/[^-0-9.]/g, "")) >= 0 ? "var(--atlas-brand)" : "oklch(0.7 0.18 22)",
                      }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div style={edStyles.runHead}>
        <span>www.useatlas.dev</span>
        <span style={edStyles.runHeadCenter}>— continued, p.3 —</span>
        <span>vol. 1 / no. 12</span>
      </div>

      {/* PAGE 3: SIX PRIMITIVES — newspaper columns */}
      <section style={edStyles.section}>
        <div style={edStyles.secEye}>page 3 · the system</div>
        <h2 style={edStyles.h2}>
          Six pieces.<br />Each <em style={edStyles.h2Em}>load-bearing.</em>
        </h2>

        <div style={edStyles.colsGrid}>
          {[
            { n: "i.", k: "Semantic layer", b: "Entities, metrics, and a glossary in YAML, kept beside your code. Atlas reads them on every prompt — no more hallucinated column names, no joins on imaginary keys.", code: "entity: accounts\nprimary_key: id\nmetrics:\n  - arr\n  - mrr" },
            { n: "ii.", k: "7 validators", b: "AST-parsed, permission-checked, row-limited. Read-only by default. Every statement passes a fixed pipeline before it touches your warehouse — same in dev, same in prod.", code: "✓ ast.parse  ✓ read_only\n✓ permissions ✓ row_limit\n✓ join_check  ✓ + 2 more" },
            { n: "iii.", k: "Prompt library", b: "Save and version prompts in TypeScript, not strings in a UI. Share across the team. Roll back like code. Every prompt is a function, every function lives in your repo.", code: "export const top5 =\n  prompt`top 5 accounts\n  by ${metric} this ${period}`" },
            { n: "iv.", k: "React widget", b: "A drop-in component. Inherits your tokens; speaks your data. Use it inside an internal admin panel, a customer-facing analytics tab, or a CFO's dashboard — same widget, different scope.", code: "<AtlasChat\n  workspace=\"acme\"\n  scope=\"finance\" />" },
            { n: "v.", k: "Warehouse-native", b: "Postgres, Snowflake, BigQuery, DuckDB. One connection spec. On self-host, no data leaves your network — Atlas runs in your VPC, talks to your warehouse on your terms.", code: "db: postgres://…\nssl: require\nschema: analytics" },
            { n: "vi.", k: "Audit-ready", b: "Every query, every result, every operator — logged, searchable, exportable. SSO, SAML, SCIM on cloud. Quarterly reviews are a CSV download, not a fire drill.", code: "atlas audit \\\n  --since=24h \\\n  --export=csv" },
          ].map((p, i) => (
            <article key={i} style={edStyles.colCard}>
              <div style={edStyles.colHead}>
                <span style={edStyles.colNum}>{p.n}</span>
                <span style={edStyles.colName}>{p.k}</span>
              </div>
              <p style={edStyles.colBody}>{p.b}</p>
              <pre style={edStyles.colCode}>{p.code}</pre>
            </article>
          ))}
        </div>
      </section>

      <div style={edStyles.runHead}>
        <span>www.useatlas.dev</span>
        <span style={edStyles.runHeadCenter}>— continued, p.4 —</span>
        <span>vol. 1 / no. 12</span>
      </div>

      {/* PAGE 4 — DEPLOY: A vs B */}
      <section style={edStyles.section}>
        <div style={edStyles.secEye}>page 4 · deployment</div>
        <h2 style={edStyles.h2}>
          Two ways to run it.<br />
          <em style={edStyles.h2Em}>Same code.</em>
        </h2>

        <div style={edStyles.deployCmp}>
          <div style={edStyles.deployRow}>
            <div style={edStyles.deployHead}>option A</div>
            <div style={edStyles.deployHead}>—</div>
            <div style={edStyles.deployHead}>option B</div>
          </div>

          {[
            ["Self-host", "compare", "Atlas Cloud"],
            ["Free, MIT, every feature", "price", "$29 / seat / month"],
            ["Bun, Docker, or Kubernetes", "runtime", "We host, monitor, update"],
            ["BYO model key", "ai", "Use ours, or BYO"],
            ["Inside your VPC", "data path", "Encrypted, scoped, audited"],
            ["Community Discord", "support", "SSO · SLA · priority email"],
            ["3 minute install", "ttv", "3 minute signup"],
          ].map((r, i) => (
            <div key={i} style={i === 0 ? edStyles.deployRowH : edStyles.deployRow}>
              <div style={i === 0 ? edStyles.deployA1 : edStyles.deployA}>{r[0]}</div>
              <div style={edStyles.deployMid}>{r[1]}</div>
              <div style={i === 0 ? edStyles.deployB1 : edStyles.deployB}>{r[2]}</div>
            </div>
          ))}

          <div style={edStyles.deployCtaRow}>
            <div style={edStyles.deployCtaA}>
              <code style={edStyles.deployCmd}>$ bun create @useatlas</code>
              <span style={edStyles.deployCmdNote}>read the docs →</span>
            </div>
            <div style={edStyles.deployMid} />
            <div style={edStyles.deployCtaB}>
              <button style={edStyles.btnPrimary}>Start free trial</button>
              <span style={edStyles.deployCmdNote}>14 days · no card</span>
            </div>
          </div>
        </div>
      </section>

      {/* LETTERS — testimonials styled as letters to the editor */}
      <section style={edStyles.section}>
        <div style={edStyles.secEye}>page 5 · letters from operators</div>
        <h2 style={edStyles.h2}>
          From the field.
        </h2>

        <div style={edStyles.lettersGrid}>
          <Letter
            from="head of data, mid-market saas"
            place="Berlin · DE"
            body="We had a 'pasted-schema' channel in Slack. It's now a graveyard. The team got their afternoons back; finance stopped asking us for numbers."
          />
          <Letter
            from="founding engineer"
            place="Brooklyn · NY"
            body="What sold me was the audit log. Every prompt, every SQL, every operator. Quarterly compliance went from a week to a CSV."
          />
          <Letter
            from="analytics engineer"
            place="Austin · TX"
            body="The semantic layer felt like extra work for two days. Then the team stopped writing the same five queries every Monday. I'd never go back."
          />
        </div>
      </section>

      {/* COLOPHON FOOTER */}
      <footer style={edStyles.colophon}>
        <div style={edStyles.colTop}>
          <div style={edStyles.colBrand}>
            <AtlasGlyph />
            <span style={edStyles.colBrandWord}>atlas</span>
            <span style={edStyles.colBrandTag}>text-to-sql, that actually runs</span>
          </div>
          <div style={edStyles.colCols}>
            <div>
              <div style={edStyles.colHeadF}>product</div>
              <div style={edStyles.colLink}>features</div>
              <div style={edStyles.colLink}>pricing</div>
              <div style={edStyles.colLink}>changelog</div>
              <div style={edStyles.colLink}>status</div>
            </div>
            <div>
              <div style={edStyles.colHeadF}>developers</div>
              <div style={edStyles.colLink}>docs</div>
              <div style={edStyles.colLink}>cli</div>
              <div style={edStyles.colLink}>react widget</div>
              <div style={edStyles.colLink}>github</div>
            </div>
            <div>
              <div style={edStyles.colHeadF}>company</div>
              <div style={edStyles.colLink}>blog</div>
              <div style={edStyles.colLink}>careers</div>
              <div style={edStyles.colLink}>security</div>
              <div style={edStyles.colLink}>privacy</div>
            </div>
          </div>
        </div>
        <div style={edStyles.colBottom}>
          <span>set in Sora &amp; JetBrains Mono</span>
          <span>printed in oklch</span>
          <span>© 2026 atlas defense corp · san francisco</span>
        </div>
      </footer>
    </div>
  );
};

const AtlasGlyph = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--atlas-brand)" strokeWidth="1.8">
    <path d="M12 3L3 20h18L12 3z" />
    <circle cx="12" cy="3" r="1.6" fill="var(--atlas-brand)" />
  </svg>
);

const Letter = ({ from, place, body }) => (
  <article style={edStyles.letter}>
    <div style={edStyles.letterMark}>—</div>
    <p style={edStyles.letterBody}>{body}</p>
    <div style={edStyles.letterSig}>
      <span style={edStyles.letterFrom}>{from}</span>
      <span style={edStyles.letterPlace}>{place}</span>
    </div>
  </article>
);

const edStyles = {
  root: {
    fontFamily: "var(--font-sans)",
    background: "#0C0C10",
    color: "oklch(0.985 0 0)",
    width: 1440,
    paddingBottom: 0,
  },

  /* MASTHEAD */
  masthead: { padding: "20px 56px 36px", borderBottom: "2px solid oklch(1 0 0 / 0.15)" },
  mastTop: {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
    fontFamily: "var(--font-mono)",
    fontSize: 11, color: "oklch(0.556 0 0)",
    paddingBottom: 14, borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    letterSpacing: "0.04em",
    alignItems: "center",
  },
  mastDate: {},
  mastEdition: { textAlign: "center" },
  mastNav: { display: "flex", justifyContent: "flex-end", gap: 22, alignItems: "center" },
  mastCta: { color: "var(--atlas-brand)", fontWeight: 600 },
  mastBrand: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
    padding: "26px 0 10px",
  },
  mastWord: {
    fontSize: 86, fontWeight: 700, letterSpacing: "-0.04em",
    fontFamily: "var(--font-sans)",
  },
  mastTag: {
    fontFamily: "'Sora', serif",
    fontStyle: "italic",
    textAlign: "center", color: "oklch(0.708 0 0)",
    fontSize: 14, letterSpacing: "0.01em",
    paddingTop: 4,
  },

  /* FOLD */
  fold: {
    display: "grid",
    gridTemplateColumns: "240px 1fr 320px",
    gap: 36,
    padding: "44px 56px 56px",
    borderBottom: "1px solid oklch(1 0 0 / 0.1)",
  },

  foldSide: { borderRight: "1px solid oklch(1 0 0 / 0.06)", paddingRight: 28 },
  tocHead: {
    fontFamily: "var(--font-mono)",
    fontSize: 10, letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "oklch(0.443 0 0)",
    margin: "0 0 12px",
    paddingBottom: 8, borderBottom: "1px solid oklch(1 0 0 / 0.05)",
  },
  toc: {
    listStyle: "none", padding: 0, margin: "0 0 32px",
    fontSize: 13, color: "oklch(0.871 0 0)",
  },
  tocNum: {
    fontFamily: "var(--font-mono)",
    fontSize: 10, color: "oklch(0.443 0 0)",
    width: 32, display: "inline-block", letterSpacing: "0.04em",
  },
  miniList: {
    listStyle: "none", padding: 0, margin: "0 0 32px",
    display: "flex", flexDirection: "column", gap: 8,
    fontFamily: "var(--font-mono)", fontSize: 11.5, color: "oklch(0.708 0 0)",
  },
  callout: {
    border: "1px solid color-mix(in oklch, var(--atlas-brand) 30%, transparent)",
    borderRadius: 8,
    padding: "14px 14px",
    background: "color-mix(in oklch, var(--atlas-brand) 5%, transparent)",
  },
  calloutEye: {
    fontFamily: "var(--font-mono)",
    fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
    color: "var(--atlas-brand)", marginBottom: 8,
  },
  calloutTxt: { fontSize: 13, color: "oklch(0.871 0 0)", lineHeight: 1.5 },
  calloutBy: { display: "block", marginTop: 8, fontSize: 11, color: "oklch(0.556 0 0)", fontStyle: "normal" },

  /* LEAD */
  lead: { paddingRight: 12 },
  leadEye: {
    fontFamily: "var(--font-mono)",
    fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase",
    color: "var(--atlas-brand)", marginBottom: 16,
  },
  h1: {
    fontSize: 84, lineHeight: 0.96, letterSpacing: "-0.04em",
    fontWeight: 600, margin: "0 0 4px",
  },
  h1Em: { fontStyle: "italic", color: "oklch(0.985 0 0)", fontWeight: 600 },
  h1Strike: { textDecoration: "line-through", textDecorationColor: "oklch(0.7 0.18 22)", textDecorationThickness: 4, color: "oklch(0.443 0 0)" },
  h1Sub: {
    fontSize: 84, lineHeight: 0.96, letterSpacing: "-0.04em",
    fontWeight: 600, margin: "0 0 28px",
  },
  h1Brand: { color: "var(--atlas-brand)" },
  byline: {
    display: "flex", gap: 10, alignItems: "center",
    fontFamily: "var(--font-mono)", fontSize: 11.5,
    color: "oklch(0.556 0 0)", letterSpacing: "0.02em",
    paddingBottom: 22, borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    marginBottom: 24,
  },
  bylineName: { color: "oklch(0.985 0 0)" },
  bylineDot: { color: "oklch(0.32 0 0)" },
  leadBody: {},
  leadP: {
    fontSize: 17, lineHeight: 1.65, color: "oklch(0.871 0 0)",
    margin: "0 0 18px",
    fontWeight: 400,
  },
  dropcap: {
    fontFamily: "var(--font-sans)",
    float: "left", fontSize: 78, lineHeight: 0.85,
    fontWeight: 600, marginRight: 12, marginTop: 4,
    color: "var(--atlas-brand)",
    letterSpacing: "-0.04em",
  },
  leadCta: {
    marginTop: 32,
    paddingTop: 22, borderTop: "1px solid oklch(1 0 0 / 0.05)",
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
  },
  btnPrimary: {
    background: "var(--atlas-brand)", color: "oklch(0.145 0 0)",
    border: "none", borderRadius: 8,
    padding: "11px 18px", fontWeight: 600, fontSize: 13.5,
    cursor: "pointer", fontFamily: "var(--font-sans)",
  },
  btnSec: {
    background: "transparent", color: "oklch(0.985 0 0)",
    border: "1px solid oklch(1 0 0 / 0.18)",
    borderRadius: 8, padding: "10px 16px",
    cursor: "pointer", fontFamily: "var(--font-sans)",
  },
  btnCode: { fontFamily: "var(--font-mono)", fontSize: 12.5, color: "oklch(0.871 0 0)" },
  leadDis: {
    fontFamily: "var(--font-mono)", fontSize: 11,
    color: "oklch(0.443 0 0)", letterSpacing: "0.04em",
  },

  /* MARGIN */
  foldMargin: {
    paddingLeft: 8, borderLeft: "1px solid oklch(1 0 0 / 0.06)",
    display: "flex", flexDirection: "column", gap: 28,
  },
  fig: {},
  figLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
    color: "oklch(0.443 0 0)", marginBottom: 10,
  },
  diff: {
    border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 6, overflow: "hidden",
  },
  diffRow: { display: "flex", padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, gap: 8 },
  diffMinus: { color: "oklch(0.7 0.18 22)", width: 12 },
  diffPlus: { color: "var(--atlas-brand)", width: 12 },
  diffOld: { color: "oklch(0.556 0 0)", textDecoration: "line-through", textDecorationColor: "oklch(0.7 0.18 22 / 0.4)" },
  diffNew: { color: "oklch(0.871 0 0)" },
  pull: {
    margin: 0,
    fontFamily: "'Sora'",
    fontStyle: "italic",
    fontSize: 22, lineHeight: 1.35, fontWeight: 500,
    color: "oklch(0.985 0 0)",
    letterSpacing: "-0.015em",
    paddingLeft: 20,
    borderLeft: "3px solid var(--atlas-brand)",
    position: "relative",
  },
  pullMark: {
    position: "absolute", left: -2, top: -22, fontSize: 64,
    color: "var(--atlas-brand)", fontStyle: "normal",
    lineHeight: 1, fontFamily: "Georgia, serif",
  },
  pullEm: { color: "var(--atlas-brand)" },
  pullFoot: {
    display: "block", marginTop: 10,
    fontFamily: "var(--font-mono)", fontStyle: "normal",
    fontSize: 11, letterSpacing: "0.04em",
    color: "oklch(0.556 0 0)",
  },
  statBlock: { display: "flex", flexDirection: "column", gap: 14 },
  statRow: {
    display: "grid", gridTemplateColumns: "70px 1fr",
    gap: 12, alignItems: "baseline",
    paddingTop: 14, borderTop: "1px solid oklch(1 0 0 / 0.06)",
  },
  statNum: {
    fontFamily: "var(--font-sans)", fontSize: 38, fontWeight: 600,
    letterSpacing: "-0.03em", color: "var(--atlas-brand)",
    lineHeight: 1,
  },
  statLbl: { fontSize: 12, color: "oklch(0.708 0 0)", lineHeight: 1.5 },

  /* RUNNING HEAD */
  runHead: {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
    padding: "12px 56px",
    fontFamily: "var(--font-mono)",
    fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase",
    color: "oklch(0.443 0 0)",
    borderTop: "1px solid oklch(1 0 0 / 0.06)",
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
  },
  runHeadCenter: { textAlign: "center", color: "oklch(0.708 0 0)" },

  /* SECTIONS */
  section: { padding: "72px 56px 64px" },
  secEye: {
    fontFamily: "var(--font-mono)",
    fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase",
    color: "var(--atlas-brand)", marginBottom: 16,
  },
  h2: {
    fontSize: 64, lineHeight: 1.0, letterSpacing: "-0.035em",
    fontWeight: 600, margin: "0 0 22px", maxWidth: 900,
  },
  h2Em: { fontStyle: "italic", color: "var(--atlas-brand)" },
  secDek: {
    fontSize: 17, lineHeight: 1.6, color: "oklch(0.708 0 0)",
    margin: "0 0 44px", maxWidth: 720,
  },

  /* ANATOMY */
  anatomy: { display: "flex", flexDirection: "column", gap: 32 },
  anatomyStrip: {
    display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8,
    paddingBottom: 16, borderBottom: "1px solid oklch(1 0 0 / 0.05)",
  },
  anatomyCol: { position: "relative", padding: "10px 14px 14px" },
  anNum: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--atlas-brand)", letterSpacing: "0.1em" },
  anKey: { fontSize: 16, fontWeight: 600, color: "oklch(0.985 0 0)", margin: "8px 0 4px" },
  anLbl: { fontSize: 12, color: "oklch(0.556 0 0)", lineHeight: 1.5 },
  anLine: { position: "absolute", right: -4, top: 18, width: 8, height: 1, background: "oklch(1 0 0 / 0.1)" },

  anatomyTwo: { display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 14 },
  anatomyCard: {
    border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 10,
    padding: 24, background: "oklch(0.18 0 0 / 0.4)",
  },
  anCardLbl: {
    fontFamily: "var(--font-mono)", fontSize: 10.5,
    letterSpacing: "0.12em", textTransform: "uppercase",
    color: "oklch(0.443 0 0)", marginBottom: 14,
  },
  promptText: {
    fontSize: 22, lineHeight: 1.4, fontWeight: 500,
    color: "oklch(0.985 0 0)", letterSpacing: "-0.01em",
  },
  anFoot: {
    marginTop: 22, paddingTop: 14, borderTop: "1px solid oklch(1 0 0 / 0.06)",
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
  },
  anFootK: { fontFamily: "var(--font-mono)", fontSize: 10, color: "oklch(0.443 0 0)", letterSpacing: "0.1em", textTransform: "uppercase", marginRight: 6 },
  anFootChip: {
    fontFamily: "var(--font-mono)", fontSize: 11,
    padding: "3px 8px", borderRadius: 4,
    border: "1px solid color-mix(in oklch, var(--atlas-brand) 28%, transparent)",
    color: "var(--atlas-brand)",
    background: "color-mix(in oklch, var(--atlas-brand) 8%, transparent)",
  },

  codeEd: {
    background: "#0C0C10", border: "1px solid oklch(1 0 0 / 0.06)",
    borderRadius: 6, padding: "14px 16px",
    fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.7,
    color: "oklch(0.871 0 0)", margin: 0, whiteSpace: "pre-wrap",
  },
  cm: { color: "oklch(0.443 0 0)" },
  kw: { color: "var(--atlas-brand)" },
  fn: { color: "oklch(0.78 0.13 280)" },
  num: { color: "oklch(0.85 0.18 70)" },

  /* LEDGER */
  ledger: {
    border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 10,
    padding: "20px 24px 22px",
    background: "oklch(0.16 0 0 / 0.6)",
  },
  ledgerHead: {
    display: "flex", justifyContent: "space-between", alignItems: "baseline",
    marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)", fontSize: 11.5, color: "oklch(0.871 0 0)",
    letterSpacing: "0.04em",
  },
  ledgerSub: { color: "oklch(0.443 0 0)", fontSize: 11 },
  ledgerTbl: {
    width: "100%", borderCollapse: "collapse",
    fontFamily: "var(--font-mono)", fontSize: 12,
  },
  thNum: { textAlign: "left", padding: "8px 4px 12px", color: "oklch(0.443 0 0)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500, width: 32 },
  thName: { textAlign: "left", padding: "8px 4px 12px", color: "oklch(0.443 0 0)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 },
  thWhat: { textAlign: "left", padding: "8px 4px 12px", color: "oklch(0.443 0 0)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 },
  thMs: { textAlign: "right", padding: "8px 4px 12px", color: "oklch(0.443 0 0)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500, width: 60 },
  thStatus: { textAlign: "right", padding: "8px 4px 12px", color: "oklch(0.443 0 0)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500, width: 80 },
  tdNum: { padding: "9px 4px", color: "oklch(0.443 0 0)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  tdName: { padding: "9px 4px", color: "var(--atlas-brand)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  tdWhat: { padding: "9px 4px", color: "oklch(0.871 0 0)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  tdMs: { padding: "9px 4px", textAlign: "right", color: "oklch(0.708 0 0)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  tdStat: { padding: "9px 4px", textAlign: "right", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  statOk: { color: "var(--atlas-brand)", fontFamily: "var(--font-mono)" },
  ledgerFoot: {
    marginTop: 14, paddingTop: 12, borderTop: "1px solid oklch(1 0 0 / 0.06)",
    fontFamily: "var(--font-mono)", fontSize: 11, color: "oklch(0.556 0 0)",
  },

  /* RESULT */
  resultEd: {
    border: "1px solid oklch(1 0 0 / 0.08)", borderRadius: 10,
    overflow: "hidden",
  },
  resCap: {
    display: "flex", justifyContent: "space-between",
    padding: "14px 22px",
    fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em",
    color: "oklch(0.556 0 0)",
    background: "oklch(0.18 0 0)",
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
  },
  resCapMeta: { color: "oklch(0.443 0 0)" },
  resTbl: { width: "100%", borderCollapse: "collapse", fontSize: 13.5, fontFamily: "var(--font-mono)" },
  resName: { padding: "11px 22px", color: "oklch(0.985 0 0)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  resNum: { padding: "11px 16px", textAlign: "right", color: "oklch(0.871 0 0)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  resUp: { padding: "11px 16px", textAlign: "right", color: "var(--atlas-brand)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  resDown: { padding: "11px 16px", textAlign: "right", color: "oklch(0.7 0.16 22)", borderTop: "1px solid oklch(1 0 0 / 0.04)" },
  bar: { display: "inline-block", height: 6, borderRadius: 1, verticalAlign: "middle" },

  /* COLUMNS GRID */
  colsGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, borderTop: "1px solid oklch(1 0 0 / 0.1)", borderLeft: "1px solid oklch(1 0 0 / 0.1)" },
  colCard: {
    padding: "32px 28px",
    borderRight: "1px solid oklch(1 0 0 / 0.1)",
    borderBottom: "1px solid oklch(1 0 0 / 0.1)",
  },
  colHead: { display: "flex", gap: 10, alignItems: "baseline", marginBottom: 14 },
  colNum: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--atlas-brand)", letterSpacing: "0.12em" },
  colName: { fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" },
  colBody: { fontSize: 14, lineHeight: 1.6, color: "oklch(0.708 0 0)", margin: "0 0 18px" },
  colCode: {
    background: "oklch(0.18 0 0)",
    border: "1px solid oklch(1 0 0 / 0.05)",
    borderRadius: 6, padding: "10px 12px", margin: 0,
    fontFamily: "var(--font-mono)", fontSize: 11.5,
    color: "oklch(0.708 0 0)", lineHeight: 1.7, whiteSpace: "pre",
  },

  /* DEPLOY COMPARE */
  deployCmp: { border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 10, overflow: "hidden" },
  deployRow: {
    display: "grid", gridTemplateColumns: "1fr 200px 1fr",
    fontSize: 14,
    borderTop: "1px solid oklch(1 0 0 / 0.06)",
  },
  deployRowH: {
    display: "grid", gridTemplateColumns: "1fr 200px 1fr",
    background: "oklch(0.18 0 0)",
  },
  deployHead: {
    fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.14em",
    textTransform: "uppercase", color: "oklch(0.708 0 0)",
    padding: "16px 24px", textAlign: "center",
  },
  deployA: { padding: "16px 24px", color: "oklch(0.871 0 0)" },
  deployA1: { padding: "16px 24px", fontSize: 22, fontWeight: 600, color: "oklch(0.985 0 0)" },
  deployB: { padding: "16px 24px", color: "oklch(0.871 0 0)", textAlign: "right" },
  deployB1: { padding: "16px 24px", fontSize: 22, fontWeight: 600, color: "var(--atlas-brand)", textAlign: "right" },
  deployMid: {
    padding: "16px 16px", textAlign: "center",
    fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.14em",
    textTransform: "uppercase", color: "oklch(0.443 0 0)",
    borderLeft: "1px solid oklch(1 0 0 / 0.06)",
    borderRight: "1px solid oklch(1 0 0 / 0.06)",
    background: "oklch(0.16 0 0)",
  },
  deployCtaRow: {
    display: "grid", gridTemplateColumns: "1fr 200px 1fr",
    background: "oklch(0.16 0 0)",
    borderTop: "1px solid oklch(1 0 0 / 0.06)",
  },
  deployCtaA: { padding: "20px 24px", display: "flex", alignItems: "center", gap: 14 },
  deployCtaB: { padding: "20px 24px", display: "flex", alignItems: "center", gap: 14, justifyContent: "flex-end" },
  deployCmd: {
    fontFamily: "var(--font-mono)", fontSize: 13,
    padding: "10px 14px", border: "1px solid oklch(1 0 0 / 0.12)",
    borderRadius: 6, color: "oklch(0.985 0 0)",
    background: "#0C0C10",
  },
  deployCmdNote: { fontFamily: "var(--font-mono)", fontSize: 10.5, color: "oklch(0.443 0 0)", letterSpacing: "0.06em" },

  /* LETTERS */
  lettersGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 28 },
  letter: {
    borderTop: "1px solid oklch(1 0 0 / 0.1)",
    paddingTop: 22,
  },
  letterMark: { color: "var(--atlas-brand)", fontSize: 24, marginBottom: 14, lineHeight: 1 },
  letterBody: {
    fontFamily: "'Sora'",
    fontStyle: "italic",
    fontSize: 18, lineHeight: 1.5, fontWeight: 400,
    color: "oklch(0.871 0 0)", margin: "0 0 22px",
    letterSpacing: "-0.01em",
  },
  letterSig: { display: "flex", flexDirection: "column", gap: 4 },
  letterFrom: {
    fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.04em",
    color: "oklch(0.985 0 0)",
  },
  letterPlace: {
    fontFamily: "var(--font-mono)", fontSize: 10.5,
    color: "oklch(0.443 0 0)", letterSpacing: "0.04em",
  },

  /* COLOPHON */
  colophon: {
    padding: "44px 56px",
    borderTop: "2px solid oklch(1 0 0 / 0.15)",
    background: "oklch(0.12 0 0)",
  },
  colTop: { display: "grid", gridTemplateColumns: "1.4fr 2fr", gap: 36, marginBottom: 32 },
  colBrand: { display: "flex", alignItems: "center", gap: 12 },
  colBrandWord: { fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" },
  colBrandTag: {
    fontFamily: "var(--font-mono)", fontSize: 11,
    color: "oklch(0.443 0 0)", marginLeft: 12, letterSpacing: "0.04em",
  },
  colCols: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 },
  colHeadF: {
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em",
    textTransform: "uppercase", color: "oklch(0.443 0 0)", marginBottom: 12,
  },
  colLink: { fontSize: 13, color: "oklch(0.708 0 0)", padding: "4px 0" },
  colBottom: {
    paddingTop: 18, borderTop: "1px solid oklch(1 0 0 / 0.05)",
    display: "flex", justifyContent: "space-between",
    fontFamily: "var(--font-mono)", fontSize: 10.5,
    letterSpacing: "0.06em", color: "oklch(0.443 0 0)",
  },
};

window.EditorialVariant = EditorialVariant;
