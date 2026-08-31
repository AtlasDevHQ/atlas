import { describe, expect, it, afterEach } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");

function makeTool(name: string) {
  return tool({
    description: `Test tool: ${name}`,
    inputSchema: z.object({ input: z.string() }),
    execute: async ({ input }) => input,
  });
}

function makeAction(name: string, opts?: { requiredCredentials?: string[] }) {
  return {
    name,
    description: `Action: ${name}`,
    tool: tool({
      description: name,
      inputSchema: z.object({ input: z.string() }),
      execute: async ({ input }) => input,
    }),
    actionType: `test:${name}`,
    reversible: true,
    defaultApproval: "manual" as const,
    requiredCredentials: opts?.requiredCredentials ?? [],
  };
}

describe("ToolRegistry — getActions", () => {
  it("returns empty array when no actions registered", () => {
    const registry = new ToolRegistry();
    expect(registry.getActions()).toEqual([]);
  });

  it("returns only tools that are actions (have actionType field)", () => {
    const registry = new ToolRegistry();
    const action1 = makeAction("sendEmail");
    const action2 = makeAction("createTicket");
    registry.register(action1);
    registry.register(action2);

    const actions = registry.getActions();
    expect(actions).toHaveLength(2);
    expect(actions[0].name).toBe("sendEmail");
    expect(actions[1].name).toBe("createTicket");
  });

  it("doesn't return regular tools (without actionType)", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "explore", description: "Explore", tool: makeTool("explore") });
    registry.register({ name: "executeSQL", description: "SQL", tool: makeTool("sql") });

    const actions = registry.getActions();
    expect(actions).toEqual([]);
  });
});

describe("the action-tool name contract (manifest ↔ barrel ↔ warning copy)", () => {
  // `validateActionCredentials` lived here until ADR-0046's cleanup pass —
  // three fixture tests for a validator whose every live subject declares
  // `requiredCredentials: []`. What replaced it is the drift these suites
  // actually need to catch: the warning copy is built from the
  // dependency-free manifest (readable when the action modules fail to
  // load), and registration iterates the barrel's ACTION_TOOLS — so the two
  // lists agreeing IS the contract, and target #6 has to be named in both
  // before it ships.
  it("ACTION_TOOLS registers exactly the names the manifest promises, in order", async () => {
    const { ACTION_TOOLS, ACTION_TOOL_NAMES } = await import("@atlas/api/lib/tools/actions");
    expect(ACTION_TOOLS.map((a) => a.name)).toEqual([...ACTION_TOOL_NAMES]);
  });

  it("the unavailable-warning names every manifest tool, verbatim", async () => {
    const { ACTION_TOOLS_UNAVAILABLE_WARNING } = await import("@atlas/api/lib/tools/registry");
    const { ACTION_TOOL_NAMES } = await import("@atlas/api/lib/tools/actions/manifest");
    for (const name of ACTION_TOOL_NAMES) {
      expect(ACTION_TOOLS_UNAVAILABLE_WARNING).toContain(name);
    }
  });

  it("every operator action declares requiredCredentials: [] (per-workspace targets, ADR-0046)", async () => {
    const { ACTION_TOOLS } = await import("@atlas/api/lib/tools/actions");
    for (const action of ACTION_TOOLS) {
      expect(action.requiredCredentials).toEqual([]);
    }
  });
});

describe("ToolRegistry — actions alongside regular tools", () => {
  it("actions can be registered alongside regular tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "explore", description: "Explore", tool: makeTool("explore") });
    registry.register(makeAction("sendEmail"));
    registry.register({ name: "executeSQL", description: "SQL", tool: makeTool("sql") });
    registry.register(makeAction("createTicket"));

    const all = registry.getAll();
    expect(Object.keys(all).sort()).toEqual([
      "createTicket",
      "executeSQL",
      "explore",
      "sendEmail",
    ]);

    const actions = registry.getActions();
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.name).sort()).toEqual(["createTicket", "sendEmail"]);
  });
});
