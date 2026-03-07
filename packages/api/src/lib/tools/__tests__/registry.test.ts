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

mock.module("@atlas/api/lib/tools/actions", () => ({
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

const { ToolRegistry, defaultRegistry, buildRegistry } = await import(
  "@atlas/api/lib/tools/registry"
);

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
    expect(all.foo).toBe(fooTool);
    expect(all.bar).toBe(barTool);
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
});

describe("defaultRegistry", () => {
  it("contains all 2 core tools", () => {
    expect(defaultRegistry.get("explore")).toBeDefined();
    expect(defaultRegistry.get("executeSQL")).toBeDefined();
  });

  it("getAll returns exactly the 2 core tools", () => {
    const all = defaultRegistry.getAll();
    expect(Object.keys(all).sort()).toEqual(["executeSQL", "explore"]);
  });

  it("describe produces the expected workflow text", () => {
    const text = defaultRegistry.describe();
    expect(text).toContain("### 2. Explore the Semantic Layer");
    expect(text).toContain("### 3. Write and Execute SQL");
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
      const registry = await buildRegistry();
      const names = Object.keys(registry.getAll()).sort();
      expect(names).toEqual(["executePython", "executeSQL", "explore"]);
      expect(registry.describe()).toContain("### 4. Analyze Data with Python");
    } finally {
      if (saved.enabled !== undefined) process.env.ATLAS_PYTHON_ENABLED = saved.enabled;
      else delete process.env.ATLAS_PYTHON_ENABLED;
      if (saved.url !== undefined) process.env.ATLAS_SANDBOX_URL = saved.url;
      else delete process.env.ATLAS_SANDBOX_URL;
    }
  });

  it("returns 2 core tools by default", async () => {
    const registry = await buildRegistry();
    const names = Object.keys(registry.getAll()).sort();
    expect(names).toEqual(["executeSQL", "explore"]);
  });

  it("with includeActions returns 4 tools including createJiraTicket and sendEmailReport", async () => {
    const registry = await buildRegistry({ includeActions: true });
    const names = Object.keys(registry.getAll()).sort();
    expect(names).toEqual([
      "createJiraTicket",
      "executeSQL",
      "explore",
      "sendEmailReport",
    ]);
  });

  it("returned registry is frozen", async () => {
    const registry = await buildRegistry();
    expect(() =>
      registry.register({ name: "extra", description: "X", tool: makeTool("x") })
    ).toThrow("Cannot register tools on a frozen registry");
  });

  it("getActions returns action tools with correct metadata", async () => {
    const registry = await buildRegistry({ includeActions: true });
    const actions = registry.getActions();
    const actionTypes = actions.map((a) => a.actionType).sort();
    expect(actionTypes).toEqual(["email:send", "jira:create"]);
  });

  it("core-only registry has no actions", async () => {
    const registry = await buildRegistry();
    expect(registry.getActions()).toEqual([]);
  });
});
