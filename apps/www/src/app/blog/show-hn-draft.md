# Show HN: Atlas – open-source text-to-SQL agent with a semantic layer

Atlas is an open-source (AGPL-3.0) text-to-SQL agent. You connect it to your database (Postgres, MySQL, BigQuery, ClickHouse, DuckDB, Snowflake, or Salesforce), it auto-profiles your schema into a YAML semantic layer, and then an AI agent uses that context to write and execute validated SQL from natural language questions.

The semantic layer is the key idea. Instead of feeding raw schema to the LLM and hoping it infers what `fact_txn_amt` means, Atlas reads YAML files that describe each table's columns, types, sample values, business definitions, joins, and metrics. The agent sees "net_revenue = SUM(total - discount - refund_amount), exclude rows where is_deleted = true" instead of guessing from column names. You version these files in git and review changes in PRs.

Every generated query passes through a 7-layer validation pipeline before it touches the database: empty check → regex mutation guard → AST parse (single SELECT only, via node-sql-parser) → table whitelist (only semantic layer entities are queryable) → row-level security injection → auto LIMIT → statement timeout. The SQL validation pipeline has ~170 unit tests. The goal is defense-in-depth — any single layer can fail, but all 7 would need to fail simultaneously for a dangerous query to execute.

Tech stack: TypeScript end-to-end (Hono API + Next.js frontend + bun runtime), Vercel AI SDK for the agent loop, Effect.ts for structured concurrency and typed errors on the backend. Deploy with Docker, Railway, or Vercel. There's also a managed cloud at app.useatlas.dev if you don't want to run infrastructure.

Other things it does: 20+ plugins (datasource adapters, Slack/Teams/Discord bots via Chat SDK, MCP server, webhooks), sandboxed Python execution for charts and analysis (nsjail or Firecracker), admin console, embeddable React widget and script tag, TypeScript SDK, headless API.

Demo (cybersecurity SaaS dataset, 60 tables, 200K rows): https://demo.useatlas.dev

GitHub: https://github.com/AtlasDevHQ/atlas

Docs: https://docs.useatlas.dev

Quick start:

    bun create @useatlas my-app --demo
    cd my-app && bun run dev

Would love feedback on the semantic layer approach vs RAG-based training (like Vanna) — we think explicit YAML definitions are more auditable and predictable, but the trade-off is more upfront work (though atlas init automates the initial generation).
