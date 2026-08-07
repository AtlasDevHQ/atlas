/**
 * Workspace capability probe — the gate that replaced chat's process-level
 * `resolveDatasourceUrl()` check (#4826).
 *
 * The bug this locks down is a FALSE REFUSAL: a workspace adopted for the
 * Knowledge Base or the Company Atlas has no analytics datasource by design,
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
// Static imports are hoisted, so these bind the REAL modules regardless of where
// they sit relative to the `mock.module` calls below; spreading each keeps every
// export intact (mock-all-exports) while only the probed seams are replaced.
import * as realInternal from "@atlas/api/lib/db/internal";
import * as realLogger from "@atlas/api/lib/logger";

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

/**
 * Fail-open is only safe if it is OBSERVABLE — the log line is the sole
 * operator-visible artifact of a turn that bypassed the gate. Spying the logger
 * means a future refactor cannot delete it and stay green, which is exactly how
 * a documented fail-open decays into the silent swallow CLAUDE.md forbids.
 */
let warnings: { fields: Record<string, unknown>; msg: string }[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  ...realLogger,
  createLogger: () => ({
    warn: (fields: Record<string, unknown>, msg: string) => {
      warnings.push({ fields, msg });
    },
    debug: () => {},
    info: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
  }),
}));

const {
  probeWorkspaceCapabilities,
  shouldRefuseTurn,
  diagnosticsForBoundWorkspace,
  PROCESS_DATASOURCE_DIAGNOSTICS,
  NO_CAPABILITY_MESSAGE,
} = await import("@atlas/api/lib/workspace-capability");

const EMPTY_ROW: CapabilityRow = {
  has_datasource: false,
  has_knowledge: false,
  has_brain: false,
};

const ORIGINAL_DATASOURCE_URL = process.env.ATLAS_DATASOURCE_URL;

beforeEach(() => {
  capturedQueries = [];
  warnings = [];
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
    // A bypassed gate that leaves no trace is a silent swallow.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields.workspaceId).toBe("ws-db-blip");
  });

  it("returns `unknown` when the query yields no rows", async () => {
    nextRows = [];

    const probe = await probeWorkspaceCapabilities("ws-no-rows");

    expect(probe.kind).toBe("unknown");
    expect(warnings).toHaveLength(1);
  });

  it("returns `unknown` when there is no internal database and no env datasource", async () => {
    internalDbPresent = false;

    const probe = await probeWorkspaceCapabilities("ws-no-internal-db");

    expect(probe.kind).toBe("unknown");
    expect(capturedQueries).toHaveLength(0);
    // This branch is near-unreachable (an org implies managed auth implies
    // DATABASE_URL), which is exactly the state that produces an unexplainable
    // ticket if it ever fires silently.
    expect(warnings).toHaveLength(1);
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

    // One bind param, shared by all three EXISTS predicates.
    expect(params).toEqual(["ws-scoped"]);

    // Every table the probe touches must be workspace-scoped — an unscoped
    // EXISTS would let one tenant's data unlock another tenant's chat.
    // (`brain_facts` is deliberately absent: the composite FK makes an episode
    // mandatory for every fact, so the episodes EXISTS already subsumes it.)
    for (const table of ["workspace_plugins", "brain_episodes"]) {
      const clause = new RegExp(`FROM ${table}\\s+WHERE workspace_id = \\$1`);
      expect(sql).toMatch(clause);
    }
    expect(sql).not.toMatch(/FROM brain_facts/);
  });

  it("excludes archived installs from the datasource and knowledge pillars", async () => {
    await probeWorkspaceCapabilities("ws-archived");

    expect(capturedQueries).toHaveLength(1);
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

  it("drops MISSING_SEMANTIC_LAYER — a bound workspace reads its whitelist from the DB, not disk", async () => {
    const filtered = diagnosticsForBoundWorkspace([
      { code: "MISSING_SEMANTIC_LAYER", message: "No semantic layer found." },
    ]);

    expect(filtered).toEqual([]);
  });

  it("KEEPS everything once a process datasource is configured — it is then THIS workspace's datasource", async () => {
    // The over-filter risk, and the one rule the whole function turns on.
    // `validateEnvironment` runs the connectivity checks ONLY when a datasource
    // URL resolved, and when one has, `probeWorkspaceCapabilities` counts it as
    // this workspace's `datasource` pillar. Filtering then would trade an
    // actionable "your analytics DB is unreachable" 400 for a turn that burns
    // tokens and dies inside the agent loop.
    process.env.ATLAS_DATASOURCE_URL = "postgresql://u:p@localhost:5432/analytics";

    const unreachable = { code: "DB_UNREACHABLE", message: "Cannot connect to the analytics database." } as const;
    const badSchema = { code: "INVALID_SCHEMA", message: "Schema mismatch." } as const;
    const noSemantic = { code: "MISSING_SEMANTIC_LAYER", message: "No semantic layer found." } as const;

    const filtered = diagnosticsForBoundWorkspace([unreachable, badSchema, noSemantic]);

    expect(filtered).toEqual([unreachable, badSchema, noSemantic]);
  });

  it("keeps MISSING_SEMANTIC_LAYER's read-failure variant for a workspace that reads that directory", async () => {
    // Why the rule is a predicate rather than a curated "absence-shaped" list:
    // MISSING_SEMANTIC_LAYER doubles as an EACCES report, so blanket-dropping it
    // would swallow a real filesystem fault for a self-hosted workspace whose
    // datasource — and therefore whose on-disk entities — genuinely exist.
    process.env.ATLAS_DATASOURCE_URL = "postgresql://u:p@localhost:5432/analytics";
    const eacces = {
      code: "MISSING_SEMANTIC_LAYER",
      message: "Could not read semantic layer directory: EACCES. Check file permissions.",
    } as const;

    expect(diagnosticsForBoundWorkspace([eacces])).toEqual([eacces]);
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

  it("scopes the set to the process datasource — it must never grow to swallow a universal blocker", () => {
    // Membership means "describes the process datasource", nothing more; the
    // relevance question is the `resolveDatasourceUrl()` predicate above. Adding
    // a code that blocks EVERY tenancy shape (a provider key, the internal DB)
    // is how the #4826 bug class returns.
    expect([...PROCESS_DATASOURCE_DIAGNOSTICS].sort()).toEqual([
      "DB_UNREACHABLE",
      "INVALID_SCHEMA",
      "MISSING_DATASOURCE_URL",
      "MISSING_SEMANTIC_LAYER",
    ]);
  });
});

describe("shouldRefuseTurn", () => {
  it("refuses only a resolved-and-empty probe", () => {
    expect(
      shouldRefuseTurn({ kind: "resolved", capabilities: new Set() }),
    ).toBe(true);
  });

  it("serves a resolved probe with any capability", () => {
    for (const pillar of ["datasource", "knowledge", "brain"] as const) {
      expect(
        shouldRefuseTurn({ kind: "resolved", capabilities: new Set([pillar]) }),
      ).toBe(false);
    }
  });

  it("serves an undecidable probe — fail open, never fail closed", () => {
    // The inverted form (`kind !== "resolved" || size === 0`) compiles and
    // silently reintroduces the outage-amplifying behaviour. Pin the direction.
    expect(shouldRefuseTurn({ kind: "unknown", reason: "db down" })).toBe(false);
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
    expect(NO_CAPABILITY_MESSAGE).toContain("Company Atlas");
  });
});
