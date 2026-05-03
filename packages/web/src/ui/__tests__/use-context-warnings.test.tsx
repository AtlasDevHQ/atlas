import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
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
  | { type: "replace-messages"; messages: Array<{ id: string; role: string }> }
  | { type: "send" }
  | { type: "new-chat" }
  // Emit several data-context-warning frames in the same React batch
  // BEFORE any subsequent message append, exercising the buffer path
  // that production hits when `chat.ts` writes warnings ahead of the
  // assistant text-delta merge.
  | { type: "batch"; frames: Array<{ type: "data-context-warning"; data: unknown }> };

/**
 * Test harness — replays a frame sequence the way `atlas-chat` would
 * dispatch it, then renders the banner above the latest assistant turn so
 * tests can assert end-to-end (wire frame in → DOM out).
 *
 * `flush()` advances through the queued frames in order. We drive the
 * timeline imperatively (not from inside a useEffect) so the harness's
 * deps stay stable and we never recurse on the hook's returned object,
 * which is a fresh reference per render.
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
            case "replace-messages":
              setMessages(f.messages);
              break;
            case "send":
              ctlRef.current.resetPending();
              break;
            case "new-chat":
              setMessages([]);
              ctlRef.current.reset();
              break;
            case "batch":
              for (const inner of f.frames) ctlRef.current.handleData(inner);
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

  test("turn-N warnings attach to turn N's assistant, NOT turn N-1's", async () => {
    // Regression: pre-fix the drain effect found the most-recent
    // assistant id at the time the frame arrived, which on turn 2 was
    // still a1 (because the chat route writes warnings before merging
    // the agent stream — a2 doesn't exist yet). The anchorMessageCount
    // snapshot bounds the drain so it waits for an assistant at index
    // >= the count when the batch was first buffered.
    const frames: Frame[] = [
      // Turn 1: degraded
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "semantic_layer_unavailable", title: "Turn 1 warning" },
      },
      { type: "assistant-message", id: "a1" },
      // Turn 2: ALSO degraded — must attach to a2, not a1
      { type: "send" },
      { type: "user-message", id: "u2" },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "learned_patterns_unavailable", title: "Turn 2 warning" },
      },
      { type: "assistant-message", id: "a2" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    const turn1 = container.querySelector('[data-testid="turn-a1"]');
    const turn2 = container.querySelector('[data-testid="turn-a2"]');
    expect(turn1?.textContent).toContain("Turn 1 warning");
    expect(turn1?.textContent).not.toContain("Turn 2 warning");
    expect(turn2?.textContent).toContain("Turn 2 warning");
    expect(turn2?.textContent).not.toContain("Turn 1 warning");
  });

  test("multiple warnings for one turn delivered in a single batch all attach", async () => {
    // Production order: chat.ts writes ALL warning frames in a tight
    // loop, then merges the agent stream. The batch arrives before any
    // assistant message id, so the buffer must hold every frame until
    // drain — not race-drop later ones to the empty bucket reset.
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      {
        type: "batch",
        frames: [
          {
            type: "data-context-warning",
            data: { severity: "warning", code: "plan_limit_warning", title: "Plan" },
          },
          {
            type: "data-context-warning",
            data: { severity: "warning", code: "semantic_layer_unavailable", title: "Sem" },
          },
          {
            type: "data-context-warning",
            data: { severity: "warning", code: "learned_patterns_unavailable", title: "LP" },
          },
        ],
      },
      { type: "assistant-message", id: "a1" },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    const turn = container.querySelector('[data-testid="turn-a1"]');
    expect(turn?.textContent).toContain("Plan");
    expect(turn?.textContent).toContain("Sem");
    expect(turn?.textContent).toContain("LP");
  });

  test("orphaned bucket is dropped when its message id leaves messages", async () => {
    // setMessages can replace a message on regenerate / edit. The hook
    // must drop the orphaned bucket so the map doesn't leak forever
    // and so the old warning can never re-appear if a new id collides.
    const frames: Frame[] = [
      { type: "user-message", id: "u1" },
      {
        type: "data-context-warning",
        data: { severity: "warning", code: "semantic_layer_unavailable", title: "Was here" },
      },
      { type: "assistant-message", id: "a1" },
      // Fully replace the messages list — a1 is gone, a2 takes its slot.
      {
        type: "replace-messages",
        messages: [
          { id: "u1", role: "user" },
          { id: "a2", role: "assistant" },
        ],
      },
    ];
    const { Harness, flush } = buildHarness();
    const { container } = render(<Harness frames={frames} />);
    await flush();

    expect(container.querySelector('[data-testid="turn-a1"]')).toBeNull();
    expect(container.querySelector('[data-testid="turn-a2"]')).toBeNull();
  });

  describe("malformed frame logging", () => {
    let warnSpy: ReturnType<typeof mock>;
    let originalWarn: typeof console.warn;
    beforeEach(() => {
      originalWarn = console.warn;
      warnSpy = mock(() => {});
      console.warn = warnSpy;
    });
    afterEach(() => {
      console.warn = originalWarn;
    });

    test("malformed data-context-warning frame logs (so wire regressions are observable)", async () => {
      const frames: Frame[] = [
        { type: "user-message", id: "u1" },
        {
          type: "data-context-warning",
          data: { severity: "warning", code: "made_up", title: "x" },
        },
        { type: "assistant-message", id: "a1" },
      ];
      const { Harness, flush } = buildHarness();
      render(<Harness frames={frames} />);
      await flush();

      // Console.warn fires once for the dropped malformed frame.
      // The pre-#2005 `data-plan-warning` channel went undetected for
      // two releases because nothing logged the typed mismatch — this
      // pin keeps that mistake from recurring quietly.
      expect(warnSpy).toHaveBeenCalled();
      const args = warnSpy.mock.calls[0];
      expect(args[0]).toContain("dropped malformed");
    });
  });

  describe("parser edge cases (sharper severity / extra fields)", () => {
    test("severity casing is strict: 'Warning' (capital) is rejected", async () => {
      const frames: Frame[] = [
        { type: "user-message", id: "u1" },
        {
          type: "data-context-warning",
          data: { severity: "Warning", code: "semantic_layer_unavailable", title: "x" },
        },
        { type: "assistant-message", id: "a1" },
      ];
      const { Harness, flush } = buildHarness();
      const { container } = render(<Harness frames={frames} />);
      await flush();
      // No banner — parser rejected on case-sensitive discriminator.
      expect(container.querySelector('[data-testid="turn-a1"]')).toBeNull();
    });

    test("warning-only assistant turn (no text, no tools) still renders the banner", async () => {
      // Atlas-chat's skip-render predicate carves out warning-only
      // turns: an assistant message with no visible parts but with
      // attached warnings is still rendered so the user sees the
      // banner. This test exercises that exact gating using the same
      // bucket the production component reads from — pinning the
      // contract end-to-end without mounting the full chat UI.
      const frames: Frame[] = [
        { type: "user-message", id: "u1" },
        {
          type: "data-context-warning",
          data: {
            severity: "warning",
            code: "semantic_layer_unavailable",
            title: "Degraded with no content",
          },
        },
        // assistant message with NO parts (modelled as just the role+id)
        { type: "assistant-message", id: "a1" },
      ];
      const { Harness, flush } = buildHarness();
      const { container } = render(<Harness frames={frames} />);
      await flush();

      // Banner is the only content for this turn; assert it rendered.
      // The harness skips messages without buckets, so a regression
      // that drops the bucket would surface as a missing turn.
      const turn = container.querySelector('[data-testid="turn-a1"]');
      expect(turn).not.toBeNull();
      expect(turn?.textContent).toContain("Degraded with no content");
    });

    test("extra unknown fields on the wire are dropped (no banner contamination)", async () => {
      const frames: Frame[] = [
        { type: "user-message", id: "u1" },
        {
          type: "data-context-warning",
          data: {
            severity: "warning",
            code: "semantic_layer_unavailable",
            title: "Has extras",
            unknownField: "should not appear in DOM",
            requestId: "req-keep",
          },
        },
        { type: "assistant-message", id: "a1" },
      ];
      const { Harness, flush } = buildHarness();
      const { container } = render(<Harness frames={frames} />);
      await flush();

      const turn = container.querySelector('[data-testid="turn-a1"]');
      expect(turn?.textContent).toContain("Has extras");
      expect(turn?.textContent).toContain("req-keep");
      expect(turn?.textContent).not.toContain("should not appear in DOM");
    });
  });
});
