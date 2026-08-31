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

/**
 * The status matrix (#5564). Every one of the five {@link ActionTargetState}
 * values gets the situation that defines it, because the whole point of the
 * discriminant is that the situations are distinguishable — a state that no
 * arrangement of row and env produces is a state the UI branches on for
 * nothing, and two situations that collapse onto one state is the bug this
 * replaced.
 */
describe("getActionTargetStatus — the five-state matrix", () => {
  /** A tenant row missing JIRA_API_TOKEN — complete enough to look configured, not enough to run. */
  const PARTIAL_ROW = {
    JIRA_BASE_URL: "https://tenant.atlassian.net",
    JIRA_EMAIL: "admin@tenant.example",
  };

  it("`workspace` — a complete row resolves; presence + source only, never a value", async () => {
    mockRead.mockResolvedValue(TENANT_ROW);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "saas", env: OPERATOR_ENV });
    expect(status).not.toBeNull();
    expect(status?.state).toBe("workspace");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("tenant-token");
    expect(serialized).not.toContain("operator-token");
    expect(serialized).not.toContain("admin@tenant.example");
  });

  it("`env` — no row, self-hosted, a complete environment", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    expect(status?.state).toBe("env");
  });

  it("`unconfigured` — no row and no rung that answers", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: {} });
    expect(status?.state).toBe("unconfigured");
  });

  it("`partial-row` — an incomplete row with nothing behind it to shadow", async () => {
    mockRead.mockResolvedValue(PARTIAL_ROW);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: {} });
    expect(status?.state).toBe("partial-row");
  });

  it("`partial-row-shadowing-env` — the same row, over an environment that WOULD have worked", async () => {
    // The distinction the old shape could not draw, and the one that matters
    // to an admin: this target was running off the operator's env until the
    // half-finished row landed on top of it.
    mockRead.mockResolvedValue(PARTIAL_ROW);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    expect(status?.state).toBe("partial-row-shadowing-env");
  });

  it("an EMPTY row is still a row — `partial-row`, not `unconfigured`", async () => {
    // `{}` decrypts to a bundle, so a row exists and shadows env exactly like
    // any other partial one. Reporting it as `unconfigured` would send the
    // admin looking for a row that is there.
    mockRead.mockResolvedValue({});
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: {} });
    expect(status?.state).toBe("partial-row");
  });

  it("a row whose only fields are OPTIONAL is partial — optional fields never satisfy required ones", async () => {
    mockRead.mockResolvedValue({ JIRA_DEFAULT_PROJECT: "TEN" });
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    expect(status?.state).toBe("partial-row-shadowing-env");
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

  it("on saas the env rung never shows as a source", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "saas", env: OPERATOR_ENV });
    expect(status?.state).toBe("unconfigured");
    expect(status?.fields.every((f) => f.source !== "env")).toBe(true);
  });

  it("on SaaS only `unconfigured`, `workspace` and `partial-row` are reachable", async () => {
    // The env rung does not exist on SaaS (ADR-0046 — no operator tier), so
    // neither state that names it can be produced there. Asserted over the
    // whole arrangement space rather than by inspection: every combination of
    // {no row, partial row, complete row} × {empty env, complete operator env}.
    const rows = [null, { JIRA_BASE_URL: "https://tenant.atlassian.net" }, TENANT_ROW];
    const envs: NodeJS.ProcessEnv[] = [{}, OPERATOR_ENV];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const env of envs) {
        mockRead.mockResolvedValue(row);
        const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "saas", env });
        if (status) seen.add(status.state);
      }
    }
    expect([...seen].toSorted()).toEqual(["partial-row", "unconfigured", "workspace"]);
  });

  it("`stored` tracks the ROW, so a shadowed field is not reported missing", async () => {
    // The regression this exists for: under the winning-rung view every field
    // of a partial row reads `unset`, which told the Admin form the admin had
    // to re-type credentials that were already stored and unreadable.
    mockRead.mockResolvedValue(PARTIAL_ROW);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    const byVar = new Map(status?.fields.map((f) => [f.envVar, f]));
    expect(byVar.get("JIRA_BASE_URL")?.stored).toBe(true);
    expect(byVar.get("JIRA_BASE_URL")?.present).toBe(false);
    expect(byVar.get("JIRA_BASE_URL")?.source).toBe("unset");
    expect(byVar.get("JIRA_API_TOKEN")?.stored).toBe(false);
    // And it never reports a value the ENV holds as stored — the env is not
    // the row, and conflating them would offer removal of something DELETE
    // cannot touch.
    expect(byVar.get("JIRA_DEFAULT_PROJECT")?.stored).toBe(false);
  });

  it("`stored` is false for every field when no row exists, whatever the env says", async () => {
    mockRead.mockResolvedValue(null);
    const status = await getActionTargetStatus("jira", { workspaceId: WS, deployMode: "self-hosted", env: OPERATOR_ENV });
    expect(status?.state).toBe("env");
    expect(status?.fields.every((f) => !f.stored)).toBe(true);
  });

  it("returns null for an unmanaged target", async () => {
    expect(await getActionTargetStatus("not-a-target", { workspaceId: WS, deployMode: "saas", env: {} })).toBeNull();
  });

  it("no credential value is derivable from `state`, over EVERY registered target", async () => {
    // A property over the registry rather than a per-target list, so target #5
    // is covered the day it is added. `state` is one of five fixed strings; the
    // assertion is that no arrangement of a tenant row and an operator env —
    // complete, partial, or absent — can put either one's bytes into it.
    const { ACTION_TARGETS: targets } = await import("../targets");
    for (const spec of targets) {
      const fullRow: Record<string, string> = {};
      const fullEnv: NodeJS.ProcessEnv = {};
      for (const field of spec.fields) {
        fullRow[field.envVar] = `row-secret-${field.envVar}`;
        fullEnv[field.envVar] = `env-secret-${field.envVar}`;
      }
      const partialRow = { ...fullRow };
      const firstRequired = spec.fields.find((f) => f.required);
      if (firstRequired) delete partialRow[firstRequired.envVar];

      for (const row of [null, partialRow, fullRow]) {
        for (const env of [{}, fullEnv]) {
          for (const deployMode of ["saas", "self-hosted"] as const) {
            mockRead.mockResolvedValue(row);
            const status = await getActionTargetStatus(spec.target, {
              workspaceId: WS,
              deployMode,
              env,
            });
            expect(status).not.toBeNull();
            expect(status?.state).not.toContain("secret-");
            // The whole status, not just `state` — `stored` is presence too,
            // and the masked read-back contract covers every field of it.
            expect(JSON.stringify(status)).not.toContain("row-secret-");
            expect(JSON.stringify(status)).not.toContain("env-secret-");
          }
        }
      }
    }
  });
});

/**
 * The one path a partial row is still reachable by, now that the write path
 * rejects incomplete saves: a target's field spec GAINS a required field after
 * rows are stored, and every stored row for that target turns partial at once.
 * `ACTION_TARGETS` is live code that gained three entries in a week, so this is
 * the regression test the partial states are actually for (#5564).
 */
describe("spec evolution turns a stored row partial", () => {
  it("the completeness predicate is asked of TODAY's spec, so yesterday's complete row goes partial", async () => {
    // Stated at the predicate, where spec evolution is directly expressible: a
    // bundle written when the spec had two required fields, re-asked under a
    // spec that now has three. `getActionTargetStatus` reads its spec from the
    // live registry, so this is the one place the evolved spec can be supplied
    // rather than imitated.
    const { missingRequiredFor } = await import("../resolver");
    const yesterdaysRow = { ACME_URL: "https://acme.example", ACME_KEY: "k" };
    const todaysSpec = {
      target: "acme",
      label: "Acme",
      fields: [
        { envVar: "ACME_URL", label: "URL", hint: "", secret: false, required: true },
        { envVar: "ACME_KEY", label: "Key", hint: "", secret: true, required: true },
        { envVar: "ACME_REGION", label: "Region", hint: "", secret: false, required: true },
      ],
    };
    expect(missingRequiredFor(todaysSpec, (k) => yesterdaysRow[k as keyof typeof yesterdaysRow])).toEqual([
      "ACME_REGION",
    ]);
  });

  it("such a row reports partial, and still shows the fields it holds as stored", async () => {
    // The stored state spec evolution produces is exactly this: a row missing a
    // field the CURRENT spec requires. Whether it got there by the spec growing
    // or by a field being cleared, the status must read the same — and it is
    // the spec-growth path that is still reachable, because the write path now
    // refuses to create the other.
    const evolvedRow: Record<string, string> = { ...TENANT_ROW };
    delete evolvedRow.JIRA_API_TOKEN;
    mockRead.mockResolvedValue(evolvedRow);

    const shadowing = await getActionTargetStatus("jira", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: OPERATOR_ENV,
    });
    expect(shadowing?.state).toBe("partial-row-shadowing-env");

    const alone = await getActionTargetStatus("jira", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: {},
    });
    expect(alone?.state).toBe("partial-row");

    // And the fields the row still holds stay visible as stored, so the admin
    // is asked for the ONE new field rather than all of them.
    const byVar = new Map(alone?.fields.map((f) => [f.envVar, f]));
    expect(byVar.get("JIRA_BASE_URL")?.stored).toBe(true);
    expect(byVar.get("JIRA_EMAIL")?.stored).toBe(true);
    expect(byVar.get("JIRA_API_TOKEN")?.stored).toBe(false);
  });
});

/**
 * The GitHub App target (#5555). Jira's matrix above already covers the ladder
 * generically, so this block is deliberately narrow: it pins the all-or-nothing
 * rule ON THIS TARGET, because GitHub is the entry whose credential set is not
 * the flat token bundle the rule was written against. A three-field App
 * credential has more ways to be half-filled, and each one of them is the same
 * leak: dispatching a tenant's issue on the deployment's App.
 */
describe("all-or-nothing on the GitHub App target (#5555)", () => {
  /** A complete tenant-owned GitHub App row. */
  const TENANT_GH = {
    GITHUB_ACTION_APP_ID: "111111",
    GITHUB_ACTION_INSTALLATION_ID: "222222",
    GITHUB_ACTION_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ntenant\n-----END PRIVATE KEY-----",
  };

  /** A complete operator-owned env, distinct from the tenant's in every field. */
  const OPERATOR_GH_ENV: NodeJS.ProcessEnv = {
    GITHUB_ACTION_APP_ID: "999999",
    GITHUB_ACTION_INSTALLATION_ID: "888888",
    GITHUB_ACTION_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\noperator\n-----END PRIVATE KEY-----",
    GITHUB_ACTION_DEFAULT_REPO: "atlas/ops",
  };

  it("a complete workspace row wins outright and takes nothing from env", async () => {
    mockRead.mockResolvedValue(TENANT_GH);
    const resolved = await resolveActionCredentials("github", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: OPERATOR_GH_ENV,
    });
    expect(resolved.resolvedFrom).toBe("workspace");
    expect(resolved.values.GITHUB_ACTION_APP_ID).toBe("111111");
    expect(resolved.values.GITHUB_ACTION_PRIVATE_KEY).toContain("tenant");
    // The operator's optional default repo must NOT ride along on the row.
    expect(resolved.values.GITHUB_ACTION_DEFAULT_REPO).toBeUndefined();
  });

  // Each of the three required fields, missing one at a time. Per-field
  // precedence would fill the gap from the operator's env; all-or-nothing
  // throws. The private-key row is the sharpest: it is the field that decides
  // WHICH GitHub App signs, so borrowing it means filing as Atlas.
  for (const missing of [
    "GITHUB_ACTION_APP_ID",
    "GITHUB_ACTION_INSTALLATION_ID",
    "GITHUB_ACTION_PRIVATE_KEY",
  ] as const) {
    it(`a row missing ${missing} throws rather than borrowing it from env`, async () => {
      const partial: Record<string, string> = { ...TENANT_GH };
      delete partial[missing];
      mockRead.mockResolvedValue(partial);

      try {
        await resolveActionCredentials("github", {
          workspaceId: WS,
          deployMode: "self-hosted",
          env: OPERATOR_GH_ENV,
        });
        expect.unreachable("a partial workspace row must not resolve");
      } catch (err) {
        expect(err).toBeInstanceOf(ActionCredentialError);
        expect((err as InstanceType<typeof ActionCredentialError>).reason).toBe(
          "partial-workspace-row",
        );
        // Names the gap, never a value from either rung.
        expect((err as Error).message).toContain(missing);
        expect((err as Error).message).not.toContain("999999");
        expect((err as Error).message).not.toContain("operator");
      }
    });
  }

  it("an optional-only gap still resolves — the default repo is not required", async () => {
    mockRead.mockResolvedValue(TENANT_GH);
    const resolved = await resolveActionCredentials("github", {
      workspaceId: WS,
      deployMode: "saas",
      env: {},
    });
    expect(resolved.resolvedFrom).toBe("workspace");
  });

  it("saas × no row → throws even with a complete operator env", async () => {
    mockRead.mockResolvedValue(null);
    await expect(
      resolveActionCredentials("github", {
        workspaceId: WS,
        deployMode: "saas",
        env: OPERATOR_GH_ENV,
      }),
    ).rejects.toThrow(ActionCredentialError);
  });

  it("self-hosted × no row × complete env → resolves from env", async () => {
    mockRead.mockResolvedValue(null);
    const resolved = await resolveActionCredentials("github", {
      workspaceId: WS,
      deployMode: "self-hosted",
      env: OPERATOR_GH_ENV,
    });
    expect(resolved.resolvedFrom).toBe("env");
    expect(resolved.values.GITHUB_ACTION_DEFAULT_REPO).toBe("atlas/ops");
  });

  it("self-hosted × no row × env holding only the OPERATOR-TIER GitHub App vars → unconfigured", async () => {
    // `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` belong to Atlas's own App,
    // which backs the github-data datasource. This target deliberately does
    // not read them (see GITHUB_TARGET), so a box that configured only that
    // App must not find the action target silently armed.
    mockRead.mockResolvedValue(null);
    await expect(
      resolveActionCredentials("github", {
        workspaceId: WS,
        deployMode: "self-hosted",
        env: {
          GITHUB_APP_ID: "999999",
          GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\noperator\n-----END PRIVATE KEY-----",
        },
      }),
    ).rejects.toThrow(ActionCredentialError);
  });

  it("status reports the PEM field as secret + multiline and never its value", async () => {
    mockRead.mockResolvedValue(TENANT_GH);
    const status = await getActionTargetStatus("github", {
      workspaceId: WS,
      deployMode: "saas",
      env: {},
    });
    const key = status?.fields.find((f) => f.envVar === "GITHUB_ACTION_PRIVATE_KEY");
    expect(key?.secret).toBe(true);
    expect(key?.multiline).toBe(true);
    expect(key?.present).toBe(true);
    // The status shape carries presence + source only — no value channel at all.
    expect(JSON.stringify(status)).not.toContain("tenant");
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

// ---------------------------------------------------------------------------
// resolveCredentialsFor — the typed seam every action module crosses (#3766)
// ---------------------------------------------------------------------------

// Dynamic imports, matching the file's top half: static `import` statements
// hoist above the `mock.module` calls, so they would evaluate `../resolver`'s
// graph unmocked — the exact ordering the harness above exists to control.
const { resolveCredentialsFor } = await import("../resolver");
const { ACTION_TARGETS, JIRA_TARGET } = await import("../targets");

describe("resolveCredentialsFor — property over every registered target", () => {
  // These two replace the four per-target `toXCredentials` suites: the
  // narrowing they tested is now derived from the spec, so the property to
  // pin is the resolver's guarantee itself, for EVERY target — including
  // target #6 the day it is added.
  it("every target: a complete self-hosted env resolves with every declared field", async () => {
    for (const spec of ACTION_TARGETS) {
      const env: NodeJS.ProcessEnv = {};
      for (const field of spec.fields) env[field.envVar] = `value-for-${field.envVar}`;
      const credentials = await resolveCredentialsFor(spec, { workspaceId: null }, {
        deployMode: "self-hosted",
        env,
      });
      for (const field of spec.fields) {
        expect((credentials as Record<string, string>)[field.envVar]).toBe(
          `value-for-${field.envVar}`,
        );
      }
    }
  });

  it("every target: an env missing ONE required field refuses to resolve, naming keys and never values", async () => {
    for (const spec of ACTION_TARGETS) {
      const required = spec.fields.filter((f) => f.required);
      for (const omitted of required) {
        const env: NodeJS.ProcessEnv = {};
        for (const field of spec.fields) {
          if (field.envVar !== omitted.envVar) env[field.envVar] = `value-for-${field.envVar}`;
        }
        try {
          await resolveCredentialsFor(spec, { workspaceId: null }, {
            deployMode: "self-hosted",
            env,
          });
          throw new Error(`resolveCredentialsFor(${spec.target}) resolved without ${omitted.envVar}`);
        } catch (err) {
          expect(err).toBeInstanceOf(ActionCredentialError);
          const message = (err as Error).message;
          // The unconfigured message names required env vars, never values.
          expect(message).not.toContain("value-for-");
        }
      }
    }
  });

  it("a PARTIAL workspace row still refuses through this seam (the all-or-nothing rule holds)", async () => {
    mockRead.mockResolvedValue({ JIRA_BASE_URL: "https://tenant.atlassian.net" });
    await expect(
      resolveCredentialsFor(JIRA_TARGET, { workspaceId: WS }, {
        deployMode: "self-hosted",
        env: OPERATOR_ENV,
      }),
    ).rejects.toThrow(/incomplete/);
  });

  it("the resolved record is the derived shape — required keys typed present", async () => {
    mockRead.mockResolvedValue(TENANT_ROW);
    const credentials = await resolveCredentialsFor(JIRA_TARGET, { workspaceId: WS }, {
      deployMode: "saas",
    });
    // Compile-time: these reads are non-optional string properties.
    const baseUrl: string = credentials.JIRA_BASE_URL;
    const optionalProject: string | undefined = credentials.JIRA_DEFAULT_PROJECT;
    expect(baseUrl).toBe("https://tenant.atlassian.net");
    expect(optionalProject).toBeUndefined();
  });
});
