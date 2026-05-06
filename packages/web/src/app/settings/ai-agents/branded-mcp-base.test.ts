import { describe, expect, it } from "bun:test";
import { brandedMcpBase } from "./branded-mcp-base";

/**
 * The connect-wizard renders the user-facing config snippet that every
 * SaaS user pastes into Claude Desktop / Cursor / ChatGPT. A regex
 * drift here silently emits the wrong hostname without a Playwright
 * signal — Next.js inlines `process.env.NEXT_PUBLIC_*` at bundle time
 * so the e2e suite can't drive the SaaS code path.
 *
 * The matcher is also one of three lockstep `api*.useatlas.dev →
 * mcp*.useatlas.dev` mappers in the codebase
 * (`well-known.ts:brandedMcpHost`, `hosted.ts:brandedMcpHost`); a
 * future regex relaxation (e.g. accidental `[a-z]+` instead of
 * `[a-z0-9]+`, or losing the `^/$` anchors) would slip past those
 * three sibling test suites if this fourth one didn't exist.
 */
describe("brandedMcpBase", () => {
  it("maps the us-region api host to the brand mirror", () => {
    expect(brandedMcpBase("https://api.useatlas.dev")).toBe(
      "https://mcp.useatlas.dev",
    );
  });

  it("maps api-eu and api-apac to their brand siblings", () => {
    expect(brandedMcpBase("https://api-eu.useatlas.dev")).toBe(
      "https://mcp-eu.useatlas.dev",
    );
    expect(brandedMcpBase("https://api-apac.useatlas.dev")).toBe(
      "https://mcp-apac.useatlas.dev",
    );
  });

  it("returns null for non-useatlas.dev bases (self-hosted, dev, custom domain)", () => {
    // Caller falls back to the trimmed input — the wizard renders the
    // same string the user is already on. Self-hosted operators on
    // arbitrary hostnames must NOT see a synthesised
    // `mcp.example.test` URL appear in the snippet.
    expect(brandedMcpBase("https://api.example.test")).toBeNull();
    expect(brandedMcpBase("http://localhost:3001")).toBeNull();
    expect(brandedMcpBase("https://atlas.example.com")).toBeNull();
  });

  it("returns null for the brand hosts themselves (already canonical)", () => {
    // The wizard helper is asymmetric on purpose — we never want to
    // flip `mcp.useatlas.dev` BACK to `api.useatlas.dev` in the
    // displayed snippet. The caller falls through to the as-is URL
    // when this returns null.
    expect(brandedMcpBase("https://mcp.useatlas.dev")).toBeNull();
    expect(brandedMcpBase("https://mcp-eu.useatlas.dev")).toBeNull();
  });

  it("rejects useatlas.dev anti-patterns", () => {
    // Pin each anti-pattern explicitly so a future regex relaxation
    // that re-introduces brand mirroring for malicious or typo'd hosts
    // trips this test.
    expect(brandedMcpBase("https://apiv2.useatlas.dev")).toBeNull();
    expect(brandedMcpBase("https://api.eu.useatlas.dev")).toBeNull();
    expect(brandedMcpBase("https://api.useatlas.dev.evil.test")).toBeNull();
    expect(brandedMcpBase("https://api-.useatlas.dev")).toBeNull();
  });

  it("returns null for an empty or non-URL base (Playwright / SSR fallback)", () => {
    expect(brandedMcpBase("")).toBeNull();
    expect(brandedMcpBase("not-a-url")).toBeNull();
    expect(brandedMcpBase("api.useatlas.dev")).toBeNull();
  });
});
