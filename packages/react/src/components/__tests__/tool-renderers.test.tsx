import { describe, it, expect, mock } from "bun:test";
import type React from "react";
import { render, screen } from "@testing-library/react";
import type { ToolRendererProps, ToolRenderers } from "../../lib/tool-renderer-types";

// Mock the `ai` module — must mock ALL named exports used by the component tree
mock.module("ai", () => ({
  getToolName: (part: Record<string, unknown>) => {
    if (!part.toolName) throw new Error("Unknown tool part");
    return part.toolName as string;
  },
  isToolUIPart: () => true,
  DefaultChatTransport: class {},
}));

// Import after mocks
const { ToolPart } = await import("../chat/tool-part");

function makePart(toolName: string, args: Record<string, unknown>, output: unknown, state = "output-available") {
  return { toolName, input: args, output, state };
}

describe("ToolPart with custom renderers", () => {
  it("uses custom renderer when provided for a tool", () => {
    function CustomSQL({ toolName, args, result, isLoading }: ToolRendererProps) {
      return (
        <div data-testid="custom-sql">
          {toolName}|{String(args.sql)}|{JSON.stringify(result)}|{String(isLoading)}
        </div>
      );
    }

    const renderers: ToolRenderers = { executeSQL: CustomSQL };
    const part = makePart("executeSQL", { sql: "SELECT 1" }, { success: true, columns: ["a"], rows: [{ a: 1 }] });

    render(<ToolPart part={part} toolRenderers={renderers} />);

    const el = screen.getByTestId("custom-sql");
    expect(el.textContent).toContain("executeSQL");
    expect(el.textContent).toContain("SELECT 1");
    expect(el.textContent).toContain("false"); // isLoading should be false when state is output-available
  });

  it("falls back to default renderer when no custom renderer provided", () => {
    const part = makePart("executeSQL", { sql: "SELECT 1" }, { success: true, columns: [], rows: [] });

    // No toolRenderers prop → default renderer
    const { container } = render(<ToolPart part={part} />);

    // Default SQL card renders — should not have our custom testid
    expect(screen.queryByTestId("custom-sql")).toBeNull();
    // The default card renders something (the SQL result card)
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("falls back to default renderer for tools not in the renderers map", () => {
    function CustomSQL() {
      return <div data-testid="custom-sql">custom</div>;
    }

    const renderers: ToolRenderers = { executeSQL: CustomSQL };
    const part = makePart("explore", { command: "ls" }, "file.txt");

    render(<ToolPart part={part} toolRenderers={renderers} />);

    // explore is not in renderers → uses default ExploreCard
    expect(screen.queryByTestId("custom-sql")).toBeNull();
  });

  it("passes isLoading=true and result=null when tool is still running", () => {
    const receivedProps: ToolRendererProps[] = [];
    function Spy(props: ToolRendererProps) {
      receivedProps.push(props);
      return <div data-testid="custom-explore">{String(props.isLoading)}</div>;
    }

    const renderers: ToolRenderers = { explore: Spy };
    const part = makePart("explore", { command: "ls" }, null, "call");

    render(<ToolPart part={part} toolRenderers={renderers} />);

    expect(screen.getByTestId("custom-explore").textContent).toBe("true");
    expect(receivedProps[0].isLoading).toBe(true);
    expect(receivedProps[0].result).toBeNull();
  });

  it("passes isLoading=false when tool is complete", () => {
    function CustomExplore({ isLoading }: ToolRendererProps) {
      return <div data-testid="custom-explore">{String(isLoading)}</div>;
    }

    const renderers: ToolRenderers = { explore: CustomExplore };
    const part = makePart("explore", { command: "ls" }, "output", "output-available");

    render(<ToolPart part={part} toolRenderers={renderers} />);

    expect(screen.getByTestId("custom-explore").textContent).toBe("false");
  });

  it("supports custom renderer for executePython", () => {
    function CustomPython({ toolName, result }: ToolRendererProps) {
      return <div data-testid="custom-python">{toolName}|{JSON.stringify(result)}</div>;
    }

    const renderers: ToolRenderers = { executePython: CustomPython };
    const part = makePart("executePython", { code: "print(1)" }, { success: true, output: "1" });

    render(<ToolPart part={part} toolRenderers={renderers} />);

    const el = screen.getByTestId("custom-python");
    expect(el.textContent).toContain("executePython");
    expect(el.textContent).toContain('"success":true');
  });

  it("supports custom renderer for arbitrary tool names", () => {
    function CustomTool({ toolName }: ToolRendererProps) {
      return <div data-testid="custom-tool">{toolName}</div>;
    }

    const renderers: ToolRenderers = { myCustomTool: CustomTool };
    const part = makePart("myCustomTool", {}, { data: "hello" });

    render(<ToolPart part={part} toolRenderers={renderers} />);

    expect(screen.getByTestId("custom-tool").textContent).toBe("myCustomTool");
  });

  it("passes correct args from the tool part", () => {
    const receivedProps: ToolRendererProps[] = [];
    function Spy(props: ToolRendererProps) {
      receivedProps.push(props);
      return <div data-testid="spy">ok</div>;
    }

    const renderers: ToolRenderers = { executeSQL: Spy };
    const part = makePart("executeSQL", { sql: "SELECT *", explanation: "Get all" }, { success: true });

    render(<ToolPart part={part} toolRenderers={renderers} />);

    expect(receivedProps).toHaveLength(1);
    expect(receivedProps[0].toolName).toBe("executeSQL");
    expect(receivedProps[0].args).toEqual({ sql: "SELECT *", explanation: "Get all" });
    expect(receivedProps[0].result).toEqual({ success: true });
    expect(receivedProps[0].isLoading).toBe(false);
  });

  it("renders with empty toolRenderers map (all defaults)", () => {
    const renderers: ToolRenderers = {};
    const part = makePart("executeSQL", { sql: "SELECT 1" }, { success: true, columns: [], rows: [] });

    const { container } = render(<ToolPart part={part} toolRenderers={renderers} />);

    // Should render the default card, not crash
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders error fallback when custom renderer throws", () => {
    function BrokenRenderer(): React.ReactNode {
      throw new Error("Renderer exploded");
    }

    const renderers: ToolRenderers = { executeSQL: BrokenRenderer };
    const part = makePart("executeSQL", { sql: "SELECT 1" }, { success: true });

    // Error boundary should catch — no crash
    const { container } = render(<ToolPart part={part} toolRenderers={renderers} />);

    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("Renderer exploded");
  });

  it("renders fallback banner when getToolName fails", () => {
    // Part without toolName triggers the mock's throw
    const malformedPart = { input: {}, output: null, state: "call" };

    const { container } = render(<ToolPart part={malformedPart} />);

    expect(container.textContent).toContain("Tool result (unknown type)");
  });

  it("dispatches to correct renderer when multiple renderers are registered", () => {
    function CustomSQL({ toolName }: ToolRendererProps) {
      return <div data-testid="custom-sql">{toolName}</div>;
    }
    function CustomExplore({ toolName }: ToolRendererProps) {
      return <div data-testid="custom-explore">{toolName}</div>;
    }
    function CustomPython({ toolName }: ToolRendererProps) {
      return <div data-testid="custom-python">{toolName}</div>;
    }

    const renderers: ToolRenderers = {
      executeSQL: CustomSQL,
      explore: CustomExplore,
      executePython: CustomPython,
    };

    const sqlPart = makePart("executeSQL", { sql: "SELECT 1" }, { success: true });
    const { unmount: u1 } = render(<ToolPart part={sqlPart} toolRenderers={renderers} />);
    expect(screen.getByTestId("custom-sql").textContent).toBe("executeSQL");
    u1();

    const explorePart = makePart("explore", { command: "ls" }, "files");
    const { unmount: u2 } = render(<ToolPart part={explorePart} toolRenderers={renderers} />);
    expect(screen.getByTestId("custom-explore").textContent).toBe("explore");
    u2();

    const pyPart = makePart("executePython", { code: "1+1" }, { success: true });
    render(<ToolPart part={pyPart} toolRenderers={renderers} />);
    expect(screen.getByTestId("custom-python").textContent).toBe("executePython");
  });

  it("passes error-shaped result (success: false) through to custom renderer", () => {
    const receivedProps: ToolRendererProps[] = [];
    function Spy(props: ToolRendererProps) {
      receivedProps.push(props);
      return <div data-testid="spy">error</div>;
    }

    const renderers: ToolRenderers = { executeSQL: Spy };
    const part = makePart("executeSQL", { sql: "BAD SQL" }, { success: false, error: "syntax error" });

    render(<ToolPart part={part} toolRenderers={renderers} />);

    expect(receivedProps[0].result).toEqual({ success: false, error: "syntax error" });
    expect(receivedProps[0].isLoading).toBe(false);
  });

  it("falls back to default when renderer value is undefined in the map", () => {
    const renderers = { executeSQL: undefined } as unknown as ToolRenderers;
    const part = makePart("executeSQL", { sql: "SELECT 1" }, { success: true, columns: [], rows: [] });

    const { container } = render(<ToolPart part={part} toolRenderers={renderers} />);

    // undefined entry → default SQLResultCard renders
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(screen.queryByTestId("custom-sql")).toBeNull();
  });
});
