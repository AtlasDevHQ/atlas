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

describe("ToolRegistry — validateActionCredentials", () => {
  const origTestApiKey = process.env.TEST_API_KEY;
  const origTestSecret = process.env.TEST_SECRET;
  const origMissingKeyA = process.env.MISSING_KEY_A;
  const origMissingKeyB = process.env.MISSING_KEY_B;
  const origPresentKey = process.env.PRESENT_KEY;

  afterEach(() => {
    if (origTestApiKey !== undefined) process.env.TEST_API_KEY = origTestApiKey; else delete process.env.TEST_API_KEY;
    if (origTestSecret !== undefined) process.env.TEST_SECRET = origTestSecret; else delete process.env.TEST_SECRET;
    if (origMissingKeyA !== undefined) process.env.MISSING_KEY_A = origMissingKeyA; else delete process.env.MISSING_KEY_A;
    if (origMissingKeyB !== undefined) process.env.MISSING_KEY_B = origMissingKeyB; else delete process.env.MISSING_KEY_B;
    if (origPresentKey !== undefined) process.env.PRESENT_KEY = origPresentKey; else delete process.env.PRESENT_KEY;
  });

  it("returns empty array when no actions", () => {
    const registry = new ToolRegistry();
    expect(registry.validateActionCredentials()).toEqual([]);
  });

  it("returns empty array when all credentials present", () => {
    process.env.TEST_API_KEY = "key-123";
    process.env.TEST_SECRET = "secret-456";

    const registry = new ToolRegistry();
    registry.register(
      makeAction("myAction", { requiredCredentials: ["TEST_API_KEY", "TEST_SECRET"] }),
    );

    expect(registry.validateActionCredentials()).toEqual([]);
  });

  it("returns missing credentials for each action", () => {
    delete process.env.MISSING_KEY_A;
    delete process.env.MISSING_KEY_B;
    process.env.PRESENT_KEY = "exists";

    const registry = new ToolRegistry();
    registry.register(
      makeAction("actionA", { requiredCredentials: ["MISSING_KEY_A", "PRESENT_KEY"] }),
    );
    registry.register(
      makeAction("actionB", { requiredCredentials: ["MISSING_KEY_B"] }),
    );

    const result = registry.validateActionCredentials();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ action: "actionA", missing: ["MISSING_KEY_A"] });
    expect(result[1]).toEqual({ action: "actionB", missing: ["MISSING_KEY_B"] });
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
