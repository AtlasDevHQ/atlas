import { describe, expect, it } from "bun:test";
import { detectLocalAtlas } from "../../init/local-atlas.js";

const HEALTHY = { ok: true, status: 200 } as Response;
const UNHEALTHY = { ok: false, status: 500 } as Response;

describe("detectLocalAtlas", () => {
  it("returns true when /api/v1/health responds 2xx at the configured URL", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return HEALTHY;
    }) as unknown as typeof fetch;
    const found = await detectLocalAtlas({
      url: "http://localhost:3001",
      fetchImpl,
      timeoutMs: 100,
    });
    expect(found).toBe(true);
    expect(calls[0]).toBe("http://localhost:3001/api/v1/health");
  });

  it("returns false when fetch throws (connection refused)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const found = await detectLocalAtlas({
      url: "http://localhost:3001",
      fetchImpl,
      timeoutMs: 100,
    });
    expect(found).toBe(false);
  });

  it("returns false when the server responds with non-2xx", async () => {
    const fetchImpl = (async () => UNHEALTHY) as unknown as typeof fetch;
    const found = await detectLocalAtlas({
      url: "http://localhost:3001",
      fetchImpl,
      timeoutMs: 100,
    });
    expect(found).toBe(false);
  });

  it("uses the URL from ATLAS_API_URL when explicitly provided", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return HEALTHY;
    }) as unknown as typeof fetch;
    await detectLocalAtlas({
      url: "http://atlas.internal:9000",
      fetchImpl,
      timeoutMs: 100,
    });
    expect(calls[0]).toBe("http://atlas.internal:9000/api/v1/health");
  });

  it("returns false when fetch hangs past the timeout", async () => {
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const found = await detectLocalAtlas({
      url: "http://localhost:3001",
      fetchImpl,
      timeoutMs: 5,
    });
    expect(found).toBe(false);
  });
});
