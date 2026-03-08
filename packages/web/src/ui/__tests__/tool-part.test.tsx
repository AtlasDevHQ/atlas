import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

// Mock the ai package — must mock ALL named exports
mock.module("ai", () => ({
  getToolName: (part: Record<string, unknown>) => {
    if (!part || typeof part.toolName !== "string") throw new Error("No tool name");
    return part.toolName;
  },
  isToolUIPart: () => false,
  DefaultChatTransport: class {},
  streamText: () => {},
  generateText: () => {},
}));

// Mock next/dynamic
mock.module("next/dynamic", () => ({
  default: () => {
    return function DynamicStub() {
      return <div data-testid="chart-placeholder" />;
    };
  },
}));

import { ToolPart } from "../components/chat/tool-part";
import { AtlasUIProvider } from "../context";

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AtlasUIProvider config={{ apiUrl: "http://localhost:3001", isCrossOrigin: false, authClient: stubAuthClient }}>
      {children}
    </AtlasUIProvider>
  );
}

function makePart(toolName: string, overrides: Record<string, unknown> = {}) {
  return {
    toolName,
    input: {},
    output: null,
    state: "output-available",
    ...overrides,
  };
}

describe("ToolPart", () => {
  test("dispatches explore tool to ExploreCard", () => {
    const { container } = render(
      <ToolPart
        part={makePart("explore", {
          input: { command: "ls semantic/" },
          output: "entities/\nmetrics/",
        })}
      />,
    );
    // ExploreCard shows the command
    expect(container.textContent).toContain("ls semantic/");
  });

  test("dispatches executeSQL to SQLResultCard", () => {
    const { container } = render(
      <ToolPart
        part={makePart("executeSQL", {
          input: { sql: "SELECT 1", explanation: "Test query" },
          output: { success: true, columns: ["?column?"], rows: [{ "?column?": 1 }] },
        })}
      />,
    );
    expect(container.textContent).toContain("SQL");
    expect(container.textContent).toContain("Test query");
  });

  test("dispatches executePython to PythonResultCard", () => {
    const { container } = render(
      <ToolPart
        part={makePart("executePython", {
          input: { code: "print('hello')", explanation: "Python test" },
          output: { success: true, output: "hello" },
        })}
      />,
    );
    expect(container.textContent).toContain("Python");
  });

  test("renders fallback for unknown tool", () => {
    const { container } = render(
      <ToolPart part={makePart("unknownTool", { output: { foo: "bar" } })} />,
    );
    expect(container.textContent).toContain("Tool: unknownTool");
  });

  test("renders unknown type warning when toolName is missing", () => {
    const { container } = render(
      <ToolPart part={{ input: {}, output: null, state: "output-available" }} />,
    );
    expect(container.textContent).toContain("Tool result (unknown type)");
  });

  test("renders action approval card for action tool results", () => {
    const { container } = render(
      <ToolPart
        part={makePart("createReport", {
          output: {
            actionId: "act-123",
            status: "pending_approval",
            summary: "Create monthly report",
          },
        })}
      />,
      { wrapper: Wrapper },
    );
    // ActionApprovalCard should render — it checks isActionToolResult
    expect(container.textContent).not.toContain("Tool: createReport");
  });
});
