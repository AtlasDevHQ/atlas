/**
 * Tests for the shared OpenAPI SSRF chokepoint (`egress-guard.ts`, #3006): the
 * one `assertBaseUrlAllowed` install / rediscover / resolve / execute all share,
 * the operator opt-out flag, and the redirect-revalidating `guardedFetch`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  assertBaseUrlAllowed,
  assertSafeEgressTarget,
  createGuardedFetch,
  guardedFetch,
  hostForLog,
  isInternalEgressAllowed,
  type EgressLookup,
  EgressBlockedError,
  MAX_REDIRECTS,
} from "../egress-guard";

const ORIGINAL = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
  else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = ORIGINAL;
});

/** A single public IPv4 every DNS-name host in these tests resolves to. */
const PUBLIC_IP = "93.184.216.34";
/** Stub resolver: every hostname resolves to one public IPv4 (hermetic — no network). */
const publicLookup: EgressLookup = async () => [{ address: PUBLIC_IP, family: 4 }];
/** Read the (pinned) request's `Host` header — carries the original hostname. */
const hostHeader = (init?: RequestInit): string | null => new Headers(init?.headers).get("host");

describe("assertBaseUrlAllowed", () => {
  it("throws EgressBlockedError for every internal-address encoding", () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    for (const url of [
      "https://[::1]/x",
      "https://[::ffff:169.254.169.254]/x",
      "https://metadata.google.internal/x",
      "https://100.100.100.200/x",
      "https://172.16.0.5/x",
      "http://example.com/x", // non-HTTPS
    ]) {
      expect(() => assertBaseUrlAllowed(url), url).toThrow(EgressBlockedError);
    }
  });

  it("allows a genuinely public HTTPS host", () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    expect(() => assertBaseUrlAllowed("https://crm.example.com/rest")).not.toThrow();
  });

  it("is bypassed when the operator opts out (ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true)", () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    expect(isInternalEgressAllowed()).toBe(true);
    expect(() => assertBaseUrlAllowed("http://10.0.0.5/x")).not.toThrow();
    expect(() => assertBaseUrlAllowed("https://169.254.169.254/x")).not.toThrow();
  });

  it("keeps the guard ON for any non-`true` opt-out value (fail-closed)", () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "1"; // not the literal "true"
    expect(isInternalEgressAllowed()).toBe(false);
    expect(() => assertBaseUrlAllowed("http://10.0.0.5/x")).toThrow(EgressBlockedError);
  });
});

describe("guardedFetch", () => {
  it("validates the initial URL before issuing any request", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await expect(guardedFetch("https://127.0.0.1/x", {}, { fetchImpl })).rejects.toBeInstanceOf(EgressBlockedError);
    expect(called).toBe(false);
  });

  it("forces redirect:'manual' and returns a non-redirect response directly", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let seenRedirect: RequestInit["redirect"];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://public.example.com/x", { method: "GET" }, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(200);
    expect(seenRedirect).toBe("manual");
  });

  it("follows a public→public redirect, re-validating the new host", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    // Hosts read from the `Host` header (the socket connects to the pinned IP,
    // but the header carries the original hostname).
    const hosts: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const host = hostHeader(init);
      hosts.push(host ?? "");
      if (host === "a.example.com") {
        return new Response(null, { status: 302, headers: { location: "https://b.example.com/final" } });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://a.example.com/x", {}, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(200);
    expect(hosts).toEqual(["a.example.com", "b.example.com"]);
  });

  it("rejects a public→internal redirect (the TOCTOU vector)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let hops = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      hops++;
      if (hostHeader(init) === "public.example.com") {
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/" } });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await expect(
      guardedFetch("https://public.example.com/x", {}, { fetchImpl, lookup: publicLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hops).toBe(1); // the metadata hop never fired
  });

  it("resolves a relative Location against the current URL before validating", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    // Reconstruct the original target (Host header + path) — the pinned URL host
    // is the IP, but relative-Location resolution reasons about the hostname.
    const targets: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      targets.push(`${hostHeader(init)}${path}`);
      if (path === "/a") {
        return new Response(null, { status: 301, headers: { location: "/b" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://public.example.com/a", {}, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(200);
    expect(targets).toEqual(["public.example.com/a", "public.example.com/b"]);
  });

  it("caps redirect depth and throws rather than looping forever", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let hops = 0;
    const fetchImpl = (async () => {
      hops++;
      // Always redirect to another public host — a redirect loop.
      return new Response(null, { status: 302, headers: { location: `https://public.example.com/${hops}` } });
    }) as unknown as typeof globalThis.fetch;
    await expect(
      guardedFetch("https://public.example.com/0", {}, { fetchImpl, lookup: publicLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hops).toBe(MAX_REDIRECTS + 1); // initial + MAX_REDIRECTS hops, then bail
  });

  it("returns a 3xx with no Location unchanged (nothing to follow)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const fetchImpl = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://public.example.com/x", {}, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(304);
  });

  it("throws EgressBlockedError when the redirect Location is malformed (fail closed)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "ht!tp://::::" }, // unparseable even against the base
      })) as unknown as typeof globalThis.fetch;
    await expect(
      guardedFetch("https://public.example.com/x", {}, { fetchImpl, lookup: publicLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("strips the credential headers on a cross-origin redirect (public→public), keeps them same-origin", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const authByHost: Record<string, string | null> = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      // Host comes from the Host header (pinned URL host is the IP); the path is
      // preserved through pinning, so it still distinguishes the two hops.
      const host = hostHeader(init) ?? "";
      authByHost[host] = new Headers(init?.headers).get("authorization");
      if (host === "a.example.com") {
        // first an in-origin hop, then bounce to a different public origin
        return new URL(url).pathname === "/start"
          ? new Response(null, { status: 302, headers: { location: "https://a.example.com/next" } })
          : new Response(null, { status: 302, headers: { location: "https://b.example.com/final" } });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await guardedFetch(
      "https://a.example.com/start",
      { headers: { Authorization: "Bearer SECRET", accept: "application/json" } },
      { fetchImpl, lookup: publicLookup },
    );
    expect(res.status).toBe(200);
    // Same-origin hops keep the credential; the cross-origin hop to b.example.com must not see it.
    expect(authByHost["a.example.com"]).toBe("Bearer SECRET");
    expect(authByHost["b.example.com"]).toBeNull();
  });

  it("downgrades a 303 to GET and drops the body on the next hop", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let secondHopMethod = "";
    let secondHopHadBody = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/post") {
        return new Response(null, { status: 303, headers: { location: "https://api.example.com/result" } });
      }
      secondHopMethod = (init?.method ?? "GET").toUpperCase();
      secondHopHadBody = init?.body != null;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await guardedFetch(
      "https://api.example.com/post",
      { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } },
      { fetchImpl, lookup: publicLookup },
    );
    expect(res.status).toBe(200);
    expect(secondHopMethod).toBe("GET"); // 303 always becomes GET
    expect(secondHopHadBody).toBe(false); // and drops the body
  });

  // ── #4779 — DNS-blind SSRF: connect-time resolution + IP pinning ──────────

  it("rejects a hostname that RESOLVES to an internal IP, before connect (the DNS-blind SSRF)", async () => {
    // The live-confirmed vector: a public hostname (e.g. `127.0.0.1.nip.io`)
    // that the sync guard passes but that resolves to an internal IP.
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const internalLookup: EgressLookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await expect(
      guardedFetch("https://metadata.nip.io.example/x", {}, { fetchImpl, lookup: internalLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(called).toBe(false); // rejected BEFORE any request left the box
  });

  it("rejects when ANY resolved address is internal (mixed A-record set)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("nope", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const mixedLookup: EgressLookup = async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: "10.0.0.5", family: 4 }, // one private record poisons the set
    ];
    await expect(
      guardedFetch("https://rebind.example/x", {}, { fetchImpl, lookup: mixedLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(called).toBe(false);
  });

  it("pins the validated public IP: connects to the IP, keeps the hostname in the Host header (rebind defense)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let connectedUrl = "";
    let sentHost = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      connectedUrl = url;
      sentHost = hostHeader(init) ?? "";
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://api.example.com/v1", {}, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(200);
    // The socket target is the pre-validated IP — not a re-resolution.
    expect(new URL(connectedUrl).hostname).toBe(PUBLIC_IP);
    expect(new URL(connectedUrl).pathname).toBe("/v1");
    // SNI / cert verification still ride the original hostname via Host.
    expect(sentHost).toBe("api.example.com");
  });

  it("rejects when DNS resolution returns no records (fail closed)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const fetchImpl = (async () => new Response("x")) as unknown as typeof globalThis.fetch;
    const emptyLookup: EgressLookup = async () => [];
    await expect(
      guardedFetch("https://nx.example/x", {}, { fetchImpl, lookup: emptyLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("does NOT resolve DNS when the operator opts out (internal targets allowed)", async () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    let lookupCalled = false;
    let connectedHost = "";
    const fetchImpl = (async (url: string) => {
      connectedHost = new URL(url).hostname;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const spyLookup: EgressLookup = async () => {
      lookupCalled = true;
      return [{ address: "10.0.0.9", family: 4 }];
    };
    const res = await guardedFetch("http://internal.corp/x", {}, { fetchImpl, lookup: spyLookup });
    expect(res.status).toBe(200);
    expect(lookupCalled).toBe(false); // opt-out short-circuits before resolution
    expect(connectedHost).toBe("internal.corp"); // and no pin/rewrite is applied
  });

  it("rejects (fail closed) when the resolver itself throws", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("nope");
    }) as unknown as typeof globalThis.fetch;
    const throwingLookup: EgressLookup = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    await expect(
      guardedFetch("https://flaky.example/x", {}, { fetchImpl, lookup: throwingLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(called).toBe(false);
  });

  it("rejects a redirect to a hostname that RESOLVES internal (rebind on a hop, not a literal)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let hops = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      hops++;
      if (hostHeader(init) === "public.example.com") {
        return new Response(null, { status: 302, headers: { location: "https://rebind.example/final" } });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    // public host resolves public; the redirect target resolves to an internal IP.
    const rebindLookup: EgressLookup = async (host) =>
      host === "public.example.com"
        ? [{ address: PUBLIC_IP, family: 4 }]
        : [{ address: "10.1.2.3", family: 4 }];
    await expect(
      guardedFetch("https://public.example.com/x", {}, { fetchImpl, lookup: rebindLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hops).toBe(1); // the second hop (internal-resolving) never fired
  });

  it("pins a public IPv6 target with correct bracketing", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let connectedHost = "";
    let sentHost = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      connectedHost = new URL(url).hostname; // WHATWG URL keeps IPv6 bracketed
      sentHost = hostHeader(init) ?? "";
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const v6Lookup: EgressLookup = async () => [{ address: "2001:4860:4860::8888", family: 6 }];
    const res = await guardedFetch("https://dns.example.com/x", {}, { fetchImpl, lookup: v6Lookup });
    expect(res.status).toBe(200);
    expect(connectedHost).toBe("[2001:4860:4860::8888]"); // pin spliced a correctly-bracketed IPv6
    expect(sentHost).toBe("dns.example.com");
  });

  it("rejects an IPv4-mapped-IPv6 internal address (::ffff:10.0.0.5) before connect", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("nope");
    }) as unknown as typeof globalThis.fetch;
    const mappedLookup: EgressLookup = async () => [{ address: "::ffff:10.0.0.5", family: 6 }];
    await expect(
      guardedFetch("https://mapped.example/x", {}, { fetchImpl, lookup: mappedLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(called).toBe(false);
  });

  it("preserves a non-default port through the pin rewrite", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let connectedUrl = "";
    let sentHost = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      connectedUrl = url;
      sentHost = hostHeader(init) ?? "";
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://api.example.com:8443/v1", {}, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(200);
    const u = new URL(connectedUrl);
    expect(u.hostname).toBe(PUBLIC_IP);
    expect(u.port).toBe("8443");
    expect(sentHost).toBe("api.example.com:8443"); // Host carries the original authority incl. port
  });
});

describe("assertSafeEgressTarget", () => {
  it("returns null for a validated IP-literal host (no pin, no resolution)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let lookupCalled = false;
    const spy: EgressLookup = async () => {
      lookupCalled = true;
      return [];
    };
    await expect(assertSafeEgressTarget("https://93.184.216.34/x", { lookup: spy })).resolves.toBeNull();
    expect(lookupCalled).toBe(false);
  });

  it("throws for a literal internal IP without resolving", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    await expect(assertSafeEgressTarget("https://169.254.169.254/x")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("throws when a DNS name resolves to an internal IP (stubbed resolver)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const internalLookup: EgressLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      assertSafeEgressTarget("https://loopback.nip.io.example/x", { lookup: internalLookup }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("returns the pinned public IP for a public DNS name", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const pin = await assertSafeEgressTarget("https://api.example.com/x", { lookup: publicLookup });
    expect(pin).toEqual({ address: PUBLIC_IP, family: 4 });
  });

  it("returns null and does NOT resolve when the operator opts out", async () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    let lookupCalled = false;
    const spy: EgressLookup = async () => {
      lookupCalled = true;
      return [{ address: "10.0.0.1", family: 4 }];
    };
    await expect(assertSafeEgressTarget("https://internal.corp/x", { lookup: spy })).resolves.toBeNull();
    expect(lookupCalled).toBe(false);
  });
});

describe("createGuardedFetch", () => {
  it("produces a fetch that rejects an internal-resolving host before connect", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("nope");
    }) as unknown as typeof globalThis.fetch;
    const internalLookup: EgressLookup = async () => [{ address: "169.254.169.254", family: 4 }];
    const guarded = createGuardedFetch({ fetchImpl, lookup: internalLookup });
    await expect(guarded("https://metadata.nip.io.example/v1/chat/completions")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(called).toBe(false);
  });

  it("pins and forwards a public request (the live-agent baseUrl path)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let connectedHost = "";
    let sentHost = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      connectedHost = new URL(url).hostname;
      sentHost = hostHeader(init) ?? "";
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const guarded = createGuardedFetch({ fetchImpl, lookup: publicLookup });
    const res = await guarded("https://llm.example.com/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
    expect(connectedHost).toBe(PUBLIC_IP);
    expect(sentHost).toBe("llm.example.com");
  });

  it("rejects an internal-resolving host passed as a Request object (SDK Request-input shape)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("nope");
    }) as unknown as typeof globalThis.fetch;
    const internalLookup: EgressLookup = async () => [{ address: "169.254.169.254", family: 4 }];
    const guarded = createGuardedFetch({ fetchImpl, lookup: internalLookup });
    await expect(
      guarded(new Request("https://metadata.nip.io.example/v1/chat/completions", { method: "POST" })),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(called).toBe(false);
  });
});

describe("hostForLog", () => {
  it("returns host only — never the path or query (which can carry an apiKey-query secret)", () => {
    expect(hostForLog("https://10.0.0.5/v1/things?api_key=SECRET")).toBe("10.0.0.5");
    expect(hostForLog("https://api.example.com:8443/x?token=abc")).toBe("api.example.com:8443");
  });

  it("returns <unparseable> for a malformed URL (never the raw string)", () => {
    expect(hostForLog("ht!tp://::::")).toBe("<unparseable>");
  });
});

describe("EgressBlockedError redaction", () => {
  it("does not leak an apiKey-query secret into the message or the host field", () => {
    const err = new EgressBlockedError("https://169.254.169.254/latest?api_key=SUPER_SECRET");
    expect(err.host).toBe("169.254.169.254");
    expect(err.message).not.toContain("SUPER_SECRET");
    expect(err.message).not.toContain("api_key");
    expect(err.message).toContain("169.254.169.254");
  });
});
