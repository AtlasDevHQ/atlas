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
        // The minter's own claim bag. `tenant_id` is the RLS claim they hold —
        // a key can embed it (within scope) but not any claim outside this bag.
        claims: { twoFactorEnabled: true, tenant_id: "acme" },
      },
    }),
  );
}

/** Authenticate as a workspace API key actor (the api_key marker claim). */
function authAsApiKey(): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "key-owner-1",
        mode: "managed",
        label: "ci@test.com",
        role: "admin",
        activeOrganizationId: "org-alpha",
        claims: { api_key: true, org_id: "org-alpha", sub: "key-owner-1", origin: "cli" },
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

  it("embeds the supplied RLS claims into the metadata (within the minter's scope)", async () => {
    // The minter holds `tenant_id: "acme"` (see authAs), so the key may carry it.
    await mint({ name: "ci-key", role: "member", claims: { tenant_id: "acme" } });
    expect(createApiKeyCalls[0].body.metadata.claims).toEqual({ tenant_id: "acme" });
  });

  it("rejects an RLS claim the minter does not hold (422) — no widening (#4110 AC3)", async () => {
    // The minter holds tenant_id:"acme"; minting tenant_id:"globex" would grant
    // RLS reach they don't have. Must be refused, and no key minted.
    const res = await mint({ name: "ci-key", claims: { tenant_id: "globex" } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("claim_not_allowed");
    expect(createApiKeyCalls.length).toBe(0);
  });

  it("rejects a claim key the minter does not hold at all (422) — no fabrication (#4110 AC3)", async () => {
    const res = await mint({ name: "ci-key", claims: { region: "us" } });
    expect(res.status).toBe(422);
    expect(createApiKeyCalls.length).toBe(0);
  });

  it("rejects a reserved identity claim key (422) — can't forge identity/MFA (#4110 AC3)", async () => {
    const res = await mint({ name: "ci-key", claims: { sub: "someone-else" } });
    expect(res.status).toBe(422);
    expect(createApiKeyCalls.length).toBe(0);
  });

  it("denies a workspace API key actor from the mint surface (403) — keys are data-plane (#4110 AC1/AC2)", async () => {
    authAsApiKey();
    const res = await mint({ name: "ci-key" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("api_key_not_permitted");
    expect(createApiKeyCalls.length).toBe(0);
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
