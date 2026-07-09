/**
 * Shared workspace-HTTP primitives (#4196) — unit tests.
 *
 * `lib/http.ts` is the ONE fetch → timeout → ok → error-map execution path the
 * lifecycle clients (`sql`/`metric`/`datasource`) ride, plus the byte-identical
 * status copy (`defaultWorkspaceErrorInfo`) they share. The per-command suites
 * exercise these through each client; this pins the shared units directly so the
 * status→copy table + the transport invariants are tested ONCE, not re-asserted
 * per client.
 */

import { describe, it, expect } from "bun:test";

import {
  asRecord,
  defaultWorkspaceErrorInfo,
  isAbortOrTimeout,
  NO_WORKSPACE_MESSAGE,
  serverMessage,
  SESSION_INVALID_MESSAGE,
  unreachableMessage,
  workspaceRequest,
  type WorkspaceRequestTarget,
} from "../lib/http";
import type { CliCredential } from "../lib/credential";

const BASE = "http://localhost:3001";
const TOKEN = "sess_bearer";

/** A minimal typed error so we can assert the client's `toError`/`toNetworkError` ran. */
class StubError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "StubError";
  }
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** One canned response, capturing method/url/headers/body. */
function stubFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers as Record<string, string>).forEach((v, k) => (headers[k] = v));
    calls.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function target(fetchImpl: typeof fetch, credential: CliCredential = { token: TOKEN }): WorkspaceRequestTarget {
  return { baseUrl: BASE, credential, fetchImpl };
}

const HANDLERS = {
  toError: (status: number, body: Record<string, unknown>) =>
    new StubError(`err_${status}`, serverMessage(body, status)),
  toNetworkError: (message: string) => new StubError("network", message),
  timeoutMessage: (seconds: number) => `Timed out after ${seconds}s doing the thing.`,
};

// ---------------------------------------------------------------------------

describe("defaultWorkspaceErrorInfo — the shared status→copy table (#4196)", () => {
  it("401 → unauthorized with the shared re-login copy", () => {
    expect(defaultWorkspaceErrorInfo(401, { error: "auth_error" })).toEqual({
      kind: "unauthorized",
      message: SESSION_INVALID_MESSAGE,
    });
  });

  it("400 bad_request → no_workspace with the shared guidance", () => {
    expect(defaultWorkspaceErrorInfo(400, { error: "bad_request" })).toEqual({
      kind: "no_workspace",
      message: NO_WORKSPACE_MESSAGE,
    });
  });

  it("a non-bad_request 400 → request_failed (the client special-cases its own 400s first)", () => {
    const info = defaultWorkspaceErrorInfo(400, { error: "invalid_sql", message: "bad table" });
    expect(info.kind).toBe("request_failed");
    expect(info.message).toContain("bad table");
  });

  it("any other status → request_failed surfacing the server message + requestId", () => {
    const info = defaultWorkspaceErrorInfo(500, { message: "boom", requestId: "req-9" });
    expect(info.kind).toBe("request_failed");
    expect(info.message).toBe("boom (request req-9)");
  });

  it("the shared copy names the actionable remedy", () => {
    expect(SESSION_INVALID_MESSAGE).toContain("atlas login");
    expect(NO_WORKSPACE_MESSAGE).toContain("not bound to a workspace");
  });
});

describe("workspaceRequest — the shared transport (#4196)", () => {
  it("POSTs to baseUrl+path with the credential header, Content-Type, and the JSON body", async () => {
    const { fetchImpl, calls } = stubFetch(200, { ok: true });
    const out = await workspaceRequest(
      target(fetchImpl),
      { method: "POST", path: "/api/v1/execute-sql", body: { sql: "SELECT 1" } },
      HANDLERS,
    );
    expect(out).toEqual({ ok: true });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/execute-sql`);
    expect(calls[0].headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body!)).toEqual({ sql: "SELECT 1" });
  });

  it("an api-key credential rides x-api-key, never Authorization", async () => {
    const { fetchImpl, calls } = stubFetch(200, {});
    await workspaceRequest(
      target(fetchImpl, { apiKey: "atlas_wk_1" }),
      { method: "GET", path: "/api/v1/admin/connections" },
      HANDLERS,
    );
    expect(calls[0].headers["x-api-key"]).toBe("atlas_wk_1");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("omits the body and Content-Type on a GET with no body", async () => {
    const { fetchImpl, calls } = stubFetch(200, {});
    await workspaceRequest(target(fetchImpl), { method: "GET", path: "/api/v1/admin/connections" }, HANDLERS);
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers["content-type"]).toBeUndefined();
  });

  it("forwards a DELETE (no body) verbatim — the method contract covers all three verbs", async () => {
    const { fetchImpl, calls } = stubFetch(200, { success: true });
    await workspaceRequest(
      target(fetchImpl),
      { method: "DELETE", path: "/api/v1/admin/connections/prod-us" },
      HANDLERS,
    );
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers["content-type"]).toBeUndefined();
  });

  it("degrades an empty/non-JSON 2xx body to {} rather than throwing", async () => {
    const { fetchImpl } = stubFetch(200, undefined); // empty body
    const out = await workspaceRequest(target(fetchImpl), { method: "POST", path: "/p", body: {} }, HANDLERS);
    expect(out).toEqual({});
  });

  it("routes a non-2xx through the client's toError(status, body)", async () => {
    const { fetchImpl } = stubFetch(403, { error: "forbidden", message: "nope" });
    const err = await workspaceRequest(target(fetchImpl), { method: "GET", path: "/p" }, HANDLERS).catch((e) => e);
    expect(err).toBeInstanceOf(StubError);
    expect((err as StubError).kind).toBe("err_403");
    expect((err as StubError).message).toContain("nope");
  });

  it("a timeout throws the client's network error with the timeout copy", async () => {
    const fetchImpl = (() => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const err = await workspaceRequest(
      { baseUrl: BASE, credential: { token: TOKEN }, fetchImpl, timeoutMs: 5_000 },
      { method: "GET", path: "/p" },
      HANDLERS,
    ).catch((e) => e);
    expect((err as StubError).kind).toBe("network");
    expect((err as StubError).message).toBe("Timed out after 5s doing the thing.");
  });

  it("an unreachable API throws the client's network error naming the base URL", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const err = await workspaceRequest(
      { baseUrl: BASE, credential: { token: TOKEN }, fetchImpl },
      { method: "GET", path: "/p" },
      HANDLERS,
    ).catch((e) => e);
    expect((err as StubError).kind).toBe("network");
    expect((err as StubError).message).toContain(BASE);
    expect((err as StubError).message).toContain("ECONNREFUSED");
  });
});

describe("pure helpers", () => {
  it("asRecord narrows objects and degrades non-objects to {}", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toEqual({});
    expect(asRecord("x")).toEqual({});
  });

  it("serverMessage prefers message > error > HTTP status and appends a requestId", () => {
    expect(serverMessage({ message: "m" }, 400)).toBe("m");
    expect(serverMessage({ error: "e" }, 400)).toBe("e");
    expect(serverMessage({}, 418)).toBe("HTTP 418");
    expect(serverMessage({ message: "m", requestId: "r1" }, 400)).toBe("m (request r1)");
  });

  it("serverMessage treats empty-string envelope fields as absent (the `.length > 0` guards)", () => {
    // An empty `message` must fall through to `error`, not surface as "".
    expect(serverMessage({ message: "", error: "e" }, 400)).toBe("e");
    // An empty `error` (and message) must fall through to the HTTP status.
    expect(serverMessage({ message: "", error: "" }, 500)).toBe("HTTP 500");
    // An empty `requestId` must NOT produce a dangling "(request )" suffix.
    expect(serverMessage({ message: "m", requestId: "" }, 400)).toBe("m");
  });

  it("isAbortOrTimeout recognizes TimeoutError and AbortError only", () => {
    const t = new Error("x");
    t.name = "TimeoutError";
    const a = new Error("x");
    a.name = "AbortError";
    expect(isAbortOrTimeout(t)).toBe(true);
    expect(isAbortOrTimeout(a)).toBe(true);
    expect(isAbortOrTimeout(new Error("other"))).toBe(false);
  });

  it("unreachableMessage names the base URL and the underlying error", () => {
    expect(unreachableMessage(BASE, new Error("down"))).toBe(`Could not reach the Atlas API at ${BASE}: down`);
  });
});
