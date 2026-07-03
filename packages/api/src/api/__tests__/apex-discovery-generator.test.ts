/**
 * Unit tests for the apex-discovery generator's render contract
 * (`packages/api/scripts/generate-apex-discovery.ts`).
 *
 * The `check-apex-discovery-drift.sh` gate can't catch a host-precedence
 * regression — it regenerates with the SAME generator, so a bug that flipped
 * the host resolution would leave the committed artifact and the regenerated
 * one equally wrong (and the gate green). These tests lock the two properties
 * the drift gate assumes: the render is env-independent (pins the canonical
 * base regardless of ambient env), and the protected-resource SSOT keeps its
 * RFC 9728 shape.
 */
import { describe, it, expect } from "bun:test";

import {
  renderCanonicalAuthMd,
  API_PROTECTED_RESOURCE,
  buildRegionDirectory,
} from "../../../scripts/generate-apex-discovery";

describe("apex-discovery generator", () => {
  it("renders the canonical hosts regardless of polluting ambient env", () => {
    const prevApi = process.env.ATLAS_PUBLIC_API_URL;
    const prevAuth = process.env.BETTER_AUTH_URL;
    // Ambient env that would mislead the shared host helpers if it leaked in.
    process.env.ATLAS_PUBLIC_API_URL = "https://wrong.example";
    process.env.BETTER_AUTH_URL = "https://evil.example";
    try {
      const md = renderCanonicalAuthMd();
      expect(md).toContain("https://api.useatlas.dev/api/auth");
      expect(md).toContain("https://mcp.useatlas.dev/mcp");
      expect(md).not.toContain("evil.example");
      expect(md).not.toContain("wrong.example");
      // The render restores ambient env in its finally block.
      expect(process.env.ATLAS_PUBLIC_API_URL).toBe("https://wrong.example");
      expect(process.env.BETTER_AUTH_URL).toBe("https://evil.example");
    } finally {
      if (prevApi === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
      else process.env.ATLAS_PUBLIC_API_URL = prevApi;
      if (prevAuth === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = prevAuth;
    }
  });

  it("keeps the canonical RFC 9728 protected-resource fields", () => {
    expect(API_PROTECTED_RESOURCE.resource).toBe("https://api.useatlas.dev");
    expect(API_PROTECTED_RESOURCE.authorization_servers).toEqual([
      "https://api.useatlas.dev",
    ]);
    expect(API_PROTECTED_RESOURCE.bearer_methods_supported).toEqual(["header"]);
    expect(API_PROTECTED_RESOURCE.resource_policy_uri).toBe(
      "https://www.useatlas.dev/privacy",
    );
  });

  it("builds a region directory with the us default and per-region hosts", () => {
    const dir = buildRegionDirectory();
    expect(dir.default).toBe("us");
    expect(dir.regions.map((r) => r.id)).toEqual(["us", "eu", "apac"]);
  });

  it("derives each region's MCP host via the api*→mcp* brand-mirror", () => {
    const dir = buildRegionDirectory();
    const eu = dir.regions.find((r) => r.id === "eu");
    expect(eu).toMatchObject({
      api: "https://api-eu.useatlas.dev",
      mcp: "https://mcp-eu.useatlas.dev/mcp",
      authMd: "https://api-eu.useatlas.dev/auth.md",
    });
    // US has no region suffix — mirror must not inject a stray hyphen.
    expect(dir.regions.find((r) => r.id === "us")?.mcp).toBe(
      "https://mcp.useatlas.dev/mcp",
    );
  });
});
