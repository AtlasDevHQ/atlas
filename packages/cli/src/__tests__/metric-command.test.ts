import { describe, it, expect } from "bun:test";

import { runMetricCommand, type MetricIO, type MetricRunDeps } from "../commands/metric";
import { runMetric, MetricCliError } from "../lib/metric-client";
import type { StoredSession } from "../lib/credentials";

const BASE = "http://localhost:3001";
const SESSION: StoredSession = {
  token: "sess_abc",
  workspaceId: "org-1",
  createdAt: "2026-06-27T00:00:00Z",
};

function capture(): { io: MetricIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Single-canned-response fetch capturing requests + their bodies + headers. */
function stubFetch(
  status: number,
  body: unknown,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string; body: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers as Record<string, string>).forEach((v, k) => {
        headers[k] = v;
      });
    }
    calls.push({
      method: init?.method ?? "GET",
      url: typeof url === "string" ? url : url.toString(),
      body: typeof init?.body === "string" ? init.body : "",
      headers,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(
  fetchImpl: typeof fetch | undefined,
  session: StoredSession | null = SESSION,
): MetricRunDeps {
  return { baseUrl: BASE, session, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
}

const OK_SCALAR = {
  id: "total_gmv",
  label: "Total GMV",
  value: 1234.5,
  columns: ["total_gmv"],
  rows: [{ total_gmv: 1234.5 }],
  rowCount: 1,
  truncated: false,
  sql: "SELECT SUM(total_cents)/100.0 AS total_gmv FROM orders",
  executedAt: "2026-06-29T00:00:00Z",
};

describe("runMetricCommand — guards", () => {
  it("with no session, refuses with a login hint and exits 1", async () => {
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(undefined, null), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
  });

  it("no subcommand prints usage and exits 1", async () => {
    const { io, out } = capture();
    const code = await runMetricCommand(["metric"], deps(undefined), io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("Usage: atlas metric run");
  });

  it("--help prints usage and exits 0", async () => {
    const { io, out } = capture();
    const code = await runMetricCommand(["metric", "--help"], deps(undefined), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage: atlas metric run");
  });

  it("unknown subcommand errors and exits 1", async () => {
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "frobnicate"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unknown metric command");
  });

  it("run without a metric id errors and exits 1", async () => {
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas metric run <id>");
  });
});

describe("runMetricCommand — execution", () => {
  it("runs a metric and prints the scalar value", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_SCALAR);
    const { io, out } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(0);
    // POSTs to the metric-run route.
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/metrics/total_gmv/run`);
    expect(out.join("\n")).toContain("Total GMV (total_gmv): 1234.5");
  });

  it("threads --connection into the request body", async () => {
    const { fetchImpl, calls } = stubFetch(200, { ...OK_SCALAR, id: "prod_signups" });
    const { io } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "prod_signups", "--connection", "us-prod"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0].body)).toEqual({ connectionId: "us-prod" });
  });

  it("emits raw JSON with --json", async () => {
    const { fetchImpl } = stubFetch(200, OK_SCALAR);
    const { io, out } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.id).toBe("total_gmv");
    expect(parsed.value).toBe(1234.5);
  });

  it("renders a table for a multi-row result", async () => {
    const { fetchImpl } = stubFetch(200, {
      id: "gmv_by_region",
      label: "GMV by region",
      value: [
        { region: "us", gmv: 10 },
        { region: "eu", gmv: 20 },
      ],
      columns: ["region", "gmv"],
      rows: [
        { region: "us", gmv: 10 },
        { region: "eu", gmv: 20 },
      ],
      rowCount: 2,
      truncated: false,
      sql: "SELECT region, SUM(gmv) gmv FROM orders GROUP BY region",
      executedAt: "2026-06-29T00:00:00Z",
    });
    const { io, out } = capture();
    const code = await runMetricCommand(["metric", "run", "gmv_by_region"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("region");
    expect(joined).toContain("us");
  });
});

describe("runMetricCommand — workspace API key (#4112 unattended CI)", () => {
  it("sends the key on x-api-key (not Authorization) when ATLAS_API_KEY is set, with no session", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_SCALAR);
    const { io } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "total_gmv"],
      { baseUrl: BASE, session: null, apiKey: "atlas_wk_abc", fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("atlas_wk_abc");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("the --api-key flag overrides ATLAS_API_KEY (deps.apiKey)", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_SCALAR);
    const { io } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "total_gmv", "--api-key", "flag_key"],
      { baseUrl: BASE, session: null, apiKey: "env_key", fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("flag_key");
  });

  it("does not mistake the --api-key value for the metric id positional", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_SCALAR);
    const { io } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "--api-key", "flag_key", "total_gmv"],
      { baseUrl: BASE, session: null, fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].url).toBe(`${BASE}/api/v1/metrics/total_gmv/run`);
  });

  it("honors the inline --api-key=<key> form and does not silently fall back to the session", async () => {
    // Regression: a space-only flag reader drops `--api-key=key` and would run as
    // the ambient session — wrong identity, no error. The key must win here.
    const { fetchImpl, calls } = stubFetch(200, OK_SCALAR);
    const { io } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "total_gmv", "--api-key=inline_key"],
      { baseUrl: BASE, session: SESSION, fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("inline_key");
    expect(calls[0].headers["authorization"]).toBeUndefined();
    expect(calls[0].url).toBe(`${BASE}/api/v1/metrics/total_gmv/run`);
  });

  it("the api-key path takes precedence over a stored session", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_SCALAR);
    const { io } = capture();
    await runMetricCommand(
      ["metric", "run", "total_gmv"],
      { baseUrl: BASE, session: SESSION, apiKey: "atlas_wk_abc", fetchImpl },
      io,
    );
    expect(calls[0].headers["x-api-key"]).toBe("atlas_wk_abc");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("with neither a session nor an api-key, refuses with a login + ATLAS_API_KEY hint", async () => {
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(undefined, null), io);
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("atlas login");
    expect(joined).toContain("ATLAS_API_KEY");
  });

  it("does not mistake the --connection value for the metric id positional", async () => {
    // Pre-existing argv gap surfaced by adding a second value flag: the id finder
    // must skip a value-taking flag's value, not return it as the id.
    const { fetchImpl, calls } = stubFetch(200, { ...OK_SCALAR, id: "prod_signups" });
    const { io } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "--connection", "us-prod", "prod_signups"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].url).toBe(`${BASE}/api/v1/metrics/prod_signups/run`);
    expect(JSON.parse(calls[0].body)).toEqual({ connectionId: "us-prod" });
  });
});

describe("runMetricCommand — error mapping", () => {
  it("maps 401 to a re-login hint", async () => {
    const { fetchImpl } = stubFetch(401, { error: "auth_error", message: "expired" });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
  });

  it("maps 404 to a metric-not-found message", async () => {
    const { fetchImpl } = stubFetch(404, { error: "unknown_metric", message: "not found" });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "nope"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain('Metric "nope" not found');
  });

  it("surfaces a 403 billing block message verbatim", async () => {
    const { fetchImpl } = stubFetch(403, {
      error: "trial_expired",
      message: "Your trial has expired.",
      requestId: "req-1",
    });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Your trial has expired.");
  });

  it("surfaces a 409 approval-required message", async () => {
    const { fetchImpl } = stubFetch(409, {
      error: "approval_required",
      message: "Approval needed for this metric.",
    });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Approval needed");
  });

  it("maps a 400 bad_request to the no-workspace guidance", async () => {
    const { fetchImpl } = stubFetch(400, {
      error: "bad_request",
      message: "Your login is not bound to a workspace.",
    });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not bound to a workspace");
  });

  it("surfaces a 400 invalid_request (e.g. wrong connection) with the server message + requestId", async () => {
    const { fetchImpl } = stubFetch(400, {
      error: "invalid_request",
      message: 'connectionId "eu" targets a different datasource',
      requestId: "req-9",
    });
    const { io, err } = capture();
    const code = await runMetricCommand(
      ["metric", "run", "prod_signups", "--connection", "eu"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("targets a different datasource");
    expect(joined).toContain("(request req-9)");
  });

  it("surfaces a 503 (datasource/subsystem unavailable) with the server message", async () => {
    const { fetchImpl } = stubFetch(503, { error: "no_datasource", message: "Datasource unavailable." });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Datasource unavailable.");
  });

  it("surfaces a 429 (rate limited) with the server message + requestId", async () => {
    const { fetchImpl } = stubFetch(429, {
      error: "rate_limited",
      message: "Too many requests. Please wait before trying again.",
      requestId: "req-rl",
    });
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("Too many requests");
    expect(joined).toContain("(request req-rl)");
  });

  it("surfaces a network/timeout failure with the base URL", async () => {
    const fetchImpl = (async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Timed out");
  });

  it("a malformed 200 body (missing required fields) → an unexpected-shape error, not silent garbage", async () => {
    // The .safeParse() of the 200 must surface a shape mismatch as a typed
    // error rather than handing a half-filled result to the renderer (#4111).
    const { fetchImpl } = stubFetch(200, { id: "total_gmv" }); // missing sql/columns/rows/...
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unexpected response shape");
  });

  it("surfaces a generic (non-abort) network failure via the shared unreachableMessage (#4113)", async () => {
    // A non-Timeout/Abort throw takes the `unreachableMessage` branch of the
    // consolidated http.ts helper — pins the generic-failure path the abort/
    // timeout tests route around, with the base URL interpolated.
    const fetchImpl = (async () => {
      const e = new TypeError("fetch failed");
      throw e;
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runMetricCommand(["metric", "run", "total_gmv"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(`Could not reach the Atlas API at ${BASE}`);
  });
});

// The command renders `err.message` for any MetricCliError, so the new typed
// kinds (#4113 parity with sql-client) are only observable on the thrown error.
// Pin them at the client layer so 429/503 stop collapsing into `request_failed`.
describe("runMetric — typed error kinds (parity with sql-client #4113)", () => {
  async function kindFor(status: number, body: unknown): Promise<string> {
    const { fetchImpl } = stubFetch(status, body);
    try {
      await runMetric({ baseUrl: BASE, credential: { token: "t" }, fetchImpl }, { id: "total_gmv" });
      throw new Error("expected runMetric to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MetricCliError);
      return (err as MetricCliError).kind;
    }
  }

  it("maps 429 → rate_limited", async () => {
    expect(await kindFor(429, { error: "rate_limited", message: "Slow down." })).toBe("rate_limited");
  });

  it("maps 503 → unavailable", async () => {
    expect(await kindFor(503, { error: "no_datasource", message: "Datasource unavailable." })).toBe(
      "unavailable",
    );
  });
});
