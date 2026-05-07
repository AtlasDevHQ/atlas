// cold-start.js — measures the cost of a brand-new MCP session: the
// `initialize` round-trip + the first `tools/list`. This is the
// user-visible latency on first connect — the time between "agent
// configures the MCP server" and "agent has the tool surface and is
// ready to dispatch."
//
// Each iteration opens a fresh session, lists tools, and tears it down.
// No per-VU session reuse — that defeats the measurement.
//
// Usage
// ─────
// k6 run \
//   -e BASE_URL=https://api.useatlas.dev \
//   -e WORKSPACE_ID=ws_... \
//   -e BEARER=eyJhbGciOi... \
//   eval/load-tests/mcp/cold-start.js
//
// Tuning
// ──────
// - VUS sets concurrency (default 10). Higher values measure cold-start
//   latency under contention — the answer becomes "how much does the
//   server slow down when many clients connect at once?"
// - ITERATIONS caps the total session-init count (default 200). Useful
//   for a fast measurement against a slim dataset. Set to 0 (default
//   when DURATION is set) to fall through to time-bounded mode.
// - DURATION runs for a fixed wall time instead of an iteration count.
//
// What this script does NOT measure
// ─────────────────────────────────
// The full DCR + PKCE + token-exchange round-trip — those are SDK-level
// concerns and are ~1-2 round-trips before anything in this script
// runs. The hosted MCP route only sees an already-issued bearer token;
// `initialize` is the first frame after auth completes. If you need
// the full first-connect latency including DCR, augment this script
// with the `runHostedAuthFlow` helper from `@useatlas/mcp/init` (see
// `packages/mcp/src/eval/auth.ts`).

import { check, sleep } from 'k6';
import { initializeSession, listTools, closeSession } from './lib.js';

const VUS = Number.parseInt(__ENV.VUS || '10', 10);
const ITERATIONS = Number.parseInt(__ENV.ITERATIONS || '200', 10);
const DURATION = __ENV.DURATION || null;

const scenarios = DURATION
  ? {
      cold: {
        executor: 'constant-vus',
        vus: VUS,
        duration: DURATION,
        gracefulStop: '15s',
      },
    }
  : {
      cold: {
        executor: 'shared-iterations',
        vus: VUS,
        iterations: ITERATIONS,
        maxDuration: '10m',
      },
    };

export const options = {
  scenarios,
  thresholds: {
    'checks': ['rate>0.95'],
    'http_req_failed': ['rate<0.05'],
    'http_req_duration{rpc:initialize}': ['p(95)<5000'],
    'http_req_duration{rpc:tools/list}': ['p(95)<3000'],
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const init = initializeSession(`atlas-mcp-loadtest:cold:vu-${__VU}-iter-${__ITER}`);
  const sessionId = init.sessionId;
  if (!sessionId) {
    sleep(0.5);
    return;
  }

  const tools = listTools(sessionId);
  check(tools.parsed, {
    'tools/list: result.tools is non-empty': (p) =>
      Boolean(p && p.result && Array.isArray(p.result.tools) && p.result.tools.length > 0),
  });

  closeSession(sessionId);
  // Brief pause so we don't hot-loop init/teardown — the measurement of
  // interest is the per-iteration latency, not raw QPS.
  sleep(0.25);
}

// `loadtest.sh` passes `--summary-export=results/<scenario>-<UTC>.json`.
// Don't double-emit `summary.json` to cwd.
export function handleSummary() {
  return {
    'stdout':
      '\nMCP cold-start load test complete.\n' +
      'Read the per-frame breakdown from `http_req_duration{rpc:initialize}` and `{rpc:tools/list}` in the summary.\n' +
      'Total cold-start cost is the sum of those two — that\'s the user-visible "time to first tool dispatch" on a fresh client.\n',
  };
}
