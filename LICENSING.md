# Licensing

Atlas uses a split license model:

## AGPL-3.0 — Server & Core

The following packages are licensed under the [GNU Affero General Public License v3.0](LICENSE):

- `@atlas/api` — Hono API server, agent loop, tools, auth, DB
- `@atlas/cli` — CLI profiler, schema diff, enrichment
- `@atlas/web` — Next.js frontend and chat UI
- `@atlas/mcp` — MCP server (stdio + SSE transport)
- `@atlas/sandbox-sidecar` — Isolated explore/python sidecar
- `apps/www` — Landing page
- `apps/docs` — Documentation site

**What this means:** You can freely use, modify, and self-host Atlas. If you modify the server code and serve it to users over a network, you must share those modifications under AGPL-3.0.

## MIT — Client Libraries, Plugins & Tools

The following packages are licensed under the [MIT License](packages/sdk/LICENSE):

- `@useatlas/sdk` — TypeScript SDK
- `@useatlas/react` — Embeddable React chat component
- `@useatlas/types` — Shared TypeScript types
- `@useatlas/plugin-sdk` — Plugin type definitions
- All packages under `plugins/`
- `create-atlas` — Scaffolding CLI
- `examples/` — Example deployments

**What this means:** Embed these in proprietary applications with no restrictions. The MIT client libraries communicate with the AGPL server over HTTP, which does not trigger copyleft.

## FAQ

**Can I embed Atlas in my commercial SaaS product?**
Yes. Use `@useatlas/react` or `@useatlas/sdk` (MIT) in your frontend. Self-host the Atlas server as-is. Your application code stays private.

**Can I fork Atlas and offer it as a hosted service?**
Only if you release your modifications under AGPL-3.0. For a commercial license that allows proprietary modifications, contact us.

**Can I write proprietary plugins?**
Yes. The plugin SDK is MIT. Your plugins are your own.

**Can my company self-host Atlas internally?**
Yes. AGPL-3.0 only requires sharing modifications when you serve the software to external users over a network. Internal use within your organization has no disclosure requirements.
