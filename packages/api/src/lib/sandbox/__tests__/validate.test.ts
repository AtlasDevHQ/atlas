/**
 * Tests for `src/lib/sandbox/validate.ts` — every branch of the credential
 * validator plus the SSRF guard primitives it exports.
 *
 * Merged from `validate-railway.test.ts` (#3231), `validate-vercel.test.ts`
 * (#3370) and `validate-ssrf.test.ts` (#3006); the per-section comments below
 * carry each file's original rationale.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  isBlockedResolvedAddress,
  isSafeExternalUrl,
  validateCredentials,
  validateRailwayCredentials,
} from "../validate";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

function mockFetchJson(body: unknown, status = 200): FetchFn {
  return mock(async (): Promise<Response> => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

interface QueuedResponse {
  body: unknown;
  status?: number;
}

/** Fetch mock that pops responses in call order and records request URLs. */
function mockFetchQueue(responses: QueuedResponse[]): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const queue = [...responses];
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    urls.push((typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url));
    const next = queue.shift();
    if (!next) throw new Error("fetch called more times than queued responses");
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
  return { fetch: fetchMock, urls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Railway (#3231). The Railway branch of `validateCredentials` hits a fixed
// GraphQL endpoint — these cases assert the dispatch contract: required fields,
// environment-scoped validation, GraphQL-errors-as-200 handling, and HTTP auth
// failures.
// ---------------------------------------------------------------------------

describe("validateCredentials — railway dispatch", () => {
  it("rejects a missing token without any network call", async () => {
    let called = false;
    globalThis.fetch = mock(async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchFn;

    const result = await validateCredentials("railway", {});
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("API token is required");
    expect(called).toBe(false);
  });

  it("validates the environment when environmentId is supplied", async () => {
    const fetchMock = mockFetchJson({
      data: { environment: { id: "env-1", name: "staging" } },
    });
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("railway", {
      token: "rw_tok",
      environmentId: "env-1",
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.displayName).toBe("Railway (staging)");

    // The request must target the fixed Railway endpoint with the env query
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect(String(init.headers && (init.headers as Record<string, string>).Authorization)).toBe(
      "Bearer rw_tok",
    );
    const body = JSON.parse((init.body as string)) as { query: string; variables?: { id: string } };
    expect(body.query).toContain("environment(id: $id)");
    expect(body.variables?.id).toBe("env-1");
  });

  it("rejects a missing environmentId without any network call (#3370)", async () => {
    // The BYOC runtime never falls back to the operator's
    // RAILWAY_ENVIRONMENT_ID env var, so a connect without environmentId
    // would store credentials that can never run.
    let called = false;
    globalThis.fetch = mock(async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchFn;

    const result = await validateCredentials("railway", { token: "rw_tok" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Environment ID is required");
    expect(called).toBe(false);
  });

  it("validateRailwayCredentials still supports the me-query fallback directly", async () => {
    // The function-level optional param remains for callers outside the
    // connect dispatch (the dispatch itself requires environmentId).
    const fetchMock = mockFetchJson({ data: { me: { name: "Ada" } } });
    globalThis.fetch = fetchMock;

    const result = await validateRailwayCredentials("rw_tok");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.displayName).toBe("Railway (Ada)");

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const [, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((init.body as string)) as { query: string };
    expect(body.query).toContain("me { name }");
  });
});

describe("validateRailwayCredentials — failure shapes", () => {
  it("treats GraphQL errors (HTTP 200) as invalid", async () => {
    globalThis.fetch = mockFetchJson({
      errors: [{ message: "Not Authorized" }],
    });
    const result = await validateRailwayCredentials("rw_bad", "env-1");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Not Authorized");
      expect(result.error).toContain("env-1");
    }
  });

  it("scrubs control chars and truncates upstream GraphQL error text", async () => {
    globalThis.fetch = mockFetchJson({
      errors: [{ message: `bad\u0007token\u001b[31m ${"x".repeat(500)}` }],
    });
    const result = await validateRailwayCredentials("rw_bad", "env-1");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("bad token");
      expect(result.error).not.toContain("\u0007");
      expect(result.error).not.toContain("\u001b");
      expect(result.error).not.toContain("x".repeat(300));
    }
  });

  it("treats a null environment as not found", async () => {
    globalThis.fetch = mockFetchJson({ data: { environment: null } });
    const result = await validateRailwayCredentials("rw_tok", "env-missing");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("not found");
  });

  it("fails closed on a non-JSON 200 response (no environmentId path)", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => {
      return new Response("<html>gateway error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as FetchFn;
    const result = await validateRailwayCredentials("rw_tok");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("non-JSON");
  });

  it("maps HTTP 401 to an invalid-token error", async () => {
    globalThis.fetch = mockFetchJson({}, 401);
    const result = await validateRailwayCredentials("rw_bad");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Invalid API token");
  });

  it("maps network failure to a reachability error", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as FetchFn;
    const result = await validateRailwayCredentials("rw_tok");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Could not reach Railway API");
  });
});


// ---------------------------------------------------------------------------
// Vercel (#3370). The vercel branch makes two sequential calls — team lookup,
// then a project-access check (the sandbox runtime needs the full
// token/teamId/projectId triple, so project access must fail at connect time,
// not at the org's first explore call).
// ---------------------------------------------------------------------------

const FULL_CREDS = { accessToken: "vc_tok", teamId: "team_1", projectId: "prj_1" };

describe("validateCredentials — vercel dispatch", () => {
  it("rejects a missing projectId without any network call (#3370)", async () => {
    let called = false;
    globalThis.fetch = mock(async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchFn;

    const result = await validateCredentials("vercel", {
      accessToken: "vc_tok",
      teamId: "team_1",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Project ID is required");
    expect(called).toBe(false);
  });

  it("validates team then project and returns the team name", async () => {
    const { fetch: fetchMock, urls } = mockFetchQueue([
      { body: { name: "Acme Team" } }, // team lookup
      { body: { id: "prj_1" } }, // project check
    ]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.displayName).toBe("Acme Team");

    expect(urls.length).toBe(2);
    expect(urls[0]).toBe("https://api.vercel.com/v2/teams/team_1");
    expect(urls[1]).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1");
  });

  it("maps a project 404 to 'Project not found' even when the team check passes", async () => {
    const { fetch: fetchMock } = mockFetchQueue([
      { body: { name: "Acme Team" } },
      { body: {}, status: 404 },
    ]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Project not found");
  });

  it("maps a project 403 to a token-scope error", async () => {
    const { fetch: fetchMock } = mockFetchQueue([
      { body: { name: "Acme Team" } },
      { body: {}, status: 403 },
    ]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("cannot access this project");
  });

  it("still fails fast on a bad token at the team check (no project call)", async () => {
    const { fetch: fetchMock, urls } = mockFetchQueue([{ body: {}, status: 401 }]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Invalid access token");
    expect(urls.length).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// SSRF guard (#3006). `isSafeExternalUrl` is the single IP-parsing primitive
// every host-side fetch (OpenAPI probe + operations, Daytona validation,
// sub-processor webhooks) routes through. The legacy string-prefix blocklist
// returned `true` for a long tail of internal-address encodings — these cases
// lock each verified bypass closed and assert real CIDR membership.
// ---------------------------------------------------------------------------

describe("isSafeExternalUrl — blocked (SSRF vectors)", () => {
  // Every entry MUST be rejected. The comment names the encoding that bypassed
  // the legacy string-prefix guard (verified in #3006).
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ["https://[::1]/openapi.json", "IPv6 loopback"],
    ["https://[0:0:0:0:0:0:0:1]/x", "expanded IPv6 loopback"],
    ["https://[::ffff:169.254.169.254]/latest/meta-data/", "IPv4-mapped AWS metadata"],
    ["https://[::ffff:7f00:1]/x", "hex-form IPv4-mapped loopback (127.0.0.1)"],
    ["https://metadata.google.internal/computeMetadata/v1/", "GCP metadata hostname"],
    ["https://foo.internal/x", "*.internal hostname"],
    ["https://100.100.100.200/x", "CGNAT 100.64.0.0/10"],
    ["https://100.64.0.1/x", "CGNAT lower bound"],
    ["https://172.16.0.5/x", "RFC1918 172.16/12"],
    ["https://172.31.255.254/x", "RFC1918 172.16/12 upper"],
    ["https://192.168.1.10/x", "RFC1918 192.168/16"],
    ["https://10.0.0.5/x", "RFC1918 10/8"],
    ["https://169.254.169.254/", "link-local v4 (AWS/Azure/GCP metadata)"],
    ["https://[fe80::1]/", "link-local v6"],
    ["https://[fc00::1]/", "ULA v6"],
    ["https://[fd12:3456::1]/", "ULA v6 fd00::/8"],
    ["https://0.0.0.0/", "0.0.0.0/8 literal"],
    ["https://0.0.0.172/x", "0.0.0.0/8 (the 172. NaN-octet normalization target)"],
    ["https://127.0.0.1/x", "loopback literal"],
    ["https://127.1/x", "shorthand loopback (WHATWG-normalized)"],
    ["https://0x7f000001/x", "hex loopback (WHATWG-normalized)"],
    ["https://2130706433/x", "decimal loopback (WHATWG-normalized)"],
    ["https://localhost/x", "localhost hostname"],
    ["https://sub.localhost/x", "*.localhost hostname"],
    ["https://metadata.google.internal./computeMetadata/v1/", "trailing-dot GCP metadata (FQDN bypass)"],
    ["https://localhost./x", "trailing-dot localhost (FQDN bypass)"],
    ["https://foo.internal./x", "trailing-dot *.internal (FQDN bypass)"],
    ["https://attacker.com@169.254.169.254/x", "userinfo decoy — connects to the trailing IP, not the decoy host"],
    ["https://user:pass@[::1]/x", "userinfo decoy over IPv6 loopback"],
    ["https://0177.0.0.1/x", "octal loopback (WHATWG-normalized)"],
    ["https://[::169.254.169.254]/x", "IPv4-compatible IPv6 metadata (embedded-IPv4 re-test)"],
    ["https://[::7f00:1]/x", "IPv4-compatible IPv6 loopback, hex form"],
    ["https://[64:ff9b::169.254.169.254]/x", "NAT64-wrapped metadata, dotted (embedded-IPv4 re-test)"],
    ["https://[64:ff9b::a9fe:a9fe]/x", "NAT64-wrapped metadata, all-hex (embedded-IPv4 re-test)"],
    ["http://example.com/x", "non-HTTPS (credentials in clear)"],
    ["ftp://example.com/x", "non-HTTP(S) scheme"],
    ["not a url", "unparseable — fail closed"],
    ["https://172./x", "garbage octet — fail closed (normalizes into 0.0.0.0/8)"],
  ];

  for (const [url, why] of blocked) {
    it(`rejects ${url} (${why})`, () => {
      expect(isSafeExternalUrl(url)).toBe(false);
    });
  }
});

describe("isSafeExternalUrl — allowed (genuinely public HTTPS)", () => {
  const allowed: ReadonlyArray<string> = [
    "https://example.com/openapi.json",
    "https://crm.example.com/rest/open-api/core",
    "https://8.8.8.8/x", // public IPv4 literal
    "https://[2001:4860:4860::8888]/x", // public IPv6 literal (Google DNS)
    "https://[64:ff9b::8.8.8.8]/x", // NAT64 wrapping a PUBLIC IPv4 — must not over-block
    "https://api.useatlas.dev/", // a hostname we don't resolve — allowed
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isSafeExternalUrl(url)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// isBlockedResolvedAddress — the connect-time half of the guard (#4779). Given a
// *resolved* IP literal (an A/AAAA record), is it in a blocked range? This is
// the primitive `assertSafeEgressTarget` re-checks every DNS result against.
// ---------------------------------------------------------------------------

describe("isBlockedResolvedAddress — blocked resolved IPs", () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ["10.0.0.5", "RFC1918 10/8"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local (cloud metadata)"],
    ["172.16.0.5", "RFC1918 172.16/12"],
    ["192.168.1.10", "RFC1918 192.168/16"],
    ["100.64.0.1", "CGNAT 100.64/10"],
    ["0.0.0.0", "'this network' 0/8"],
    ["::1", "IPv6 loopback"],
    ["fc00::1", "IPv6 ULA"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:10.0.0.5", "IPv4-mapped IPv6 wrapping a private IPv4"],
    ["::ffff:169.254.169.254", "IPv4-mapped IPv6 wrapping metadata"],
    ["not-an-ip", "non-IP-literal fails CLOSED (anomalous resolver output)"],
    ["", "empty string fails closed"],
  ];
  for (const [ip, why] of blocked) {
    it(`blocks ${ip || "<empty>"} (${why})`, () => {
      expect(isBlockedResolvedAddress(ip)).toBe(true);
    });
  }
});

describe("isBlockedResolvedAddress — allowed public resolved IPs", () => {
  const allowed: ReadonlyArray<string> = [
    "93.184.216.34", // public IPv4
    "8.8.8.8", // public IPv4
    "2001:4860:4860::8888", // public IPv6 (Google DNS)
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      expect(isBlockedResolvedAddress(ip)).toBe(false);
    });
  }
});
