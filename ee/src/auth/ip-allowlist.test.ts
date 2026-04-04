import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);

const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));

mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Import after mocks
const {
  parseCIDR,
  isIPInRange,
  isIPAllowed,
  listIPAllowlistEntries,
  addIPAllowlistEntry,
  removeIPAllowlistEntry,
  checkIPAllowlist,
  IPAllowlistError,
  _clearCache,
} = await import("./ip-allowlist");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

function resetMocks() {
  ee.reset();
  _clearCache();
}

// ── Tests: CIDR Parsing ─────────────────────────────────────────────

describe("parseCIDR", () => {
  beforeEach(resetMocks);

  it("parses valid IPv4 CIDR", () => {
    const result = parseCIDR("10.0.0.0/8");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(4);
    expect(result!.original).toBe("10.0.0.0/8");
    expect(result!.normalized).toBe("10.0.0.0/8");
  });

  it("parses /32 single-host IPv4", () => {
    const result = parseCIDR("192.168.1.1/32");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(4);
  });

  it("parses /0 all-IPs IPv4", () => {
    const result = parseCIDR("0.0.0.0/0");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(4);
    expect(result!.normalized).toBe("0.0.0.0/0");
  });

  it("parses valid IPv6 CIDR", () => {
    const result = parseCIDR("2001:db8::/32");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(6);
    expect(result!.original).toBe("2001:db8::/32");
  });

  it("parses IPv6 /128 single-host", () => {
    const result = parseCIDR("::1/128");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(6);
  });

  it("parses IPv6 /0", () => {
    const result = parseCIDR("::/0");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(6);
  });

  it("normalizes network address", () => {
    // 192.168.1.100/24 should normalize to network 192.168.1.0
    const result = parseCIDR("192.168.1.100/24");
    expect(result).not.toBeNull();
    expect(result!.normalized).toBe("192.168.1.0/24");
  });

  it("trims whitespace", () => {
    const result = parseCIDR("  10.0.0.0/8  ");
    expect(result).not.toBeNull();
    expect(result!.original).toBe("10.0.0.0/8");
  });

  it("accepts plain IPv4 (no prefix) as /32", () => {
    const result = parseCIDR("10.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(4);
    expect(result!.normalized).toBe("10.0.0.1/32");
  });

  it("accepts plain IPv6 (no prefix) as /128", () => {
    const result = parseCIDR("::1");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(6);
    expect(result!.normalized).toBe("::1/128");
  });

  it("returns null for invalid IP", () => {
    expect(parseCIDR("999.999.999.999/8")).toBeNull();
  });

  it("returns null for negative prefix", () => {
    expect(parseCIDR("10.0.0.0/-1")).toBeNull();
  });

  it("returns null for prefix too large (IPv4)", () => {
    expect(parseCIDR("10.0.0.0/33")).toBeNull();
  });

  it("returns null for prefix too large (IPv6)", () => {
    expect(parseCIDR("::1/129")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCIDR("")).toBeNull();
  });

  it("returns null for non-numeric prefix", () => {
    expect(parseCIDR("10.0.0.0/abc")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseCIDR("not-a-cidr")).toBeNull();
  });
});

// ── Tests: IP Range Matching ────────────────────────────────────────

describe("isIPInRange", () => {
  beforeEach(resetMocks);

  it("matches IP in /8 range", () => {
    const cidr = parseCIDR("10.0.0.0/8")!;
    expect(isIPInRange("10.0.0.1", cidr)).toBe(true);
    expect(isIPInRange("10.255.255.255", cidr)).toBe(true);
  });

  it("rejects IP outside /8 range", () => {
    const cidr = parseCIDR("10.0.0.0/8")!;
    expect(isIPInRange("11.0.0.1", cidr)).toBe(false);
    expect(isIPInRange("192.168.1.1", cidr)).toBe(false);
  });

  it("matches exact IP with /32", () => {
    const cidr = parseCIDR("192.168.1.1/32")!;
    expect(isIPInRange("192.168.1.1", cidr)).toBe(true);
    expect(isIPInRange("192.168.1.2", cidr)).toBe(false);
  });

  it("matches all IPs with /0", () => {
    const cidr = parseCIDR("0.0.0.0/0")!;
    expect(isIPInRange("1.2.3.4", cidr)).toBe(true);
    expect(isIPInRange("255.255.255.255", cidr)).toBe(true);
  });

  it("matches /24 network correctly", () => {
    const cidr = parseCIDR("192.168.1.0/24")!;
    expect(isIPInRange("192.168.1.0", cidr)).toBe(true); // network address
    expect(isIPInRange("192.168.1.255", cidr)).toBe(true); // broadcast
    expect(isIPInRange("192.168.1.42", cidr)).toBe(true);
    expect(isIPInRange("192.168.2.1", cidr)).toBe(false);
  });

  it("matches IPv6 range", () => {
    const cidr = parseCIDR("2001:db8::/32")!;
    expect(isIPInRange("2001:db8::1", cidr)).toBe(true);
    expect(isIPInRange("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", cidr)).toBe(true);
    expect(isIPInRange("2001:db9::1", cidr)).toBe(false);
  });

  it("does not match IPv4 against IPv6 CIDR", () => {
    const cidr = parseCIDR("2001:db8::/32")!;
    expect(isIPInRange("10.0.0.1", cidr)).toBe(false);
  });

  it("does not match IPv6 against IPv4 CIDR", () => {
    const cidr = parseCIDR("10.0.0.0/8")!;
    expect(isIPInRange("2001:db8::1", cidr)).toBe(false);
  });

  it("returns false for invalid IP", () => {
    const cidr = parseCIDR("10.0.0.0/8")!;
    expect(isIPInRange("not-an-ip", cidr)).toBe(false);
  });

  it("matches loopback /128", () => {
    const cidr = parseCIDR("::1/128")!;
    expect(isIPInRange("::1", cidr)).toBe(true);
    expect(isIPInRange("::2", cidr)).toBe(false);
  });
});

// ── Tests: isIPAllowed ──────────────────────────────────────────────

describe("isIPAllowed", () => {
  beforeEach(resetMocks);

  it("allows all IPs when ranges is empty", () => {
    expect(isIPAllowed("1.2.3.4", [])).toBe(true);
  });

  it("allows IP matching one of multiple ranges", () => {
    const ranges = [parseCIDR("10.0.0.0/8")!, parseCIDR("192.168.0.0/16")!];
    expect(isIPAllowed("192.168.1.1", ranges)).toBe(true);
  });

  it("rejects IP not matching any range", () => {
    const ranges = [parseCIDR("10.0.0.0/8")!, parseCIDR("192.168.0.0/16")!];
    expect(isIPAllowed("172.16.0.1", ranges)).toBe(false);
  });
});

// ── Tests: CRUD operations ──────────────────────────────────────────

describe("listIPAllowlistEntries", () => {
  beforeEach(resetMocks);

  it("returns entries from DB", async () => {
    ee.queueMockRows([
      {
        id: "entry-1",
        org_id: "org-1",
        cidr: "10.0.0.0/8",
        description: "Office",
        created_at: "2026-03-22T00:00:00Z",
        created_by: "admin-1",
      },
    ]);

    const entries = await run(listIPAllowlistEntries("org-1"));
    expect(entries).toHaveLength(1);
    expect(entries[0].cidr).toBe("10.0.0.0/8");
    expect(entries[0].description).toBe("Office");
    expect(entries[0].orgId).toBe("org-1");
  });

  it("throws if enterprise not enabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(listIPAllowlistEntries("org-1"))).rejects.toThrow("Enterprise features");
  });
});

describe("addIPAllowlistEntry", () => {
  beforeEach(resetMocks);

  it("adds a valid CIDR entry", async () => {
    // First query: duplicate check (no results)
    ee.queueMockRows([]);
    // Second query: INSERT RETURNING
    ee.queueMockRows([
      {
        id: "new-id",
        org_id: "org-1",
        cidr: "10.0.0.0/8",
        description: "Office",
        created_at: "2026-03-22T00:00:00Z",
        created_by: "admin-1",
      },
    ]);

    const entry = await run(addIPAllowlistEntry("org-1", "10.0.0.0/8", "Office", "admin-1"));
    expect(entry.cidr).toBe("10.0.0.0/8");
    expect(entry.description).toBe("Office");
  });

  it("rejects invalid CIDR format", async () => {
    const err = await Effect.runPromise(
      addIPAllowlistEntry("org-1", "not-a-cidr", null, null).pipe(Effect.flip),
    );
    expect(err).toBeInstanceOf(IPAllowlistError);
    expect((err as InstanceType<typeof IPAllowlistError>).code).toBe("validation");
  });

  it("rejects duplicate CIDR", async () => {
    // Duplicate check returns existing row
    ee.queueMockRows([{ id: "existing-id" }]);

    const err = await Effect.runPromise(
      addIPAllowlistEntry("org-1", "10.0.0.0/8", null, null).pipe(Effect.flip),
    );
    expect(err).toBeInstanceOf(IPAllowlistError);
    expect((err as InstanceType<typeof IPAllowlistError>).code).toBe("conflict");
  });

  it("throws if enterprise not enabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(addIPAllowlistEntry("org-1", "10.0.0.0/8", null, null))).rejects.toThrow("Enterprise features");
  });
});

describe("removeIPAllowlistEntry", () => {
  beforeEach(resetMocks);

  it("removes existing entry", async () => {
    ee.queueMockRows([{ id: "entry-1" }]);
    const deleted = await run(removeIPAllowlistEntry("org-1", "entry-1"));
    expect(deleted).toBe(true);
  });

  it("returns false for non-existent entry", async () => {
    ee.queueMockRows([]);
    const deleted = await run(removeIPAllowlistEntry("org-1", "no-such-entry"));
    expect(deleted).toBe(false);
  });

  it("throws if enterprise not enabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(removeIPAllowlistEntry("org-1", "entry-1"))).rejects.toThrow("Enterprise features");
  });
});

// ── Tests: checkIPAllowlist (middleware integration) ─────────────────

describe("checkIPAllowlist", () => {
  beforeEach(resetMocks);

  it("allows when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    const result = await checkIPAllowlist("org-1", "1.2.3.4");
    expect(result.allowed).toBe(true);
  });

  it("allows when no allowlist entries exist (opt-in)", async () => {
    ee.queueMockRows([]); // empty allowlist
    const result = await checkIPAllowlist("org-1", "1.2.3.4");
    expect(result.allowed).toBe(true);
  });

  it("allows matching IP", async () => {
    ee.queueMockRows([{ cidr: "10.0.0.0/8" }]);
    const result = await checkIPAllowlist("org-1", "10.0.0.1");
    expect(result.allowed).toBe(true);
  });

  it("blocks non-matching IP", async () => {
    ee.queueMockRows([{ cidr: "10.0.0.0/8" }]);
    const result = await checkIPAllowlist("org-1", "192.168.1.1");
    expect(result.allowed).toBe(false);
  });

  it("blocks when IP is null and allowlist has entries", async () => {
    ee.queueMockRows([{ cidr: "10.0.0.0/8" }]);
    const result = await checkIPAllowlist("org-1", null);
    expect(result.allowed).toBe(false);
  });

  it("uses cache on second call", async () => {
    ee.queueMockRows([{ cidr: "10.0.0.0/8" }]);
    await checkIPAllowlist("org-1", "10.0.0.1");
    // Second call should not query DB (no additional rows needed)
    const result = await checkIPAllowlist("org-1", "10.0.0.1");
    expect(result.allowed).toBe(true);
    // Only 1 DB query should have been made
    expect(ee.capturedQueries).toHaveLength(1);
  });

  it("cache invalidation forces DB reload", async () => {
    ee.queueMockRows([{ cidr: "10.0.0.0/8" }]);
    await checkIPAllowlist("org-1", "10.0.0.1");

    // Invalidate cache
    _clearCache();
    ee.queueMockRows([{ cidr: "192.168.0.0/16" }]);

    const result = await checkIPAllowlist("org-1", "10.0.0.1");
    // Should now be blocked because cache was cleared and new DB data loaded
    expect(result.allowed).toBe(false);
    expect(ee.capturedQueries).toHaveLength(2);
  });
});

// ── Tests: Edge cases ───────────────────────────────────────────────

describe("edge cases", () => {
  beforeEach(resetMocks);

  it("handles multiple CIDR ranges for one org", async () => {
    ee.queueMockRows([
      { cidr: "10.0.0.0/8" },
      { cidr: "172.16.0.0/12" },
      { cidr: "192.168.0.0/16" },
    ]);
    // RFC 1918 address in the 172.16.x.x range
    const result = await checkIPAllowlist("org-1", "172.16.5.10");
    expect(result.allowed).toBe(true);
  });

  it("handles mixed IPv4/IPv6 in allowlist", async () => {
    ee.queueMockRows([
      { cidr: "10.0.0.0/8" },
      { cidr: "2001:db8::/32" },
    ]);
    const v4 = await checkIPAllowlist("org-1", "10.0.0.1");
    expect(v4.allowed).toBe(true);

    // Clear cache for fresh query
    _clearCache();
    ee.queueMockRows([
      { cidr: "10.0.0.0/8" },
      { cidr: "2001:db8::/32" },
    ]);
    const v6 = await checkIPAllowlist("org-1", "2001:db8::1");
    expect(v6.allowed).toBe(true);
  });

  it("parseCIDR handles /16 boundary correctly", () => {
    const cidr = parseCIDR("172.16.0.0/16")!;
    expect(isIPInRange("172.16.0.1", cidr)).toBe(true);
    expect(isIPInRange("172.16.255.255", cidr)).toBe(true);
    expect(isIPInRange("172.17.0.1", cidr)).toBe(false);
  });

  it("parseCIDR handles /12 boundary correctly", () => {
    const cidr = parseCIDR("172.16.0.0/12")!;
    expect(isIPInRange("172.16.0.1", cidr)).toBe(true);
    expect(isIPInRange("172.31.255.255", cidr)).toBe(true);
    expect(isIPInRange("172.32.0.1", cidr)).toBe(false);
  });

  it("IPv6 fe80::/10 link-local range", () => {
    const cidr = parseCIDR("fe80::/10")!;
    expect(isIPInRange("fe80::1", cidr)).toBe(true);
    expect(isIPInRange("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", cidr)).toBe(true);
    expect(isIPInRange("fec0::1", cidr)).toBe(false);
  });
});

// ── Tests: Fixed issues ─────────────────────────────────────────────

describe("fixed issues", () => {
  beforeEach(resetMocks);

  it("detects overlapping CIDRs as duplicates via normalized form", () => {
    // 10.0.0.5/8 and 10.0.0.0/8 represent the same network
    const a = parseCIDR("10.0.0.5/8")!;
    const b = parseCIDR("10.0.0.0/8")!;
    expect(a.normalized).toBe("10.0.0.0/8");
    expect(b.normalized).toBe("10.0.0.0/8");
    expect(a.normalized).toBe(b.normalized);
  });

  it("addIPAllowlistEntry normalizes CIDR for duplicate check", async () => {
    // First call: add 10.0.0.0/8
    ee.queueMockRows([]); // no duplicates
    ee.queueMockRows([
      {
        id: "new-id",
        org_id: "org-1",
        cidr: "10.0.0.0/8",
        description: null,
        created_at: "2026-03-22T00:00:00Z",
        created_by: null,
      },
    ]);

    await run(addIPAllowlistEntry("org-1", "10.0.0.5/8", null, null));

    // The duplicate check query should use normalized "10.0.0.0/8", not raw "10.0.0.5/8"
    expect(ee.capturedQueries[0].params).toEqual(["org-1", "10.0.0.0/8"]);
    // The INSERT should also use normalized form
    expect(ee.capturedQueries[1].params[1]).toBe("10.0.0.0/8");
  });

  it("IPv4-mapped IPv6 matches IPv4 CIDR", () => {
    const cidr = parseCIDR("10.0.0.0/8")!;
    // ::ffff:10.0.0.1 is the IPv4-mapped IPv6 form of 10.0.0.1
    expect(isIPInRange("::ffff:10.0.0.1", cidr)).toBe(true);
    expect(isIPInRange("::ffff:10.255.255.255", cidr)).toBe(true);
    expect(isIPInRange("::ffff:11.0.0.1", cidr)).toBe(false);
  });

  it("IPv4-mapped IPv6 works in isIPAllowed with mixed ranges", () => {
    const ranges = [parseCIDR("10.0.0.0/8")!, parseCIDR("192.168.0.0/16")!];
    expect(isIPAllowed("::ffff:10.0.0.1", ranges)).toBe(true);
    expect(isIPAllowed("::ffff:192.168.1.1", ranges)).toBe(true);
    expect(isIPAllowed("::ffff:172.16.0.1", ranges)).toBe(false);
  });

  it("plain IP without prefix is accepted as single-host CIDR", () => {
    // IPv4
    const v4 = parseCIDR("10.0.0.1")!;
    expect(v4).not.toBeNull();
    expect(v4.version).toBe(4);
    expect(v4.normalized).toBe("10.0.0.1/32");
    expect(isIPInRange("10.0.0.1", v4)).toBe(true);
    expect(isIPInRange("10.0.0.2", v4)).toBe(false);

    // IPv6
    const v6 = parseCIDR("2001:db8::1")!;
    expect(v6).not.toBeNull();
    expect(v6.version).toBe(6);
    expect(v6.normalized).toBe("2001:db8::1/128");
    expect(isIPInRange("2001:db8::1", v6)).toBe(true);
    expect(isIPInRange("2001:db8::2", v6)).toBe(false);
  });

  it("plain IP can be added to allowlist", async () => {
    ee.queueMockRows([]); // no duplicates
    ee.queueMockRows([
      {
        id: "new-id",
        org_id: "org-1",
        cidr: "10.0.0.1/32",
        description: "Single host",
        created_at: "2026-03-22T00:00:00Z",
        created_by: null,
      },
    ]);

    const entry = await run(addIPAllowlistEntry("org-1", "10.0.0.1", "Single host", null));
    expect(entry.cidr).toBe("10.0.0.1/32");

    // The stored CIDR should be the normalized /32 form
    expect(ee.capturedQueries[1].params[1]).toBe("10.0.0.1/32");
  });
});
