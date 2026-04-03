# Atlas Launch Thread — Twitter/X

> Draft for @AtlasDevHQ launch announcement.
> Each tweet is under 280 characters. Post as a thread.

---

## Tweet 1 (Hook)

We just open-sourced Atlas — a text-to-SQL agent that connects to your database, reads a semantic layer to understand your schema, validates every query, and runs it.

Self-host with Docker or use Atlas Cloud. AGPL-3.0.

github.com/AtlasDevHQ/atlas

---

## Tweet 2 (The problem)

Every data team is pasting schemas into ChatGPT to write SQL.

It works until it doesn't. The AI guesses what `fact_txn_amt` means, misses soft-delete filters, calculates metrics before discounts.

Atlas gives the AI actual business context instead of column names.

---

## Tweet 3 (Semantic layer)

How: a YAML semantic layer that describes what your tables and columns mean — business definitions, joins, metrics, sample values.

`atlas init` auto-generates it from your database. You version it in git and review changes in PRs.

No training data. No vector DB. No fine-tuning.

---

## Tweet 4 (Safety)

Every query passes through 7 validation layers before it touches your database:

- AST parse (single SELECT only)
- Table whitelist (semantic layer entities only)
- Row-level security injection
- Auto LIMIT + statement timeout

~170 unit tests on the SQL pipeline alone.

---

## Tweet 5 (What ships)

What ships in 1.0:

- 7 databases (Postgres, MySQL, BigQuery, ClickHouse, DuckDB, Snowflake, Salesforce)
- 20+ plugins (Slack, Teams, Discord, MCP, webhooks)
- Embeddable React widget + TypeScript SDK
- Admin console, audit logs, SSO/SCIM
- Effect.ts backend architecture

---

## Tweet 6 (Deploy anywhere)

Deploy anywhere:

- `bun create @useatlas my-app` for local dev
- Docker, Railway, or Vercel for production
- Atlas Cloud (app.useatlas.dev) if you don't want infrastructure

Self-hosted is free, every feature, no limits. Cloud is for teams that want managed infra.

---

## Tweet 7 (CTA)

Try it now — no signup needed:

demo.useatlas.dev

60 tables, 200K rows of realistic cybersecurity SaaS data. Ask it anything.

Star the repo if this is useful: github.com/AtlasDevHQ/atlas

Docs: docs.useatlas.dev
