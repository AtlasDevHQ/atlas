/**
 * Workspace-key mint route tests (#4046 / ADR-0027 §6).
 *
 * POST /api/v1/admin/workspace-keys mints a Better Auth `apiKey()` key carrying
 * {orgId, role, claims} metadata derived SERVER-SIDE from the caller's membership,
 * so the key resolves to the minter's bound workspace. These pin the security
 * contract:
 *  - the orgId in the metadata comes from the resolved session, NOT the body
 *    (a caller can't mint a key for another workspace);
 *  - the role is capped at the minter's own (no escalation);
 *  - the key is owned by the authenticated minter (request headers forwarded);
 *  - the mint is audited (keyId + scope), never the key value.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// Default authed user: an ADMIN of org-alpha. Individual tests re-mock the
// auth context via setAuthUser when they need a member-level minter.
const mocks = createApiTestMocks({
  authUser: {
    id: "minter-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}
const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});
mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// Capture every createApiKey call so we can assert the injected metadata.
interface CreateApiKeyCall {
  body: { name: string; metadata: Record<string, unknown>; expiresIn: number };
  headers: Headers;
}
const createApiKeyCalls: CreateApiKeyCall[] = [];
let createApiKeyImpl: (opts: CreateApiKeyCall) => Promise<{ id?: string; key?: string } | undefined> =
  async () => ({ id: "key_minted", key: "atlas_wk_thefullsecret" });

// Override the harness auth/server mock with one that exposes api.createApiKey.
// Curated stub, documented for mock-all-exports (CLAUDE.md): the ONLY real
// `auth/server` exports this admin router's graph reaches are `getAuthInstance`
// (reshaped here to expose `createApiKey`) and `SESSION_ORIGIN_CLI` (statically
// imported by managed.ts), so this two-key stub is complete. The shared harness
// mock (`__mocks__/api-test-mocks.ts`) additionally lists `listAllUsers`/
// `setUserRole`/`setBanStatus`/`setPasswordChangeRequired`/`deleteUser`, but those
// are NOT real exports of auth/server (stale harness residue, grep-confirmed) —
// reproducing them here would mirror a phantom shape, not satisfy any importer.
mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: {
      createApiKey: (opts: CreateApiKeyCall) => {
        createApiKeyCalls.push(opts);
        return createApiKeyImpl(opts);
      },
    },
  }),
  SESSION_ORIGIN_CLI: "cli",
}));

const { admin } = await import("../admin");

async function mint(body: unknown): Promise<Response> {
  return admin.request("/workspace-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: "session=abc" },
    body: JSON.stringify(body),
  });
}

function authAs(role: "member" | "admin" | "owner", id = "minter-1"): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id,
        mode: "managed",
        label: `${role}@test.com`,
        role,
        activeOrganizationId: "org-alpha",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

beforeEach(() => {
  createApiKeyCalls.length = 0;
  mockLogAdminAction.mockReset();
  createApiKeyImpl = async () => ({ id: "key_minted", key: "atlas_wk_thefullsecret" });
  authAs("admin");
});

describe("POST /api/v1/admin/workspace-keys", () => {
  it("injects the minter's orgId into the key metadata (never the body)", async () => {
    const res = await mint({ name: "ci-key", role: "member" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { key: string; id: string; orgId: string; role: string };
    expect(json.key).toBe("atlas_wk_thefullsecret");
    expect(json.orgId).toBe("org-alpha");

    expect(createApiKeyCalls.length).toBe(1);
    const meta = createApiKeyCalls[0].body.metadata;
    expect(meta.atlasWorkspaceKey).toBe(true);
    expect(meta.orgId).toBe("org-alpha");
    expect(meta.role).toBe("member");
  });

  it("caps the requested role at the minter's own (an admin cannot mint an owner key)", async () => {
    authAs("admin");
    const res = await mint({ name: "ci-key", role: "owner" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { role: string };
    expect(json.role).toBe("admin");
    expect(createApiKeyCalls[0].body.metadata.role).toBe("admin");
  });

  it("blocks a non-admin member from the mint surface entirely (403)", async () => {
    authAs("member");
    const res = await mint({ name: "ci-key", role: "member" });
    expect(res.status).toBe(403);
    expect(createApiKeyCalls.length).toBe(0);
  });

  it("embeds the supplied RLS claims into the metadata", async () => {
    await mint({ name: "ci-key", role: "member", claims: { tenant_id: "acme" } });
    expect(createApiKeyCalls[0].body.metadata.claims).toEqual({ tenant_id: "acme" });
  });

  it("defaults the role to the minter's own when none is requested", async () => {
    await mint({ name: "ci-key" });
    expect(createApiKeyCalls[0].body.metadata.role).toBe("admin");
  });

  it("forwards the request headers so the key binds to the authenticated minter", async () => {
    await mint({ name: "ci-key" });
    expect(createApiKeyCalls[0].headers.get("cookie")).toBe("session=abc");
  });

  it("audits the mint with the keyId + scope, never the key value", async () => {
    await mint({ name: "ci-key", role: "member", claims: { tenant_id: "acme" } });
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry.actionType).toBe("workspace_key.mint");
    expect(entry.targetId).toBe("key_minted");
    expect(entry.metadata).toMatchObject({ keyId: "key_minted", role: "member", hasClaims: true });
    // The plaintext key must never appear in the audit metadata.
    expect(JSON.stringify(entry)).not.toContain("atlas_wk_thefullsecret");
  });

  it("returns 500 (not a partial success) when createApiKey fails", async () => {
    createApiKeyImpl = async () => undefined;
    const res = await mint({ name: "ci-key" });
    expect(res.status).toBe(500);
  });

  it("rejects an empty name (422)", async () => {
    const res = await mint({ name: "" });
    expect(res.status).toBe(422);
  });
});
