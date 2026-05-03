import { describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import {
  useContextWarnings,
  type WarningBucket,
} from "../hooks/use-context-warnings";
import { ContextWarningBanner } from "../components/chat/context-warning-banner";

type Frame =
  | { type: "data-context-warning"; data: unknown }
  | { type: "user-message"; id: string }
  | { type: "assistant-message"; id: string }
  | { type: "send" }
  | { type: "new-chat" };

/**
 * Test harness — replays a frame sequence the way `atlas-chat` would
 * dispatch it, then renders the banner above the latest assistant turn so
 * tests can assert end-to-end (wire frame in → DOM out).
 *
 * `step` advances on each `flush()` call from the test, not on render —
 * that keeps `useEffect` deps stable and avoids the infinite re-render
 * loop that follows from putting the hook handle in the deps array (the
 * hook returns a new object every render).
 */
function buildHarness() {
  const stepRef: { current: () => Promise<void> } = { current: async () => {} };

  function Harness({ frames }: { frames: Frame[] }) {
    const [messages, setMessages] = useState<Array<{ id: string; role: string }>>([]);
    const indexRef = useRef(0);
    const ctl = useContextWarnings(messages);
    const ctlRef = useRef(ctl);
    ctlRef.current = ctl;

    // Expose an imperative step() so the test drives the timeline.
    stepRef.current = async () => {
      while (indexRef.current < frames.length) {
        const f = frames[indexRef.current];
        indexRef.current += 1;
        await act(async () => {
          switch (f.type) {
            case "data-context-warning":
              ctlRef.current.handleData(f);
              break;
            case "user-message":
              setMessages((prev) => [...prev, { id: f.id, role: "user" }]);
              break;
            case "assistant-message":
              setMessages((prev) => [...prev, { id: f.id, role: "assistant" }]);
              break;
            case "send":
              ctlRef.current.resetPending();
              break;
            case "new-chat":
              setMessages([]);
              ctlRef.current.reset();
              break;
          }
          await Promise.resolve();
        });
        // Let the buffer-drain useEffect inside the hook run.
        await act(async () => {
          await Promise.resolve();
        });
      }
    };

    return (
      <div>
        {messages.map((m) => {
          const bucket = ctl.byMessage.get(m.id) as WarningBucket | undefined;
          if (m.role !== "assistant" || !bucket) return null;
          return (
            <div key={m.id} data-testid={`turn-${m.id}`}>
              <ContextWarningBanner warnings={bucket.warnings} />
            </div>
          );
        })}
      </div>
    );
  }

  return {
    Harness,
    flush: () => stepRef.current(),
  };
}

describe("useContextWarnings (integration)", () => {
  test("banner appears above the assistant turn after a context-warning frame", async () => {
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: {
          severity: "warning",
          code: "semantic_layer_unavailable",
          title: "Semantic layer unavailable",
          detail: "Falling back to defaults.",
          requestId: "req-1",
        },
      },
      { type: "assistant-message", id: "a1" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    const turn = container.querySelector('[data-testid="turn-a1"]');
    expect(turn).not.toBeNull();
    expect(turn?.textContent).toContain("Semantic layer unavailable");
    expect(turn?.textContent).toContain("semantic_layer_unavailable");
    expect(turn?.textContent).toContain("req-1");
  });

  test("banner renders plan_limit_warning code (unified channel for plan + preflight signals)", async () => {
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: {
          severity: "warning",
          code: "plan_limit_warning",
          title: "Approaching plan limit",
          detail: "85% of monthly budget used.",
        },
      },
      { type: "assistant-message", id: "a1" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    const turn = container.querySelector('[data-testid="turn-a1"]');
    expect(turn).not.toBeNull();
    expect(turn?.textContent).toContain("Approaching plan limit");
    expect(turn?.textContent).toContain("plan_limit_warning");
    expect(turn?.textContent).toContain("85% of monthly budget used.");
  });

  test("warnings are scoped per-message, not session-wide", async () => {
    const frames: Frame[] = [
      // First turn: degraded
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "semantic_layer_unavailable", title: "Degraded" },
      },
      { type: "assistant-message", id: "a1" },
      // Second turn: clean — must NOT inherit the prior warning
      { type: "send" },
      { type: "user-message", id: "u2" },
      { type: "assistant-message", id: "a2" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    expect(container.querySelector('[data-testid="turn-a1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="turn-a2"]')).toBeNull();
  });

  test("invalid data-context-warning frames are silently dropped", async () => {
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      // Missing required `severity: "warning"` discriminator
      {
        type: "data-context-warning",
        data: { code: "semantic_layer_unavailable", title: "x" },
      },
      // Unknown code
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "made_up", title: "x" },
      },
      { type: "assistant-message", id: "a1" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    expect(container.querySelector('[data-testid="turn-a1"]')).toBeNull();
  });

  test("multiple warnings on the same turn render together", async () => {
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "plan_limit_warning", title: "Plan clipped" },
      },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "semantic_layer_unavailable", title: "Sem missing" },
      },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "learned_patterns_unavailable", title: "LP missing" },
      },
      { type: "assistant-message", id: "a1" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    const turn = container.querySelector('[data-testid="turn-a1"]');
    expect(turn?.textContent).toContain("Sem missing");
    expect(turn?.textContent).toContain("LP missing");
    expect(turn?.textContent).toContain("Plan clipped");
  });

  test("reset() clears warnings and pending bucket on new chat", async () => {
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "semantic_layer_unavailable", title: "Degraded" },
      },
      { type: "assistant-message", id: "a1" },
      { type: "new-chat" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    // After new-chat, the bucket is cleared; nothing renders.
    expect(container.querySelector('[data-testid="turn-a1"]')).toBeNull();
  });

  test("handleData returns true for warning frames, false for unrelated", async () => {
    let returnedForWarning: boolean | null = null;
    let returnedForOther: boolean | null = null;

    function Probe() {
      const ctl = useContextWarnings([]);
      const fired = useRef(false);
      useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        returnedForWarning = ctl.handleData({
          type: "data-context-warning",
          data: { severity: "warning", code: "semantic_layer_unavailable", title: "x" },
        });
        returnedForOther = ctl.handleData({
          type: "data-python-progress",
          data: { type: "stdout", text: "hi" },
        });
      });
      return null;
    }

    render(<Probe />);
    await act(async () => { await Promise.resolve(); });

    expect(returnedForWarning).toBe(true);
    expect(returnedForOther).toBe(false);
  });
});
