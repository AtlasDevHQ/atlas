const COLUMNS = [
  { id: "atlas", label: "atlas", mobileLabel: "Atlas", tone: "brand" },
  { id: "bi", label: "traditional bi", mobileLabel: "Traditional BI", tone: "muted" },
  { id: "textToSql", label: "other text-to-sql", mobileLabel: "Other text-to-SQL", tone: "muted" },
] as const;

type ColumnId = (typeof COLUMNS)[number]["id"];

type Row = { readonly feature: string } & Readonly<Record<ColumnId, string>>;

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
      "MCP server first — Claude Desktop, Cursor, Continue with bunx @useatlas/mcp init; read tools open, datasource writes gated by OAuth scope + RBAC",
    bi: "Bolted-on AI feature",
    textToSql: "Standalone chat UI",
  },
  {
    feature: "Embeddable",
    atlas: "Script tag, React component, headless API, MCP, 6 chat platforms",
    bi: "Standalone app",
    textToSql: "Standalone app",
  },
  {
    feature: "Dashboards as conversations",
    atlas:
      "Chat drawer is the editor — per-user drafts + atomic three-way-merge Publish over a persisted baseline",
    bi: "Static dashboards with separate edit mode",
    textToSql: "No dashboards",
  },
  {
    feature: "Chat-platform reach",
    atlas:
      "Slack-native — answers questions in opt-in channels with a reaction-first tracer, fail-closed kill switch (paid plans)",
    bi: "Web app only — context-switch out of Slack",
    textToSql: "Web app only",
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
      "PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, BigQuery, Elasticsearch, Salesforce",
    bi: "Usually one",
    textToSql: "Usually one",
  },
  {
    feature: "REST APIs as datasources",
    atlas:
      "Stripe, GitHub, Notion, any OpenAPI spec — read like a datasource, write-gated; generic OpenAPI installs auto-refresh",
    bi: "None",
    textToSql: "None",
  },
];

export function Comparison() {
  return (
    <section className="px-6 pb-24 md:px-16">
      <div
        className="mx-auto max-w-5xl overflow-hidden rounded-xl border border-white/10"
        style={{ background: "oklch(0.16 0 0)" }}
      >
        {/* Mobile-first: stack rows. Desktop: 4-col grid. */}
        <div className="hidden grid-cols-[200px_1fr_1fr_1fr] border-b border-white/5 md:grid">
          <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-zinc-400">
            feature
          </div>
          {COLUMNS.map((col) => (
            <div
              key={col.id}
              className={`px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] ${
                col.tone === "brand" ? "text-brand" : "text-zinc-400"
              }`}
            >
              {col.label}
            </div>
          ))}
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
            {COLUMNS.map((col) => (
              <div
                key={col.id}
                className={`px-4 py-3 text-[13px] leading-[1.55] ${
                  col.tone === "brand" ? "text-zinc-200" : "text-zinc-400"
                }`}
              >
                <span
                  className={`md:hidden font-mono text-[10.5px] uppercase tracking-[0.06em] ${
                    col.tone === "brand" ? "text-brand" : "text-zinc-500"
                  }`}
                >
                  {col.mobileLabel}:{" "}
                </span>
                {row[col.id]}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
