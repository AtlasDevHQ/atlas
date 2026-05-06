# Hosted MCP load tests

[k6](https://k6.io/) scripts that drive the hosted MCP endpoint at
`{BASE_URL}/mcp/{WORKSPACE_ID}/sse` to measure latency, throughput, and
session-scaling behaviour. Reproducible answers to "how much MCP
traffic can a single Atlas region handle?" — the perf profile is
documented at [`apps/docs/content/docs/architecture/mcp-performance.mdx`](../../../apps/docs/content/docs/architecture/mcp-performance.mdx).

## Why k6

These scripts hand-roll the Streamable HTTP transport instead of
reusing the upstream `@modelcontextprotocol/sdk` client. k6 runs JS in
Goja (no Node/npm), so it cannot import the SDK directly. The wire
protocol is small enough (`initialize` / `notifications/initialized` /
`tools/list` / `tools/call` / `DELETE`) that a single-file
implementation in [`lib.js`](./lib.js) is cleaner than carrying a
WASM/CommonJS shim.

## Install

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k && \
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && \
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
    sudo tee /etc/apt/sources.list.d/k6.list && \
  sudo apt-get update && sudo apt-get install k6
```

Or use the official Docker image: `grafana/k6:latest`.

## Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | yes | API base URL — `https://api.useatlas.dev` (US), `https://mcp.useatlas.dev` (brand surface), or `http://localhost:3001` for a dev API |
| `WORKSPACE_ID` | yes | Workspace id path segment — must match the bearer's `workspace_id` claim |
| `BEARER` | yes | OAuth 2.1 access token (JWT) issued for the workspace, scope `mcp:read` |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PROTOCOL_VERSION` | `2025-03-26` | Pin the version negotiated in `initialize`. Bump only if testing a specific SDK version |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-request HTTP timeout |
| `SQL_QUERIES` | NovaMart fixture | `\|\|\|`-separated SELECTs for the executeSQL slice of the mix |
| `ENTITY_NAMES` | NovaMart fixture | Comma-separated entity names for describeEntity |
| `METRIC_IDS` | NovaMart fixture | Comma-separated metric ids for runMetric |

## Acquiring a bearer token

The hosted MCP route requires a Better-Auth-issued OAuth 2.1 access
token bound to the workspace, with audience `{api-host}/mcp` and scope
`mcp:read`. The full DCR + PKCE flow lives in `@useatlas/mcp/init`.

There is no drop-in token-printer script in the repo today — tracked
in [#2129](https://github.com/AtlasDevHQ/atlas/issues/2129). For now,
the two practical options are:

1. **Lift a token from a connected MCP client.** Claude Desktop /
   Cursor / ChatGPT cache the access token after completing OAuth;
   inspect the client's connection state for the `Authorization` value
   it sends to `{api-host}/mcp/{workspace_id}/sse`. This is the
   fastest path for ad-hoc load tests.
2. **Adapt the canonical eval's auth helper.** The in-process Better
   Auth + DCR + PKCE round-trip used by the canonical-question MCP
   eval is at [`packages/mcp/src/eval/auth.ts`](../../../packages/mcp/src/eval/auth.ts).
   It is **not** a drop-in token printer — it boots a self-contained
   Better Auth instance with an in-memory adapter to exercise the auth
   path during testing. Adapting it to print a token against your
   running server is a 1–2 hour task; expect to (a) point its
   `fetchImpl` at your real API, (b) drop the in-memory adapter, (c)
   echo the resolved bearer to stdout. Worth doing once and committing
   as a `scripts/print-bearer.ts` if you'll run load tests repeatedly.

The token MUST carry the `https://atlas.useatlas.dev/workspace_id`
custom claim matching the path segment, or every frame returns 403 (
[`hosted.ts`](../../../packages/mcp/src/hosted.ts) — `MCP path/bearer
workspace mismatch`).

## Scenarios

### `concurrent-sessions.js`

Ramps from 1 → 10 → 50 → 100 → 200 sessions, each holding the
connection open and dispatching one tool call per second for 5 minutes
per stage. Each step's "hold" segment is the steady-state read.

```bash
k6 run \
  -e BASE_URL=https://api.useatlas.dev \
  -e WORKSPACE_ID=ws_abcd \
  -e BEARER=eyJhbGciOi... \
  --out json=concurrent.json \
  eval/load-tests/mcp/concurrent-sessions.js
```

Tuning:

- `STAGES` — comma list of session caps. Default `1,10,50,100,200`.
- `STAGE_SECONDS` — hold time at each cap, default `300`.
- `RAMP_SECONDS` — ramp between caps, default `15`.
- `TOOL` — single tool name dispatched per iteration, default
  `listEntities`. Switching to a heavier tool (e.g. `runMetric`)
  isolates "session-scaling cost when each session is also doing
  expensive work."

### `tool-call-mix.js`

The realistic distribution from the issue: 60% executeSQL / 20%
listEntities / 10% describeEntity / 10% runMetric. Captures
`http_req_duration{tool:<name>}` per tool so you can see which tail
dominates.

```bash
k6 run \
  -e BASE_URL=https://api.useatlas.dev \
  -e WORKSPACE_ID=ws_abcd \
  -e BEARER=eyJhbGciOi... \
  -e VUS=50 \
  -e DURATION=5m \
  --out json=mix.json \
  eval/load-tests/mcp/tool-call-mix.js
```

Tuning:

- `VUS` — steady-state concurrency, default `50`. Stay well below
  `ATLAS_MCP_MAX_SESSIONS` (default `100`) so you measure dispatch, not
  the cap.
- `DURATION` — total wall time, default `5m`.
- `TARGET_RPS` — when set, switches to a constant-arrival-rate
  executor at exactly N frames/s (k6 will spawn additional VUs to
  sustain the rate when latency rises).

### `cold-start.js`

Per-iteration session bootstrap (`initialize` + `tools/list`). The
sum of `http_req_duration{rpc:initialize}` + `{rpc:tools/list}` is the
user-visible "time to first tool dispatch" on a fresh MCP connection.

```bash
k6 run \
  -e BASE_URL=https://api.useatlas.dev \
  -e WORKSPACE_ID=ws_abcd \
  -e BEARER=eyJhbGciOi... \
  -e VUS=10 \
  --out json=cold.json \
  eval/load-tests/mcp/cold-start.js
```

Does **not** measure DCR + PKCE + token exchange — those are
SDK-level and run before this script's first frame. To extend, lift
`runHostedAuthFlow` from `@useatlas/mcp/init` and prepend it to the
iteration body.

## Running locally

The scripts work against a local API so you can validate them without
burning staging quota:

```bash
# Terminal 1
bun run db:up
bun run dev:api

# Terminal 2 — issue a token (one-off; see Acquiring a bearer token above)
export BEARER="eyJhbGciOi..."

# Terminal 3 — point at localhost
k6 run \
  -e BASE_URL=http://localhost:3001 \
  -e WORKSPACE_ID=$(bun -e 'const p = process.env.BEARER.split(".")[1]; process.stdout.write(JSON.parse(Buffer.from(p, "base64url").toString())["https://atlas.useatlas.dev/workspace_id"])') \
  -e BEARER="$BEARER" \
  -e STAGES=1,5,10 \
  -e STAGE_SECONDS=30 \
  eval/load-tests/mcp/concurrent-sessions.js
```

A local validation run with reduced stages is the fastest way to catch
script bugs (typos, missing env vars, wire-format drift) before
spending staging time.

## Reading the output

Per the issue, the load test answers four questions:

1. **Latency curve at each session count** — read
   `http_req_duration{rpc:tools/call}` per stage from
   `--out json=...`. Tools like
   [k6-reporter](https://github.com/benc-uk/k6-reporter) can render
   per-stage P50/P95/P99 directly from the JSON.
2. **Throughput at saturation** — `http_reqs` rate per stage. Watch
   for the inflection where the rate stops growing as VUs increase.
3. **Bottleneck identification** — correlate the time-series with:
   - API CPU + memory (Railway dashboard or local `htop`)
   - DB pool saturation (`pg_stat_activity`)
   - LLM provider latency contribution — pulled from OTel spans
     emitted via [#2029](https://github.com/AtlasDevHQ/atlas/issues/2029)
   - SQL validation overhead — proportionally small but visible in the
     `atlas.sql.execute` span breakdown
4. **Cold-start cost** — `cold-start.js` summary; the sum of the two
   `rpc:` slices is the answer.

The bottleneck and tuning recommendations distilled from a real run
land in
[`apps/docs/content/docs/architecture/mcp-performance.mdx`](../../../apps/docs/content/docs/architecture/mcp-performance.mdx).
