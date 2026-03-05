import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { validateApiKey } from "../simple-key";

function makeReq(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/chat", { headers });
}

describe("validateApiKey()", () => {
  const origApiKey = process.env.ATLAS_API_KEY;
  const origApiKeyRole = process.env.ATLAS_API_KEY_ROLE;

  beforeEach(() => {
    process.env.ATLAS_API_KEY = "sk-test-abcdef1234567890";
    delete process.env.ATLAS_API_KEY_ROLE;
  });

  afterEach(() => {
    if (origApiKey !== undefined) process.env.ATLAS_API_KEY = origApiKey;
    else delete process.env.ATLAS_API_KEY;
    if (origApiKeyRole !== undefined) process.env.ATLAS_API_KEY_ROLE = origApiKeyRole;
    else delete process.env.ATLAS_API_KEY_ROLE;
  });

  it("authenticates with correct Authorization: Bearer header", () => {
    const req = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user).toBeDefined();
      expect(result.user!.mode).toBe("simple-key");
    }
  });

  it("authenticates with correct X-API-Key header", () => {
    const req = makeReq({ "X-API-Key": "sk-test-abcdef1234567890" });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user).toBeDefined();
      expect(result.user!.mode).toBe("simple-key");
    }
  });

  it("rejects mismatched key", () => {
    const req = makeReq({ Authorization: "Bearer wrong-key" });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("Invalid API key");
    }
  });

  it("rejects when no key header is present", () => {
    const req = makeReq();
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("API key required");
    }
  });

  it("rejects when ATLAS_API_KEY is not configured", () => {
    delete process.env.ATLAS_API_KEY;
    const req = makeReq({ Authorization: "Bearer some-key" });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("API key not configured");
    }
  });

  it("produces a stable user ID (same key → same hash)", () => {
    const req1 = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
    const req2 = makeReq({ "X-API-Key": "sk-test-abcdef1234567890" });
    const r1 = validateApiKey(req1);
    const r2 = validateApiKey(req2);
    expect(r1.authenticated).toBe(true);
    expect(r2.authenticated).toBe(true);
    if (r1.authenticated && r1.user && r2.authenticated && r2.user) {
      expect(r1.user.id).toBe(r2.user.id);
      expect(r1.user.id).toMatch(/^api-key-[0-9a-f]{8}$/);
    }
  });

  it("user label contains key prefix (first 4 chars)", () => {
    const req = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(true);
    if (result.authenticated && result.user) {
      expect(result.user.label).toBe("api-key-sk-t");
    }
  });

  it("Authorization header takes precedence over X-API-Key", () => {
    const req = makeReq({
      Authorization: "Bearer sk-test-abcdef1234567890",
      "X-API-Key": "wrong-key",
    });
    const result = validateApiKey(req);
    // Should succeed because Authorization header has the correct key
    expect(result.authenticated).toBe(true);
  });

  it("rejects Authorization header without Bearer prefix", () => {
    const req = makeReq({ Authorization: "sk-test-abcdef1234567890" });
    // No "Bearer " prefix → extractKey falls through to X-API-Key (not present) → null
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toBe("API key required");
    }
  });

  it("rejects very short key without throwing", () => {
    const req = makeReq({ Authorization: "Bearer a" });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects very long key without throwing", () => {
    const req = makeReq({ Authorization: "Bearer " + "x".repeat(1000) });
    const result = validateApiKey(req);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(401);
    }
  });

  describe("role extraction via ATLAS_API_KEY_ROLE", () => {
    it("ATLAS_API_KEY_ROLE=admin produces user with role 'admin'", () => {
      process.env.ATLAS_API_KEY_ROLE = "admin";
      const req = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
      const result = validateApiKey(req);
      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("admin");
      }
    });

    it("ATLAS_API_KEY_ROLE=invalid falls back (no role on user)", () => {
      process.env.ATLAS_API_KEY_ROLE = "invalid";
      const req = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
      const result = validateApiKey(req);
      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });

    it("ATLAS_API_KEY_ROLE=ADMIN (case insensitive) works", () => {
      process.env.ATLAS_API_KEY_ROLE = "ADMIN";
      const req = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
      const result = validateApiKey(req);
      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBe("admin");
      }
    });

    it("no ATLAS_API_KEY_ROLE set — user has no explicit role", () => {
      delete process.env.ATLAS_API_KEY_ROLE;
      const req = makeReq({ Authorization: "Bearer sk-test-abcdef1234567890" });
      const result = validateApiKey(req);
      expect(result.authenticated).toBe(true);
      if (result.authenticated && result.user) {
        expect(result.user.role).toBeUndefined();
      }
    });
  });
});
