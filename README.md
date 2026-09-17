<h1 align="center">Atlas</h1>

<p align="center">
  <strong>Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.</strong>
</p>

<p align="center">
  <a href="https://github.com/AtlasDevHQ/atlas/actions/workflows/ci.yml"><img src="https://github.com/AtlasDevHQ/atlas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@useatlas/mcp"><img src="https://img.shields.io/npm/v/@useatlas/mcp?label=%40useatlas%2Fmcp" alt="npm"></a>
  <a href="https://github.com/AtlasDevHQ/atlas/blob/main/LICENSE"><img src="https://img.shields.io/github/license/AtlasDevHQ/atlas" alt="License"></a>
</p>

> **The hosted service is shut down.** I ran Atlas as a hosted service at useatlas.dev until September 2026 and have now turned it off, along with the hosted demo and docs.useatlas.dev. Atlas continues as open source: everything below runs on your own machine or in your own VPC. The docs live in [`apps/docs/content`](apps/docs/content).

Point Claude Desktop, Cursor or Continue at a local Atlas with one command. With no datasource configured it uses the bundled NovaMart demo data:

```bash
bunx @useatlas/mcp init --local --write
```

Restart the client and ask it a question about NovaMart's orders. (Claude Code, VS Code and other clients: the same command with `--client generic` prints a block to paste. On WSL2, write `bun x` instead of `bunx`.)

## How it works

Three kinds of thing live in the Atlas, and every answer says which it is drawing on:

1. **Surveyed** — read straight from your company's own data through a semantic layer you author. True by construction: the query re-reads live rows, nobody interpreted anything, and it cannot go stale between readings. SELECT-only, single statement, table-whitelisted, validated seven ways before it runs.
2. **Attested** — extracted from something someone wrote, then approved by a named person in your company. That person is on the record, and the fact carries its source and its date.
3. **On the record** — the raw source material itself, unedited. Trustworthy as testimony, not as fact.

Surveyed outranks Attested wherever they overlap, so a recollection never overwrites the data. Nothing becomes Attested without a person approving it, and there is no setting that turns that off. Contradictions are shown with both claims and both sources; Atlas does not pick a winner. Where nobody has surveyed, the coverage page says so instead of guessing.

## Run it

- **Self-hosted** — the complete Atlas under AGPL, in your VPC, free; Docker, Railway or Vercel. [Self-host quick start](apps/docs/content/self-hosted/getting-started/quick-start.mdx).
- **From your AI agent** — `bunx @useatlas/mcp init --local` against a local Atlas, or `bunx @useatlas/mcp init --hosted --api-url <your Atlas>` against a self-hosted one with managed auth. [MCP guide](apps/docs/content/shared/guides/mcp.mdx).

## Where everything else went

This README used to inventory the whole product. Each section now lives on one docs page, in the docs source:

- The four context surfaces (semantic layer, Knowledge Base, learned patterns, the Company Atlas) and where answers show up — [Introduction](apps/docs/content/docs/index.mdx)
- The YAML semantic layer and a worked `orders.yml` — [Semantic layer](apps/docs/content/shared/getting-started/semantic-layer.mdx)
- The NovaMart dataset and the canonical questions — [Demo datasets](apps/docs/content/shared/getting-started/demo-datasets.mdx)
- The local scaffold (`bun create atlas-agent`) — [Self-host quick start](apps/docs/content/self-hosted/getting-started/quick-start.mdx)
- The embeddable widget and React component — [Embedding widget](apps/docs/content/shared/guides/embedding-widget.mdx)
- How Atlas compares to Genie, Cortex Analyst, Hyper, Glean and the text-to-SQL peers — [Comparisons](apps/docs/content/shared/comparisons/index.mdx)
- Deploy buttons, starters and Docker Compose — [Deploy](apps/docs/content/self-hosted/deployment/deploy.mdx)
- The SQL validation pipeline and sandbox threat model — [SQL validation](apps/docs/content/shared/security/sql-validation.mdx), [Sandbox architecture](apps/docs/content/shared/architecture/sandbox.mdx)
- Environment variables — [Reference](apps/docs/content/shared/reference/environment-variables.mdx) and [`.env.example`](.env.example)
- Plugins, datasources, chat platforms and connectors — [Plugin authoring](apps/docs/content/shared/plugins/authoring-guide.mdx), [Integrations](apps/docs/content/shared/guides/integrations.mdx)
- Supported databases and LLM providers — [Connect your data](apps/docs/content/shared/getting-started/connect-your-data.mdx), [Model routing](apps/docs/content/docs/guides/model-routing.mdx)
- The Knowledge Base, dashboards, and bringing your own frontend — [Knowledge Base](apps/docs/content/docs/guides/knowledge-base.mdx), [Dashboards](apps/docs/content/docs/guides/dashboards.mdx), [Frameworks](apps/docs/content/self-hosted/frameworks/overview.mdx)
- The CLI (`atlas init`, `atlas diff`, and the rest) — [CLI reference](apps/docs/content/shared/reference/cli.mdx)
- The monorepo layout and dev setup — [CONTRIBUTING.md](CONTRIBUTING.md)
- What is open source and what is commercial — [Enterprise boundary](apps/docs/content/shared/architecture/enterprise.mdx)

## Acknowledgments

Atlas was inspired by [Abhi Sivasailam](https://x.com/_abhisivasailam)'s work on Vercel's internal data agent **d0** and the open-source [vercel-labs/oss-data-analyst](https://github.com/vercel-labs/oss-data-analyst) template. The core insight — invest in a rich semantic layer, trust the model, and keep the tool surface minimal — came from that work.

## License

The server and core packages are [AGPL-3.0](LICENSE): if you modify the server and serve it to users, you share those modifications. The client libraries (`@useatlas/sdk`, `@useatlas/react`, `@useatlas/types`, `@useatlas/plugin-sdk`, `@useatlas/mcp`) and all plugins are [MIT](packages/sdk/LICENSE). The `ee/` directory is source-available under a [commercial license](ee/LICENSE); nothing that makes the Atlas work is behind it — only governance, convenience and scale. Full inventory: [Enterprise boundary](apps/docs/content/shared/architecture/enterprise.mdx).
