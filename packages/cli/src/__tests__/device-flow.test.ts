import { describe, it, expect } from "bun:test";

import {
  requestDeviceCode,
  pollForToken,
  DeviceFlowError,
  ATLAS_CLI_CLIENT_ID,
} from "../lib/device-flow";

const BASE = "http://localhost:3001";

interface ResponseSpec {
  status: number;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): ResponseSpec {
  return { status, body };
}

/**
 * A fetch stub that returns queued responses in order, building a FRESH
 * `Response` each call (response bodies are single-use, and the poll loop may
 * read the same queued spec across attempts once the queue is exhausted).
 */
function queuedFetch(specs: ResponseSpec[]): { fetchImpl: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(typeof url === "string" ? url : url.toString(), init));
    const spec = specs[Math.min(i, specs.length - 1)];
    i++;
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

/** A fetch stub that always rejects (network down / DNS failure). */
const rejectingFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

describe("requestDeviceCode (#4043)", () => {
  it("returns the device + user code on success", async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(200, {
        device_code: "dev_123",
        user_code: "ABCD-1234",
        verification_uri: "http://localhost:3000/device",
        verification_uri_complete: "http://localhost:3000/device?user_code=ABCD-1234",
        expires_in: 1800,
        interval: 5,
      }),
    ]);
    const out = await requestDeviceCode(BASE, { clientId: ATLAS_CLI_CLIENT_ID, fetchImpl });
    expect(out.user_code).toBe("ABCD-1234");
    expect(out.device_code).toBe("dev_123");
    expect(out.interval).toBe(5);
    // Hits the Better Auth device/code endpoint.
    expect(calls[0].url).toContain("/api/auth/device/code");
  });

  it("throws a DeviceFlowError when the endpoint errors", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, { error: "invalid_request", error_description: "bad client" }),
    ]);
    await expect(
      requestDeviceCode(BASE, { clientId: ATLAS_CLI_CLIENT_ID, fetchImpl }),
    ).rejects.toBeInstanceOf(DeviceFlowError);
  });

  it("throws network_error when the request cannot reach the API", async () => {
    const err = await requestDeviceCode(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      fetchImpl: rejectingFetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("network_error");
  });
});

describe("pollForToken (#4043)", () => {
  it("returns the bearer once approved (after pending polls)", async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(400, { error: "authorization_pending", error_description: "wait" }),
      jsonResponse(400, { error: "authorization_pending", error_description: "wait" }),
      jsonResponse(200, { access_token: "sess_xyz", token_type: "Bearer", expires_in: 3600 }),
    ]);
    const result = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.token).toBe("sess_xyz");
    expect(result.expiresIn).toBe(3600);
    expect(calls.length).toBe(3);
    expect(calls[0].url).toContain("/api/auth/device/token");
  });

  it("backs off on slow_down and keeps polling", async () => {
    const intervals: number[] = [];
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, { error: "slow_down", error_description: "slow" }),
      jsonResponse(200, { access_token: "sess_ok", token_type: "Bearer" }),
    ]);
    const result = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 5,
      fetchImpl,
      sleep: noSleep,
      onSlowDown: (s) => intervals.push(s),
    });
    expect(result.token).toBe("sess_ok");
    expect(intervals).toEqual([10]); // 5 + 5
  });

  it("throws on access_denied (terminal)", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, { error: "access_denied", error_description: "denied" }),
    ]);
    const err = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl,
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe("access_denied");
  });

  it("throws expired_token with actionable guidance", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, { error: "expired_token", error_description: "expired" }),
    ]);
    const err = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl,
      sleep: noSleep,
    }).catch((e) => e);
    expect((err as DeviceFlowError).code).toBe("expired_token");
    expect((err as DeviceFlowError).message).toMatch(/atlas login/);
  });

  it("returns the bearer on the first poll when already approved", async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(200, { access_token: "sess_first", token_type: "Bearer" }),
    ]);
    const result = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.token).toBe("sess_first");
    expect(calls.length).toBe(1);
  });

  it("throws on a terminal default error (invalid_grant)", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, { error: "invalid_grant", error_description: "device code not found" }),
    ]);
    const err = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl,
      sleep: noSleep,
    }).catch((e) => e);
    expect((err as DeviceFlowError).code).toBe("invalid_grant");
    expect((err as DeviceFlowError).message).toContain("device code not found");
  });

  it("throws network_error when polling loses contact with the API", async () => {
    const err = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl: rejectingFetch,
      sleep: noSleep,
    }).catch((e) => e);
    expect((err as DeviceFlowError).code).toBe("network_error");
  });

  it("times out after maxAttempts of authorization_pending", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse(400, { error: "authorization_pending", error_description: "wait" }),
    ]);
    const err = await pollForToken(BASE, {
      clientId: ATLAS_CLI_CLIENT_ID,
      deviceCode: "dev_123",
      intervalSeconds: 1,
      fetchImpl,
      sleep: noSleep,
      maxAttempts: 3,
    }).catch((e) => e);
    expect((err as DeviceFlowError).code).toBe("timeout");
  });
});
