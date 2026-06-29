import { describe, it, expect } from "bun:test";

import {
  DatasourceCliError,
  listDatasources,
  getDatasource,
  testDatasource,
  archiveDatasource,
  restoreDatasource,
  deleteDatasource,
  createDatasource,
  profileDatasource,
  type DatasourceClientOptions,
  type ProfileTableEvent,
} from "../lib/datasource-client";

const BASE = "http://localhost:3001";
const TOKEN = "sess_bearer_abc";

interface CapturedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

/**
 * A fetch stub returning one canned response and capturing the request, so each
 * subcommand's route mapping (method + path + bearer + body) and the
 * status-code → typed-error mapping are testable without a live server.
 */
function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      authorization:
        init?.headers && typeof init.headers === "object"
          ? ((init.headers as Record<string, string>).Authorization ?? null)
          : null,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function opts(fetchImpl: typeof fetch): DatasourceClientOptions {
  return { baseUrl: BASE, token: TOKEN, fetchImpl };
}

describe("datasource-client route mapping (#4044)", () => {
  it("list → GET /api/v1/admin/connections with the bearer", async () => {
    const { fetchImpl, calls } = stubFetch(200, {
      connections: [{ id: "prod-us", dbType: "postgres", status: "published" }],
    });
    const out = await listDatasources(opts(fetchImpl));
    expect(out).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections`);
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("list tolerates a missing connections array", async () => {
    const { fetchImpl } = stubFetch(200, {});
    expect(await listDatasources(opts(fetchImpl))).toEqual([]);
  });

  it("get → GET /api/v1/admin/connections/{id}", async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: "prod-us", dbType: "postgres" });
    const out = await getDatasource(opts(fetchImpl), "prod-us");
    expect(out.id).toBe("prod-us");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections/prod-us`);
  });

  it("get url-encodes the id", async () => {
    const { fetchImpl, calls } = stubFetch(200, {});
    await getDatasource(opts(fetchImpl), "weird id");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections/weird%20id`);
  });

  it("test → POST /api/v1/admin/connections/{id}/test", async () => {
    const { fetchImpl, calls } = stubFetch(200, { status: "healthy", latencyMs: 12 });
    const out = await testDatasource(opts(fetchImpl), "prod-us");
    expect(out.status).toBe("healthy");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections/prod-us/test`);
  });

  it("archive → POST /api/v1/admin/archive-connection with { connectionId }", async () => {
    const { fetchImpl, calls } = stubFetch(200, { archived: { connection: true } });
    await archiveDatasource(opts(fetchImpl), "prod-us");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/archive-connection`);
    expect(JSON.parse(calls[0].body!)).toEqual({ connectionId: "prod-us" });
  });

  it("restore → POST /api/v1/admin/restore-connection with { connectionId }", async () => {
    const { fetchImpl, calls } = stubFetch(200, { restored: { connection: true } });
    await restoreDatasource(opts(fetchImpl), "prod-us");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/restore-connection`);
    expect(JSON.parse(calls[0].body!)).toEqual({ connectionId: "prod-us" });
  });

  it("delete → DELETE /api/v1/admin/connections/{id}", async () => {
    const { fetchImpl, calls } = stubFetch(200, { success: true });
    const out = await deleteDatasource(opts(fetchImpl), "prod-us");
    expect(out.success).toBe(true);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections/prod-us`);
  });

  it("create → POST /api/v1/admin/connections with the secret url in the body", async () => {
    const { fetchImpl, calls } = stubFetch(201, {
      id: "prod-us",
      dbType: "postgres",
      maskedUrl: "postgres://***@host/db",
    });
    const out = await createDatasource(
      opts(fetchImpl),
      { id: "prod-us", description: "US prod", schema: "public" },
      "postgres://user:pw@host:5432/db",
    );
    expect(out.id).toBe("prod-us");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections`);
    const body = JSON.parse(calls[0].body!);
    expect(body).toEqual({
      id: "prod-us",
      url: "postgres://user:pw@host:5432/db",
      description: "US prod",
      schema: "public",
    });
  });

  it("create omits absent optional metadata from the body", async () => {
    const { fetchImpl, calls } = stubFetch(201, { id: "ds1" });
    await createDatasource(opts(fetchImpl), { id: "ds1" }, "mysql://u:p@h/db");
    expect(JSON.parse(calls[0].body!)).toEqual({ id: "ds1", url: "mysql://u:p@h/db" });
  });

  it("create forwards a group attachment", async () => {
    const { fetchImpl, calls } = stubFetch(201, { id: "ds1" });
    await createDatasource(opts(fetchImpl), { id: "ds1", connectionGroupId: "prod" }, "postgres://u:p@h/db");
    expect(JSON.parse(calls[0].body!).connectionGroupId).toBe("prod");
  });

  it("create strips a plaintext url from the response (defense-in-depth, never echoes the secret)", async () => {
    // Simulate a server regression that echoes the raw url; the client must not
    // surface it (it would otherwise reach `--json` output / a redirected log).
    const { fetchImpl } = stubFetch(201, {
      id: "ds1",
      dbType: "postgres",
      maskedUrl: "postgres://***@h/db",
      url: "postgres://user:pw@h/db",
    });
    const out = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://user:pw@h/db");
    expect(out.url).toBeUndefined();
    expect(out.maskedUrl).toBe("postgres://***@h/db");
  });
});

describe("datasource-client error mapping (#4044)", () => {
  it("401 → unauthorized with a re-login hint", async () => {
    const { fetchImpl } = stubFetch(401, { error: "auth_error", message: "Not signed in" });
    const err = await listDatasources(opts(fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(DatasourceCliError);
    expect((err as DatasourceCliError).kind).toBe("unauthorized");
    expect((err as DatasourceCliError).message).toContain("atlas login");
  });

  it("403 forbidden_role → forbidden, naming the admin-role requirement", async () => {
    const { fetchImpl } = stubFetch(403, { error: "forbidden_role", message: "Admin role required." });
    const err = await archiveDatasource(opts(fetchImpl), "prod-us").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("forbidden");
    expect((err as DatasourceCliError).message).toContain("admin role");
    expect((err as DatasourceCliError).message).toContain("archive datasource");
  });

  it("403 mfa_enrollment_required → mfa_required", async () => {
    const { fetchImpl } = stubFetch(403, { error: "mfa_enrollment_required", message: "..." });
    const err = await deleteDatasource(opts(fetchImpl), "prod-us").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("mfa_required");
    expect((err as DatasourceCliError).message).toContain("two-factor");
  });

  it("400 bad_request (no active org) → no_workspace", async () => {
    const { fetchImpl } = stubFetch(400, { error: "bad_request", message: "No active organization." });
    const err = await listDatasources(opts(fetchImpl)).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("no_workspace");
  });

  it("404 → not_found surfacing the server message", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_found", message: 'Connection "x" not found.' });
    const err = await getDatasource(opts(fetchImpl), "x").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("not_found");
    expect((err as DatasourceCliError).message).toContain("not found");
  });

  it("409 → conflict surfacing the server message", async () => {
    const { fetchImpl } = stubFetch(409, {
      error: "conflict",
      message: "Cannot delete — referenced by 2 scheduled task(s).",
    });
    const err = await deleteDatasource(opts(fetchImpl), "prod-us").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("conflict");
    expect((err as DatasourceCliError).message).toContain("scheduled task");
  });

  it("a network failure → network", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const err = await listDatasources({ baseUrl: BASE, token: TOKEN, fetchImpl }).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("network");
    expect((err as DatasourceCliError).message).toContain(BASE);
  });

  it("a timeout → network with the timeout copy", async () => {
    const fetchImpl = (() => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const err = await testDatasource({ baseUrl: BASE, token: TOKEN, fetchImpl }, "x").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("network");
    expect((err as DatasourceCliError).message).toContain("Timed out");
    expect((err as DatasourceCliError).message).toContain("test datasource");
  });

  it("a 500 → request_failed surfacing the server message + requestId", async () => {
    const { fetchImpl } = stubFetch(500, {
      error: "internal_error",
      message: "Drain failed.",
      requestId: "req-xyz",
    });
    const err = await deleteDatasource(opts(fetchImpl), "prod-us").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("request_failed");
    expect((err as DatasourceCliError).message).toContain("Drain failed.");
    expect((err as DatasourceCliError).message).toContain("req-xyz");
  });

  it("a non-JSON error body → request_failed with an HTTP-status message", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;
    const err = await listDatasources({ baseUrl: BASE, token: TOKEN, fetchImpl }).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("request_failed");
    expect((err as DatasourceCliError).message).toContain("HTTP 502");
  });
});

describe("datasource-client create error mapping (#4051)", () => {
  it("400 connection_failed → connection_failed surfacing the (scrubbed) test error", async () => {
    const { fetchImpl } = stubFetch(400, {
      error: "connection_failed",
      message: "Connection test failed: timeout. Fix the URL and try again.",
    });
    const err = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://u:p@h/db").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("connection_failed");
    expect((err as DatasourceCliError).message).toContain("Fix the URL");
  });

  it("409 → conflict when the id already exists", async () => {
    const { fetchImpl } = stubFetch(409, { error: "conflict", message: 'Connection "ds1" already exists.' });
    const err = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://u:p@h/db").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("conflict");
  });

  it("429 plan_limit_exceeded → plan_limit (distinct from a bare rate-limit 429)", async () => {
    const { fetchImpl } = stubFetch(429, { error: "plan_limit_exceeded", message: "Datasource limit reached." });
    const err = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://u:p@h/db").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("plan_limit");
    expect((err as DatasourceCliError).message).toContain("limit");
  });

  it("a bare 429 (rate limit, no plan error) → request_failed", async () => {
    const { fetchImpl } = stubFetch(429, { error: "rate_limited", message: "Too many requests." });
    const err = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://u:p@h/db").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("request_failed");
  });

  it("503 → billing_unavailable (fail-closed, retry — not an upgrade prompt)", async () => {
    const { fetchImpl } = stubFetch(503, { error: "billing_check_failed", message: "Try again shortly." });
    const err = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://u:p@h/db").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("billing_unavailable");
  });

  it("404 not_available → not_available (no internal DB on this deployment)", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_available", message: "Requires an internal database." });
    const err = await createDatasource(opts(fetchImpl), { id: "ds1" }, "postgres://u:p@h/db").catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("not_available");
  });
});

// ---------------------------------------------------------------------------
// profile — NDJSON streaming consumer (#4052)
// ---------------------------------------------------------------------------

/** A fetch stub that returns an NDJSON 200 body, optionally split into chunks. */
function stubNdjsonStream(chunks: string[]): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      authorization:
        init?.headers && typeof init.headers === "object"
          ? ((init.headers as Record<string, string>).Authorization ?? null)
          : null,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("datasource-client profile streaming (#4052)", () => {
  const resultLine = JSON.stringify({
    type: "result",
    id: "prod-us",
    queryable: true,
    persisted: true,
    persistedStatus: "draft",
    entitiesGenerated: 2,
    metricsGenerated: 1,
    tables: ["orders", "users"],
    profilingErrors: 0,
    incomplete: false,
    elapsedMs: 1234,
  });

  it("POSTs to the profile route with the bearer and an empty body by default", async () => {
    const { fetchImpl, calls } = stubNdjsonStream([
      `${JSON.stringify({ type: "start", total: 0 })}\n${resultLine}\n`,
    ]);
    await profileDatasource(opts(fetchImpl), { id: "prod-us" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/datasources/prod-us/profile`);
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body).toBe("{}");
  });

  it("passes a schema override in the body when supplied", async () => {
    const { fetchImpl, calls } = stubNdjsonStream([`${resultLine}\n`]);
    await profileDatasource(opts(fetchImpl), { id: "prod-us", schema: "analytics" });
    expect(calls[0].body).toBe(JSON.stringify({ schema: "analytics" }));
  });

  it("forwards start + table events to the reporter and returns the terminal result", async () => {
    const { fetchImpl } = stubNdjsonStream([
      `${JSON.stringify({ type: "start", total: 2 })}\n`,
      `${JSON.stringify({ type: "table", name: "orders", index: 0, total: 2, status: "done" })}\n`,
      `${JSON.stringify({ type: "table", name: "users", index: 1, total: 2, status: "error", error: "denied" })}\n`,
      `${resultLine}\n`,
    ]);
    let started = -1;
    const tables: ProfileTableEvent[] = [];
    const result = await profileDatasource(opts(fetchImpl), {
      id: "prod-us",
      reporter: { onStart: (t) => (started = t), onTable: (e) => tables.push(e) },
    });
    expect(started).toBe(2);
    expect(tables.map((t) => t.name)).toEqual(["orders", "users"]);
    expect(tables[1].status).toBe("error");
    expect(tables[1].error).toBe("denied");
    expect(result.entitiesGenerated).toBe(2);
    expect(result.persistedStatus).toBe("draft");
  });

  it("reassembles events split across chunk boundaries", async () => {
    // The `start` event is split mid-JSON across two chunks; the consumer must
    // buffer until the newline rather than mis-parsing a partial line.
    const startLine = JSON.stringify({ type: "start", total: 1 });
    const { fetchImpl } = stubNdjsonStream([
      startLine.slice(0, 10),
      `${startLine.slice(10)}\n${resultLine}\n`,
    ]);
    let started = -1;
    const result = await profileDatasource(opts(fetchImpl), {
      id: "prod-us",
      reporter: { onStart: (t) => (started = t), onTable: () => {} },
    });
    expect(started).toBe(1);
    expect(result.id).toBe("prod-us");
  });

  it("a terminal error event → request_failed with the server message", async () => {
    const { fetchImpl } = stubNdjsonStream([
      `${JSON.stringify({ type: "error", error: "profiling_failed", message: "No profilable tables." })}\n`,
    ]);
    const err = await profileDatasource(opts(fetchImpl), { id: "prod-us" }).catch((e) => e);
    expect(err).toBeInstanceOf(DatasourceCliError);
    expect((err as DatasourceCliError).message).toContain("No profilable tables");
  });

  it("a reconnect_required terminal error → conflict", async () => {
    const { fetchImpl } = stubNdjsonStream([
      `${JSON.stringify({ type: "error", error: "reconnect_required", message: "Reconnect it." })}\n`,
    ]);
    const err = await profileDatasource(opts(fetchImpl), { id: "sfdc" }).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("conflict");
  });

  it("a stream that ends without a result → request_failed (not a silent success)", async () => {
    const { fetchImpl } = stubNdjsonStream([
      `${JSON.stringify({ type: "start", total: 0 })}\n`,
    ]);
    const err = await profileDatasource(opts(fetchImpl), { id: "prod-us" }).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("request_failed");
    expect((err as DatasourceCliError).message).toContain("without a result");
  });

  it("maps a pre-stream 403 role denial to an actionable admin-role message", async () => {
    const { fetchImpl } = stubFetch(403, { error: "forbidden_role", message: "Admin role required." });
    const err = await profileDatasource(opts(fetchImpl), { id: "prod-us" }).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("forbidden");
    expect((err as DatasourceCliError).message).toContain("admin role");
  });

  it("maps a pre-stream 404 to not_found", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_found", message: "nope" });
    const err = await profileDatasource(opts(fetchImpl), { id: "ghost" }).catch((e) => e);
    expect((err as DatasourceCliError).kind).toBe("not_found");
  });

  it("an aborted fetch (Ctrl-C) → network with cancelled copy", async () => {
    // Mirror real fetch: an aborted request rejects with an AbortError.
    const fetchImpl = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const err = await profileDatasource(opts(fetchImpl), {
      id: "prod-us",
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DatasourceCliError);
    expect((err as DatasourceCliError).kind).toBe("network");
    expect((err as DatasourceCliError).message).toContain("cancelled");
  });
});
