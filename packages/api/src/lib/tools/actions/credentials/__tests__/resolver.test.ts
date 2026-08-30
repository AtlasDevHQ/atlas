/**
 * Action-credential resolver tests (#3766).
 *
 * The combinatorial matrix over {deploy mode} × {workspace row} × {env} is the
 * point of this file: the precedence ladder is a security boundary, and each
 * row below is a leak that would otherwise be one refactor away.
 *
 * @see ADR-0046
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

const mockRead: Mock<
  (workspaceId: string, target: string) => Promise<Record<string, string> | null>
> = mock(() => Promise.resolve(null));
const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
const mockGetConfig: Mock<() => { deployMode?: string } | undefined> = mock(() => ({
  deployMode: "self-hosted",
}));

void mock.module("../store", () => ({ readActionCredentials: mockRead }));
void mock.module("@atlas/api/lib/db/internal", () => ({ hasInternalDB: mockHasInternalDB }));
void mock.module("@atlas/api/lib/config", () => ({ getConfig: mockGetConfig }));
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { resolveActionCredentials, getActionTargetStatus, ActionCredentialError } =
  await import("../resolver");

const WS = "ws-tenant-1";

/** A complete tenant-owned Jira credential row. */
const TENANT_ROW = {
  JIRA_BASE_URL: "https://tenant.atlassian.net",
  JIRA_EMAIL: "admin@tenant.example",
  JIRA_API_TOKEN: "tenant-token",
};

/** A complete operator-owned env, distinct from the tenant's in every field. */
const OPERATOR_ENV: NodeJS.ProcessEnv = {
  JIRA_BASE_URL: "https://operator.atlassian.net",
  JIRA_EMAIL: "operator@atlas.dev",
  JIRA_API_TOKEN: "operator-token",
  JIRA_DEFAULT_PROJECT: "OPS",
};

/** The same, for the Linear target (#5554). */
const LINEAR_OPERATOR_ENV: NodeJS.ProcessEnv = {
  LINEAR_API_KEY: "lin_api_operator-key",
  LINEAR_DEFAULT_TEAM_KEY: "OPS",
};

beforeEach(() => {
  mockRead.mockReset();
  mockRead.mockResolvedValue(null);
  mockHasInternalDB.mockReset();
  mockHasInternalDB.mockReturnValue(true);
  mockGetConfig.mockReset();
  mockGetConfig.mockReturnValue({ deployMode: "self-hosted" });
});
afterEach(() => mockRead.mockReset());

describe("resolveActionCredentials — precedence matrix", () => {
  it("saas × workspace row present → returns the workspace row, env ignored", async () => {
    mockRead.mockResolvedValue(TENANT_ROW);
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: WS,
      deployMode: "saas",
      env: OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("workspace");
    expect(resolved.values.JIRA_BASE_URL).toBe("https://tenant.atlassian.net");
    expect(resolved.values.JIRA_API_TOKEN).toBe("tenant-token");
    // The operator's optional default project must NOT leak in alongside.
    expect(resolved.values.JIRA_DEFAULT_PROJECT).toBeUndefined();
  });

  it("saas × no row × env present → throws, never falls back to env", async () => {
    mockRead.mockResolvedValue(null);
    await expect(
      resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "saas",
        env: OPERATOR_ENV,
      }),
    ).rejects.toThrow(ActionCredentialError);
  });

  it("saas × no row × env present → the thrown error carries no credential value", async () => {
    mockRead.mockResolvedValue(null);
    try {
      await resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "saas",
        env: OPERATOR_ENV,
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("operator-token");
      expect(message).not.toContain("operator@atlas.dev");
      expect(message).not.toContain("operator.atlassian.net");
      expect((err as InstanceType<typeof ActionCredentialError>).reason).toBe("unconfigured");
    }
  });

  it("self-hosted × workspace row present → returns the row (DB wins over env)", async () => {
    mockRead.mockResolvedValue(TENANT_ROW);
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("workspace");
    expect(resolved.values.JIRA_API_TOKEN).toBe("tenant-token");
  });

  it("self-hosted × no row × env present → returns env (the operator carve-out)", async () => {
    mockRead.mockResolvedValue(null);
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("env");
    expect(resolved.values.JIRA_API_TOKEN).toBe("operator-token");
    expect(resolved.values.JIRA_DEFAULT_PROJECT).toBe("OPS");
  });

  it("self-hosted × no row × no env → throws", async () => {
    mockRead.mockResolvedValue(null);
    await expect(
      resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: {},
      }),
    ).rejects.toThrow(ActionCredentialError);
  });

  it("self-hosted × no workspace × env present → returns env (auth-off self-host)", async () => {
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: null,
      deployMode: "self-hosted",
      env: OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("env");
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("saas × no workspace → throws with reason `no-workspace`", async () => {
    try {
      await resolveActionCredentials("jira", {
        workspaceId: null,
        deployMode: "saas",
        env: OPERATOR_ENV,
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect((err as InstanceType<typeof ActionCredentialError>).reason).toBe("no-workspace");
    }
  });

  it("an unmanaged target throws with reason `unmanaged-target`", async () => {
    try {
      await resolveActionCredentials("not-a-target", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: OPERATOR_ENV,
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect((err as InstanceType<typeof ActionCredentialError>).reason).toBe(
        "unmanaged-target",
      );
    }
  });

  it("with no internal DB the workspace rung is skipped entirely", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("env");
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("resolveActionCredentials — the all-or-nothing rule", () => {
  it("a PARTIAL workspace row throws rather than filling the gap from env", async () => {
    // The Direction-1 leak, one tier down: a tenant's base URL + email with the
    // OPERATOR's API token would create the ticket as Atlas against the
    // tenant's Jira. Per-field precedence would produce exactly that.
    mockRead.mockResolvedValue({
      JIRA_BASE_URL: "https://tenant.atlassian.net",
      JIRA_EMAIL: "admin@tenant.example",
      // JIRA_API_TOKEN deliberately absent
    });
    try {
      await resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: OPERATOR_ENV,
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const e = err as InstanceType<typeof ActionCredentialError>;
      expect(e.reason).toBe("partial-workspace-row");
      expect(e.message).toContain("JIRA_API_TOKEN");
      expect(e.message).not.toContain("operator-token");
    }
  });

  it("a partial row throws on saas too", async () => {
    mockRead.mockResolvedValue({ JIRA_BASE_URL: "https://tenant.atlassian.net" });
    await expect(
      resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "saas",
        env: OPERATOR_ENV,
      }),
    ).rejects.toThrow(/incomplete/i);
  });

  it("a row with an empty-string required field counts as missing, not present", async () => {
    mockRead.mockResolvedValue({ ...TENANT_ROW, JIRA_API_TOKEN: "" });
    await expect(
      resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: OPERATOR_ENV,
      }),
    ).rejects.toThrow(ActionCredentialError);
  });

  // ── Linear (#5554) ──────────────────────────────────────────────────
  //
  // The seam's claim is that a new target inherits the rung rules with no
  // resolver change. That claim is only worth something if it is measured per
  // target: these run the same three cases against Linear's own field spec, so
  // a future target whose fields the resolver happened to mis-handle would
  // fail here rather than pass on Jira's coverage.

  it("linear × a PARTIAL workspace row throws rather than filling the gap from env", async () => {
    // Linear's required set is one field, so "partial" here means a row that
    // exists carrying only the OPTIONAL default team. Under per-field
    // precedence the missing key would come from the operator's env and the
    // issue would be filed as ATLAS into the tenant's Linear.
    mockRead.mockResolvedValue({ LINEAR_DEFAULT_TEAM_KEY: "ENG" });
    try {
      await resolveActionCredentials("linear", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: LINEAR_OPERATOR_ENV,
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const e = err as InstanceType<typeof ActionCredentialError>;
      expect(e.reason).toBe("partial-workspace-row");
      expect(e.message).toContain("LINEAR_API_KEY");
      expect(e.message).not.toContain("lin_api_operator-key");
    }
  });

  it("linear × a complete workspace row wins outright, env ignored", async () => {
    mockRead.mockResolvedValue({ LINEAR_API_KEY: "lin_api_tenant-key" });
    const resolved = await resolveActionCredentials("linear", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: LINEAR_OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("workspace");
    expect(resolved.values.LINEAR_API_KEY).toBe("lin_api_tenant-key");
    // The operator's optional default team must NOT leak in alongside.
    expect(resolved.values.LINEAR_DEFAULT_TEAM_KEY).toBeUndefined();
  });

  it("linear × saas × no row → throws, never falls back to env", async () => {
    mockRead.mockResolvedValue(null);
    await expect(
      resolveActionCredentials("linear", {
        workspaceId: WS,
        deployMode: "saas",
        env: LINEAR_OPERATOR_ENV,
      }),
    ).rejects.toThrow(ActionCredentialError);
  });

  it("linear × self-hosted × no row × env present → returns env (the operator carve-out)", async () => {
    mockRead.mockResolvedValue(null);
    const resolved = await resolveActionCredentials("linear", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: LINEAR_OPERATOR_ENV,
    });
    expect(resolved.resolvedFrom).toBe("env");
    expect(resolved.values.LINEAR_API_KEY).toBe("lin_api_operator-key");
  });

  it("a complete row missing only an OPTIONAL field resolves fine", async () => {
    mockRead.mockResolvedValue(TENANT_ROW); // no JIRA_DEFAULT_PROJECT
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: WS,
      deployMode: "saas",
      env: {},
    });
    expect(resolved.resolvedFrom).toBe("workspace");
  });

  it("a row carrying an undeclared key does not smuggle it into the result", async () => {
    mockRead.mockResolvedValue({
      ...TENANT_ROW,
      DATABASE_URL: "postgres://should-not-leak",
      SLACK_CLIENT_SECRET: "operator-secret",
    });
    const resolved = await resolveActionCredentials("jira", {
      workspaceId: WS,
      deployMode: "saas",
      env: {},
    });
    expect(resolved.values).not.toHaveProperty("DATABASE_URL");
    expect(resolved.values).not.toHaveProperty("SLACK_CLIENT_SECRET");
  });

  it("a store read failure propagates rather than degrading to env", async () => {
    // A decrypt failure that fell through to env would silently re-route a
    // tenant's action at the operator's Jira — worse than a hard failure.
    mockRead.mockRejectedValue(new Error("decrypt failed: unknown key version"));
    await expect(
      resolveActionCredentials("jira", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: OPERATOR_ENV,
      }),
    ).rejects.toThrow("decrypt failed");
  });
});

describe("getActionTargetStatus", () => {
  it("reports presence + source and never a secret value", async () => {
    mockRead.mockResolvedValue(TENANT_ROW);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "saas", env: OPERATOR_ENV });
    expect(status).not.toBeNull();
    expect(status?.configured).toBe(true);
    expect(status?.resolvedFrom).toBe("workspace");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("tenant-token");
    expect(serialized).not.toContain("operator-token");
    expect(serialized).not.toContain("admin@tenant.example");
  });

  it("marks env-only fields `unset` when a workspace row wins", async () => {
    // The operator env has a default project the tenant row lacks. At execution
    // time the resolver would never read it, so the status must not advertise
    // it as configured-from-env.
    mockRead.mockResolvedValue(TENANT_ROW);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    const defaultProject = status?.fields.find((f) => f.envVar === "JIRA_DEFAULT_PROJECT");
    expect(defaultProject?.present).toBe(false);
    expect(defaultProject?.source).toBe("unset");
    expect(status?.fields.every((f) => f.source === "workspace" || f.source === "unset")).toBe(
      true,
    );
  });

  it("an INCOMPLETE workspace row reports unconfigured, not env-configured", async () => {
    // Mirrors the resolver: the incomplete row shadows env, so reporting
    // `configured: true` here would promise an execution that will throw.
    mockRead.mockResolvedValue({ JIRA_BASE_URL: "https://tenant.atlassian.net" });
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    expect(status?.configured).toBe(false);
    expect(status?.resolvedFrom).toBeNull();
  });

  it("on saas the env rung never shows as a source", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "saas", env: OPERATOR_ENV });
    expect(status?.configured).toBe(false);
    expect(status?.fields.every((f) => f.source !== "env")).toBe(true);
  });

  it("on self-hosted with no row, env is reported as the source", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    expect(status?.configured).toBe(true);
    expect(status?.resolvedFrom).toBe("env");
  });

  it("returns null for an unmanaged target", async () => {
    expect(await getActionTargetStatus("not-a-target", { workspaceId: WS, deployMode: "saas", env: {} })).toBeNull();
  });
});

describe("resolveActionDeployMode", () => {
  it("prefers the config's resolved mode over raw env", async () => {
    // A hosted region declares `deployMode: "saas"` in atlas.config.ts and sets
    // NO ATLAS_DEPLOY_MODE env var, so reading raw env would re-derive the mode
    // from the `auto` heuristic instead of reading the operator's declaration.
    mockGetConfig.mockReturnValue({ deployMode: "saas" });
    const { resolveActionDeployMode } = await import("../resolver");
    expect(resolveActionDeployMode()).toBe("saas");

    mockGetConfig.mockReturnValue({ deployMode: "self-hosted" });
    expect(resolveActionDeployMode()).toBe("self-hosted");
  });

  it("falls through to env-based resolution when config is not loaded", async () => {
    // Unreachable on a live request path (the app cannot serve one before
    // boot). It exists so an unloaded config does not silently assume
    // self-hosted and open the env rung.
    mockGetConfig.mockReturnValue(undefined);
    const { resolveActionDeployMode } = await import("../resolver");
    expect(["saas", "self-hosted"]).toContain(resolveActionDeployMode());
  });
});
