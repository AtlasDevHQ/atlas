import { describe, it, expect } from "bun:test";

import {
  DatasourceCliError,
  listDatasources,
  getDatasource,
  testDatasource,
  archiveDatasource,
  restoreDatasource,
  deleteDatasource,
  type DatasourceClientOptions,
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
