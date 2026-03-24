# Show HN: Atlas -- Open-source text-to-SQL agent you can embed in any app

Atlas is an open-source (MIT) text-to-SQL agent that deploys as an API server and embeds into any application. Drop in a `<script>` tag or React component and your users can query their data in plain English.

**What makes it different:**

- **Embeddable** -- A chat widget you add to your app with one line of code, not a standalone BI tool your users have to context-switch into. Script tag, React component, or raw API.
- **Semantic layer** -- YAML files describe your schema, business terms, and metrics. The agent reads them before writing SQL, so it understands "churn rate" means what your team means, not what GPT guesses.
- **Read-only by design** -- 4-layer SQL validation pipeline. Only SELECT, only whitelisted tables, auto LIMIT, statement timeout. No writes, ever.
- **Plugin ecosystem** -- 15+ plugins for datasources (Postgres, MySQL, BigQuery, ClickHouse, Snowflake, DuckDB, Salesforce), sandboxed Python execution, Slack, MCP, email actions, and more.
- **Deploy anywhere** -- One-click Railway/Vercel, Docker, or `bun create atlas-agent` to scaffold a new project.

We built Atlas because text-to-SQL is a feature every data-heavy app needs, but the existing tools are all standalone products. We wanted something you could ship inside your own product in an afternoon.

Live demo: https://demo.useatlas.dev
Docs: https://docs.useatlas.dev
GitHub: https://github.com/AtlasDevHQ/atlas
