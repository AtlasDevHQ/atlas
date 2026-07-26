/**
 * Workspace capability probe — the gate that replaced chat's process-level
 * `resolveDatasourceUrl()` check (#4826).
 *
 * The bug this locks down is a FALSE REFUSAL: a workspace adopted for the
 * Knowledge Base or the Company Brain has no analytics datasource by design,
 * and the old env-level gate read that as "unusable" and 400'd every chat turn
 * before the agent loop started. So the tests that matter are the ones asserting
 * the probe reports a capability for a workspace that has *only* knowledge, or
 * *only* brain content — the two deployment shapes with zero coverage before.
 *
 * The second failure mode is the inverse: a probe that cannot reach the internal
 * DB must never be mistaken for "this workspace is empty", or a transient blip
 * would take chat down for correctly-configured tenants. That is why the probe
 * returns a discriminated `unknown` rather than an empty set, and why several
 * tests below assert `kind === "unknown"` instead of `capabilities.size === 0`.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as realInternal from "@atlas/api/lib/db/internal";

interface CapabilityRow extends Record<string, unknown> {
  has_datasource: boolean;
  has_knowledge: boolean;
  has_brain: boolean;
}

/** Queries the probe issued, so tests can pin org scoping. */
let capturedQueries: { sql: string; params: unknown[] }[] = [];
/** What the next `internalQuery` resolves to, or a thrower. */
let nextRows: CapabilityRow[] | (() => never) = [];
let internalDbPresent = true;

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => internalDbPresent,
  internalQuery: async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params: params ?? [] });
    if (typeof nextRows === "function") nextRows();
    return nextRows;
  },
}));

void mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

const {
  probeWorkspaceCapabilities,
  diagnosticsForBoundWorkspace,
  PROCESS_DATASOURCE_DIAGNOSTICS,
  NO_CAPABILITY_MESSAGE,
} = await import("@atlas/api/lib/workspace-capability");

/** Row shape for a workspace with none of the three pillars. */
const EMPTY_ROW: CapabilityRow = {
  has_datasource: false,
  has_knowledge: false,
  has_brain: false,
};

const ORIGINAL_DATASOURCE_URL = process.env.ATLAS_DATASOURCE_URL;

beforeEach(() => {
  capturedQueries = [];
  nextRows = [EMPTY_ROW];
  internalDbPresent = true;
  delete process.env.ATLAS_DATASOURCE_URL;
});

afterEach(() => {
  if (ORIGINAL_DATASOURCE_URL === undefined) delete process.env.ATLAS_DATASOURCE_URL;
  else process.env.ATLAS_DATASOURCE_URL = ORIGINAL_DATASOURCE_URL;
});

describe("probeWorkspaceCapabilities — the deployment shapes that were dead on arrival", () => {
  it("reports `knowledge` for a workspace with only a Knowledge Base collection", async () => {
    nextRows = [{ has_datasource: false, has_knowledge: true, has_brain: false }];

    const probe = await probeWorkspaceCapabilities("ws-knowledge-only");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect([...probe.capabilities]).toEqual(["knowledge"]);
    // The whole point: a knowledge-only workspace is servable, so the gate
    // must not refuse it just because no analytics datasource exists.
    expect(probe.capabilities.size).toBeGreaterThan(0);
  });

  it("reports `brain` for a workspace with only brain content — the shape that blocked the M1 soak", async () => {
    nextRows = [{ has_datasource: false, has_knowledge: false, has_brain: true }];

    const probe = await probeWorkspaceCapabilities("ws-brain-only");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect([...probe.capabilities]).toEqual(["brain"]);
  });

  it("reports `datasource` for a registry-connected workspace with no ATLAS_DATASOURCE_URL", async () => {
    // The SaaS shape: the tenant's datasource lives in `workspace_plugins`, and
    // the process sets no analytics env var at all.
    nextRows = [{ has_datasource: true, has_knowledge: false, has_brain: false }];

    const probe = await probeWorkspaceCapabilities("ws-saas");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect([...probe.capabilities]).toEqual(["datasource"]);
    expect(process.env.ATLAS_DATASOURCE_URL).toBeUndefined();
  });

  it("reports every pillar a workspace actually has", async () => {
    nextRows = [{ has_datasource: true, has_knowledge: true, has_brain: true }];

    const probe = await probeWorkspaceCapabilities("ws-full");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect([...probe.capabilities].sort()).toEqual(["brain", "datasource", "knowledge"]);
  });
});

describe("probeWorkspaceCapabilities — the genuinely-empty workspace", () => {
  it("resolves to an empty set so the caller can refuse the turn", async () => {
    nextRows = [EMPTY_ROW];

    const probe = await probeWorkspaceCapabilities("ws-empty");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect(probe.capabilities.size).toBe(0);
  });

  it("counts a process-level ATLAS_DATASOURCE_URL even when the tenant tables are empty", async () => {
    // Self-hosted single-tenant with a bound org: the env datasource is real
    // and serves this workspace, so an empty `workspace_plugins` is not empty.
    process.env.ATLAS_DATASOURCE_URL = "postgresql://u:p@localhost:5432/analytics";
    nextRows = [EMPTY_ROW];

    const probe = await probeWorkspaceCapabilities("ws-self-hosted");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect([...probe.capabilities]).toEqual(["datasource"]);
  });
});

describe("probeWorkspaceCapabilities — undecidable probes fail open", () => {
  it("returns `unknown`, not an empty set, when the internal query throws", async () => {
    nextRows = () => {
      throw new Error("connection terminated unexpectedly");
    };

    const probe = await probeWorkspaceCapabilities("ws-db-blip");

    // The distinction is the whole safety property: `resolved` + empty means
    // "refuse the turn", and a DB blip must never produce that.
    expect(probe.kind).toBe("unknown");
    if (probe.kind !== "unknown") throw new Error("unreachable");
    expect(probe.reason).toContain("connection terminated");
  });

  it("returns `unknown` when the query yields no rows", async () => {
    nextRows = [];

    const probe = await probeWorkspaceCapabilities("ws-no-rows");

    expect(probe.kind).toBe("unknown");
  });

  it("returns `unknown` when there is no internal database and no env datasource", async () => {
    internalDbPresent = false;

    const probe = await probeWorkspaceCapabilities("ws-no-internal-db");

    expect(probe.kind).toBe("unknown");
    expect(capturedQueries).toHaveLength(0);
  });

  it("resolves without querying when there is no internal database but an env datasource exists", async () => {
    internalDbPresent = false;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://u:p@localhost:5432/analytics";

    const probe = await probeWorkspaceCapabilities("ws-no-internal-db-env-ds");

    expect(probe.kind).toBe("resolved");
    if (probe.kind !== "resolved") throw new Error("unreachable");
    expect([...probe.capabilities]).toEqual(["datasource"]);
    expect(capturedQueries).toHaveLength(0);
  });
});

describe("probeWorkspaceCapabilities — org scoping", () => {
  it("scopes every pillar to the requested workspace and nothing else", async () => {
    await probeWorkspaceCapabilities("ws-scoped");

    expect(capturedQueries).toHaveLength(1);
    const { sql, params } = capturedQueries[0]!;

    // One bind param, used for all four EXISTS predicates.
    expect(params).toEqual(["ws-scoped"]);

    // Every table the probe touches must be workspace-scoped — an unscoped
    // EXISTS would let one tenant's data unlock another tenant's chat.
    for (const table of ["workspace_plugins", "brain_facts", "brain_episodes"]) {
      const clause = new RegExp(`FROM ${table}\\s+WHERE workspace_id = \\$1`);
      expect(sql).toMatch(clause);
    }
  });

  it("excludes archived installs from the datasource and knowledge pillars", async () => {
    await probeWorkspaceCapabilities("ws-archived");
    const { sql } = capturedQueries[0]!;

    expect(sql).toContain("pillar = 'datasource' AND status <> 'archived'");
    expect(sql).toContain("pillar = 'knowledge' AND status <> 'archived'");
  });
});

describe("diagnosticsForBoundWorkspace", () => {
  it("drops MISSING_DATASOURCE_URL — the diagnostic that broke knowledge-first deployments", async () => {
    // Reproduces the exact staging shape: DATABASE_URL set, ATLAS_DATASOURCE_URL
    // unset, so `checkDatasourceUrlPresence` raises MISSING_DATASOURCE_URL and
    // chat 400'd with `configuration_error` before the agent ever ran.
    const filtered = diagnosticsForBoundWorkspace([
      { code: "MISSING_DATASOURCE_URL", message: "DATABASE_URL is set but ATLAS_DATASOURCE_URL is not." },
    ]);

    expect(filtered).toEqual([]);
  });

  it("drops the other process-datasource diagnostics a bound workspace does not depend on", async () => {
    const filtered = diagnosticsForBoundWorkspace([
      { code: "MISSING_SEMANTIC_LAYER", message: "No semantic layer found." },
      { code: "DB_UNREACHABLE", message: "Datasource unreachable." },
      { code: "INVALID_SCHEMA", message: "Schema mismatch." },
    ]);

    expect(filtered).toEqual([]);
  });

  it("KEEPS diagnostics that block chat for every tenancy shape", async () => {
    // The regression risk of this filter is over-filtering: a SaaS deploy with
    // no provider key must still get a clear `configuration_error`, not an
    // agent that fails mysteriously at model init.
    const apiKey = { code: "MISSING_API_KEY", message: "ANTHROPIC_API_KEY is not set." } as const;
    const internalDb = { code: "INTERNAL_DB_UNREACHABLE", message: "Internal DB unreachable." } as const;
    const authPrereq = { code: "MISSING_AUTH_PREREQ", message: "BETTER_AUTH_SECRET is not set." } as const;

    const filtered = diagnosticsForBoundWorkspace([apiKey, internalDb, authPrereq]);

    expect(filtered).toEqual([apiKey, internalDb, authPrereq]);
  });

  it("preserves the kept diagnostics when mixed with filtered ones", async () => {
    const apiKey = { code: "MISSING_API_KEY", message: "ANTHROPIC_API_KEY is not set." } as const;

    const filtered = diagnosticsForBoundWorkspace([
      { code: "MISSING_DATASOURCE_URL", message: "…" },
      apiKey,
      { code: "MISSING_SEMANTIC_LAYER", message: "…" },
    ]);

    expect(filtered).toEqual([apiKey]);
  });

  it("does not filter any diagnostic outside the declared process-datasource set", () => {
    // Guards against the set silently growing to swallow a real blocker.
    expect([...PROCESS_DATASOURCE_DIAGNOSTICS].sort()).toEqual([
      "DB_UNREACHABLE",
      "INVALID_SCHEMA",
      "MISSING_DATASOURCE_URL",
      "MISSING_SEMANTIC_LAYER",
    ]);
  });
});

describe("NO_CAPABILITY_MESSAGE", () => {
  it("no longer tells a knowledge/brain adopter to configure a datasource env var", () => {
    // Acceptance criterion: the refusal must stop assuming the missing thing is
    // an analytics datasource.
    expect(NO_CAPABILITY_MESSAGE).not.toContain("ATLAS_DATASOURCE_URL");
  });

  it("names all three pillars so the refusal is actionable", () => {
    expect(NO_CAPABILITY_MESSAGE).toContain("data source");
    expect(NO_CAPABILITY_MESSAGE).toContain("Knowledge Base");
    expect(NO_CAPABILITY_MESSAGE).toContain("Company Brain");
  });
});
