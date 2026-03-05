/**
 * E2E: Helper infrastructure tests.
 *
 * Validates that the shared test helpers (mock-server, slack-helpers,
 * wait-for, api-client) work correctly before other surfaces depend on them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createMockServer, createRoutedMockServer, type MockServer } from "../helpers/mock-server";
import { makeSignature } from "../helpers/slack-helpers";
import { waitFor, waitForHealthy } from "../helpers/wait-for";
import { AtlasClient } from "../helpers/api-client";

describe("E2E: Mock server", () => {
  let server: MockServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("starts on a random port and serves responses", async () => {
    server = createMockServer();
    expect(server.port).toBeGreaterThan(0);

    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("records calls with method, path, headers, and body", async () => {
    server = createMockServer();

    await fetch(`${server.url}/test/path?q=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "value" },
      body: JSON.stringify({ data: 42 }),
    });

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].method).toBe("POST");
    expect(server.calls[0].path).toBe("/test/path?q=1");
    expect(server.calls[0].headers["x-custom"]).toBe("value");
    expect(server.calls[0].body).toBe('{"data":42}');
  });

  it("supports custom handlers", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({ custom: true }), { status: 201 }),
    );

    const res = await fetch(server.url);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.custom).toBe(true);
  });

  it("records multiple sequential calls", async () => {
    server = createMockServer();
    await fetch(`${server.url}/first`);
    await fetch(`${server.url}/second`);
    await fetch(`${server.url}/third`);

    expect(server.calls).toHaveLength(3);
    expect(server.calls[0].path).toBe("/first");
    expect(server.calls[1].path).toBe("/second");
    expect(server.calls[2].path).toBe("/third");
  });

  it("preserves request body for handlers", async () => {
    server = createMockServer(async (req) => {
      const body = await req.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ echo: body.value }));
    });

    const res = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.echo).toBe("hello");
    // Call log also captured the body
    expect(server.calls[0].body).toBe('{"value":"hello"}');
  });

  it("captures handler errors instead of silently swallowing", async () => {
    server = createMockServer(() => {
      throw new Error("handler crashed");
    });

    const res = await fetch(server.url);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Mock handler threw");
    expect(body.detail).toBe("handler crashed");
    expect(server.errors).toHaveLength(1);
    expect(server.errors[0].message).toBe("handler crashed");
  });

  it("supports routed handlers", async () => {
    server = createRoutedMockServer({
      "/health": () => new Response(JSON.stringify({ status: "ok" })),
      "/data": () => new Response(JSON.stringify({ rows: [1, 2, 3] })),
    });

    const healthRes = await fetch(`${server.url}/health`);
    expect(healthRes.status).toBe(200);

    const dataRes = await fetch(`${server.url}/data`);
    const dataBody = (await dataRes.json()) as { rows: number[] };
    expect(dataBody.rows).toEqual([1, 2, 3]);

    const notFoundRes = await fetch(`${server.url}/unknown`);
    expect(notFoundRes.status).toBe(404);
  });
});

describe("E2E: Slack helpers", () => {
  it("generates valid HMAC-SHA256 signatures", () => {
    const secret = "test-secret";
    const body = "hello=world";
    const { signature, timestamp } = makeSignature(secret, body);

    expect(signature).toStartWith("v0=");
    expect(signature).toHaveLength(3 + 64); // "v0=" prefix + 64 hex chars
    expect(timestamp).toMatch(/^\d+$/);
  });

  it("produces different signatures for different bodies", () => {
    const secret = "test-secret";
    const ts = "1234567890";
    const { signature: sig1 } = makeSignature(secret, "body-a", ts);
    const { signature: sig2 } = makeSignature(secret, "body-b", ts);

    expect(sig1).not.toBe(sig2);
  });

  it("produces same signature for same inputs", () => {
    const secret = "test-secret";
    const body = "same-body";
    const ts = "1234567890";
    const { signature: sig1 } = makeSignature(secret, body, ts);
    const { signature: sig2 } = makeSignature(secret, body, ts);

    expect(sig1).toBe(sig2);
  });
});

describe("E2E: waitFor", () => {
  it("resolves when predicate returns true", async () => {
    let count = 0;
    await waitFor(() => {
      count++;
      return count >= 3;
    }, 5000, 50);

    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("throws on timeout", async () => {
    await expect(
      waitFor(() => false, 200, 50),
    ).rejects.toThrow("timed out");
  });

  it("resolves with async predicate", async () => {
    let count = 0;
    await waitFor(async () => {
      count++;
      return count >= 3;
    }, 5000, 50);

    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("retries when predicate throws instead of aborting", async () => {
    let count = 0;
    await waitFor(() => {
      count++;
      if (count < 3) throw new Error("not ready");
      return true;
    }, 5000, 50);

    expect(count).toBeGreaterThanOrEqual(3);
  });
});

describe("E2E: waitForHealthy", () => {
  let server: MockServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("resolves when URL returns 200", async () => {
    server = createMockServer(() => new Response("ok", { status: 200 }));
    await waitForHealthy(server.url, 5000, 50);
  });

  it("throws on persistent non-2xx", async () => {
    server = createMockServer(() => new Response("fail", { status: 503 }));
    await expect(
      waitForHealthy(server.url, 300, 50),
    ).rejects.toThrow("timed out");
  });

  it("retries through initial failures then resolves", async () => {
    let callCount = 0;
    server = createMockServer(() => {
      callCount++;
      if (callCount < 3) return new Response("not ready", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    await waitForHealthy(server.url, 5000, 50);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

describe("E2E: AtlasClient", () => {
  let server: MockServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("sends GET requests with auth header", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({ status: "ok" })),
    );

    const client = new AtlasClient({
      baseUrl: server.url,
      apiKey: "test-key-123",
    });

    const res = await client.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    expect(server.calls[0].headers["authorization"]).toBe("Bearer test-key-123");
  });

  it("sends POST requests with JSON body", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({ answer: "42" })),
    );

    const client = new AtlasClient({ baseUrl: server.url });

    const res = await client.post("/api/v1/query", { question: "how many?" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer: "42" });

    expect(server.calls[0].method).toBe("POST");
    expect(JSON.parse(server.calls[0].body)).toEqual({ question: "how many?" });
  });

  it("sends DELETE requests", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({ deleted: true })),
    );

    const client = new AtlasClient({ baseUrl: server.url });
    const res = await client.delete("/api/v1/conversations/123");
    expect(res.status).toBe(200);
    expect(server.calls[0].method).toBe("DELETE");
    expect(server.calls[0].path).toBe("/api/v1/conversations/123");
  });

  it("query() sends question to /api/v1/query", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({ answer: "5", sql: [], data: [], steps: 1, usage: { totalTokens: 100 } })),
    );
    const client = new AtlasClient({ baseUrl: server.url });
    const res = await client.query("how many orders?");
    expect(res.body.answer).toBe("5");
    expect(server.calls[0].path).toBe("/api/v1/query");
    expect(JSON.parse(server.calls[0].body)).toEqual({ question: "how many orders?" });
  });

  it("query() includes conversationId when provided", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({ answer: "5", sql: [], data: [], steps: 1, usage: { totalTokens: 100 } })),
    );
    const client = new AtlasClient({ baseUrl: server.url });
    await client.query("follow up", { conversationId: "conv-123" });
    const body = JSON.parse(server.calls[0].body) as Record<string, unknown>;
    expect(body.conversationId).toBe("conv-123");
  });

  it("aborts requests that exceed timeoutMs", async () => {
    server = createMockServer(async () => {
      await Bun.sleep(5000);
      return new Response("too late");
    });

    const client = new AtlasClient({ baseUrl: server.url, timeoutMs: 100 });
    await expect(client.get("/slow")).rejects.toThrow();
  });

  it("health() shortcut works", async () => {
    server = createMockServer(() =>
      new Response(JSON.stringify({
        status: "ok",
        checks: {
          datasource: { status: "ok" },
          provider: { status: "ok", provider: "anthropic", model: "claude-sonnet-4-6" },
          semanticLayer: { status: "ok", entityCount: 3 },
          internalDb: { status: "not_configured" },
          explore: { backend: "just-bash", isolated: false },
          auth: { mode: "none", enabled: false },
          slack: { enabled: false, mode: "disabled" },
        },
      })),
    );

    const client = new AtlasClient({ baseUrl: server.url });
    const res = await client.health();
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.provider.provider).toBe("anthropic");
  });
});
