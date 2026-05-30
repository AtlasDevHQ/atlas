/**
 * Tests for the shared OpenAPI SSRF chokepoint (`egress-guard.ts`, #3006): the
 * one `assertBaseUrlAllowed` install / rediscover / resolve / execute all share,
 * the operator opt-out flag, and the redirect-revalidating `guardedFetch`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  assertBaseUrlAllowed,
  guardedFetch,
  isInternalEgressAllowed,
  EgressBlockedError,
  MAX_REDIRECTS,
} from "../egress-guard";

const ORIGINAL = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
  else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = ORIGINAL;
});

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
    const res = await guardedFetch("https://public.example.com/x", { method: "GET" }, { fetchImpl });
    expect(res.status).toBe(200);
    expect(seenRedirect).toBe("manual");
  });

  it("follows a public→public redirect, re-validating the new host", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const hosts: string[] = [];
    const fetchImpl = (async (url: string) => {
      hosts.push(new URL(url).host);
      if (url.startsWith("https://a.example.com")) {
        return new Response(null, { status: 302, headers: { location: "https://b.example.com/final" } });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://a.example.com/x", {}, { fetchImpl });
    expect(res.status).toBe(200);
    expect(hosts).toEqual(["a.example.com", "b.example.com"]);
  });

  it("rejects a public→internal redirect (the TOCTOU vector)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let hops = 0;
    const fetchImpl = (async (url: string) => {
      hops++;
      if (url.startsWith("https://public.example.com")) {
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/" } });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await expect(guardedFetch("https://public.example.com/x", {}, { fetchImpl })).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(hops).toBe(1); // the metadata hop never fired
  });

  it("resolves a relative Location against the current URL before validating", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url === "https://public.example.com/a") {
        return new Response(null, { status: 301, headers: { location: "/b" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://public.example.com/a", {}, { fetchImpl });
    expect(res.status).toBe(200);
    expect(urls).toEqual(["https://public.example.com/a", "https://public.example.com/b"]);
  });

  it("caps redirect depth and throws rather than looping forever", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    let hops = 0;
    const fetchImpl = (async () => {
      hops++;
      // Always redirect to another public host — a redirect loop.
      return new Response(null, { status: 302, headers: { location: `https://public.example.com/${hops}` } });
    }) as unknown as typeof globalThis.fetch;
    await expect(guardedFetch("https://public.example.com/0", {}, { fetchImpl })).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(hops).toBe(MAX_REDIRECTS + 1); // initial + MAX_REDIRECTS hops, then bail
  });

  it("returns a 3xx with no Location unchanged (nothing to follow)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const fetchImpl = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof globalThis.fetch;
    const res = await guardedFetch("https://public.example.com/x", {}, { fetchImpl });
    expect(res.status).toBe(304);
  });
});
