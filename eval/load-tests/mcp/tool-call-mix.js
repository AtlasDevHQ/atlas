// tool-call-mix.js — drives the realistic tool-call distribution issue
// #2070 calls for: 60% executeSQL / 20% listEntities / 10% describeEntity
// / 10% runMetric. Captures P50/P95/P99 + throughput broken out per tool
// so we can see which tool's tail dominates the curve.
//
// Usage
// ─────
// k6 run \
//   -e BASE_URL=https://api.useatlas.dev \
//   -e WORKSPACE_ID=ws_... \
//   -e BEARER=eyJhbGciOi... \
//   eval/load-tests/mcp/tool-call-mix.js
//
// Tuning
// ──────
// - VUS sets the steady-state concurrency (default 50). Pick a value
//   that's well within `ATLAS_MCP_MAX_SESSIONS` (default 100) so you're
//   measuring tool dispatch, not session-cap behavior — that's
//   `concurrent-sessions.js`'s job.
// - DURATION sets the test length (default 5m).
// - TARGET_RPS optionally caps issued frames per second using a
//   constant-arrival-rate executor. Leave unset to use VU-paced cadence.
// - SQL_QUERIES / ENTITY_NAMES / METRIC_IDS override the fixture pools
//   in lib.js when targeting a non-NovaMart dataset.
//
// Reading the results
// ───────────────────
// k6 emits `http_req_duration{tool:executeSQL}`, `{tool:listEntities}`,
// etc. Use the per-tool slices to identify which tool's tail dominates
// the aggregate curve (typically executeSQL — variable cost from real DB
// work). The aggregate `tools/call` slice is the user-visible response
// time across the realistic mix.

import { sleep } from 'k6';
import { initializeSession, callTool, nextToolCall } from './lib.js';

const VUS = Number.parseInt(__ENV.VUS || '50', 10);
const DURATION = __ENV.DURATION || '5m';
const TARGET_RPS = __ENV.TARGET_RPS ? Number.parseInt(__ENV.TARGET_RPS, 10) : null;

// Two scenario modes:
//   - Default: `constant-vus` — VUs as fast as the server lets them.
//     The realistic-mix latency curve at a chosen concurrency.
//   - TARGET_RPS: `constant-arrival-rate` — a fixed issued QPS. Useful
//     for "how does the server behave at exactly N frames/s?" without
//     letting the load drift down when latency spikes.
const scenarios = TARGET_RPS
  ? {
      mix: {
        executor: 'constant-arrival-rate',
        rate: TARGET_RPS,
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: VUS,
        maxVUs: Math.max(VUS, TARGET_RPS),
      },
    }
  : {
      mix: {
        executor: 'constant-vus',
        vus: VUS,
        duration: DURATION,
        gracefulStop: '15s',
      },
    };

export const options = {
  scenarios,
  thresholds: {
    'checks': ['rate>0.95'],
    'http_req_failed': ['rate<0.05'],
    // Tail-latency floor — read individual percentiles per-tool from
    // the summary; thresholds are sanity gates, not the answer.
    'http_req_duration{rpc:tools/call}': ['p(95)<15000'],
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

let sessionId = null;

export default function () {
  if (!sessionId) {
    const init = initializeSession(`atlas-mcp-loadtest:mix:vu-${__VU}`);
    sessionId = init.sessionId;
    if (!sessionId) {
      sleep(1);
      return;
    }
  }

  const next = nextToolCall();
  callTool(sessionId, next.name, next.arguments);
  // No sleep — VUs run as fast as the server lets them. Cadence shaping
  // happens via TARGET_RPS / constant-arrival-rate when set.
}

export function handleSummary(data) {
  return {
    'stdout':
      '\nMCP tool-call-mix load test complete.\n' +
      'Per-tool latencies are exported as `http_req_duration{tool:<name>}` — slice the summary or the time-series export by that tag.\n',
    'summary.json': JSON.stringify(data, null, 2),
  };
}
