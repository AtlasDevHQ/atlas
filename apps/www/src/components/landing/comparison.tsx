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
      "YAML on disk: query_patterns, virtual_dimensions, glossary.status: ambiguous, metrics.objective are all first-class",
    bi: "Proprietary metadata, GUI-authored",
    textToSql: "None or limited",
  },
  {
    feature: "Agent-native",
    atlas:
      "MCP server first (stdio + Streamable HTTP): Claude Desktop, Cursor, Continue with bunx @useatlas/mcp init; read tools open, datasource writes gated by OAuth scope + RBAC",
    bi: "Bolted-on AI feature",
    textToSql: "Standalone chat UI",
  },
  {
    feature: "Embeddable",
    atlas:
      "Script-tag widget, <AtlasChat /> React component, typed @useatlas/sdk, MCP, 6 chat platforms (Slack live; Google Chat coming soon)",
    bi: "Standalone app",
    textToSql: "Standalone app",
  },
  {
    feature: "Long-running turns",
    atlas:
      "Durable agent loop: a turn interrupted by a deploy, crash, or serverless timeout resumes from its last checkpoint — security re-verified on resume",
    bi: "N/A",
    textToSql: "Restarts from scratch",
  },
  {
    feature: "Semantic layer editing",
    atlas:
      "Author entities, dimensions, measures, joins and query patterns in the in-product admin editor — or as YAML in your repo, versioned in PRs",
    bi: "GUI-only, proprietary store",
    textToSql: "None",
  },
  {
    feature: "Dashboards as conversations",
    atlas:
      "Chat drawer is the editor: per-user drafts + atomic three-way-merge Publish over a versioned baseline; bound-mode editing keeps the agent on the dashboard you opened",
    bi: "Static dashboards with separate edit mode",
    textToSql: "No dashboards",
  },
  {
    feature: "Chat-platform reach",
    atlas:
      "Slack-native: answers questions in opt-in channels with a reaction-first tracer, fail-closed kill switch (paid plans)",
    bi: "Web app only; context-switch out of Slack",
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
    atlas:
      "24 plugins across 5 types (datasource, context, interaction, action, sandbox); author your own with @useatlas/plugin-sdk and install from the in-product registry",
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
      "PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, BigQuery, Elasticsearch / OpenSearch, Salesforce",
    bi: "Usually one",
    textToSql: "Usually one",
  },
  {
    feature: "REST APIs as datasources",
    atlas:
      "Stripe, GitHub, Notion, any OpenAPI spec: read like a datasource, write-gated; generic OpenAPI installs auto-refresh",
    bi: "None",
    textToSql: "None",
  },
];

// ---------------------------------------------------------------------------
// CLAIM-ACCURACY NOTE (#3994). Every cell above is verified against shipped
// code. Specifically:
//   - "Multi-database" lists only queryable read datasources. Elasticsearch
//     and OpenSearch are one unified plugin (engine flag), so both are named.
//     Twenty (CRM) and Obsidian are deliberately NOT here — Twenty is an
//     action/write target and Obsidian is a surface + vault-reader action,
//     not analytics datasources.
//   - "24 plugins across 5 types" = directories under plugins/ whose
//     definePlugin() declares a PluginType (the `obsidian` client app extends
//     Obsidian's own Plugin class and declares none, so it's excluded). This
//     is the CANONICAL plugin count + counting rule (#4066). It is no longer
//     hand-maintained: scripts/check-plugin-count.sh derives it from plugins/
//     and fails CI if this cell — or any other surface in that script's
//     authoritative SURFACES list (README, the docs comparisons, llms.txt, the
//     launch posts, the blog page, the brand-asset generator) — drifts from the
//     derived total. The per-type breakdown below is point-in-time context, not
//     an enforced figure: as of #4066, 25 dirs under plugins/, 24 declare a
//     PluginType (only `obsidian` excluded) — 7 datasource, 6 sandbox,
//     5 interaction, 5 action, 1 context = 24. Bump this cell when CI says so.
//   - The REST/OpenAPI datasources named on the landing page (Stripe, Notion,
//     GitHub, any OpenAPI spec) are OpenAPI presets in
//     packages/api/src/lib/openapi/data-candidates.ts, NOT plugins/ entries —
//     the absence of a plugins/github dir is expected, not drift.
//   - "Long-running turns", "Semantic layer editing", MCP stdio+SSE, and the
//     @useatlas/sdk / <AtlasChat /> embed claims are each backed by shipped
//     packages — see #3994 for the verification trail.
// Do not add a capability row without the same verification.
// ---------------------------------------------------------------------------

export function Comparison() {
  return (
    <section className="px-6 pb-24 md:px-16">
      <div
        className="mx-auto max-w-5xl overflow-hidden rounded-xl border border-border"
        style={{ background: "var(--bg-raised)" }}
      >
        {/* Mobile-first: stack rows. Desktop: 4-col grid. */}
        <div className="hidden grid-cols-[200px_1fr_1fr_1fr] border-b border-border-soft md:grid">
          <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-fg-muted">
            feature
          </div>
          {COLUMNS.map((col) => (
            <div
              key={col.id}
              className={`px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] ${
                col.tone === "brand" ? "text-accent" : "text-fg-muted"
              }`}
            >
              {col.label}
            </div>
          ))}
        </div>

        {ROWS.map((row, i) => (
          <div
            key={row.feature}
            className="grid grid-cols-1 border-b border-border-soft last:border-b-0 md:grid-cols-[200px_1fr_1fr_1fr]"
            style={{
              background: i % 2 ? "var(--bg-sunken)" : "transparent",
            }}
          >
            <div className="px-4 py-3 font-mono text-[12.5px] font-medium text-fg">
              {row.feature}
            </div>
            {COLUMNS.map((col) => (
              <div
                key={col.id}
                className={`px-4 py-3 text-[13px] leading-[1.55] ${
                  col.tone === "brand" ? "text-fg" : "text-fg-muted"
                }`}
              >
                <span
                  className={`md:hidden font-mono text-[10.5px] uppercase tracking-[0.06em] ${
                    col.tone === "brand" ? "text-accent" : "text-fg-faint"
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
