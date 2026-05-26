/**
 * Cloudflare Turnstile siteverify wrapper tests (#2730).
 *
 * No live calls to challenges.cloudflare.com — fetch is overridden via
 * the `fetchImpl` option on every test.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { verifyTurnstile } from "../turnstile";

const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
});

interface CapturedCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

function makeScriptedFetch(response: { status: number; body: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k] = v;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
      headers,
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe("verifyTurnstile", () => {
  test("fails closed when TURNSTILE_SECRET_KEY is unset", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const result = await verifyTurnstile({
      token: "tok",
      fetchImpl: (async () => {
        throw new Error("siteverify must not be called without a secret");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_secret");
      expect(result.errorCodes).toEqual([]);
    }
  });

  test("returns ok=true when Cloudflare returns success=true", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret_xyz";
    const { fetch, calls } = makeScriptedFetch({
      status: 200,
      body: { success: true },
    });
    const result = await verifyTurnstile({
      token: "good-token",
      remoteIp: "203.0.113.42",
      fetchImpl: fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // Body is form-encoded — assert each key independently rather than
    // pinning ordering (URLSearchParams produces stable but not
    // contract-guaranteed order).
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("secret")).toBe("secret_xyz");
    expect(params.get("response")).toBe("good-token");
    expect(params.get("remoteip")).toBe("203.0.113.42");
  });

  test("omits remoteip when not provided", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const { fetch, calls } = makeScriptedFetch({
      status: 200,
      body: { success: true },
    });
    await verifyTurnstile({ token: "t", fetchImpl: fetch });
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("remoteip")).toBeNull();
  });

  test("returns ok=false with error-codes when Cloudflare returns success=false", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const { fetch } = makeScriptedFetch({
      status: 200,
      body: {
        success: false,
        "error-codes": ["invalid-input-response", "timeout-or-duplicate"],
      },
    });
    const result = await verifyTurnstile({ token: "bad", fetchImpl: fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCodes).toEqual([
        "invalid-input-response",
        "timeout-or-duplicate",
      ]);
      expect(result.reason).toBe("siteverify_rejected");
    }
  });

  test("returns ok=false with empty error-codes when success=false with no codes", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const { fetch } = makeScriptedFetch({
      status: 200,
      body: { success: false },
    });
    const result = await verifyTurnstile({ token: "t", fetchImpl: fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCodes).toEqual([]);
      expect(result.reason).toBe("siteverify_no_success");
    }
  });

  test("returns ok=false on 5xx from Cloudflare with body excerpt for diagnostics", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const { fetch } = makeScriptedFetch({ status: 502, body: { foo: "bar" } });
    const result = await verifyTurnstile({ token: "t", fetchImpl: fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("siteverify_http_502");
      // Operator-diagnostic excerpt: capture upstream body verbatim
      // (truncated to ~200 chars) so a misconfigured secret/sitekey
      // doesn't require reproducing the failure to debug.
      expect(result.reason).toContain('"foo":"bar"');
    }
  });

  test("returns ok=false on 4xx with body excerpt (Cloudflare misconfig response)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const { fetch } = makeScriptedFetch({
      status: 400,
      body: { "error-codes": ["invalid-input-secret"] },
    });
    const result = await verifyTurnstile({ token: "t", fetchImpl: fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("siteverify_http_400");
      expect(result.reason).toContain("invalid-input-secret");
    }
  });

  test("returns ok=false on network failure (does not throw)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const result = await verifyTurnstile({
      token: "t",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("siteverify_request_failed");
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  test("returns ok=false on non-JSON success body (defensive parse)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const fetchImpl = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as unknown as typeof globalThis.fetch;
    const result = await verifyTurnstile({ token: "t", fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("siteverify_parse_failed");
    }
  });
});
