# @atlas/mcp

Atlas Model Context Protocol (MCP) server. Exposes the agent's `explore`
and `executeSQL` tools, the semantic layer as MCP resources, and prompt
templates over stdio or SSE transport.

See **[docs/guides/mcp](../../apps/docs/content/docs/guides/mcp.mdx)** for
the full Claude Desktop / Cursor / SSE setup guide.

## Quick start

```bash
bun run mcp                                                 # stdio (default)
bun packages/mcp/bin/serve.ts --transport sse --port 8080   # streamable HTTP
```

The MCP server reads the same configuration as the Hono API
(`atlas.config.ts` or env vars: `ATLAS_DATASOURCE_URL`, `ATLAS_PROVIDER`,
provider API keys, etc.).

## Actor binding (`ATLAS_MCP_USER_ID` + `ATLAS_MCP_ORG_ID`)

The MCP transport runs the same agent tools as the web app, so
deployment-wide governance (approval rules, query audit, content mode)
must apply. Two operating modes:

### Governed transport (recommended when `DATABASE_URL` is set)

Set both env vars to bind every MCP query to a workspace identity:

```bash
ATLAS_MCP_USER_ID=usr_abc123        # an Atlas user id from the internal DB
ATLAS_MCP_ORG_ID=org_xyz789         # the org the bound user is acting under
```

Approval rules now match against the bound requester. The
`audit_log.user_id` row attribution surfaces in the same admin views as
chat / scheduler / Slack queries.

When the deployment has any enabled approval rule and these env vars are
unset, MCP **fails to boot** with:

> MCP transport has no actor binding but the deployment has approval
> rules. Set ATLAS_MCP_USER_ID + ATLAS_MCP_ORG_ID at MCP startup, or
> scope your approval rules to other surfaces.

This is intentional. The previous behaviour (silent every-query failure
with a "approve via the Atlas web app" message that doesn't apply to
MCP) was the F-54 / F-55 silent-bypass shape — see
[`security-audit-1-2-3.md`](../../.claude/research/security-audit-1-2-3.md)
Phase 7.

### Trusted transport (no internal DB or no approval rules)

Leave both env vars unset. MCP starts under a synthetic `system:mcp`
actor (mirrors the F-27 `system:audit-purge-scheduler` convention) so
audit attribution is preserved. Behaviour is unchanged from the
pre-#1858 state — intended for self-hosted deploys where MCP is the
only way the operator interacts with the agent.

If approval rules are later enabled in the internal DB, MCP will fail
to boot on the next restart until the env vars are set or the rules are
scoped to other surfaces.

### Bind to a service account, not a real user

The bound user shows up on every approval request and audit row. A
dedicated `mcp-bot` user under the operator's org keeps the admin UI
clean and lets you revoke MCP access with a single user delete.
