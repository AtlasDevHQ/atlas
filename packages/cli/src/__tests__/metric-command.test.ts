import { describe, it, expect } from "bun:test";

import { runMetricCommand, type MetricIO, type MetricRunDeps } from "../commands/metric";
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

/** Single-canned-response fetch capturing requests + their bodies. */
function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ method: string; url: string; body: string }> } {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: typeof url === "string" ? url : url.toString(),
      body: typeof init?.body === "string" ? init.body : "",
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
});
