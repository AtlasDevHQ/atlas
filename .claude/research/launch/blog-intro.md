# Why We Built Atlas: Text-to-SQL Is a Feature, Not a Product

Every data-heavy application eventually gets the same feature request: "Can I just ask a question about my data?" Sales teams want pipeline numbers without opening a BI tool. Support teams want to look up customer metrics mid-conversation. Product managers want to check engagement data without waiting for an analyst.

The answer today is usually one of three things: build a custom dashboard (expensive, rigid), give users access to a BI tool (context switch, training overhead), or hire more analysts (doesn't scale). Text-to-SQL has been the promising fourth option for years, but every implementation we've seen treats it as a standalone product -- another tool your users have to log into, another dashboard to maintain, another vendor to evaluate.

We think that's backwards. Text-to-SQL should be a feature you embed in the tools people already use, not a destination you send them to.

## The Problem with Standalone Text-to-SQL

The current generation of text-to-SQL tools -- WrenAI, Vanna, Metabase's AI features -- are all standalone applications. They have their own auth, their own UI, their own deployment. They're designed to be the product, not a component of your product.

This creates real friction:

- **Context switching** -- Your users leave your app, open another tool, ask their question, then come back. The data they need is one tab away, but it might as well be a different continent.
- **Auth duplication** -- You already authenticate your users. Now you need to sync those users to another system, manage another set of permissions, audit another access log.
- **Deployment complexity** -- Another service to deploy, monitor, and scale. Another thing that can go wrong at 2am.
- **No customization** -- You can't control what the AI says, how it reasons about your data, or what actions it can take after generating a query.

For teams building internal tools, this friction is annoying. For teams building customer-facing products, it's a dealbreaker. You can't send your customers to a third-party BI tool with your database credentials.

## Atlas: Embed a Data Analyst in Your App

Atlas is an open-source text-to-SQL agent that deploys as an API server and embeds into any application. It's MIT licensed, runs on your infrastructure, and connects to the databases you already use.

Here's what that means in practice:

### One Line to Embed

Add a `<script>` tag to any page and your users get a chat widget that queries your database. Or use the React component for tighter integration. Or hit the API directly for full control.

```html
<script src="https://your-atlas.example.com/widget.js"
  data-api-url="https://your-atlas.example.com"
  data-position="bottom-right">
</script>
```

Your users ask questions in plain English. Atlas writes SQL, validates it, runs it, and returns the results -- with charts, tables, and follow-up suggestions.

### Semantic Layer, Not Prompt Engineering

Atlas doesn't guess at your schema. Before it writes a single query, it reads a semantic layer -- YAML files that describe your tables, columns, business terms, and key metrics. When a user asks about "monthly recurring revenue," Atlas knows exactly which table, which column, and which calculation to use.

```yaml
table: subscriptions
dimensions:
  mrr:
    type: number
    description: Monthly recurring revenue in USD
    sql: amount / 12
```

This is the difference between a demo that works on simple queries and a system that handles the messy reality of production databases with 60+ tables, legacy naming conventions, and business logic that lives in tribal knowledge.

### Read-Only by Design

Every query goes through a 4-layer validation pipeline: regex guard, AST parsing, table whitelist, and auto LIMIT. Only SELECT statements against tables defined in your semantic layer. No writes, no shell escapes, no surprises.

When you need the agent to take action -- send an email, create a JIRA ticket, trigger a webhook -- that goes through a separate approval framework with explicit user confirmation.

### Plugin Ecosystem

Atlas ships with 15+ official plugins:

- **Datasources** -- PostgreSQL and MySQL built-in, plus plugins for BigQuery, ClickHouse, Snowflake, DuckDB, and Salesforce
- **Sandboxes** -- Run Python for data analysis in nsjail, a sidecar container, E2B, Daytona, or Vercel's sandbox
- **Interactions** -- Slack bot, MCP server for AI coding tools
- **Actions** -- Email, JIRA, with an approval workflow

Build your own with `bun create @useatlas/plugin` and the Plugin SDK.

### Deploy Anywhere

One-click deploy to Railway or Vercel. Docker image for self-hosted. Or scaffold a new project with `bun create @useatlas` and customize everything.

Atlas is a Hono API server + Next.js frontend. It runs on Bun, deploys as two containers (API + optional sandbox sidecar), and connects to your existing Postgres, MySQL, or any supported datasource.

## Why Now

Three things changed that made Atlas possible:

1. **LLMs got good enough at SQL** -- GPT-4, Claude, and open models can write correct SQL for complex queries. The bottleneck isn't the model anymore; it's the context you give it.
2. **The AI SDK standardized tool use** -- Vercel's AI SDK gives us a clean abstraction for streaming, tool calling, and multi-step agent loops. We don't have to reinvent the plumbing.
3. **Embedding is the deployment model** -- The shift from standalone SaaS to embedded components (Stripe Elements, Auth0 Lock, Intercom) proved that developer-facing features work best when they live inside the host application.

Atlas is open source under MIT. We think text-to-SQL is infrastructure -- it should be free to use, modify, and deploy without vendor lock-in.

**Try it out:**
- Live demo: [demo.useatlas.dev](https://demo.useatlas.dev)
- Docs: [docs.useatlas.dev](https://docs.useatlas.dev)
- GitHub: [github.com/AtlasDevHQ/atlas](https://github.com/AtlasDevHQ/atlas)
- Get started: `bun create @useatlas`
