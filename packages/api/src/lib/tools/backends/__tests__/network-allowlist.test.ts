import { describe, expect, it } from "bun:test";
import {
  computeNetworkAllowlist,
  hostFromUrl,
  networkPolicyFromAllowlist,
} from "../network-allowlist";

// ---------------------------------------------------------------------------
// network-allowlist — layer 0 of the OpenAPI-agent safety stack (#2927).
//
// These tests are the SECURITY-BOUNDARY proof for the issue's acceptance
// criteria:
//   AC: "the allowlist is computed server-side ... a prompt cannot inject or
//        widen it"  — proven structurally (no code parameter exists) + by the
//        crafted-URL test below.
//   AC: "the allowlist is per-request ... tenant A cannot reach tenant B"
//        — proven by the tenant-isolation tests.
//   AC: a prompt-injected host is blocked — proven by deny-by-default (only
//        listed hosts appear in `allow`; everything else is denied).
//
// The policy intentionally carries NO credential transformer (egress is opened,
// auth is not) — so there is no per-host auth shape to assert here.
// ---------------------------------------------------------------------------

describe("hostFromUrl", () => {
  it("extracts the lowercased hostname, dropping scheme / port / path / query", () => {
    expect(hostFromUrl("https://CRM.Example.com:8443/rest/api?x=1")).toBe(
      "crm.example.com",
    );
    expect(hostFromUrl("http://api.internal/v1")).toBe("api.internal");
  });

  it("returns null for non-http(s) schemes (fail-closed)", () => {
    expect(hostFromUrl("file:///etc/passwd")).toBeNull();
    expect(hostFromUrl("ftp://host/x")).toBeNull();
    expect(hostFromUrl("data:text/plain,hi")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(hostFromUrl("not a url")).toBeNull();
    expect(hostFromUrl("")).toBeNull();
  });

  it("SECURITY: rejects `*` wildcard hosts (fail-closed — never widens to allow-all)", () => {
    // `new URL("https://*/x").hostname` is the literal "*", which @vercel/sandbox
    // treats as match-all (allow-all). `*.evil.com` matches every subdomain.
    // Both parse fine, so the wildcard guard — not the URL parser — must reject
    // them. A real datasource host never contains `*`.
    expect(hostFromUrl("https://*/rest")).toBeNull();
    expect(hostFromUrl("https://*.evil.com/rest")).toBeNull();
    expect(hostFromUrl("http://crm.*.example.com/v1")).toBeNull();
  });
});

describe("computeNetworkAllowlist", () => {
  it("maps base URLs to a de-duplicated, sorted host set", () => {
    expect(
      computeNetworkAllowlist([
        "https://b.example.com/rest",
        "https://a.example.com/rest",
        "https://a.example.com/other", // same host, different path → one entry
      ]),
    ).toEqual(["a.example.com", "b.example.com"]);
  });

  it("drops unparseable / non-http(s) URLs rather than widening the surface", () => {
    expect(
      computeNetworkAllowlist([
        "https://good.example.com/rest",
        "file:///etc/passwd",
        "garbage",
      ]),
    ).toEqual(["good.example.com"]);
  });

  it("returns an empty allowlist for no input (caller maps to deny-all)", () => {
    expect(computeNetworkAllowlist([])).toEqual([]);
  });

  it("SECURITY: a host smuggled into a URL's path/query is NOT added to the allowlist", () => {
    // A base URL that *mentions* attacker.example.com as a redirect param must
    // still resolve to its real host only — the attacker host never appears.
    const allowlist = computeNetworkAllowlist([
      "https://crm.tenant-a.example/rest?redirect=https://attacker.example.com",
    ]);
    expect(allowlist).toEqual(["crm.tenant-a.example"]);
    expect(allowlist).not.toContain("attacker.example.com");
  });

  it("SECURITY: a `*` wildcard base URL fails closed to an empty allowlist (→ deny-all)", () => {
    // The whole point of the wildcard guard: even a configured datasource whose
    // base URL is `https://*/` (or `*.evil.com`) must collapse to no host, so
    // the caller maps it to deny-all rather than allow-all.
    expect(computeNetworkAllowlist(["https://*/rest"])).toEqual([]);
    expect(computeNetworkAllowlist(["https://*.evil.com/rest"])).toEqual([]);
    // A wildcard URL alongside a real one contributes only the real host.
    expect(
      computeNetworkAllowlist(["https://*/rest", "https://crm.real.example/rest"]),
    ).toEqual(["crm.real.example"]);
  });
});

describe("networkPolicyFromAllowlist", () => {
  it("maps an empty allowlist to deny-all (fail-closed — never allow-all)", () => {
    expect(networkPolicyFromAllowlist([])).toBe("deny-all");
  });

  it("maps hosts to the record allow form with empty rules (no credential transformer)", () => {
    // The empty rule list `[]` is what proves no transformer is attached —
    // egress is opened, auth is not.
    const policy = networkPolicyFromAllowlist(["crm.example.com"]);
    expect(policy).toEqual({ allow: { "crm.example.com": [] } });
    if (typeof policy === "string") throw new Error("expected record policy");
    // Explicit per-host-value assertion: guards against a future regression that
    // attaches a transformer (which the @vercel/sandbox type permits but our
    // contract forbids). The value must stay exactly `[]`.
    expect(policy.allow).not.toBe(undefined);
    expect((policy.allow as Record<string, unknown>)["crm.example.com"]).toEqual([]);
  });

  it("maps a multi-host allowlist to one empty-rule entry per host", () => {
    // Today the live caller passes a single base URL, but slice 2's per-workspace
    // registry can resolve several — this locks the record-building loop so it
    // emits every host (not just the first / last) each with an empty rule list.
    const policy = networkPolicyFromAllowlist(["a.example.com", "b.example.com"]);
    expect(policy).toEqual({
      allow: { "a.example.com": [], "b.example.com": [] },
    });
  });

  it("SECURITY (tenant isolation): tenant A's policy never contains tenant B's host", () => {
    const tenantA = networkPolicyFromAllowlist(
      computeNetworkAllowlist(["https://crm.tenant-a.example/rest"]),
    );
    const tenantB = networkPolicyFromAllowlist(
      computeNetworkAllowlist(["https://crm.tenant-b.example/rest"]),
    );
    if (typeof tenantA === "string" || typeof tenantB === "string") {
      throw new Error("expected record policies");
    }
    expect(Object.keys(tenantA.allow ?? {})).toEqual(["crm.tenant-a.example"]);
    expect(Object.keys(tenantB.allow ?? {})).toEqual(["crm.tenant-b.example"]);
    expect(tenantA.allow).not.toHaveProperty("crm.tenant-b.example");
    expect(tenantB.allow).not.toHaveProperty("crm.tenant-a.example");
  });

  it("SECURITY: an attacker host is absent from a datasource-derived policy (deny-by-default blocks it)", () => {
    const policy = networkPolicyFromAllowlist(
      computeNetworkAllowlist(["https://crm.tenant-a.example/rest"]),
    );
    if (typeof policy === "string") throw new Error("expected record policy");
    // attacker.example.com is not in `allow`, so @vercel/sandbox denies it.
    expect(policy.allow).not.toHaveProperty("attacker.example.com");
  });
});
