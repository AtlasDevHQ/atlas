/**
 * Unit tests for the turn partitioner (#4298) — the pure function that splits a
 * finished assistant turn's parts into { activity, answer, answerBearingArtifact }
 * per CONTEXT.md § Chat turn presentation.
 *
 * Boundary rules under test (v1):
 * - everything up to and including the last tool part is activity;
 * - trailing text parts are the answer;
 * - the last successful executeSQL result is promoted as the answer-bearing
 *   artifact (and excluded from the activity the receipt renders);
 * - reasoning parts are never surfaced in any bucket.
 */

import { describe, expect, test } from "bun:test";
import {
  activityAwaitsUser,
  partitionTurn,
  summarizeActivity,
  type TextTurnPart,
  type ToolTurnPart,
  type TurnPart,
} from "../turn-partitioner";

/* ------------------------------------------------------------------ */
/*  Part fixtures                                                      */
/* ------------------------------------------------------------------ */

function text(t: string, state?: "streaming" | "done"): TextTurnPart {
  return { type: "text", text: t, state };
}

function reasoning(t: string): TurnPart {
  return { type: "reasoning", text: t };
}

function stepStart(): TurnPart {
  return { type: "step-start" };
}

let nextCallId = 0;

function sql(opts: {
  success?: boolean;
  state?: "input-streaming" | "input-available" | "output-available";
  sql?: string;
}): ToolTurnPart {
  const state = opts.state ?? "output-available";
  return {
    type: "tool-executeSQL",
    toolCallId: `call-${nextCallId++}`,
    state,
    input: { sql: opts.sql ?? "SELECT 1", explanation: "test query" },
    ...(state === "output-available"
      ? {
          output:
            opts.success === false
              ? { success: false, error: "boom" }
              : { success: true, columns: ["n"], rows: [{ n: 1 }] },
        }
      : {}),
  } as ToolTurnPart;
}

function explore(command = "ls semantic/entities"): ToolTurnPart {
  return {
    type: "tool-explore",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: { command },
    output: "entities.yml",
  } as ToolTurnPart;
}

function python(): ToolTurnPart {
  return {
    type: "tool-executePython",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: { code: "print(1)" },
    output: { success: true, stdout: "1" },
  } as ToolTurnPart;
}

/* ------------------------------------------------------------------ */
/*  partitionTurn                                                      */
/* ------------------------------------------------------------------ */

describe("partitionTurn", () => {
  test("narration/answer boundary: text before the last tool part is activity, trailing text is the answer", () => {
    const narration1 = text("Let me check the schema first.");
    const exp = explore();
    const narration2 = text("The region column looks unpopulated, checking...");
    const query = sql({});
    const answerText = text("Revenue was $1.2M last quarter.");
    const parts = [narration1, exp, narration2, query, answerText];

    const result = partitionTurn(parts);

    // The successful query is promoted out; narration + explore stay in activity.
    expect(result.activity.map((p) => p.part)).toEqual([narration1, exp, narration2]);
    expect(result.answer.map((p) => p.part)).toEqual([answerText]);
    expect(result.answerBearingArtifact?.part).toBe(query);
  });

  test("multi-query turn: only the last successful query is promoted; earlier ones stay in activity", () => {
    const q1 = sql({ sql: "SELECT 1" });
    const q2 = sql({ sql: "SELECT 2" });
    const parts = [explore(), q1, q2, text("Answer.")];

    const result = partitionTurn(parts);

    expect(result.answerBearingArtifact?.part).toBe(q2);
    expect(result.activity.map((p) => p.part)).toContain(q1);
    expect(result.activity.map((p) => p.part)).not.toContain(q2);
  });

  test("failed last query: the previous successful query is promoted, the failure stays in activity", () => {
    const good = sql({ sql: "SELECT 1" });
    const bad = sql({ success: false, sql: "SELECT nope" });
    const parts = [good, bad, text("I could not refine the result.")];

    const result = partitionTurn(parts);

    expect(result.answerBearingArtifact?.part).toBe(good);
    expect(result.activity.map((p) => p.part)).toEqual([bad]);
  });

  test("all queries failed: nothing is promoted", () => {
    const bad1 = sql({ success: false });
    const bad2 = sql({ success: false });
    const parts = [bad1, bad2, text("The query failed.")];

    const result = partitionTurn(parts);

    expect(result.answerBearingArtifact).toBeNull();
    expect(result.activity.map((p) => p.part)).toEqual([bad1, bad2]);
  });

  test("zero-tool turn: no activity, all text is the answer", () => {
    const a = text("Hello!");
    const b = text("What would you like to know?");

    const result = partitionTurn([a, b]);

    expect(result.activity).toEqual([]);
    expect(result.answer.map((p) => p.part)).toEqual([a, b]);
    expect(result.answerBearingArtifact).toBeNull();
  });

  test("interrupted stream: tool ran but no trailing text — empty answer", () => {
    const narration = text("Checking the data...");
    const query = sql({});

    const result = partitionTurn([narration, query]);

    expect(result.answer).toEqual([]);
    expect(result.answerBearingArtifact?.part).toBe(query);
    expect(result.activity.map((p) => p.part)).toEqual([narration]);
  });

  test("non-executeSQL tools are never promoted", () => {
    const parts = [explore(), python(), text("Done.")];

    const result = partitionTurn(parts);

    expect(result.answerBearingArtifact).toBeNull();
    expect(result.activity).toHaveLength(2);
  });

  test("in-progress tool parts are activity but never promoted", () => {
    const streaming = sql({ state: "input-streaming" });
    const pending = sql({ state: "input-available" });

    const result = partitionTurn([streaming, pending]);

    expect(result.answerBearingArtifact).toBeNull();
    expect(result.activity.map((p) => p.part)).toEqual([streaming, pending]);
    expect(result.answer).toEqual([]);
  });

  test("streaming trailing text is still the answer (partial in-progress turn)", () => {
    const query = sql({});
    const partial = text("Revenue was", "streaming");

    const result = partitionTurn([query, partial]);

    expect(result.answer.map((p) => p.part)).toEqual([partial]);
  });

  test("reasoning parts are dropped from both buckets", () => {
    const parts = [reasoning("thinking..."), sql({}), reasoning("more thinking"), text("Answer.")];

    const result = partitionTurn(parts);

    const surfaced: TurnPart[] = [
      ...result.activity.map((p) => p.part),
      ...result.answer.map((p) => p.part),
      ...(result.answerBearingArtifact ? [result.answerBearingArtifact.part] : []),
    ];
    expect(surfaced.some((p) => p.type === "reasoning")).toBe(false);
    // A trailing reasoning part after the last tool must not leak into the answer either.
    const trailing = partitionTurn([sql({}), reasoning("post-hoc"), text("Answer.")]);
    expect(trailing.answer.map((p) => p.part.type)).toEqual(["text"]);
  });

  test("step-start parts are dropped", () => {
    const result = partitionTurn([stepStart(), sql({}), stepStart(), text("Answer.")]);

    const surfaced = [...result.activity, ...result.answer].map((p) => p.part.type);
    expect(surfaced).not.toContain("step-start");
  });

  test("whitespace-only text parts are dropped from activity and answer", () => {
    const result = partitionTurn([text("  \n "), sql({}), text("   ")]);

    expect(result.activity).toEqual([]);
    expect(result.answer).toEqual([]);
  });

  test("empty and undefined inputs produce an empty partition", () => {
    for (const input of [undefined, [] as TurnPart[]]) {
      const result = partitionTurn(input);
      expect(result.activity).toEqual([]);
      expect(result.answer).toEqual([]);
      expect(result.answerBearingArtifact).toBeNull();
    }
  });

  test("indices reference positions in the original parts array", () => {
    const narration = text("Looking...");
    const query = sql({});
    const answerText = text("Done.");
    const parts = [reasoning("hidden"), narration, query, answerText];

    const result = partitionTurn(parts);

    expect(result.activity).toEqual([{ part: narration, index: 1 }]);
    expect(result.answerBearingArtifact).toEqual({ part: query, index: 2 });
    expect(result.answer).toEqual([{ part: answerText, index: 3 }]);
  });
});

/* ------------------------------------------------------------------ */
/*  activityAwaitsUser                                                 */
/* ------------------------------------------------------------------ */

/** A generic tool part with an arbitrary output envelope. */
function toolWithOutput(output: unknown): ToolTurnPart {
  return {
    type: "tool-someAction",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: {},
    output,
  } as ToolTurnPart;
}

describe("activityAwaitsUser", () => {
  test("pending action approval awaits the user", () => {
    const pending = toolWithOutput({
      status: "pending",
      actionId: "a1",
      summary: "Send the email",
    });
    const { activity } = partitionTurn([pending, text("I need your approval.")]);
    expect(activityAwaitsUser(activity)).toBe(true);
  });

  test("resolved action does not await the user", () => {
    const executed = toolWithOutput({
      status: "executed",
      actionId: "a1",
      result: { ok: true },
    });
    const { activity } = partitionTurn([executed, text("Done.")]);
    expect(activityAwaitsUser(activity)).toBe(false);
  });

  test("staged dashboard change (#2365) awaits the user", () => {
    const staged = toolWithOutput({
      kind: "stage_required",
      stageId: "s1",
      stageKind: "remove_card",
      target: { cardId: "c1", currentTitle: "T" },
    });
    const { activity } = partitionTurn([staged, text("Confirm the removal?")]);
    expect(activityAwaitsUser(activity)).toBe(true);
  });

  test("REST write confirmation (#2929) awaits the user", () => {
    const confirm = toolWithOutput({
      status: "needs_confirmation",
      method: "POST",
      operationId: "op1",
      datasourceId: "d1",
      datasourceName: "CRM",
      summary: "Create a contact",
      confirm: { token: "t1" },
    });
    const { activity } = partitionTurn([confirm, text("Shall I create it?")]);
    expect(activityAwaitsUser(activity)).toBe(true);
  });

  test("ordinary activity (explore, queries, narration) does not await the user", () => {
    const { activity } = partitionTurn([
      text("Checking..."),
      explore(),
      sql({ success: false }),
      text("Answer."),
    ]);
    expect(activityAwaitsUser(activity)).toBe(false);
    expect(activityAwaitsUser([])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  summarizeActivity                                                  */
/* ------------------------------------------------------------------ */

describe("summarizeActivity", () => {
  test("explore + queries reads like the receipt example", () => {
    const { activity } = partitionTurn([
      explore(),
      sql({ sql: "SELECT 1" }),
      sql({ sql: "SELECT 2" }),
      sql({ sql: "SELECT 3" }),
      text("Answer."),
    ]);
    // Three queries ran; the promoted one leaves the receipt, two remain.
    expect(summarizeActivity(activity)).toBe("Explored schema · 2 queries");
  });

  test("failed query carries a failure marker so a collapsed receipt never reads clean", () => {
    const { activity } = partitionTurn([sql({ success: false }), text("Failed.")]);
    expect(summarizeActivity(activity)).toBe("1 query · 1 failed");
  });

  test("singular successful query in the receipt has no failure marker", () => {
    // Two successes: the last is promoted out, one stays in the receipt.
    const { activity } = partitionTurn([sql({}), sql({}), text("Answer.")]);
    expect(summarizeActivity(activity)).toBe("1 query");
  });

  test("output-error tool parts count as failed", () => {
    const errored = {
      type: "tool-executeSQL",
      toolCallId: "call-err",
      state: "output-error",
      input: { sql: "SELECT boom" },
      errorText: "connection reset",
    } as TurnPart;
    const { activity } = partitionTurn([explore(), errored, text("It broke.")]);
    expect(summarizeActivity(activity)).toBe("Explored schema · 1 query · 1 failed");
  });

  test("python runs and unknown tools are counted", () => {
    const dashboard = {
      type: "tool-createDashboard",
      toolCallId: "call-x",
      state: "output-available",
      input: {},
      output: { id: "d1" },
    } as TurnPart;
    const { activity } = partitionTurn([python(), python(), dashboard, text("Done.")]);
    expect(summarizeActivity(activity)).toBe("2 Python runs · 1 more step");
  });

  test("action envelope resolved to failed counts as failed", () => {
    // Post-approval execution failure (SMTP down, upstream 5xx): the envelope
    // completes at output-available with status "failed" and no `success`
    // field — the count (and the working feed's marker) must not read clean.
    const failed = toolWithOutput({
      status: "failed",
      actionId: "a1",
      error: "SMTP connection refused",
    });
    const { activity } = partitionTurn([failed, text("The send failed.")]);
    expect(summarizeActivity(activity)).toBe("1 more step · 1 failed");
  });

  test("executed, denied, and timed-out action envelopes do not count as failed", () => {
    // Denial and timeout are user decisions / lifecycle outcomes, not failures.
    const executed = toolWithOutput({ status: "executed", actionId: "a1", result: { ok: true } });
    const denied = toolWithOutput({ status: "denied", actionId: "a2" });
    const timedOut = toolWithOutput({ status: "timed_out", actionId: "a3" });
    const { activity } = partitionTurn([executed, denied, timedOut, text("Done.")]);
    expect(summarizeActivity(activity)).toBe("3 more steps");
  });

  test("narration-only activity falls back to a generic label", () => {
    // A single promoted query with leading narration leaves only text in the receipt.
    const { activity } = partitionTurn([text("Checking..."), sql({}), text("Answer.")]);
    expect(summarizeActivity(activity)).toBe("Working notes");
  });

  test("empty activity summarizes to an empty string", () => {
    expect(summarizeActivity([])).toBe("");
  });
});
