import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import { type AddressInfo } from "net";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import { executeOperation } from "../client";
import { OpenApiClientError, type OperationGraph } from "../types";

const FIXTURES = path.join(import.meta.dir, "fixtures");

/** What the test server saw on the most recent request. */
interface CapturedRequest {
  method: string;
  url: string; // path + query
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let baseUrl: string;
let captured: CapturedRequest | null = null;
let graph: OperationGraph;

beforeAll(async () => {
  graph = buildOperationGraph(
    JSON.parse(fs.readFileSync(path.join(FIXTURES, "client-spec.json"), "utf8")),
  );

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      route(req, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

/** Route the captured request to a canned response based on the path. */
function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];

  if (pathname === "/slow") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, 500);
    return;
  }
  if (pathname === "/rate-limited") {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
    res.end(JSON.stringify({ error: "slow down" }));
    return;
  }
  if (pathname === "/text") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello world");
    return;
  }
  if (pathname === "/empty") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === "/bad-json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{not valid json");
    return;
  }
  // Default: echo what we saw so assertions can inspect routing/auth/params.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ seen: { method: req.method, url } }));
}

describe("executeOperation — request building", () => {
  it("executes a parameterized GET: path + query + header encoding", async () => {
    const result = await executeOperation(
      graph,
      "getThing",
      {
        path: { id: "abc 123" },
        query: { q: "hello world", tags: ["a", "b"] },
        header: { "X-Trace": "trace-1" },
      },
      { kind: "bearer", token: "tok-123" },
      { baseUrl },
    );

    expect(result.status).toBe(200);
    expect(captured?.method).toBe("GET");
    // Path param is percent-encoded into the path.
    expect(captured?.url.startsWith("/things/abc%20123?")).toBe(true);
    // Query params encoded; array param explodes (repeat key).
    expect(captured?.url).toContain("q=hello+world");
    expect(captured?.url).toContain("tags=a");
    expect(captured?.url).toContain("tags=b");
    // Header param forwarded.
    expect(captured?.headers["x-trace"]).toBe("trace-1");
    // Bearer auth applied.
    expect(captured?.headers["authorization"]).toBe("Bearer tok-123");
  });

  it("drops undefined query values and explodes arrays", async () => {
    await executeOperation(
      graph,
      "getThing",
      { path: { id: "x" }, query: { q: undefined, tags: ["one", "two", "three"] } },
      { kind: "bearer", token: "t" },
      { baseUrl },
    );
    expect(captured?.url).not.toContain("q=");
    expect(captured?.url.match(/tags=/g)?.length).toBe(3);
  });

  it("uses graph.servers[0].url when no baseUrl override is given", async () => {
    // Build a graph whose declared server IS the live test server, then call
    // WITHOUT a baseUrl override — the request must still land on it.
    const serverGraph = buildOperationGraph({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: baseUrl }],
      paths: { "/public": { get: { operationId: "getPublic", security: [], responses: { "200": { description: "ok" } } } } },
    });
    const result = await executeOperation(serverGraph, "getPublic", {}, { kind: "none" });
    expect(result.status).toBe(200);
    expect(captured?.url).toBe("/public");
  });
});

describe("executeOperation — auth application per securityScheme", () => {
  it("applies an apiKey via the header named by the scheme", async () => {
    await executeOperation(graph, "getViaHeaderKey", {}, { kind: "apiKey", value: "secret-k" }, { baseUrl });
    expect(captured?.headers["x-api-key"]).toBe("secret-k");
  });

  it("applies an apiKey via the query param named by the scheme", async () => {
    await executeOperation(graph, "getViaQueryKey", {}, { kind: "apiKey", value: "qsecret" }, { baseUrl });
    expect(captured?.url).toContain("api_key=qsecret");
  });

  it("honors an explicit apiKey placement override", async () => {
    await executeOperation(
      graph,
      "getPublic",
      {},
      { kind: "apiKey", value: "ov", in: "header", name: "X-Custom-Key" },
      { baseUrl },
    );
    expect(captured?.headers["x-custom-key"]).toBe("ov");
  });

  it("applies basic auth as base64(user:pass)", async () => {
    await executeOperation(
      graph,
      "getViaBasic",
      {},
      { kind: "basic", username: "sk_live_x", password: "" },
      { baseUrl },
    );
    const expected = `Basic ${Buffer.from("sk_live_x:", "utf8").toString("base64")}`;
    expect(captured?.headers["authorization"]).toBe(expected);
  });

  it("sends no auth header when kind is none", async () => {
    await executeOperation(graph, "getPublic", {}, { kind: "none" }, { baseUrl });
    expect(captured?.headers["authorization"]).toBeUndefined();
  });

  it("fails loud when an apiKey has no placement to apply", async () => {
    // getPublic declares no apiKey scheme and no override is given.
    let err: OpenApiClientError | undefined;
    try {
      await executeOperation(graph, "getPublic", {}, { kind: "apiKey", value: "k" }, { baseUrl });
    } catch (e) {
      err = e as OpenApiClientError;
    }
    expect(err?.reason).toBe("missing-auth-placement");
  });
});

describe("executeOperation — request body", () => {
  it("serializes a JSON body and sets Content-Type", async () => {
    const result = await executeOperation(
      graph,
      "createThing",
      { body: { name: "widget" } },
      { kind: "bearer", token: "t" },
      { baseUrl },
    );
    expect(result.status).toBe(200);
    expect(captured?.method).toBe("POST");
    expect(captured?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ name: "widget" });
  });
});

describe("executeOperation — response handling", () => {
  it("returns non-2xx responses instead of throwing, and parses Retry-After", async () => {
    const result = await executeOperation(graph, "getRateLimited", {}, { kind: "none" }, { baseUrl });
    expect(result.status).toBe(429);
    expect(result.retryAfterMs).toBe(120_000);
    expect(result.body).toEqual({ error: "slow down" });
  });

  it("returns raw text for non-JSON responses", async () => {
    const result = await executeOperation(graph, "getText", {}, { kind: "none" }, { baseUrl });
    expect(result.body).toBe("hello world");
    expect(result.bodyIsRaw).toBe(true);
  });

  it("returns null body for an empty (204) response", async () => {
    const result = await executeOperation(graph, "getEmpty", {}, { kind: "none" }, { baseUrl });
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
    expect(result.bodyIsRaw).toBe(false);
  });

  it("throws unparseable-response when a JSON content-type body does not parse", async () => {
    let err: OpenApiClientError | undefined;
    try {
      await executeOperation(graph, "getBadJson", {}, { kind: "none" }, { baseUrl });
    } catch (e) {
      err = e as OpenApiClientError;
    }
    expect(err?.reason).toBe("unparseable-response");
    expect(err?.status).toBe(200);
  });
});

describe("executeOperation — timeout & fail-loud faults", () => {
  it("enforces a per-request timeout", async () => {
    let err: OpenApiClientError | undefined;
    try {
      // /slow responds after 500ms; cap at 100ms.
      await executeOperation(graph, "getSlow", {}, { kind: "none" }, { baseUrl, timeoutMs: 100 });
    } catch (e) {
      err = e as OpenApiClientError;
    }
    expect(err?.reason).toBe("timeout");
    expect(err?.status).toBe(0);
  });

  it("rejects an unknown operationId", async () => {
    let err: OpenApiClientError | undefined;
    try {
      await executeOperation(graph, "noSuchOp", {}, { kind: "none" }, { baseUrl });
    } catch (e) {
      err = e as OpenApiClientError;
    }
    expect(err?.reason).toBe("unknown-operation");
  });

  it("rejects a missing required path param", async () => {
    let err: OpenApiClientError | undefined;
    try {
      await executeOperation(graph, "getThing", {}, { kind: "bearer", token: "t" }, { baseUrl });
    } catch (e) {
      err = e as OpenApiClientError;
    }
    expect(err?.reason).toBe("missing-path-param");
  });
});
