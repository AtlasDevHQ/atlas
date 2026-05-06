# OpenStatus monitor — MCP multi-replica session locality

> Internal ops runbook. Not published to docs.useatlas.dev.

This document describes the synthetic monitor that guards against the failure mode tracked in [#2069](https://github.com/AtlasDevHQ/atlas/issues/2069): Railway has no sticky sessions, so MCP follow-up frames must arrive at the replica that ran `initialize`. Each regional API service is pinned to one replica — but if `numReplicas` ever drifts (manual scale, dashboard misclick, a future PR that lifts the cap before the session-store-in-Postgres fallback ships), this monitor surfaces the regression as a paged alert before any user notices their agent disconnecting mid-conversation.

## Tier constraint (read first)

OpenStatus free tier: **1 monitor, 1 region, 10-minute interval** ([sla-runbook.md](./sla-runbook.md), [Starter upgrade tracking #1936](https://github.com/AtlasDevHQ/atlas/issues/1936)). The slot is currently held by monitor 9230 (`api.useatlas.dev/api/health`). Adding the MCP synthetic below requires either:

1. **Upgrade to Starter ($30/mo)** — multi-monitor + multi-region. Tracked in #1936. The MCP monitor wants per-region coverage anyway; Starter is the right tier for a regional service mesh.
2. **Replace the health monitor temporarily** — only useful if scaling-past-1-replica is imminent and we accept losing health-endpoint coverage. Not recommended.
3. **Stage the monitor config (this doc) and provision when Starter lands** — current default. The contract is pinned by the integration test (`e2e/integration/mcp-multi-replica.test.ts`) and the railway.json `numReplicas: 1` cap; the synthetic monitor is the prod-side belt-and-suspenders that fires the moment those guarantees drift. It belongs here as ready-to-deploy config, not as a hand-built dashboard click trail that gets lost.

This document is the source of truth for the monitor's shape. When OpenStatus gets the headroom, recreate it from this spec exactly.

## What the monitor verifies

A frame routed to a replica that didn't run `initialize` returns `404 unknown_session`. To exercise that:

1. Open an MCP session against the regional hostname — the response carries `mcp-session-id`.
2. Send 5 sequential JSON-RPC frames carrying that header, with **30-second gaps** between each frame.
3. Each frame must return HTTP 200. Any 404 with `error: "unknown_session"` in the body fails the check.

The 30-second gaps are deliberate. Railway's load balancer makes routing decisions per request, not per connection; a 30-second idle window is enough for any LB-side keep-alive or affinity heuristic to decay. If the API service is single-replica (as currently configured), all 5 frames pass trivially — the value of the monitor is detecting the case where someone has scaled past 1 without the session-store fallback in place.

## Synthetic script

OpenStatus supports HTTP monitors with multiple sequential steps. The script below is the per-target sequence. It runs against each regional hostname (`api`, `api-eu`, `api-apac`).

### Step 1: open session

```http
POST https://{HOSTNAME}/mcp/{WORKSPACE_ID}/sse
Authorization: Bearer {SYNTHETIC_TOKEN}
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "openstatus-mcp-monitor", "version": "1.0.0" }
  }
}
```

**Assertions:**
- `status === 200`
- response header `mcp-session-id` is non-empty — capture as `{SESSION_ID}` for subsequent steps

### Steps 2–6: five sequential frames, 30-second gaps

For `n` in `[1, 2, 3, 4, 5]`:

```http
POST https://{HOSTNAME}/mcp/{WORKSPACE_ID}/sse
Authorization: Bearer {SYNTHETIC_TOKEN}
Content-Type: application/json
Accept: application/json, text/event-stream
mcp-session-id: {SESSION_ID}

{ "jsonrpc": "2.0", "id": {n+1}, "method": "tools/list", "params": {} }
```

**Assertions per step:**
- `status === 200`
- body does NOT match `\"error\":\\s*\"unknown_session\"`
- pre-request delay: 30 seconds (skip on the first follow-up frame; OpenStatus doesn't gap step 1 → step 2 by default but the gap between steps 2–6 is what stresses LB rerouting)

### Step 7: clean teardown

```http
DELETE https://{HOSTNAME}/mcp/{WORKSPACE_ID}/sse
Authorization: Bearer {SYNTHETIC_TOKEN}
mcp-session-id: {SESSION_ID}
```

**Assertions:**
- `status === 200` (or 204) — best-effort; teardown failure should warn, not page. Sessions also GC on connection drop, so a missed DELETE is at most a slow leak.

## Variables

| Placeholder | Source | Notes |
|---|---|---|
| `{HOSTNAME}` | One of `api.useatlas.dev`, `api-eu.useatlas.dev`, `api-apac.useatlas.dev` | One monitor per region. |
| `{WORKSPACE_ID}` | Synthetic monitoring workspace | Provision a dedicated `org_synthetic` per region with `mcp:read` enabled. Do NOT reuse a real customer workspace — the audit log gets a `mcp_session.start` row per check. |
| `{SYNTHETIC_TOKEN}` | OAuth 2.1 access token issued for the synthetic workspace | Mint via `POST /api/auth/oauth2/token` (`client_credentials` grant) against a DCR-registered synthetic client. Secret stored in OpenStatus's encrypted variables. Rotate on the same cadence as other production secrets. |

## Alert routing

When the monitor fails:

- **Page severity**: matches `api.useatlas.dev` health-monitor page. This is a connection-breaking regression, not a degradation.
- **Channel**: same Slack/email path as the existing health monitor (depends on the OpenStatus tier — Starter+ supports Slack natively; on free tier, route via the OpenStatus → Pingdom-style email alerts).
- **Runbook in alert body**: link to this file plus the deploy/README.md "Replica cap" section so the on-call engineer immediately sees that "scale-past-1-replica without the session-store fallback" is the most likely cause.

## How to recreate the monitor in the OpenStatus dashboard

When the Starter tier lands, recreate via dashboard or API.

### Dashboard path

1. **Monitors → New monitor → HTTP**.
2. Set name: `MCP session locality — {region}` (one per region).
3. Add the steps above; set `Step type: Multi-step`. Each step gets the URL, headers, body, and assertions transcribed verbatim from this doc.
4. Set interval. Recommended: **5 minutes** on Starter (the per-step 30-second gaps mean a single check takes ~2.5 min — anything tighter than 5 min collides). Free tier's 10-min interval is fine if it's the only option.
5. Set regions to one near each target API region (US monitor → US-east probe; EU → europe-west; APAC → ap-south or sg). Cross-region probes give a second signal — region misroutes would surface here too.
6. Wire the alert channel.

### API path (preferred, idempotent)

OpenStatus v2 (ConnectRPC) at `https://api.openstatus.dev`. Auth header: `x-openstatus-key: {OPENSTATUS_API_KEY}`. The endpoint for multi-step HTTP monitors is `/rpc/openstatus.monitor.v1.MonitorService/CreateHTTPMonitor` ([OpenStatus OpenAPI spec](https://api.openstatus.dev/openapi.yaml)). Body: a JSON envelope containing the steps as listed above. When the Starter upgrade ships, this doc plus that spec are sufficient to script the provisioning — no additional discovery needed.

## Why this isn't terraformed

There's no terraform infra in the repo today. Adding terraform purely for this single OpenStatus monitor is more rope than the value it returns; a markdown spec keyed to the OpenStatus API contract is enough. If terraform shows up for other reasons (e.g. Cloudflare or Vercel infra), this monitor should move there at the same time.

## Cross-references

- Issue: [#2069](https://github.com/AtlasDevHQ/atlas/issues/2069)
- Replica cap rationale: [`deploy/README.md`](../../deploy/README.md) — "Replica cap (read before scaling)" subsection
- Contract test: [`e2e/integration/mcp-multi-replica.test.ts`](../../e2e/integration/mcp-multi-replica.test.ts)
- Hosted MCP guide (user-facing): [`apps/docs/content/docs/guides/mcp-hosted.mdx`](../../apps/docs/content/docs/guides/mcp-hosted.mdx) — "Operational notes" section
- OpenStatus dashboard: [app.openstatus.dev](https://app.openstatus.dev) — status page ID `4478`, slug `atlas`, current monitor ID `9230`
- Public status page: [atlas.openstatus.dev](https://atlas.openstatus.dev/)
- Starter upgrade tracking: [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936)
