// Shared helpers for the hosted-MCP k6 load tests (#2070).
//
// Why these scripts hand-roll the transport instead of reusing
// `packages/mcp/src/eval/client.ts`: k6 runs JS in a Goja VM (not Node),
// has no npm `require`, and cannot load the upstream
// `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`. We need to
// drive the wire protocol directly — `k6/http` for the request and a
// hand-rolled JSON-RPC frame builder.
//
// Wire shape — Streamable HTTP transport
// ──────────────────────────────────────
//
// All MCP traffic goes to `POST {BASE_URL}/mcp/{WORKSPACE_ID}/sse` with:
//
//   Authorization:    Bearer <token>
//   Content-Type:     application/json
//   Accept:           application/json, text/event-stream
//   Mcp-Session-Id:   <sid>      (omitted on initialize, required after)
//
// The first frame is `initialize` with no `Mcp-Session-Id`. The server
// stamps a `Mcp-Session-Id` response header on the init response — the
// client threads that header on every subsequent frame. The server may
// reply as a single JSON body OR as a one-event SSE stream; both shapes
// are handled by `parseFrame`. After init, the client SHOULD send the
// `notifications/initialized` notification (one-way, no response). Tool
// calls use `tools/call` with `params: { name, arguments }`.
//
// Closing a session: send `DELETE` to the same URL with the session
// header. The server tears down the in-process `McpServer` and reduces
// the in-memory session count back toward `ATLAS_MCP_MAX_SESSIONS`.
//
// MCP protocol version: pinned to `2025-03-26`. That matches
// `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` in
// `node_modules/@modelcontextprotocol/sdk/.../types.js` — NOT
// `LATEST_PROTOCOL_VERSION`, which advances ahead of the negotiation
// default. We pin the negotiated default so the load test isn't
// sensitive to a version-negotiation regression unrelated to
// performance; override via `MCP_PROTOCOL_VERSION` env to test a
// specific version.

import http from 'k6/http';
import { check, fail } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const WORKSPACE_ID = __ENV.WORKSPACE_ID || '';
const BEARER = __ENV.BEARER || '';
const PROTOCOL_VERSION = __ENV.MCP_PROTOCOL_VERSION || '2025-03-26';
const REQUEST_TIMEOUT_MS = Number.parseInt(__ENV.REQUEST_TIMEOUT_MS || '60000', 10);

if (!WORKSPACE_ID || !BEARER) {
  fail(
    'WORKSPACE_ID and BEARER env vars are required. See eval/load-tests/mcp/README.md for setup.',
  );
}

const ENDPOINT = `${BASE_URL}/mcp/${WORKSPACE_ID}/sse`;

function buildHeaders(sessionId) {
  const headers = {
    'Authorization': `Bearer ${BEARER}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }
  return headers;
}

// Servers may return a single JSON body OR a one-event SSE stream. Both
// are valid per the Streamable HTTP transport spec; load-test code only
// needs the JSON-RPC payload, not the framing.
//
// On parse failure we `console.warn` then return `null` so a malformed
// body surfaces in k6's stderr while still allowing callers to detect
// the failure via a `parsed !== null` check. Empty catches without that
// signal would let garbage 200s show up as success in latency stats.
function parseFrame(body) {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      console.warn(`parseFrame: JSON body parse failed: ${err && err.message ? err.message : err}`);
      return null;
    }
  }
  // SSE: scan for the first `data:` line and parse its payload.
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const data = line.slice('data:'.length).trim();
      if (!data) continue;
      try {
        return JSON.parse(data);
      } catch (err) {
        console.warn(`parseFrame: SSE data parse failed: ${err && err.message ? err.message : err}`);
        return null;
      }
    }
  }
  return null;
}

export function initializeSession(tag) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: tag || 'atlas-mcp-loadtest',
        version: '0.0.1',
      },
    },
  };

  const res = http.post(ENDPOINT, JSON.stringify(body), {
    headers: buildHeaders(null),
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { rpc: 'initialize' },
  });

  const ok = check(res, {
    'initialize: 200': (r) => r.status === 200,
    'initialize: returned Mcp-Session-Id': (r) =>
      Boolean(r.headers['Mcp-Session-Id'] || r.headers['mcp-session-id']),
  });

  if (!ok) {
    return { sessionId: null, res };
  }

  const sessionId = res.headers['Mcp-Session-Id'] || res.headers['mcp-session-id'];

  // The Streamable HTTP spec asks the client to send `notifications/
  // initialized` after a successful init. Servers buffer state until they
  // see it, so a client that skips it can hit subtly different code paths
  // — the load test models a real client.
  //
  // Capture and check the response: a 4xx here (e.g. revoked bearer
  // between init and notify) would otherwise turn the rest of the run
  // into "init succeeded, every tool call 401" with no signal that the
  // notify itself was the regression.
  const notifyRes = http.post(
    ENDPOINT,
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
    {
      headers: buildHeaders(sessionId),
      timeout: `${REQUEST_TIMEOUT_MS}ms`,
      tags: { rpc: 'notifications/initialized' },
    },
  );
  check(notifyRes, {
    'notifications/initialized: 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  return { sessionId, res };
}

export function listTools(sessionId) {
  const body = {
    jsonrpc: '2.0',
    id: uuidv4(),
    method: 'tools/list',
  };
  const res = http.post(ENDPOINT, JSON.stringify(body), {
    headers: buildHeaders(sessionId),
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { rpc: 'tools/list' },
  });
  check(res, { 'tools/list: 200': (r) => r.status === 200 });
  return { res, parsed: parseFrame(res.body) };
}

export function callTool(sessionId, name, args) {
  const body = {
    jsonrpc: '2.0',
    id: uuidv4(),
    method: 'tools/call',
    params: { name, arguments: args || {} },
  };
  const res = http.post(ENDPOINT, JSON.stringify(body), {
    headers: buildHeaders(sessionId),
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { rpc: 'tools/call', tool: name },
  });
  const parsed = parseFrame(res.body);
  // MCP error envelopes (`{ result: { isError: true, content: [...] } }`)
  // ride on HTTP 200. Without the `isError` check below, a workspace
  // where every executeSQL hits a permissions error would post a clean
  // P95 curve while every iteration was a no-op error envelope. The
  // `tool-call-mix.js` script's 60% executeSQL share makes this
  // particularly load-bearing.
  check(res, {
    [`tools/call ${name}: 200`]: (r) => r.status === 200,
  });
  check(parsed, {
    [`tools/call ${name}: parseable JSON-RPC body`]: (p) => p !== null,
    [`tools/call ${name}: not an error envelope`]: (p) =>
      Boolean(p && p.result && p.result.isError !== true),
  });
  return { res, parsed };
}

export function closeSession(sessionId) {
  if (!sessionId) return;
  // Best-effort teardown — a slow DELETE shouldn't fail the iteration.
  // Still surface the status as a check so a header-schema regression
  // that 404s every DELETE doesn't pass silently — we'd see the rate
  // drop in the summary even if no threshold trips.
  const res = http.del(ENDPOINT, null, {
    headers: buildHeaders(sessionId),
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { rpc: 'delete' },
  });
  check(res, {
    'delete: 200|204': (r) => r.status === 200 || r.status === 204,
  });
}

// Tool fixtures. The defaults match the bundled NovaMart demo
// (`semantic/`) so the scripts work against a stock dev/staging
// environment without extra config; override via env when targeting
// a different dataset.
const SQL_QUERIES = (__ENV.SQL_QUERIES
  ? __ENV.SQL_QUERIES.split('|||')
  : [
      'SELECT id FROM customers LIMIT 10',
      'SELECT id, status FROM orders WHERE status != \'cancelled\' LIMIT 25',
      'SELECT id, name FROM products LIMIT 50',
      'SELECT order_id, quantity FROM order_items LIMIT 100',
      'SELECT COUNT(*) AS n FROM customers',
    ]).map((s) => s.trim()).filter(Boolean);

const ENTITY_NAMES = (__ENV.ENTITY_NAMES
  ? __ENV.ENTITY_NAMES.split(',')
  : ['customers', 'orders', 'order_items', 'products', 'categories']).map((s) => s.trim()).filter(Boolean);

const METRIC_IDS = (__ENV.METRIC_IDS
  ? __ENV.METRIC_IDS.split(',')
  : ['total_gmv', 'aov', 'revenue_by_category']).map((s) => s.trim()).filter(Boolean);

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 60 / 20 / 10 / 10 mix — matches issue #2070's "realistic distribution".
export function nextToolCall() {
  const r = Math.random();
  if (r < 0.6) {
    return {
      name: 'executeSQL',
      arguments: {
        sql: pick(SQL_QUERIES),
        explanation: 'k6 load-test iteration',
      },
    };
  }
  if (r < 0.8) {
    return { name: 'listEntities', arguments: {} };
  }
  if (r < 0.9) {
    return {
      name: 'describeEntity',
      arguments: { name: pick(ENTITY_NAMES) },
    };
  }
  return {
    name: 'runMetric',
    arguments: { id: pick(METRIC_IDS) },
  };
}

export const config = {
  baseUrl: BASE_URL,
  workspaceId: WORKSPACE_ID,
  endpoint: ENDPOINT,
  protocolVersion: PROTOCOL_VERSION,
};
