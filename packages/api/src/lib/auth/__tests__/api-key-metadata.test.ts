import { describe, it, expect } from "bun:test";
import {
  API_KEY_MARKER_CLAIM,
  RESERVED_API_KEY_CLAIM_KEYS,
  boundClaimsToMinter,
  buildApiKeyMetadata,
  parseApiKeyMetadata,
  type ApiKeyMetadata,
} from "../api-key-metadata";

describe("buildApiKeyMetadata()", () => {
  it("stamps the workspace marker + orgId + role", () => {
    const meta = buildApiKeyMetadata({ orgId: "org_123", role: "member" });
    expect(meta.atlasWorkspaceKey).toBe(true);
    expect(meta.orgId).toBe("org_123");
    expect(meta.role).toBe("member");
    expect(meta.claims).toBeUndefined();
  });

  it("carries the RLS claim bag when supplied", () => {
    const meta = buildApiKeyMetadata({
      orgId: "org_123",
      role: "member",
      claims: { tenant_id: "acme" },
    });
    expect(meta.claims).toEqual({ tenant_id: "acme" });
  });

  it("drops empty claim bags so metadata stays minimal", () => {
    const meta = buildApiKeyMetadata({
      orgId: "org_123",
      role: "member",
      claims: {},
    });
    expect(meta.claims).toBeUndefined();
  });
});

describe("parseApiKeyMetadata()", () => {
  it("round-trips a built metadata object", () => {
    const built = buildApiKeyMetadata({
      orgId: "org_123",
      role: "owner",
      claims: { tenant_id: "acme" },
    });
    const parsed = parseApiKeyMetadata(built);
    expect(parsed).toEqual({
      orgId: "org_123",
      role: "owner",
      claims: { tenant_id: "acme" },
    } satisfies ApiKeyMetadata);
  });

  it("parses a JSON-round-tripped object (Better Auth metadata shape)", () => {
    const raw = JSON.parse(
      JSON.stringify({ atlasWorkspaceKey: true, orgId: "org_9", role: "member" }),
    );
    const parsed = parseApiKeyMetadata(raw);
    expect(parsed).toEqual({ orgId: "org_9", role: "member" });
  });

  it("returns null for metadata missing the workspace-key marker (a non-Atlas key)", () => {
    expect(parseApiKeyMetadata({ orgId: "org_1", role: "member" })).toBeNull();
  });

  it("returns null when orgId is missing — isolation can't derive without it", () => {
    expect(parseApiKeyMetadata({ atlasWorkspaceKey: true, role: "member" })).toBeNull();
  });

  it("returns null for null / non-object / array input", () => {
    expect(parseApiKeyMetadata(null)).toBeNull();
    expect(parseApiKeyMetadata(undefined)).toBeNull();
    expect(parseApiKeyMetadata("nope")).toBeNull();
    expect(parseApiKeyMetadata([1, 2])).toBeNull();
  });

  it("ignores an invalid role rather than trusting it (role is re-resolved live anyway)", () => {
    const parsed = parseApiKeyMetadata({
      atlasWorkspaceKey: true,
      orgId: "org_1",
      role: "superuser",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.role).toBeUndefined();
  });

  it("drops a non-object claims field", () => {
    const parsed = parseApiKeyMetadata({
      atlasWorkspaceKey: true,
      orgId: "org_1",
      role: "member",
      claims: "not-an-object",
    });
    expect(parsed?.claims).toBeUndefined();
  });

  it("exposes a stable reserved marker-claim key, distinct from origin", () => {
    expect(API_KEY_MARKER_CLAIM).toBe("api_key");
  });
});

describe("boundClaimsToMinter() (#4110 AC3)", () => {
  const minter = { tenant_id: "acme", region: ["us", "eu"], twoFactorEnabled: true };

  it("is ok when no claims are requested", () => {
    expect(boundClaimsToMinter(undefined, minter)).toEqual({ ok: true });
    expect(boundClaimsToMinter({}, minter)).toEqual({ ok: true });
  });

  it("allows a scalar claim the minter holds with an equal value", () => {
    expect(boundClaimsToMinter({ tenant_id: "acme" }, minter)).toEqual({ ok: true });
  });

  it("allows an array claim that matches the minter's value structurally", () => {
    expect(boundClaimsToMinter({ region: ["us", "eu"] }, minter)).toEqual({ ok: true });
  });

  it("rejects a claim value the minter doesn't hold (no widening)", () => {
    expect(boundClaimsToMinter({ tenant_id: "globex" }, minter)).toEqual({
      ok: false,
      key: "tenant_id",
      reason: "not_in_minter_scope",
    });
  });

  it("rejects a claim key absent from the minter's bag (no fabrication)", () => {
    expect(boundClaimsToMinter({ department: "eng" }, minter)).toEqual({
      ok: false,
      key: "department",
      reason: "not_in_minter_scope",
    });
  });

  it("rejects narrowing a multi-value claim (must re-mint from a narrower session)", () => {
    expect(boundClaimsToMinter({ region: ["us"] }, minter)).toMatchObject({
      ok: false,
      reason: "not_in_minter_scope",
    });
  });

  it("rejects every reserved identity/security claim key", () => {
    for (const key of RESERVED_API_KEY_CLAIM_KEYS) {
      // Give the minter the key too, to prove the reserved check wins over scope.
      const result = boundClaimsToMinter({ [key]: "x" }, { ...minter, [key]: "x" });
      expect(result).toEqual({ ok: false, key, reason: "reserved" });
    }
  });

  it("treats a missing minter bag as holding nothing", () => {
    expect(boundClaimsToMinter({ tenant_id: "acme" }, null)).toMatchObject({ ok: false });
    expect(boundClaimsToMinter(undefined, null)).toEqual({ ok: true });
  });
});
