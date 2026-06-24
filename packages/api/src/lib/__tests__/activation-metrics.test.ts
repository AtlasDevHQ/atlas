import { describe, test, expect } from "bun:test";
import {
  buildFirstAnswerLatencyEvent,
  logFirstAnswerLatency,
  isFirstTurn,
} from "@atlas/api/lib/activation-metrics";

describe("buildFirstAnswerLatencyEvent", () => {
  test("computes rounded latency and carries surface + firstTurn", () => {
    const evt = buildFirstAnswerLatencyEvent({
      surface: "demo",
      startedAtMs: 1_000,
      finishedAtMs: 6_400.6,
      firstTurn: true,
      requestId: "req-1",
    });
    expect(evt).toEqual({
      event: "activation.first_answer_latency",
      surface: "demo",
      latencyMs: 5_401,
      firstTurn: true,
      requestId: "req-1",
    });
  });

  test("includes conversationId and runId only when supplied", () => {
    const evt = buildFirstAnswerLatencyEvent({
      surface: "chat",
      startedAtMs: 0,
      finishedAtMs: 2_000,
      firstTurn: false,
      requestId: "req-2",
      conversationId: "conv-9",
      runId: "run-7",
    });
    expect(evt.conversationId).toBe("conv-9");
    expect(evt.runId).toBe("run-7");
    expect(evt.surface).toBe("chat");
    expect(evt.firstTurn).toBe(false);
  });

  test("omits correlation ids rather than emitting undefined keys", () => {
    const evt = buildFirstAnswerLatencyEvent({
      surface: "chat",
      startedAtMs: 0,
      finishedAtMs: 100,
      firstTurn: true,
      requestId: "req-3",
    });
    expect("conversationId" in evt).toBe(false);
    expect("runId" in evt).toBe(false);
  });

  test("clamps a backwards clock to zero instead of a negative latency", () => {
    const evt = buildFirstAnswerLatencyEvent({
      surface: "demo",
      startedAtMs: 5_000,
      finishedAtMs: 4_000,
      firstTurn: true,
      requestId: "req-4",
    });
    expect(evt.latencyMs).toBe(0);
  });
});

describe("isFirstTurn", () => {
  test("a zero-user-message payload counts as a first turn (defensive)", () => {
    expect(isFirstTurn([])).toBe(true);
    expect(isFirstTurn([{ role: "system" }])).toBe(true);
  });

  test("exactly one user message is the opening turn", () => {
    expect(isFirstTurn([{ role: "user" }])).toBe(true);
    expect(isFirstTurn([{ role: "assistant" }, { role: "user" }])).toBe(true);
  });

  test("two or more user messages is not a first turn", () => {
    expect(
      isFirstTurn([
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
      ]),
    ).toBe(false);
  });

  test("counts only user messages, ignoring interleaved assistant/system turns", () => {
    expect(
      isFirstTurn([
        { role: "system" },
        { role: "user" },
        { role: "assistant" },
      ]),
    ).toBe(true);
  });
});

describe("logFirstAnswerLatency", () => {
  test("is fire-and-forget — never throws into the stream lifecycle", () => {
    expect(() =>
      logFirstAnswerLatency({
        surface: "demo",
        startedAtMs: 10,
        finishedAtMs: 20,
        firstTurn: true,
        requestId: "req-5",
      }),
    ).not.toThrow();
  });
});
