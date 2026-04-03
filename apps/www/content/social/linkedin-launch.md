# Atlas Launch Post — LinkedIn

> Draft for LinkedIn launch announcement.
> Professional tone. 3-4 paragraphs, problem-solution-differentiation-CTA structure.

---

Every data team we talk to is already using AI to write SQL. They paste their schema into ChatGPT, describe the question, copy the query back into their database client, and hope it works. It works often enough to be useful, but it fails in ways that are hard to catch: wrong column references, missing filters for soft-deleted rows, metrics calculated on gross instead of net. The AI doesn't know your business rules — it guesses from column names.

Today we're open-sourcing Atlas, a text-to-SQL agent that solves this differently. Instead of training on historical queries or fine-tuning a model, Atlas uses a YAML semantic layer that explicitly describes what your tables and columns mean — business definitions, join logic, metric formulas, sample values. You run `atlas init` against your database and it auto-generates these files. From there, you version them in git and review changes in pull requests. The AI sees "net_revenue = SUM(total - discount - refund_amount), exclude rows where is_deleted = true" instead of guessing from a column called `fact_txn_amt`. Every generated query passes through a 7-layer validation pipeline — AST parsing, table whitelisting, row-level security injection, auto LIMIT, statement timeout — before it touches your database.

Atlas ships with 7 database adapters (PostgreSQL, MySQL, BigQuery, ClickHouse, DuckDB, Snowflake, Salesforce), 20+ plugins (Slack, Teams, Discord, MCP server, webhooks), an embeddable React widget, TypeScript SDK, admin console, and enterprise features like SSO/SCIM, custom roles, and audit log export. It's built in TypeScript end-to-end (Hono + Next.js + Effect.ts + bun) and deploys with Docker, Railway, or Vercel. The core is AGPL-3.0 licensed — self-host the full product for free, every feature, no artificial limits. Atlas Cloud (app.useatlas.dev) is the managed option for teams that don't want to run infrastructure.

Try the live demo at demo.useatlas.dev — no signup, no installation. It's connected to a cybersecurity SaaS dataset with 60 tables and 200K rows of realistic data. Source code and quick start: github.com/AtlasDevHQ/atlas
