type Row = {
  feature: string;
  atlas: string;
  bi: string;
  textToSql: string;
};

const ROWS: ReadonlyArray<Row> = [
  {
    feature: "Semantic layer",
    atlas:
      "YAML on disk — query_patterns, virtual_dimensions, glossary.status: ambiguous, metrics.objective are all first-class",
    bi: "Proprietary metadata, GUI-authored",
    textToSql: "None or limited",
  },
  {
    feature: "Agent-native",
    atlas:
      "MCP server first — Claude Desktop, Cursor, Continue with bunx @useatlas/mcp init",
    bi: "Bolted-on AI feature",
    textToSql: "Standalone chat UI",
  },
  {
    feature: "Embeddable",
    atlas: "Script tag, React component, headless API, MCP, Slack, Teams",
    bi: "Standalone app",
    textToSql: "Standalone app",
  },
  {
    feature: "Deploy anywhere",
    atlas: "Docker, Railway, Vercel, or your own infra",
    bi: "Vendor-hosted",
    textToSql: "Vendor-hosted",
  },
  {
    feature: "Plugin ecosystem",
    atlas: "21 plugins across 5 types — extend anything",
    bi: "Closed",
    textToSql: "Limited",
  },
  {
    feature: "Open source",
    atlas: "AGPL-3.0 core, MIT client libs",
    bi: "Proprietary",
    textToSql: "Varies",
  },
  {
    feature: "Multi-database",
    atlas:
      "PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, BigQuery, Salesforce",
    bi: "Usually one",
    textToSql: "Usually one",
  },
];

export function Comparison() {
  return (
    <section
      id="why-atlas"
      className="scroll-mt-20 border-b border-white/5 px-6 pt-20 pb-16 md:px-16 md:pt-[88px] md:pb-[72px]"
    >
      <header className="mb-10 max-w-[720px]">
        <p className="mb-4 font-mono text-[11.5px] uppercase tracking-[0.16em] text-brand">
          // why atlas
        </p>
        <h2 className="m-0 mb-4 text-[36px] md:text-[46px] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-50">
          Three columns. One choice.
        </h2>
        <p className="m-0 text-base leading-[1.65] text-zinc-400">
          The same comparison from the README — same words, same scoring, no claim drift across surfaces.
        </p>
      </header>

      <div
        className="overflow-hidden rounded-xl border border-white/10"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        {/* Mobile-first: stack rows. Desktop: 4-col grid. */}
        <div className="hidden grid-cols-[200px_1fr_1fr_1fr] border-b border-white/5 md:grid">
          <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-zinc-400">
            feature
          </div>
          <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-brand">
            atlas
          </div>
          <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-zinc-400">
            traditional bi
          </div>
          <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-zinc-400">
            other text-to-sql
          </div>
        </div>

        {ROWS.map((row, i) => (
          <div
            key={row.feature}
            className="grid grid-cols-1 border-b border-white/5 last:border-b-0 md:grid-cols-[200px_1fr_1fr_1fr]"
            style={{
              background: i % 2 ? "oklch(0.14 0 0)" : "transparent",
            }}
          >
            <div className="px-4 py-3 font-mono text-[12.5px] font-medium text-zinc-50">
              {row.feature}
            </div>
            <div className="px-4 py-3 text-[13px] leading-[1.55] text-zinc-200">
              <span className="md:hidden font-mono text-[10.5px] uppercase tracking-[0.06em] text-brand">
                Atlas:{" "}
              </span>
              {row.atlas}
            </div>
            <div className="px-4 py-3 text-[13px] leading-[1.55] text-zinc-400">
              <span className="md:hidden font-mono text-[10.5px] uppercase tracking-[0.06em] text-zinc-500">
                Traditional BI:{" "}
              </span>
              {row.bi}
            </div>
            <div className="px-4 py-3 text-[13px] leading-[1.55] text-zinc-400">
              <span className="md:hidden font-mono text-[10.5px] uppercase tracking-[0.06em] text-zinc-500">
                Other text-to-SQL:{" "}
              </span>
              {row.textToSql}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
