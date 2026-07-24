/**
 * SSRF guard tests for `isSafeExternalUrl` (#3006). The guard is the single
 * IP-parsing primitive every host-side fetch (OpenAPI probe + operations, Daytona
 * validation, sub-processor webhooks) routes through. The legacy string-prefix
 * blocklist returned `true` for a long tail of internal-address encodings — these
 * tests lock each verified bypass closed and assert real CIDR membership.
 */

import { describe, expect, it } from "bun:test";
import { isBlockedResolvedAddress, isSafeExternalUrl } from "../validate";

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
