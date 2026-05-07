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

## Quick start

`./loadtest.sh <scenario>` handles sign-in, mints a fresh MCP-scoped
bearer via the self-mint endpoint (`POST /api/v1/me/load-test/mcp-token`),
runs k6, and writes the post-run summary to `results/`. The bearer
never appears in argv, stdout, or any persisted file.

```bash
# .env carries:
#   LOADTEST_ADMIN_EMAIL=loadtest@yourcompany.com
#   LOADTEST_ADMIN_PASSWORD=<password>
# (the email must belong to a workspace member — any role — whose
#  active workspace has the NovaMart demo dataset attached. No
#  platform_admin tier required.)

./eval/load-tests/mcp/loadtest.sh concurrent-sessions
./eval/load-tests/mcp/loadtest.sh tool-call-mix
./eval/load-tests/mcp/loadtest.sh cold-start

# Pass-through k6 flags after `--`:
./eval/load-tests/mcp/loadtest.sh tool-call-mix -- -e VUS=20 -e DURATION=2m
```

Outputs land at `eval/load-tests/mcp/results/<scenario>-<UTC>.json`
(k6's `--summary-export` aggregate — counts, rates, P50/P95/P99) and
`<scenario>-<UTC>.txt` (k6's streaming output). The `results/` dir is
gitignored — pre-launch we keep run history local; once
[#2129](https://github.com/AtlasDevHQ/atlas/issues/2129) lands the CI
workflow will push to a tracking issue.

`BASE_URL` defaults to `https://mcp.useatlas.dev` — the brand
hostname for the customer-facing MCP surface. Hitting this URL means
k6 exercises exactly what real MCP clients hit. Override for a
non-default region or local validation:

```bash
BASE_URL=https://mcp-eu.useatlas.dev ./eval/load-tests/mcp/loadtest.sh concurrent-sessions
BASE_URL=http://localhost:3001 ./eval/load-tests/mcp/loadtest.sh concurrent-sessions \
  -- -e STAGES=1,5 -e STAGE_SECONDS=30
```

The script reads `LOADTEST_ADMIN_EMAIL` / `LOADTEST_ADMIN_PASSWORD`
from `.env` (or the environment if `.env` is absent). It also accepts
`TTL_SECONDS` (default `1800` — covers 5-minute stages × multi-stage
runs). Region binding is implicit in `BASE_URL`: the minted token's
audience is the regional `/mcp` URL of the host you called.

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

`./loadtest.sh` is the supported path — see [Quick start](#quick-start).
It does sign-in → mint → k6 in one pass and never lets the bearer
escape the process.

If you need a bearer outside the load-test driver (debugging, ad-hoc
curl), the [docs page for the mint endpoint](../../../apps/docs/content/docs/platform-ops/mcp-load-test-tokens.mdx)
walks through the curl form. Two non-negotiables apply equally to
manual use:

1. **The token must NEVER be logged.** The bearer signs every MCP
   tool call against your workspace; treat it like an API key. The
   audit row carries `jti` only.
2. **Audience is region-bound.** A bearer minted against
   `api.useatlas.dev` will fail (401) against `api-eu.useatlas.dev`.
   Mint per region.

Lifting a bearer from a connected MCP client (Claude Desktop / Cursor)
also works for one-off ad-hoc tests, but tokens issued through the
real OAuth flow are bound to a real user — load-test traffic ends up
in that user's audit history. The mint endpoint's synthetic
`loadtest:<workspaceId>:<random>` subject keeps load traffic
trivially distinguishable in `actor_id LIKE 'loadtest:%'` queries.

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
burning prod quota:

```bash
# Terminal 1
bun run db:up
bun run dev:api

# Terminal 2 — drive against localhost with reduced stages
BASE_URL=http://localhost:3001 \
  ./eval/load-tests/mcp/loadtest.sh concurrent-sessions \
  -- -e STAGES=1,5 -e STAGE_SECONDS=30
```

A local run with reduced stages is the fastest way to catch script
bugs (typos, missing env vars, wire-format drift) before spending
real-API time. Local dev requires the same `LOADTEST_ADMIN_*` creds in
`.env` to authenticate against your local Better Auth — seed an admin
user via the standard signup flow if you don't have one.

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
