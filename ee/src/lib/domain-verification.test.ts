import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";

// Mock DNS before importing the module under test
const mockResolveTxt: Mock<(domain: string) => Promise<string[][]>> = mock(async () => []);
mock.module("node:dns", () => ({
  default: { promises: { resolveTxt: mockResolveTxt } },
  promises: { resolveTxt: mockResolveTxt },
}));

// Mock logger to avoid console noise
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { generateVerificationToken, verifyDnsTxt } = await import("./domain-verification");

const run = <A>(effect: Effect.Effect<A, never>): Promise<A> =>
  Effect.runPromise(effect);

describe("generateVerificationToken", () => {
  it("returns token in atlas-verify=<uuid> format", () => {
    const token = generateVerificationToken();
    expect(token).toMatch(/^atlas-verify=[0-9a-f-]{36}$/);
  });

  it("generates unique tokens on each call", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a).not.toBe(b);
  });

  it("starts with atlas-verify= prefix", () => {
    const token = generateVerificationToken();
    expect(token.startsWith("atlas-verify=")).toBe(true);
  });
});

describe("verifyDnsTxt", () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveTxt.mockResolvedValue([]);
  });

  it("returns verified when matching TXT record found", async () => {
    const token = "atlas-verify=test-uuid";
    mockResolveTxt.mockResolvedValue([[token]]);

    const result = await run(verifyDnsTxt("example.com", token));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toEqual([token]);
    }
  });

  it("handles multi-part TXT records (DNS 255-byte chunks)", async () => {
    const token = "atlas-verify=test-uuid";
    mockResolveTxt.mockResolvedValue([["atlas-verify=", "test-uuid"]]);

    const result = await run(verifyDnsTxt("example.com", token));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toEqual([token]);
    }
  });

  it("returns no_match when token not found in records", async () => {
    mockResolveTxt.mockResolvedValue([["some-other-record"], ["unrelated-txt"]]);

    const result = await run(verifyDnsTxt("example.com", "atlas-verify=expected"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_match");
      expect(result.message).toContain("No matching TXT record");
      expect(result.message).toContain("atlas-verify=expected");
      expect(result.records).toEqual(["some-other-record", "unrelated-txt"]);
    }
  });

  it("returns dns_error when DNS lookup rejects", async () => {
    mockResolveTxt.mockRejectedValue(new Error("queryTxt ETIMEOUT example.com"));

    const result = await run(verifyDnsTxt("example.com", "atlas-verify=test"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("dns_error");
      expect(result.message).toContain("DNS lookup failed");
      expect(result.records).toEqual([]);
    }
  });

  it("returns timeout when DNS lookup exceeds deadline", async () => {
    mockResolveTxt.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 5_000)),
    );

    const result = await run(verifyDnsTxt("example.com", "atlas-verify=test", 50));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.message).toContain("timed out");
      expect(result.records).toEqual([]);
    }
  });

  it("returns no_match when no TXT records exist", async () => {
    mockResolveTxt.mockResolvedValue([]);

    const result = await run(verifyDnsTxt("example.com", "atlas-verify=test"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_match");
      expect(result.records).toEqual([]);
    }
  });

  it("ignores non-matching records among multiple entries", async () => {
    const token = "atlas-verify=correct-uuid";
    mockResolveTxt.mockResolvedValue([
      ["v=spf1 include:example.com ~all"],
      [token],
      ["google-site-verification=abc123"],
    ]);

    const result = await run(verifyDnsTxt("example.com", token));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toContain(token);
    }
  });

  it("includes domain in failure message", async () => {
    mockResolveTxt.mockRejectedValue(new Error("ENOTFOUND"));

    const result = await run(verifyDnsTxt("missing.example.com", "atlas-verify=test"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("missing.example.com");
    }
  });
});
