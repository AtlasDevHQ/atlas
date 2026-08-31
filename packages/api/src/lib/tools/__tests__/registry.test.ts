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
const mockGitHubTool = tool({
  description: "Mock createGitHubIssue tool",
  inputSchema: z.object({ title: z.string() }),
  execute: async ({ title }) => title,
});
const mockEmailTool = tool({
  description: "Mock sendEmailReport tool",
  inputSchema: z.object({ to: z.string() }),
  execute: async ({ to }) => to,
});
const mockSalesforceTool = tool({
  description: "Mock createSalesforceRecord tool",
  inputSchema: z.object({ object: z.string() }),
  execute: async ({ object }) => object,
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
  createGitHubIssue: {
    name: "createGitHubIssue",
    description: "### Create GitHub Issue\nMock description",
    tool: mockGitHubTool,
    actionType: "github:create_issue",
    reversible: true,
    defaultApproval: "manual",
    // Empty, like the real one — GitHub credentials are per-workspace (#5555).
    requiredCredentials: [],
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
  // #5556 — per-workspace credentials, so `requiredCredentials` is empty
  // (the real action declares it empty for the same reason).
  createSalesforceRecord: {
    name: "createSalesforceRecord",
    description: "### Create Salesforce Record\nMock description",
    tool: mockSalesforceTool,
    actionType: "salesforce:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: [],
  },
}));

const {
  ToolRegistry,
  defaultRegistry,
  confirmCapableRegistry,
  nonDashboardRegistry,
  buildRegistry,
  buildHeadlessRegistry,
  registryBuildFailedWarning,
  ACTION_TOOLS_UNAVAILABLE_WARNING,
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
    expect(defaultRegistry.get("searchAtlas")).toBeDefined();
    // #5496 — `correct_fact` is NO LONGER here. It stages onto a confirm card,
    // so it registers only where that card is rendered, and `defaultRegistry`
    // is what the embeddable widget gets: same `/api/v1/chat` route, same
    // dashboards resolver, no card. The first-party web app opts up to
    // `confirmCapableRegistry`.
    expect(defaultRegistry.get("correct_fact")).toBeUndefined();
    expect(confirmCapableRegistry.get("correct_fact")).toBeDefined();
    // #5482 — `proposeFact` joins the SAME gate, so it splits the same way. The
    // two verbs are asserted separately rather than looped over: a change that
    // moved one of them alone should name which one it moved.
    expect(defaultRegistry.get("proposeFact")).toBeUndefined();
    expect(confirmCapableRegistry.get("proposeFact")).toBeDefined();
  });

  it("confirmCapableRegistry is defaultRegistry plus exactly the two confirm-staged brain writes", () => {
    // The two singletons must differ by exactly the confirm-gated writes —
    // `correct_fact` (#5496) and `proposeFact` (#5482) — and by nothing else. An
    // EXACT set, not a membership check, so a third verb joining the gate has to
    // be named here before it can ship. A drift means a surface silently gained
    // or lost something other than a confirm-before-write verb.
    const base = Object.keys(defaultRegistry.getAll()).sort();
    const confirmable = Object.keys(confirmCapableRegistry.getAll()).sort();
    expect(confirmable).toEqual([...base, "correct_fact", "proposeFact"].sort());
  });

  it("getAll returns exactly the core tools", () => {
    const all = defaultRegistry.getAll();
    expect(Object.keys(all).sort()).toEqual([
      "createDashboard",
      "createLinearIssue",
      "executeSQL",
      "explore",
      "searchAtlas",
      "sendEmail",
    ]);
  });

  it("describe produces the expected workflow text", () => {
    const text = defaultRegistry.describe();
    expect(text).toContain("### 2. Explore the Semantic Layer");
    expect(text).toContain("### 3. Write and Execute SQL");
    expect(text).toContain("### Create a Dashboard");
    expect(text).toContain("### Search the Company Atlas");
    // #5496 — the correction guidance travels with the tool, so it is absent
    // here and present on the confirm-capable surface. A prompt that described
    // a verb the surface does not carry is the #4941 wrong-explanation bug.
    expect(text).not.toContain("### Correct a Company-Brain Fact");
    expect(confirmCapableRegistry.describe()).toContain("### Correct a Company-Brain Fact");
    // #5482 — same split, same reason. The proposal guidance names correct_fact
    // as the verb for a wrong EXISTING fact, so advertising it on a surface that
    // carries neither would describe two absent verbs at once.
    expect(text).not.toContain("### Propose a Company-Brain Fact");
    expect(confirmCapableRegistry.describe()).toContain("### Propose a Company-Brain Fact");
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
      // #5496 — `rendersConfirmations` defaults to false, so a builder that
      // does not CLAIM the capability gets no `correct_fact`. Fail-closed.
      expect(names).toEqual([
        "createDashboard",
        "createLinearIssue",
        "executePython",
        "executeSQL",
        "explore",
        "searchAtlas",
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
      "createDashboard",
      "createLinearIssue",
      "executeSQL",
      "explore",
      "searchAtlas",
      "sendEmail",
    ]);
  });

  it("registers correct_fact only when the surface claims it can render confirmations", async () => {
    // #5496 — the signal split. `dashboardUrlResolver` alone no longer decides
    // this: the widget and the web app share it, and only one has a card.
    const { registry: withCard } = await buildRegistry({ rendersConfirmations: true });
    expect(Object.keys(withCard.getAll())).toContain("correct_fact");
    expect(Object.keys(withCard.getAll())).toContain("proposeFact");

    const { registry: withoutCard } = await buildRegistry({ rendersConfirmations: false });
    expect(Object.keys(withoutCard.getAll())).not.toContain("correct_fact");
    expect(Object.keys(withoutCard.getAll())).not.toContain("proposeFact");

    // …and claiming the card without owning a dashboards route still omits it:
    // a headless surface has nowhere to render one, whatever it claims.
    const { registry: headless } = await buildRegistry({
      dashboardUrlResolver: null,
      rendersConfirmations: true,
    });
    expect(Object.keys(headless.getAll())).not.toContain("correct_fact");
    expect(Object.keys(headless.getAll())).not.toContain("proposeFact");
  });

  it("with includeActions includes every action tool alongside core tools", async () => {
    const { registry } = await buildRegistry({ includeActions: true });
    const names = Object.keys(registry.getAll()).sort();
    expect(names).toEqual([
      "createDashboard",
      "createGitHubIssue",
      "createJiraTicket",
      "createLinearIssue",
      "createSalesforceRecord",
      "executeSQL",
      "explore",
      "searchAtlas",
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
      expect(names).not.toContain("proposeFact");
      for (const core of ["explore", "executeSQL", "searchAtlas", "sendEmail", "createLinearIssue"]) {
        expect(names).toContain(core);
      }
    });

    it("the workspace resolver produces the workspace dashboards route", () => {
      expect(WORKSPACE_DASHBOARD_URL_RESOLVER("abc-123")).toBe("/dashboards/abc-123");
    });

    // The exported fallback the non-web surfaces (and the buildRegistry error
    // path in agent-query) land on — it must never carry createDashboard, so a
    // build failure can't silently reintroduce the tool.
    it("nonDashboardRegistry omits createDashboard AND both brain writes but keeps the core query tools", () => {
      expect(nonDashboardRegistry.get("createDashboard")).toBeUndefined();
      // #4915/#4707 — this registry is what POST /api/v1/query reaches, and
      // that operation is admitted to READ-SAFE Agent-Auth keys; a brain-
      // mutating tool here would break the read-only-engine guarantee (the
      // agent-auth tripwire test pins the same surface from the other side).
      expect(nonDashboardRegistry.get("correct_fact")).toBeUndefined();
      // #5482 — the same admission, the same reason. `proposeFact` mutates the
      // fact graph too: a novel claim writes a draft row, and an agreeing one
      // writes a provenance edge against a live fact. Neither is read-safe.
      expect(nonDashboardRegistry.get("proposeFact")).toBeUndefined();
      expect(nonDashboardRegistry.get("executeSQL")).toBeDefined();
      expect(nonDashboardRegistry.get("explore")).toBeDefined();
      expect(nonDashboardRegistry.get("searchAtlas")).toBeDefined();
    });
  });

  it("getActions returns action tools with correct metadata", async () => {
    const { registry } = await buildRegistry({ includeActions: true });
    const actions = registry.getActions();
    const actionTypes = actions.map((a) => a.actionType).sort();
    expect(actionTypes).toEqual([
      "email:send",
      "github:create_issue",
      "jira:create",
      "salesforce:create",
    ]);
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
    expect(names).not.toContain("proposeFact");
    // Not vacuous — a headless surface is still a full read surface.
    for (const core of ["explore", "executeSQL", "searchAtlas"]) {
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
    // in agent-query.ts never had a test for. Both omissions must hold on the
    // error path too, or a misconfigured box quietly hands every headless
    // surface the write verbs.
    //
    // #4940 amended what this case MEANS without touching what it asserts. The
    // direction (lesser-privileged, not default) is a property of the FALLBACK,
    // so it must hold for every throw class `buildRegistry` can produce —
    // including the ones a boot-time env check cannot predict, like a `./python`
    // import that fails at build time. The trigger below is the fatal
    // misconfiguration only because it is the one class reachable from env
    // alone; it is no longer evidence that swallowing it is the end state (see
    // the case immediately after).
    await withEnv(
      { ATLAS_PYTHON_ENABLED: "true", ATLAS_SANDBOX_URL: undefined },
      async () => {
        await expect(buildRegistry()).rejects.toThrow("ATLAS_SANDBOX_URL");

        const { registry } = await buildHeadlessRegistry();
        expect(registry).toBe(nonDashboardRegistry);
        const names = Object.keys(registry.getAll());
        expect(names).not.toContain("createDashboard");
        expect(names).not.toContain("correct_fact");
        expect(names).not.toContain("proposeFact");
        expect(names).toContain("executeSQL");
      },
    );
  });

  it("#4940 — the shared predicate is the join between this seam and the boot guard", async () => {
    // What the issue was actually about. Before the boot guard, the env above
    // was a state a deployment could sit in indefinitely: all five
    // `buildRegistry` callers catch, so nothing failed boot and the operator's
    // `ATLAS_PYTHON_ENABLED=true` was silently dropped while `/health` stayed
    // green. `PythonSandboxGuardLive` now fails the boot Layer on exactly this
    // predicate (`saas-guards.test.ts` owns the guard's own cases).
    //
    // Asserted through the SHARED predicate rather than by restating the rule:
    // that is the join between the two seams, and a change to either that does
    // not go through `python-sandbox-requirement.ts` breaks here.
    const { isPythonSandboxMisconfigured } = await import(
      "@atlas/api/lib/tools/python-sandbox-requirement"
    );
    await withEnv(
      { ATLAS_PYTHON_ENABLED: "true", ATLAS_SANDBOX_URL: undefined },
      async () => {
        expect(isPythonSandboxMisconfigured(process.env)).toBe(true);
        await expect(buildRegistry()).rejects.toThrow("ATLAS_SANDBOX_URL");
      },
    );
    // The negative half: the shape a working deploy has must NOT be something
    // the boot guard refuses, or enabling Python correctly would wedge boot.
    await withEnv(
      { ATLAS_PYTHON_ENABLED: "true", ATLAS_SANDBOX_URL: "http://sandbox-sidecar:8080" },
      async () => {
        expect(isPythonSandboxMisconfigured(process.env)).toBe(false);
        const { registry } = await buildRegistry();
        expect(Object.keys(registry.getAll())).toContain("executePython");
      },
    );
  });

  it("#4941 — the fallback path authors its own warning instead of degrading silently", async () => {
    // The degrade above is deliberate and stays; what was missing is that the
    // user was never told, so a turn that lands here lost capability the
    // operator believes is configured and the model called it absent.
    await withEnv(
      { ATLAS_PYTHON_ENABLED: "true", ATLAS_SANDBOX_URL: undefined, ATLAS_ACTIONS_ENABLED: "true" },
      async () => {
        const { registry, warnings } = await buildHeadlessRegistry();
        expect(registry).toBe(nonDashboardRegistry);
        expect(warnings).toEqual([registryBuildFailedWarning()]);
        // Copy addressed to the MODEL, not to an operator reading logs — it has
        // to be relayable as-is, which is the whole point of #4941.
        expect(warnings[0]).toContain("temporarily unavailable");
      },
    );
  });

  // The copy is DERIVED from the env, not fixed, and this block pins why. A
  // degraded registry is lesser-privileged, not stripped: `sendEmail` and
  // `createLinearIssue` are CORE tools and survive both the action-load failure
  // and the whole-build failure. A fixed string claiming "action tools (JIRA,
  // email) are unavailable" hands the model a live `sendEmail` while telling it
  // email is down — the same wrong-explanation bug #4941 fixes, one capability
  // over. Both strings are swept, against both registries a surface can fall
  // back to, because the over-claim was found in the second one after the first
  // was fixed.
  describe("#4941 — no degraded-tools warning ever over-claims", () => {
    it("names only what the env asked for and the fallback could not carry", async () => {
      await withEnv({ ATLAS_ACTIONS_ENABLED: "true", ATLAS_PYTHON_ENABLED: "true" }, async () => {
        const warning = registryBuildFailedWarning();
        expect(warning).toContain("createJiraTicket");
        expect(warning).toContain("executePython");
      });
    });

    it("claims nothing lost when nothing was configured", async () => {
      await withEnv({ ATLAS_ACTIONS_ENABLED: undefined, ATLAS_PYTHON_ENABLED: undefined }, async () => {
        const warning = registryBuildFailedWarning();
        expect(warning).not.toContain("createJiraTicket");
        expect(warning).not.toContain("executePython");
      });
    });

    it("every warning ends with the never-disown-a-visible-tool instruction", async () => {
      // Naming only what was lost is necessary but not sufficient: the model
      // generalizes from "the action tools are gone" to "email is gone".
      await withEnv({ ATLAS_ACTIONS_ENABLED: "true", ATLAS_PYTHON_ENABLED: undefined }, async () => {
        for (const warning of [ACTION_TOOLS_UNAVAILABLE_WARNING, registryBuildFailedWarning()]) {
          expect(warning).toContain("do NOT tell the user that one of them is unavailable");
          expect(warning).toContain("temporarily unavailable");
          // Addressed to the reader of the answer, who on Slack / SDK / MCP has
          // no server logs. The operator half is the pino line.
          expect(warning).not.toContain("server logs");
        }
      });
    });

    it("no warning ever disowns a tool the surface still carries", async () => {
      // Swept against BOTH fallback registries: `nonDashboardRegistry` (the
      // headless seam) and `defaultRegistry` (both web chat paths).
      for (const env of [{ ATLAS_ACTIONS_ENABLED: "true" }, { ATLAS_ACTIONS_ENABLED: undefined }]) {
        await withEnv({ ...env, ATLAS_PYTHON_ENABLED: undefined }, async () => {
          const warnings = [ACTION_TOOLS_UNAVAILABLE_WARNING, registryBuildFailedWarning()];
          const survivors = [
            ...Object.keys(nonDashboardRegistry.getAll()),
            ...Object.keys(defaultRegistry.getAll()),
          ];
          // Non-vacuous, and these two are the ones that made the drafts wrong.
          expect(survivors).toContain("sendEmail");
          expect(survivors).toContain("createLinearIssue");

          for (const warning of warnings) {
            for (const survivor of survivors) {
              // Word-bounded on purpose: the action tool `sendEmailReport` is
              // legitimately named, and it CONTAINS the surviving `sendEmail`.
              expect(
                new RegExp(`\\b${survivor}\\b`).test(warning),
                `"${warning.slice(0, 60)}…" disowns ${survivor}, which the surface still carries`,
              ).toBe(false);
            }
          }
        });
      }
    });
  });

  // The OTHER warning source — `buildRegistry`'s action-tool load failure, seen
  // through this seam — needs the action module itself to fail, which is a
  // file-wide `mock.module` this file cannot take (its top-level actions mock is
  // what makes every `includeActions` test above work). It lives in
  // `lib/__tests__/agent-query-degraded-tools.test.ts` alongside the call-site
  // assertion that the warning reaches the model.
});
