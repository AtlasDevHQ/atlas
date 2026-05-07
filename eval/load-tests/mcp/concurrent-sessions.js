// concurrent-sessions.js — ramps from 1 → 10 → 50 → 100 → 200 concurrent
// hosted-MCP sessions, each holding the connection open and sending one
// tool call per second for the duration of the stage. Captures latency
// (P50/P95/P99) and throughput at each step so we can see where the
// curve breaks.
//
// Mirrors issue #2070: "1 → 10 → 50 → 100 → 200 sessions, each sending
// one tool call per second for 5 minutes."
//
// Usage
// ─────
// k6 run \
//   -e BASE_URL=https://api.useatlas.dev \
//   -e WORKSPACE_ID=ws_... \
//   -e BEARER=eyJhbGciOi... \
//   eval/load-tests/mcp/concurrent-sessions.js
//
// Tuning
// ──────
// - Override stage durations with STAGE_SECONDS (default 300 = 5min).
// - Override target steps with STAGES, e.g. STAGES="1,10,50,100" to skip
//   the 200-session step. Leave as-is to match the issue spec.
// - TOOL is the single tool name driven by every iteration (default
//   `listEntities` — cheap and stable, isolates session-scaling cost from
//   per-tool variability). Use `tool-call-mix.js` to see the realistic
//   blend instead.
//
// What this script does NOT show
// ──────────────────────────────
// Pure-listEntities load isolates the MCP session-scaling cost (transport
// dispatch, OAuth verify, session lookup) from the per-tool work. It is
// deliberately not the realistic distribution — for that, run
// `tool-call-mix.js`.
//
// Session lifecycle in k6
// ───────────────────────
// k6 has no per-VU teardown hook (only setup/default/teardown). Each VU
// holds its session for its lifetime; on ramp-down, the underlying TCP
// connections close and the hosted server's `onsessionclosed` hook fires
// — the in-memory `sessions` map decrements naturally. The single
// global `teardown` below issues no DELETEs because we cannot enumerate
// per-VU session ids; relying on transport-close cleanup is fine for
// load test purposes.

import { sleep } from 'k6';
import { initializeSession, callTool, config } from './lib.js';

const STAGE_SECONDS = Number.parseInt(__ENV.STAGE_SECONDS || '300', 10);
const STAGES = (__ENV.STAGES || '1,10,50,100,200')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const TOOL = __ENV.TOOL || 'listEntities';
const RAMP_SECONDS = Number.parseInt(__ENV.RAMP_SECONDS || '15', 10);

// Build a stages array that ramps to each step, holds for STAGE_SECONDS,
// then ramps to the next step. The ramp segment is short (15s default)
// so the "hold" segment is a clean steady-state read at each cap.
function buildStages() {
  const out = [];
  for (const target of STAGES) {
    out.push({ duration: `${RAMP_SECONDS}s`, target });
    out.push({ duration: `${STAGE_SECONDS}s`, target });
  }
  out.push({ duration: '5s', target: 0 });
  return out;
}

export const options = {
  scenarios: {
    sessions: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: buildStages(),
      gracefulRampDown: '10s',
      gracefulStop: '15s',
    },
  },
  thresholds: {
    // Sanity gates — any deploy that misses these is broken, not slow.
    'checks': ['rate>0.95'],
    'http_req_failed': ['rate<0.05'],
    // Per-stage curves are read from the summary; this is a floor.
    'http_req_duration{rpc:tools/call}': ['p(95)<10000'],
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return {
    endpoint: config.endpoint,
    stages: STAGES,
    stageSeconds: STAGE_SECONDS,
    tool: TOOL,
  };
}

// Per-VU session state — initialize once on first iteration, reuse for
// every subsequent iteration in the same VU's lifetime.
let sessionId = null;

export default function () {
  if (!sessionId) {
    const init = initializeSession(`atlas-mcp-loadtest:concurrent:vu-${__VU}`);
    sessionId = init.sessionId;
    if (!sessionId) {
      // Init failed — sleep to avoid a hot-loop. The check failure is
      // captured in the `checks` rate; the next iteration retries.
      sleep(1);
      return;
    }
  }

  callTool(sessionId, TOOL, {});
  // Issue spec: "one tool call per second for 5 minutes". The sleep
  // bounds the iteration to ~1s; if a call took >1s already, we proceed
  // without sleeping — cadence is "≤1/s, or as fast as the server lets
  // us, whichever is slower".
  sleep(1);
}

// `loadtest.sh` passes `--summary-export=results/<scenario>-<UTC>.json`,
// so the per-run summary already lands in the right place. Don't also
// emit `summary.json` to cwd — that just creates a second copy at the
// repo root that someone has to remember to clean up.
export function handleSummary() {
  return {
    'stdout': '\nMCP concurrent-sessions load test complete.\n' +
      'Read the per-stage P50/P95/P99 from the time-series export when running with `--out csv=...` or `--out json=...`.\n',
  };
}
