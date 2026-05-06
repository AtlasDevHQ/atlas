/**
 * Canonical anti-pattern fixture for the brand/regional SaaS-hostname
 * mappers. Five call sites across `@atlas/api`, `@atlas/mcp`,
 * `@atlas/web` import these helpers; this is the single test suite
 * that pins their behaviour. Per-call-site test files run thin smoke
 * tests against the *callers* (audience accept-list shape, snippet
 * rendering, etc.); they do not re-pin the regex.
 */

import { describe, expect, it } from "bun:test";
import { brandUseatlasHost, flipUseatlasHost } from "../saas-hosts";

describe("flipUseatlasHost (symmetric)", () => {
  it("maps regional api hosts to brand siblings", () => {
    expect(flipUseatlasHost("https://api.useatlas.dev")).toBe(
      "https://mcp.useatlas.dev",
    );
    expect(flipUseatlasHost("https://api-eu.useatlas.dev")).toBe(
      "https://mcp-eu.useatlas.dev",
    );
    expect(flipUseatlasHost("https://api-apac.useatlas.dev")).toBe(
      "https://mcp-apac.useatlas.dev",
    );
  });

  it("maps brand mcp hosts back to regional api siblings", () => {
    // Symmetry is the load-bearing invariant: an operator who flips
    // ATLAS_PUBLIC_API_URL to the brand host must still see both
    // audiences accepted, otherwise tokens bound to the regional
    // surface stop verifying.
    expect(flipUseatlasHost("https://mcp.useatlas.dev")).toBe(
      "https://api.useatlas.dev",
    );
    expect(flipUseatlasHost("https://mcp-eu.useatlas.dev")).toBe(
      "https://api-eu.useatlas.dev",
    );
    expect(flipUseatlasHost("https://mcp-apac.useatlas.dev")).toBe(
      "https://api-apac.useatlas.dev",
    );
  });

  it("returns null for non-useatlas.dev bases (self-hosted, dev)", () => {
    expect(flipUseatlasHost("https://api.example.test")).toBeNull();
    expect(flipUseatlasHost("http://localhost:3001")).toBeNull();
  });
});

describe("brandUseatlasHost (asymmetric)", () => {
  it("maps regional api hosts to brand siblings", () => {
    expect(brandUseatlasHost("https://api.useatlas.dev")).toBe(
      "https://mcp.useatlas.dev",
    );
    expect(brandUseatlasHost("https://api-eu.useatlas.dev")).toBe(
      "https://mcp-eu.useatlas.dev",
    );
    expect(brandUseatlasHost("https://api-apac.useatlas.dev")).toBe(
      "https://mcp-apac.useatlas.dev",
    );
  });

  it("returns null for brand hosts themselves (already canonical)", () => {
    // Asymmetric on purpose: outbound surfaces (well-known doc,
    // WWW-Authenticate, 421 redirect, wizard snippet) must NEVER
    // emit `https://api.useatlas.dev` when the operator is already
    // on the brand. The caller's `?? trimmed` fallback emits the
    // brand verbatim instead.
    expect(brandUseatlasHost("https://mcp.useatlas.dev")).toBeNull();
    expect(brandUseatlasHost("https://mcp-eu.useatlas.dev")).toBeNull();
    expect(brandUseatlasHost("https://mcp-apac.useatlas.dev")).toBeNull();
  });

  it("returns null for non-useatlas.dev bases", () => {
    expect(brandUseatlasHost("https://api.example.test")).toBeNull();
    expect(brandUseatlasHost("http://localhost:3001")).toBeNull();
  });
});

describe("anti-patterns rejected by both helpers", () => {
  // Pin each anti-pattern explicitly so a future regex relaxation
  // (e.g. accidental `[a-z]+` instead of `[a-z0-9]+`, or losing the
  // `^/$` anchors) trips this test in one place rather than five.
  const ANTI_PATTERNS = [
    "https://apiv2.useatlas.dev",
    "https://api.eu.useatlas.dev", // multi-label — region is a suffix on `api`, not a separate label
    "https://api.useatlas.dev.evil.test",
    "https://api-.useatlas.dev",
    "https://mcpv2.useatlas.dev",
    "",
    "not-a-url",
    "api.useatlas.dev", // missing scheme — `new URL` rejects
  ];

  for (const host of ANTI_PATTERNS) {
    it(`rejects ${JSON.stringify(host)}`, () => {
      expect(flipUseatlasHost(host)).toBeNull();
      expect(brandUseatlasHost(host)).toBeNull();
    });
  }
});
