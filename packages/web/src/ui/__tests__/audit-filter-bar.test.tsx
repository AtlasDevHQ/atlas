/**
 * Filter-bar component tests for the audit-log MCP filter (#2067).
 *
 * Pinned behaviors:
 *   1. The MCP follow-up fields (clientId / tool) are hidden when
 *      actorKind is anything other than "mcp" — the discriminated-
 *      union UI must not leak invalid state into the URL.
 *   2. Selecting actorKind=mcp reveals exactly two extra fields.
 *   3. The clientId input gracefully falls back to free-text when
 *      the OAuth-clients fetch returned an empty list — admins
 *      pasting a known DCR UUID must not be blocked.
 *   4. Typing in the tool / clientId text inputs propagates a
 *      partial-update via onChange.
 */

import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { AuditFilterBar, actorKindUpdate } from "../components/admin/audit/filter-bar";

function noop() {}

describe("AuditFilterBar", () => {
  test("does NOT render clientId or tool fields when actorKind is empty", () => {
    const { container } = render(
      <AuditFilterBar
        actorKind=""
        clientId=""
        tool=""
        clientOptions={[]}
        onChange={noop}
      />,
    );
    expect(container.querySelector('[aria-label="Filter by OAuth client"]')).toBeNull();
    expect(container.querySelector('[aria-label="Filter by MCP tool"]')).toBeNull();
  });

  test("does NOT render MCP follow-ups for non-MCP actor kinds", () => {
    const { container } = render(
      <AuditFilterBar
        actorKind="human"
        clientId=""
        tool=""
        clientOptions={[]}
        onChange={noop}
      />,
    );
    expect(container.querySelector('[aria-label="Filter by OAuth client"]')).toBeNull();
    expect(container.querySelector('[aria-label="Filter by MCP tool"]')).toBeNull();
  });

  test("reveals clientId + tool fields when actorKind=mcp", () => {
    const { container } = render(
      <AuditFilterBar
        actorKind="mcp"
        clientId=""
        tool=""
        clientOptions={[
          { clientId: "claude-desktop", clientName: "Claude Desktop" },
        ]}
        onChange={noop}
      />,
    );
    expect(container.querySelector('[aria-label="Filter by OAuth client"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Filter by MCP tool"]')).not.toBeNull();
  });

  test("falls back to a free-text clientId input when no OAuth clients exist", () => {
    const { container } = render(
      <AuditFilterBar
        actorKind="mcp"
        clientId=""
        tool=""
        clientOptions={[]}
        onChange={noop}
      />,
    );
    const clientField = container.querySelector('[aria-label="Filter by OAuth client"]');
    expect(clientField).not.toBeNull();
    // The fallback is an `<input>`; the populated dropdown renders a
    // Radix Select trigger (`<button role="combobox">`). Asserting the
    // tag name pins the right branch was rendered.
    expect(clientField?.tagName).toBe("INPUT");
  });

  test("typing in the tool text input propagates a partial onChange", () => {
    const onChange = mock((_args: Record<string, unknown>) => {});
    const { container } = render(
      <AuditFilterBar
        actorKind="mcp"
        clientId=""
        tool=""
        clientOptions={[]}
        onChange={onChange}
      />,
    );
    const input = container.querySelector(
      '[aria-label="Filter by MCP tool"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "runMetric" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual({ tool: "runMetric" });
  });

  test("typing in the clientId fallback input propagates a partial onChange", () => {
    const onChange = mock((_args: Record<string, unknown>) => {});
    const { container } = render(
      <AuditFilterBar
        actorKind="mcp"
        clientId=""
        tool=""
        clientOptions={[]}
        onChange={onChange}
      />,
    );
    const input = container.querySelector(
      '[aria-label="Filter by OAuth client"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "custom-dcr-uuid" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual({ clientId: "custom-dcr-uuid" });
  });
});

// `actorKindUpdate` is the pure decision function the Select trigger calls.
// Driving Radix Select through jsdom is fragile, so the load-bearing
// "switch away from MCP clears the follow-ups" branch is exercised via
// the helper directly. A regression that flattens the branch (e.g.
// always emitting `{ actorKind: next }`) fails these tests.
describe("actorKindUpdate", () => {
  test("clears clientId + tool when switching away from MCP with stale follow-ups", () => {
    expect(actorKindUpdate("human", "claude-desktop", "runMetric")).toEqual({
      actorKind: "human",
      clientId: "",
      tool: "",
    });
  });

  test("emits only actorKind when follow-ups are already empty", () => {
    expect(actorKindUpdate("human", "", "")).toEqual({ actorKind: "human" });
  });

  test("does NOT clear when staying on MCP (e.g. MCP→MCP no-op)", () => {
    expect(actorKindUpdate("mcp", "claude-desktop", "runMetric")).toEqual({
      actorKind: "mcp",
    });
  });

  test("clears when switching to the empty 'All actors' value", () => {
    expect(actorKindUpdate("", "claude-desktop", "")).toEqual({
      actorKind: "",
      clientId: "",
      tool: "",
    });
  });
});
