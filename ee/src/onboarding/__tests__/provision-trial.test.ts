import { describe, expect, it } from "bun:test";
import {
  provisionTrialWorkspace,
  TrialProvisioningError,
  type ProvisionTrialDeps,
} from "../provision-trial.js";

/**
 * Build a fully-stubbed deps set so the orchestration is tested at the highest
 * seam without pulling Better Auth or the internal DB into the graph. Each
 * field is overridable per-test.
 */
function stubDeps(over: Partial<ProvisionTrialDeps> = {}): {
  deps: Partial<ProvisionTrialDeps>;
  calls: {
    signUp: Array<{ email: string; name: string }>;
    createOrg: Array<{ name: string; slug: string; userId: string }>;
    grace: Array<{ orgId: string; endsAtIso: string }>;
    mcpLead: Array<{ email: string; name?: string }>;
  };
} {
  const calls = {
    signUp: [] as Array<{ email: string; name: string }>,
    createOrg: [] as Array<{ name: string; slug: string; userId: string }>,
    grace: [] as Array<{ orgId: string; endsAtIso: string }>,
    mcpLead: [] as Array<{ email: string; name?: string }>,
  };
  const deps: Partial<ProvisionTrialDeps> = {
    getDeployMode: () => "saas",
    signUpEmail: async (b) => {
      calls.signUp.push({ email: b.email, name: b.name });
      return { user: { id: "user_new" } };
    },
    createOrganization: async (b) => {
      calls.createOrg.push(b);
      return { id: "org_new" };
    },
    readOrgTier: async () => ({ plan_tier: "trial", trial_ends_at: null }),
    setGraceWindow: async (orgId, endsAtIso) => {
      calls.grace.push({ orgId, endsAtIso });
      return 1;
    },
    buildConnectUrl: (id) => `https://mcp.test/mcp/${id}/sse`,
    enqueueMcpSignupLead: async (email, name) => {
      calls.mcpLead.push({ email, name });
    },
    graceMs: 72 * 60 * 60 * 1000,
    ...over,
  };
  return { deps, calls };
}

describe("provisionTrialWorkspace", () => {
  it("provisions a user + Workspace into unclaimed grace and returns the connect URL", async () => {
    const { deps, calls } = stubDeps();
    const before = Date.now();
    const result = await provisionTrialWorkspace(
      { email: "founder@acme.com", orgName: "Acme Analytics" },
      deps,
    );
    const after = Date.now();

    expect(result.workspaceId).toBe("org_new");
    expect(result.state).toBe("grace");
    expect(result.connectUrl).toBe("https://mcp.test/mcp/org_new/sse");

    // signUp ran with a derived name; createOrg used the user id + a slug
    // derived from the workspace name.
    expect(calls.signUp).toHaveLength(1);
    expect(calls.signUp[0]!.email).toBe("founder@acme.com");
    expect(calls.createOrg).toHaveLength(1);
    expect(calls.createOrg[0]!.userId).toBe("user_new");
    expect(calls.createOrg[0]!.name).toBe("Acme Analytics");
    expect(calls.createOrg[0]!.slug).toMatch(/^acme-analytics-[0-9a-f]{8}$/);

    // grace window narrowed to NOW + ~72h (well short of the 14-day clock).
    expect(calls.grace).toHaveLength(1);
    expect(calls.grace[0]!.orgId).toBe("org_new");
    const graceMs = Date.parse(calls.grace[0]!.endsAtIso);
    expect(graceMs).toBeGreaterThanOrEqual(before + 72 * 60 * 60 * 1000);
    expect(graceMs).toBeLessThanOrEqual(after + 72 * 60 * 60 * 1000);
    expect(graceMs).toBeLessThan(before + 14 * 24 * 60 * 60 * 1000);

    // Exactly ONE CRM lead — the MCP_SIGNUP one — is enqueued, carrying the
    // same derived name the user account got. The competing auto-SIGNUP that
    // Better Auth's user.create hook would emit is suppressed on this path
    // (see dispatch-signup-crm-lead.test.ts), so MCP_SIGNUP is the sole
    // crm_outbox row and wins sticky first-touch (atlasFirstSource = MCP_SIGNUP,
    // pinned end-to-end in plugins/twenty/__tests__/client.test.ts).
    expect(calls.mcpLead).toHaveLength(1);
    expect(calls.mcpLead[0]!.email).toBe("founder@acme.com");
    expect(calls.mcpLead[0]!.name).toBe("founder");
  });

  it("enqueues the MCP_SIGNUP lead for the locked (repeat-signup) arm too", async () => {
    // A successful provision attributes the acquisition channel regardless of
    // whether the user already consumed a trial — `locked` is still a real
    // MCP-sourced signup that should be measurable.
    const { deps, calls } = stubDeps({
      readOrgTier: async () => ({
        plan_tier: "locked",
        trial_ends_at: new Date().toISOString(),
      }),
    });
    const result = await provisionTrialWorkspace(
      { email: "founder@acme.com", orgName: "Acme Two" },
      deps,
    );
    expect(result.state).toBe("locked");
    expect(calls.mcpLead).toHaveLength(1);
    expect(calls.mcpLead[0]!.email).toBe("founder@acme.com");
  });

  it("does NOT enqueue an MCP_SIGNUP lead when signup itself fails", async () => {
    const { deps, calls } = stubDeps({
      signUpEmail: async () => ({ user: {} }),
    });
    await expect(
      provisionTrialWorkspace({ email: "a@b.com", orgName: "Acme" }, deps),
    ).rejects.toMatchObject({ code: "signup_failed" });
    expect(calls.mcpLead).toHaveLength(0);
  });

  it("refuses when deployMode !== 'saas'", async () => {
    const { deps, calls } = stubDeps({ getDeployMode: () => "self-hosted" });
    await expect(
      provisionTrialWorkspace(
        { email: "founder@acme.com", orgName: "Acme" },
        deps,
      ),
    ).rejects.toMatchObject({ name: "TrialProvisioningError", code: "not_saas" });
    // Nothing was provisioned.
    expect(calls.signUp).toHaveLength(0);
    expect(calls.createOrg).toHaveLength(0);
  });

  it("lands a repeat signup (consumed trial) on locked with no grace narrowing", async () => {
    const { deps, calls } = stubDeps({
      readOrgTier: async () => ({
        plan_tier: "locked",
        trial_ends_at: new Date().toISOString(),
      }),
    });
    const result = await provisionTrialWorkspace(
      { email: "founder@acme.com", orgName: "Acme Two" },
      deps,
    );
    expect(result.state).toBe("locked");
    expect(result.workspaceId).toBe("org_new");
    // grace narrowing is skipped for the locked arm.
    expect(calls.grace).toHaveLength(0);
  });

  it("rejects malformed email before any signup round-trip", async () => {
    const { deps, calls } = stubDeps();
    await expect(
      provisionTrialWorkspace({ email: "not-an-email", orgName: "Acme" }, deps),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.signUp).toHaveLength(0);
  });

  it("rejects a blank workspace name", async () => {
    const { deps } = stubDeps();
    await expect(
      provisionTrialWorkspace({ email: "a@b.com", orgName: "   " }, deps),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws signup_failed when Better Auth returns no user id (email already registered)", async () => {
    const { deps, calls } = stubDeps({
      signUpEmail: async () => ({ user: {} }),
    });
    await expect(
      provisionTrialWorkspace({ email: "a@b.com", orgName: "Acme" }, deps),
    ).rejects.toMatchObject({ code: "signup_failed" });
    expect(calls.createOrg).toHaveLength(0);
  });

  it("throws org_failed when organization creation returns no id", async () => {
    const { deps } = stubDeps({ createOrganization: async () => ({}) });
    await expect(
      provisionTrialWorkspace({ email: "a@b.com", orgName: "Acme" }, deps),
    ).rejects.toMatchObject({ code: "org_failed" });
  });

  it("throws trial_not_assigned when the grace-window UPDATE matches no row (TOCTOU)", async () => {
    // The tier was read as 'trial' but the guarded UPDATE narrows zero rows
    // (the tier changed under us) — returning grace here would hand back a
    // full-window trial, so the provisioner must refuse instead.
    const { deps } = stubDeps({ setGraceWindow: async () => 0 });
    await expect(
      provisionTrialWorkspace({ email: "a@b.com", orgName: "Acme" }, deps),
    ).rejects.toMatchObject({ code: "trial_not_assigned" });
  });

  it("throws trial_not_assigned when the org lands on neither trial nor locked", async () => {
    const { deps } = stubDeps({
      readOrgTier: async () => ({ plan_tier: "free", trial_ends_at: null }),
    });
    await expect(
      provisionTrialWorkspace({ email: "a@b.com", orgName: "Acme" }, deps),
    ).rejects.toMatchObject({ code: "trial_not_assigned" });
  });

  it("exposes a typed error class for envelope mapping", () => {
    const err = new TrialProvisioningError("not_saas", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TrialProvisioningError");
    expect(err.code).toBe("not_saas");
  });
});
