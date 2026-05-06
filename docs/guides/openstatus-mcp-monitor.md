# OpenStatus monitor — MCP multi-replica session locality

> Internal ops runbook. Not published to docs.useatlas.dev.

This document specifies the synthetic monitor that guards against the failure mode tracked in [#2069](https://github.com/AtlasDevHQ/atlas/issues/2069): Railway has no sticky sessions, so MCP follow-up frames must arrive at the replica that ran `initialize`. Each regional API service is pinned to one replica — but if `numReplicas` ever drifts (manual scale, dashboard misclick, a future PR that lifts the cap before the session-store-in-Postgres fallback ships), this monitor surfaces the regression as a paged alert before any user notices their agent disconnecting mid-conversation.

## Tier constraint (read first)

OpenStatus free tier (verified 2026-05-05 via the OpenAPI spec at <https://api.openstatus.dev/openapi.yaml>): **1 monitor, 1 region, 10-minute interval**. The slot is currently held by monitor 9230 (`api.useatlas.dev/api/health`). Adding the MCP synthetic below requires either:

1. **Upgrade to Starter ($30/mo)** — multi-monitor + multi-region. Tracked in [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936). The MCP monitor wants per-region coverage anyway; Starter is the right tier for a regional service mesh.
2. **Replace the health monitor temporarily** — only useful if scaling-past-1-replica is imminent and we accept losing health-endpoint coverage. Not recommended.
3. **Stage the spec (this doc) and provision when Starter lands** — current default. The contract is pinned by the integration test (`e2e/integration/mcp-multi-replica.test.ts`) and the `numReplicas: 1` cap in `deploy/<service>/railway.json`; the synthetic monitor is the prod-side belt-and-suspenders that fires the moment those guarantees drift. It belongs here as ready-to-deploy config, not as a hand-built dashboard click trail that gets lost.

This document is the source of truth for the monitor's shape. When OpenStatus gets the headroom, recreate it from this spec exactly.

## OpenStatus capability constraint

The `CreateHTTPMonitor` endpoint at `https://api.openstatus.dev` accepts a **single** `HTTPMonitor` config — one URL, one method, one body, one set of header/body/status-code assertions per monitor (verified 2026-05-05 against the OpenAPI spec). There is **no multi-step / chained-request / variable-extraction feature** on either the free or Starter tier today. That changes the shape of the synthetic, not its purpose:

- **Single-frame probe (OpenStatus-native)** — one HTTP monitor per region that POSTs the `initialize` JSON-RPC frame. Asserts the response is 200 with a `mcp-session-id` header. This catches the gross outages (region offline, auth broken, the route un-mounted) but does NOT exercise the "follow-up frame routed to the wrong replica" path — by definition, a single-request probe can't.
- **Multi-frame probe (external scheduler)** — a scheduled GitHub Actions / Railway cron job runs the full init-then-follow-up-frames sequence and reports status to OpenStatus via the `POST /monitors/{id}/trigger` endpoint or directly to the alerting channel. This is the configuration that actually guards the contract this PR is about.

Both halves should ship together: the single-frame probe gives OpenStatus its native uptime number for the status page; the multi-frame probe is what pages on the session-locality regression.

## What the monitor verifies

A frame routed to a replica that didn't run `initialize` returns `404 unknown_session`. To exercise that:

1. Open an MCP session against the regional hostname — the response carries `mcp-session-id`.
2. Send 5 sequential JSON-RPC frames carrying that header, with **30-second gaps** between each frame.
3. Each frame must return HTTP 200. Any 404 with `error: "unknown_session"` in the body fails the check.

The 30-second gaps are deliberate. Railway's load balancer makes routing decisions per request, not per connection; a 30-second idle window is enough for any LB-side keep-alive or affinity heuristic to decay. If the API service is single-replica (as currently configured), all 5 frames pass trivially — the value of the monitor is detecting the case where someone has scaled past 1 without the session-store fallback in place.

## Synthetic script

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
- pre-request delay: 30 seconds between frames

### Step 7: clean teardown

```http
DELETE https://{HOSTNAME}/mcp/{WORKSPACE_ID}/sse
Authorization: Bearer {SYNTHETIC_TOKEN}
mcp-session-id: {SESSION_ID}
```

**Assertions:** `status === 200` (or 204) — best-effort; teardown failure should warn, not page. Sessions also GC on connection drop, so a missed DELETE is at most a slow leak.

## Variables

| Placeholder | Source | Notes |
|---|---|---|
| `{HOSTNAME}` | One of `api.useatlas.dev`, `api-eu.useatlas.dev`, `api-apac.useatlas.dev` | One probe per region. |
| `{WORKSPACE_ID}` | Synthetic monitoring workspace | Provision a dedicated `org_synthetic` per region with `mcp:read` enabled. Do NOT reuse a real customer workspace — the audit log gets a `mcp_session.start` row per check. |
| `{SYNTHETIC_TOKEN}` | OAuth 2.1 access token issued for the synthetic workspace | Mint via `POST /api/auth/oauth2/token` (`client_credentials` grant) against a DCR-registered synthetic client. Secret stored in the scheduler's encrypted variables. Rotate on the same cadence as other production secrets. |

## Provisioning paths

### Native OpenStatus single-frame probe (uptime signal only)

When the Starter upgrade lands, provision **one HTTP monitor per region** that POSTs the **Step 1 (initialize)** payload above. Assertions: `status === 200`. This monitor is what the public status page reads — it gives "MCP endpoint reachable in {region}" coverage but cannot surface the session-locality regression.

```http
POST https://api.openstatus.dev/v1/monitor/http
x-openstatus-key: {OPENSTATUS_API_KEY}
Content-Type: application/json

{ url, method: "POST", body, headers, statusCodeAssertions: [{op: "EQ", value: 200}], regions: [...], periodicity: "5m" }
```

(Exact field shape per the OpenAPI spec at <https://api.openstatus.dev/openapi.yaml> — verified to be a single-request config, not a step sequence.)

### Multi-frame contract probe (external scheduler — required for the session-locality guarantee)

The 5-frame sequential probe above does NOT fit OpenStatus's HTTP-monitor shape. Two viable hosts:

1. **GitHub Actions scheduled workflow** — `cron: "*/10 * * * *"` triggers a small TypeScript runner that performs steps 1–7, reports via `POST /monitors/{id}/trigger` to OpenStatus (so the trigger feeds the existing alert pipeline), and exits non-zero on assertion failure (so the workflow itself shows red in the Actions tab).
2. **Railway cron service** — a tiny container running the same script. Tighter integration with the existing Railway deploys but adds a service-count line item.

GitHub Actions is the cheaper default. The runner's exact shape can be cribbed from the integration test (`e2e/integration/mcp-multi-replica.test.ts`) — same JSON-RPC payloads, same assertions, just pointed at production hostnames instead of the in-process server.

When the multi-frame probe ships, link the workflow file from this doc and from `docs/guides/sla-runbook.md` alongside the OpenStatus single-frame probe.

## Alert routing

When the monitor fails:

- **Page severity**: matches `api.useatlas.dev` health-monitor page. This is a connection-breaking regression, not a degradation.
- **Channel**: same Slack/email path as the existing health monitor (Slack-native on Starter+; email on free tier).
- **Runbook in alert body**: link to this file plus the `deploy/README.md` "Replica cap" section so the on-call engineer immediately sees that "scale-past-1-replica without the session-store fallback" is the most likely cause.

## Why this isn't terraformed

There's no terraform infra in the repo today. Adding terraform purely for this OpenStatus monitor is more rope than the value it returns; a markdown spec keyed to the OpenStatus API contract is enough. If terraform shows up for other reasons (e.g. Cloudflare or Vercel infra), this monitor should move there at the same time.

## Cross-references

- Issue: [#2069](https://github.com/AtlasDevHQ/atlas/issues/2069)
- Replica cap rationale: [`deploy/README.md`](../../deploy/README.md) — "Replica cap (read before scaling)" subsection
- Contract test: [`e2e/integration/mcp-multi-replica.test.ts`](../../e2e/integration/mcp-multi-replica.test.ts)
- Hosted MCP guide (user-facing): [`apps/docs/content/docs/guides/mcp-hosted.mdx`](../../apps/docs/content/docs/guides/mcp-hosted.mdx) — "Operational notes" section
- OpenStatus dashboard: [app.openstatus.dev](https://app.openstatus.dev) — status page ID `4478`, slug `atlas`, current monitor ID `9230`
- Public status page: [atlas.openstatus.dev](https://atlas.openstatus.dev/)
- OpenAPI spec (source of truth for capability claims): <https://api.openstatus.dev/openapi.yaml>
- Starter upgrade tracking: [#1936](https://github.com/AtlasDevHQ/atlas/issues/1936)
