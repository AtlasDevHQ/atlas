import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withClientIpHeader, shouldTrustProxyHeaders, stripPortSuffix } from "../routes/auth";

/**
 * Regression tests for the F-06 IP-injection middleware.
 *
 * `withClientIpHeader` is the trust boundary for Better Auth's rate
 * limiter: if it resolves the wrong IP, or lets an attacker spoof it,
 * or silently skips writing the header, the rate limits stop working.
 * These tests pin the behaviors the security audit called out.
 */

const ORIGINAL_ENV = { ...process.env };

// `withClientIpHeader` takes a Hono `Context`. For unit testing we only
// need the shape the function actually touches — `c.req.raw` and, when
// falling back to socket resolution, the underlying Bun `server` that
// Hono's `getConnInfo` reads via `c.env`. A plain object with those two
// fields is enough and keeps the tests off the real Hono app.
interface FakeCtx {
  req: { raw: Request };
  env: unknown;
}

function makeCtx(init: { headers?: Record<string, string>; serverIp?: string }): FakeCtx {
  const req = new Request("http://localhost/auth/sign-in/email", {
    method: "POST",
    headers: init.headers,
  });
  // Hono's getConnInfo calls server.requestIP(req). A minimal stub
  // returns { address } when we want to simulate a Bun socket, or
  // throws to simulate the "no server" case (Next.js standalone).
  const env = init.serverIp === undefined
    ? { requestIP: () => { throw new Error("no Bun server in env"); } }
    : { requestIP: () => ({ address: init.serverIp!, family: "IPv4", port: 54321 }) };
  return { req: { raw: req }, env };
}

beforeEach(() => {
  // Reset the env variables the middleware reads so tests don't leak
  // into each other.
  delete process.env.ATLAS_TRUST_PROXY;
  delete process.env.VERCEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("shouldTrustProxyHeaders", () => {
  it("defaults to false", () => {
    expect(shouldTrustProxyHeaders({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("trusts when ATLAS_TRUST_PROXY is 'true' or '1'", () => {
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("ignores other truthy spellings to avoid accidental trust", () => {
    // Deliberately stricter than resolveRequireEmailVerification —
    // accidentally trusting a proxy that isn't actually in front of
    // you makes X-Forwarded-For client-spoofable.
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "yes" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "on" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("auto-enables trust on Vercel (VERCEL=1)", () => {
    // Vercel's edge always sets X-Forwarded-For and never exposes a
    // Bun socket; without auto-trust, rate limiting would silently
    // no-op for every Vercel deploy.
    expect(shouldTrustProxyHeaders({ VERCEL: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("stripPortSuffix", () => {
  it("strips a trailing port from an IPv4 address", () => {
    expect(stripPortSuffix("1.2.3.4:54321")).toBe("1.2.3.4");
  });

  it("strips the bracketed port form from IPv6", () => {
    expect(stripPortSuffix("[2001:db8::1]:54321")).toBe("2001:db8::1");
    expect(stripPortSuffix("[::1]:54321")).toBe("::1");
  });

  it("leaves bare IPv6 untouched (no trailing port)", () => {
    // These must pass through unmangled — rate-limit buckets key on
    // the exact string, and rewriting `::1` to `::` would clobber it.
    expect(stripPortSuffix("::1")).toBe("::1");
    expect(stripPortSuffix("2001:db8::1")).toBe("2001:db8::1");
  });

  it("leaves bare IPv4 untouched", () => {
    expect(stripPortSuffix("1.2.3.4")).toBe("1.2.3.4");
  });

  it("trims surrounding whitespace", () => {
    expect(stripPortSuffix("  1.2.3.4  ")).toBe("1.2.3.4");
  });
});

describe("withClientIpHeader", () => {
  it("strips any inbound x-atlas-client-ip header (spoof prevention)", () => {
    // An attacker cannot pick their own rate-limit bucket.
    const ctx = makeCtx({
      headers: { "x-atlas-client-ip": "99.99.99.99" },
      serverIp: "203.0.113.5",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
    expect(out.headers.get("x-atlas-client-ip")).not.toBe("99.99.99.99");
  });

  it("leaves x-atlas-client-ip unset when no IP source resolves", () => {
    // Better Auth will log a warn and skip rate limiting for this
    // request — preferable to writing "unknown" which would make one
    // attacker exhaust every other caller's bucket.
    const ctx = makeCtx({ serverIp: undefined });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBeNull();
  });

  it("does NOT consult X-Forwarded-For when ATLAS_TRUST_PROXY is unset", () => {
    // Without an explicit trust signal, any client can set
    // X-Forwarded-For to spoof their IP. The middleware must ignore
    // the header and fall back to the socket address.
    const ctx = makeCtx({
      headers: { "x-forwarded-for": "1.2.3.4" },
      serverIp: "203.0.113.5",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("uses X-Forwarded-For when ATLAS_TRUST_PROXY=true", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeCtx({
      headers: { "x-forwarded-for": "1.2.3.4" },
      serverIp: "203.0.113.5",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("1.2.3.4");
  });

  it("picks the first (client-most) entry of a multi-hop X-Forwarded-For", () => {
    // XFF chain: "<client>, <proxy1>, <proxy2>". Picking the last
    // entry would rate-limit by proxy IP, pooling every user behind
    // the same CDN into one bucket.
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeCtx({
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2" },
      serverIp: "127.0.0.1",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("falls back to X-Real-IP when XFF is absent and proxy is trusted", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeCtx({
      headers: { "x-real-ip": "203.0.113.5" },
      serverIp: "127.0.0.1",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("passes IPv6 addresses through unmangled", () => {
    const ctx = makeCtx({ serverIp: "2001:db8::1" });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("2001:db8::1");
  });

  it("strips port suffixes from resolved IPs (per-bucket integrity)", () => {
    // Bun's server.requestIP sometimes returns "address:port" style
    // for forwarded sockets; leaving the port in would create one
    // bucket per ephemeral source port, silently defeating the limit.
    const ctx = makeCtx({ serverIp: "1.2.3.4:54321" });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("1.2.3.4");
  });

  it("strips port suffixes from X-Forwarded-For entries", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeCtx({
      headers: { "x-forwarded-for": "203.0.113.5:443" },
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("does not crash when getConnInfo throws (Next.js standalone / test harness)", () => {
    // On Vercel, `app.fetch(req)` is called without the Bun server,
    // so getConnInfo has nothing to read. The middleware must not
    // 500 the request — it falls back to leaving the header unset.
    const ctx = makeCtx({ serverIp: undefined });
    expect(() => withClientIpHeader(ctx as never)).not.toThrow();
  });
});
