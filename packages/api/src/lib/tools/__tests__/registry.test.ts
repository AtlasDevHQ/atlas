import { describe, expect, it, mock } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

// Mock the action tools so buildRegistry({ includeActions: true }) works
// without needing JIRA/email credentials or external services.
const mockJiraTool = tool({
  description: "Mock createJiraTicket tool",
  inputSchema: z.object({ summary: z.string() }),
  execute: async ({ summary }) => summary,
});
const mockEmailTool = tool({
  description: "Mock sendEmailReport tool",
  inputSchema: z.object({ to: z.string() }),
  execute: async ({ to }) => to,
});

void mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket",
    description: "### Create JIRA Ticket\nMock description",
    tool: mockJiraTool,
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "### Send Email Report\nMock description",
    tool: mockEmailTool,
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

const {
  ToolRegistry,
  defaultRegistry,
  nonDashboardRegistry,
  buildRegistry,
  buildHeadlessRegistry,
  HEADLESS_REGISTRY_FALLBACK_WARNING,
  WORKSPACE_DASHBOARD_URL_RESOLVER,
  INTENTIONAL_TOOL_SHADOWS,
  TOOL_SHADOW_REMEDIATIONS,
} = await import("@atlas/api/lib/tools/registry");

function makeTool(name: string) {
  return tool({
    description: `Test tool: ${name}`,
    inputSchema: z.object({ input: z.string() }),
    execute: async ({ input }) => input,
  });
}

describe("ToolRegistry", () => {
  it("register + get — stores and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const entry = { name: "foo", description: "Foo desc", tool: makeTool("foo") };
    registry.register(entry);
    expect(registry.get("foo")).toBe(entry);
  });

  it("get returns undefined for unknown name", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("getAll returns a ToolSet with all registered tools", () => {
    const registry = new ToolRegistry();
    const fooTool = makeTool("foo");
    const barTool = makeTool("bar");
    registry.register({ name: "foo", description: "Foo", tool: fooTool });
    registry.register({ name: "bar", description: "Bar", tool: barTool });

    const all = registry.getAll();
    expect(Object.keys(all).sort()).toEqual(["bar", "foo"]);
    // #4464 — getAll() is the span seam, so entries are the span-wrapped tools
    // rather than the raw registered ones; get() still returns the raw entry.
    expect(all.foo.description).toBe(fooTool.description);
    expect(all.bar.description).toBe(barTool.description);
    expect(registry.get("foo")!.tool).toBe(fooTool);
  });

  // #4464 — the span wrapper is a property of registration, not of each tool
  // remembering to self-instrument. A brand-new tool must be traced with zero
  // per-tool code, so assert the seam rewrote its execute.
  it("getAll() span-wraps every tool, including a newly registered one", () => {
    const registry = new ToolRegistry();
    const rawTool = makeTool("brandNew");
    registry.register({ name: "brandNew", description: "New", tool: rawTool });

    const wrapped = registry.getAll().brandNew;
    expect(wrapped.execute).toBeDefined();
    expect(wrapped.execute).not.toBe(rawTool.execute);
  });

  it("getAll() span-wraps every default-registry tool", () => {
    const raw = new Map(defaultRegistry.entries());
    let checked = 0;
    for (const [name, entry] of Object.entries(defaultRegistry.getAll())) {
      const rawExecute = raw.get(name)?.tool.execute;
      if (!rawExecute) continue; // client-side tool — nothing to wrap
      expect(entry.execute).not.toBe(rawExecute);
      checked++;
    }
    // Guard against the loop passing vacuously if the registry ever yields
    // only execute-less entries.
    expect(checked).toBeGreaterThan(0);
  });

  // #4464 — merge() must consume the RAW entries. If it ever consumed
  // getAll(), each merge hop would wrap an already-wrapped tool and nest a
  // redundant span; the span-lifecycle behaviour itself is covered by
  // tool-spans.test.ts.
  it("merge() carries raw tools, so spans cannot nest per merge hop", () => {
    const base = new ToolRegistry();
    const fooTool = makeTool("foo");
    base.register({ name: "foo", description: "Foo", tool: fooTool });
    const overlay = new ToolRegistry();
    const barTool = makeTool("bar");
    overlay.register({ name: "bar", description: "Bar", tool: barTool });

    const merged = ToolRegistry.merge(base, overlay);
    expect(merged.get("foo")!.tool).toBe(fooTool);
    expect(merged.get("bar")!.tool).toBe(barTool);
  });

  it("describe concatenates descriptions with \\n\\n separator", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "Desc A", tool: makeTool("a") });
    registry.register({ name: "b", description: "Desc B", tool: makeTool("b") });
    expect(registry.describe()).toBe("Desc A\n\nDesc B");
  });

  it("describe returns empty string for empty registry", () => {
    const registry = new ToolRegistry();
    expect(registry.describe()).toBe("");
  });

  it("duplicate registration overwrites the previous entry", () => {
    const registry = new ToolRegistry();
    const tool1 = makeTool("v1");
    const tool2 = makeTool("v2");
    registry.register({ name: "x", description: "First", tool: tool1 });
    registry.register({ name: "x", description: "Second", tool: tool2 });

    expect(registry.get("x")!.description).toBe("Second");
    expect(registry.get("x")!.tool).toBe(tool2);
    expect(Object.keys(registry.getAll())).toEqual(["x"]);
  });

  it("describe() preserves registration order", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "Desc A", tool: makeTool("a") });
    registry.register({ name: "b", description: "Desc B", tool: makeTool("b") });
    registry.register({ name: "c", description: "Desc C", tool: makeTool("c") });
    expect(registry.describe()).toBe("Desc A\n\nDesc B\n\nDesc C");
  });

  it("getAll() returns a fresh object", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "A", tool: makeTool("a") });
    registry.register({ name: "b", description: "B", tool: makeTool("b") });

    const first = registry.getAll();
    delete first.a;

    const second = registry.getAll();
    expect(second.a).toBeDefined();
  });

  it("register() throws on empty name", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({ name: "", description: "X", tool: makeTool("x") })
    ).toThrow();
  });

  it("register() throws on empty description", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({ name: "x", description: "", tool: makeTool("x") })
    ).toThrow();
  });

  it("register() throws on frozen registry", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "A", tool: makeTool("a") });
    registry.freeze();
    expect(() =>
      registry.register({ name: "b", description: "B", tool: makeTool("b") })
    ).toThrow();
  });

  describe("shadowedNames", () => {
    it("returns overlay names that collide with base (the entries merge() would shadow)", () => {
      const base = new ToolRegistry();
      base.register({ name: "querySalesforce", description: "OAuth", tool: makeTool("a") });
      base.register({ name: "executeSQL", description: "SQL", tool: makeTool("b") });
      const overlay = new ToolRegistry();
      overlay.register({ name: "querySalesforce", description: "Static", tool: makeTool("c") });
      overlay.register({ name: "queryElasticsearch", description: "ES", tool: makeTool("d") });

      expect(ToolRegistry.shadowedNames(base, overlay)).toEqual(["querySalesforce"]);
      // merge() must agree: the base entry wins for the shadowed name.
      const merged = ToolRegistry.merge(base, overlay);
      expect(merged.get("querySalesforce")!.description).toBe("OAuth");
      expect(merged.get("queryElasticsearch")!.description).toBe("ES");
    });

    it("returns empty when there is no collision", () => {
      const base = new ToolRegistry();
      base.register({ name: "executeSQL", description: "SQL", tool: makeTool("a") });
      const overlay = new ToolRegistry();
      overlay.register({ name: "querySalesforce", description: "Static", tool: makeTool("b") });
      expect(ToolRegistry.shadowedNames(base, overlay)).toEqual([]);
      expect(ToolRegistry.shadowedNames(base, new ToolRegistry())).toEqual([]);
    });
  });
});

describe("defaultRegistry", () => {
  it("contains all core tools", () => {
    expect(defaultRegistry.get("explore")).toBeDefined();
    expect(defaultRegistry.get("executeSQL")).toBeDefined();
    expect(defaultRegistry.get("createDashboard")).toBeDefined();
    expect(defaultRegistry.get("searchBrain")).toBeDefined();
    // #4915 — the four correction verbs, under the ADR's own spelling.
    expect(defaultRegistry.get("correct_fact")).toBeDefined();
  });

  it("getAll returns exactly the core tools", () => {
    const all = defaultRegistry.getAll();
    expect(Object.keys(all).sort()).toEqual([
      "correct_fact",
      "createDashboard",
      "createLinearIssue",
      "executeSQL",
      "explore",
      "searchBrain",
      "sendEmail",
    ]);
  });

  it("describe produces the expected workflow text", () => {
    const text = defaultRegistry.describe();
    expect(text).toContain("### 2. Explore the Semantic Layer");
    expect(text).toContain("### 3. Write and Execute SQL");
    expect(text).toContain("### Create a Dashboard");
    expect(text).toContain("### Search the Company Brain");
    expect(text).toContain("### Correct a Company-Brain Fact");
  });

  it("is frozen — cannot register additional tools", () => {
    expect(() =>
      defaultRegistry.register({ name: "rogue", description: "X", tool: makeTool("x") })
    ).toThrow("Cannot register tools on a frozen registry");
  });
});

describe("buildRegistry", () => {
  it("throws when ATLAS_PYTHON_ENABLED=true but ATLAS_SANDBOX_URL is not set", async () => {
    const saved = {
      enabled: process.env.ATLAS_PYTHON_ENABLED,
      url: process.env.ATLAS_SANDBOX_URL,
    };
    try {
      process.env.ATLAS_PYTHON_ENABLED = "true";
      delete process.env.ATLAS_SANDBOX_URL;
      await expect(buildRegistry()).rejects.toThrow("ATLAS_SANDBOX_URL");
    } finally {
      if (saved.enabled !== undefined) process.env.ATLAS_PYTHON_ENABLED = saved.enabled;
      else delete process.env.ATLAS_PYTHON_ENABLED;
      if (saved.url !== undefined) process.env.ATLAS_SANDBOX_URL = saved.url;
      else delete process.env.ATLAS_SANDBOX_URL;
    }
  });

  it("includes executePython when ATLAS_PYTHON_ENABLED and ATLAS_SANDBOX_URL are set", async () => {
    const saved = {
      enabled: process.env.ATLAS_PYTHON_ENABLED,
      url: process.env.ATLAS_SANDBOX_URL,
    };
    try {
      process.env.ATLAS_PYTHON_ENABLED = "true";
      process.env.ATLAS_SANDBOX_URL = "http://localhost:8080";
      const { registry } = await buildRegistry();
      const names = Object.keys(registry.getAll()).sort();
      expect(names).toEqual([
        "correct_fact",
        "createDashboard",
        "createLinearIssue",
        "executePython",
        "executeSQL",
        "explore",
        "searchBrain",
        "sendEmail",
      ]);
      expect(registry.describe()).toContain("### 4. Analyze Data with Python");
    } finally {
      if (saved.enabled !== undefined) process.env.ATLAS_PYTHON_ENABLED = saved.enabled;
      else delete process.env.ATLAS_PYTHON_ENABLED;
      if (saved.url !== undefined) process.env.ATLAS_SANDBOX_URL = saved.url;
      else delete process.env.ATLAS_SANDBOX_URL;
    }
  });

  it("returns core tools by default", async () => {
    const { registry } = await buildRegistry();
    const names = Object.keys(registry.getAll()).sort();
    expect(names).toEqual([
      "correct_fact",
      "createDashboard",
      "createLinearIssue",
      "executeSQL",
      "explore",
      "searchBrain",
      "sendEmail",
    ]);
  });

  it("with includeActions includes createJiraTicket and sendEmailReport alongside core tools", async () => {
    const { registry } = await buildRegistry({ includeActions: true });
    const names = Object.keys(registry.getAll()).sort();
    expect(names).toEqual([
      "correct_fact",
      "createDashboard",
      "createJiraTicket",
      "createLinearIssue",
      "executeSQL",
      "explore",
      "searchBrain",
      "sendEmail",
      "sendEmailReport",
    ]);
  });

  it("returned registry is frozen", async () => {
    const { registry } = await buildRegistry();
    expect(() =>
      registry.register({ name: "extra", description: "X", tool: makeTool("x") })
    ).toThrow("Cannot register tools on a frozen registry");
  });

  // #4566 — createDashboard is surface-gated on the dashboard-URL resolver.
  // Three registration states, covering every surface class the seam serves.
  describe("createDashboard surface gating (#4566)", () => {
    it("registers createDashboard when no resolver is given (workspace default)", async () => {
      // Omitting the option means the built-in workspace resolver — the
      // dashboards-owning surface (self-hosted / SaaS web) keeps the tool.
      const { registry } = await buildRegistry();
      expect(registry.get("createDashboard")).toBeDefined();
    });

    it("registers createDashboard when the workspace resolver is passed explicitly", async () => {
      const { registry } = await buildRegistry({
        dashboardUrlResolver: WORKSPACE_DASHBOARD_URL_RESOLVER,
      });
      expect(registry.get("createDashboard")).toBeDefined();
    });

    it("registers createDashboard when a custom host resolver is supplied", async () => {
      const { registry } = await buildRegistry({
        dashboardUrlResolver: (id) => `https://host.example/boards/${id}`,
      });
      expect(registry.get("createDashboard")).toBeDefined();
    });

    it("OMITS createDashboard when the surface owns no dashboards route (resolver: null)", async () => {
      // An embed / SDK / Slack / scheduler surface passes null — the tool is
      // never registered, so the agent can't propose an unreachable draft.
      const { registry } = await buildRegistry({ dashboardUrlResolver: null });
      expect(registry.get("createDashboard")).toBeUndefined();
      const names = Object.keys(registry.getAll());
      // Two tools are dropped on a headless surface — createDashboard (#4566,
      // unreachable handoff) and correct_fact (#4915, a brain WRITE that must
      // not be reachable through the read-safe POST /api/v1/query admission,
      // #4707) — the rest of the core set is intact.
      // (Assert the delta, not an exact list: querySalesforce / executePython
      // are env-gated and would break an exact-equality check on a dev box.)
      expect(names).not.toContain("createDashboard");
      expect(names).not.toContain("correct_fact");
      for (const core of ["explore", "executeSQL", "searchBrain", "sendEmail", "createLinearIssue"]) {
        expect(names).toContain(core);
      }
    });

    it("the workspace resolver produces the workspace dashboards route", () => {
      expect(WORKSPACE_DASHBOARD_URL_RESOLVER("abc-123")).toBe("/dashboards/abc-123");
    });

    // The exported fallback the non-web surfaces (and the buildRegistry error
    // path in agent-query) land on — it must never carry createDashboard, so a
    // build failure can't silently reintroduce the tool.
    it("nonDashboardRegistry omits createDashboard AND correct_fact but keeps the core query tools", () => {
      expect(nonDashboardRegistry.get("createDashboard")).toBeUndefined();
      // #4915/#4707 — this registry is what POST /api/v1/query reaches, and
      // that operation is admitted to READ-SAFE Agent-Auth keys; a brain-
      // mutating tool here would break the read-only-engine guarantee (the
      // agent-auth tripwire test pins the same surface from the other side).
      expect(nonDashboardRegistry.get("correct_fact")).toBeUndefined();
      expect(nonDashboardRegistry.get("executeSQL")).toBeDefined();
      expect(nonDashboardRegistry.get("explore")).toBeDefined();
      expect(nonDashboardRegistry.get("searchBrain")).toBeDefined();
    });
  });

  it("getActions returns action tools with correct metadata", async () => {
    const { registry } = await buildRegistry({ includeActions: true });
    const actions = registry.getActions();
    const actionTypes = actions.map((a) => a.actionType).sort();
    expect(actionTypes).toEqual(["email:send", "jira:create"]);
  });

  it("core-only registry has no actions", async () => {
    const { registry } = await buildRegistry();
    expect(registry.getActions()).toEqual([]);
  });

  it("returns empty warnings when all tools load successfully", async () => {
    const { warnings } = await buildRegistry({ includeActions: true });
    expect(warnings).toEqual([]);
  });
});

describe("tool-shadow policy (#3326)", () => {
  it("action-augmented base catches a plugin tool shadowed by an action tool", async () => {
    const { registry } = await buildRegistry({ includeActions: true });
    const plugin = new ToolRegistry();
    plugin.register({ name: "sendEmailReport", description: "Plugin Resend action", tool: makeTool("p") });
    plugin.register({ name: "queryWidgets", description: "No collision", tool: makeTool("q") });

    // defaultRegistry alone would miss this collision — the action base sees it.
    expect(ToolRegistry.shadowedNames(defaultRegistry, plugin)).toEqual([]);
    expect(ToolRegistry.shadowedNames(registry, plugin)).toEqual(["sendEmailReport"]);
  });

  it("the sendEmailReport overlap is allowlisted as intentional", () => {
    expect(INTENTIONAL_TOOL_SHADOWS.has("sendEmailReport")).toBe(true);
  });

  it("remediation copy exists for the known querySalesforce collision", () => {
    expect(TOOL_SHADOW_REMEDIATIONS.querySalesforce).toContain("SALESFORCE_CLIENT_ID");
    expect(TOOL_SHADOW_REMEDIATIONS.querySalesforce).toContain("salesforce://");
  });
});

// ---------------------------------------------------------------------------
// #4936 — buildHeadlessRegistry
// ---------------------------------------------------------------------------

/** Run `fn` with the given env keys set/cleared, restoring them afterwards. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("buildHeadlessRegistry (#4936)", () => {
  // The named seam two call sites now share — `executeAgentQuery` (serving the
  // SDK / Slack / MCP / scheduler surfaces) and the chat-plugin approval RESUME
  // of a turn started there. It exists so resume rebuilds from the same policy
  // the parked turn ran under instead of re-deriving it, which is how the
  // surface silently widened across the approval boundary before this fix.
  it("omits both write verbs but keeps the core query tools", async () => {
    const names = Object.keys((await buildHeadlessRegistry()).registry.getAll());

    expect(names).not.toContain("createDashboard");
    expect(names).not.toContain("correct_fact");
    // Not vacuous — a headless surface is still a full read surface.
    for (const core of ["explore", "executeSQL", "searchBrain"]) {
      expect(names).toContain(core);
    }
  });

  it("keeps operator action tools opt-in behind ATLAS_ACTIONS_ENABLED", async () => {
    await withEnv({ ATLAS_ACTIONS_ENABLED: undefined }, async () => {
      expect(Object.keys((await buildHeadlessRegistry()).registry.getAll())).not.toContain("sendEmailReport");
    });
    await withEnv({ ATLAS_ACTIONS_ENABLED: "true" }, async () => {
      expect(Object.keys((await buildHeadlessRegistry()).registry.getAll())).toContain("sendEmailReport");
    });
  });

  it("#4941 — a clean build carries no warnings (the degraded signal is not always-on)", async () => {
    // The negative half of the pair below. Without it "warnings is non-empty on
    // failure" is satisfiable by a seam that always warns, which would train
    // every headless agent to open with an apology.
    await withEnv({ ATLAS_ACTIONS_ENABLED: "true" }, async () => {
      expect((await buildHeadlessRegistry()).warnings).toEqual([]);
    });
  });

  it("falls back to nonDashboardRegistry — NOT defaultRegistry — when buildRegistry throws", async () => {
    // The security-relevant branch, and the one the pre-refactor inline version
    // in agent-query.ts never had a test for. `ATLAS_PYTHON_ENABLED` without
    // `ATLAS_SANDBOX_URL` is the fatal misconfiguration buildRegistry throws on
    // (pinned above). Both omissions must hold on the error path too, or a
    // misconfigured box quietly hands every headless surface the write verbs.
    await withEnv(
      { ATLAS_PYTHON_ENABLED: "true", ATLAS_SANDBOX_URL: undefined },
      async () => {
        await expect(buildRegistry()).rejects.toThrow("ATLAS_SANDBOX_URL");

        const { registry } = await buildHeadlessRegistry();
        expect(registry).toBe(nonDashboardRegistry);
        const names = Object.keys(registry.getAll());
        expect(names).not.toContain("createDashboard");
        expect(names).not.toContain("correct_fact");
        expect(names).toContain("executeSQL");
      },
    );
  });

  it("#4941 — the fallback path authors its own warning instead of degrading silently", async () => {
    // The degrade above is deliberate and stays; what was missing is that the
    // user was never told. `nonDashboardRegistry` carries no action tools and no
    // executePython no matter how the env is set, so a turn that lands here has
    // lost capability the operator believes is configured.
    await withEnv(
      { ATLAS_PYTHON_ENABLED: "true", ATLAS_SANDBOX_URL: undefined, ATLAS_ACTIONS_ENABLED: "true" },
      async () => {
        const { registry, warnings } = await buildHeadlessRegistry();
        expect(registry).toBe(nonDashboardRegistry);
        expect(warnings).toEqual([HEADLESS_REGISTRY_FALLBACK_WARNING]);
        // Copy addressed to the MODEL, not to an operator reading logs — it has
        // to be relayable as-is, which is the whole point of #4941.
        expect(HEADLESS_REGISTRY_FALLBACK_WARNING).toContain("temporarily unavailable");
      },
    );
  });

  // The OTHER warning source — `buildRegistry`'s action-tool load failure, seen
  // through this seam — needs the action module itself to fail, which is a
  // file-wide `mock.module` this file cannot take (its top-level actions mock is
  // what makes every `includeActions` test above work). It lives in
  // `lib/__tests__/agent-query-degraded-tools.test.ts` alongside the call-site
  // assertion that the warning reaches the model.
});
