/**
 * The host side of the chat plugin's per-message observer (#4967) — the switch
 * between "a chat message arrived on some platform" and "store it as a Slack
 * brain episode".
 *
 * Small on purpose: the DECISIONS all live in
 * `lib/brain/ingest/slack/webhook.ts` and are tested there. What is worth
 * pinning here is the routing, and specifically its NEGATIVE half. Every wired
 * chat adapter — Teams, Discord, gchat, Telegram — flows through this one
 * callback, and only Slack has a brain source today. A default arm that fell
 * through to the Slack writer would hand it a payload with no Slack `channel`
 * or `ts` in it at all; the writer would refuse, correctly, and the bug would
 * be invisible until someone wondered why Teams messages never became
 * episodes.
 */

import { describe, expect, it } from "bun:test";
import type { ChatMessageObservation } from "@useatlas/chat";
import { createBrainChatMessageObserver } from "@atlas/api/lib/chat-plugin/brain-observer";
import type { SlackWebhookIngestOutcome } from "@atlas/api/lib/brain/ingest/slack/webhook";

const SLACK_RAW = { type: "message", channel: "C01ABCDEF", ts: "1750000000.000100" };

function observation(overrides: Partial<ChatMessageObservation> = {}): ChatMessageObservation {
  return {
    platform: "slack",
    message: { id: "1750000000.000100", raw: SLACK_RAW },
    ...overrides,
  };
}

/** Records what the writer was handed, and answers with a scripted outcome. */
function spyIngest(
  outcome: SlackWebhookIngestOutcome = {
    status: "skipped",
    reason: "disabled",
    pollBackstopped: true,
  },
) {
  const calls: unknown[] = [];
  return {
    calls,
    ingest: async (raw: unknown): Promise<SlackWebhookIngestOutcome> => {
      calls.push(raw);
      return outcome;
    },
  };
}

describe("createBrainChatMessageObserver", () => {
  it("hands a Slack message's raw payload to the episode writer verbatim", async () => {
    // Verbatim matters: the writer reads Slack's own `channel` / `ts` /
    // `channel_type` fields, so anything this layer reshaped would have to be
    // reshaped back — and the two shapes could then disagree.
    const spy = spyIngest();
    const observe = createBrainChatMessageObserver({ ingest: spy.ingest });
    await observe(observation());
    expect(spy.calls).toEqual([SLACK_RAW]);
  });

  it("does NOT route a non-Slack platform to the Slack writer", async () => {
    const spy = spyIngest();
    const observe = createBrainChatMessageObserver({ ingest: spy.ingest });
    for (const platform of ["teams", "discord", "gchat", "telegram", "github"]) {
      await observe(observation({ platform }));
    }
    // The assertion that matters: the Slack writer is never reached at all,
    // rather than reached and refusing. A writer that refuses is a writer that
    // could stop refusing.
    expect(spy.calls).toEqual([]);
  });

  it("resolves regardless of what the writer reports", async () => {
    // The bridge ignores the result and there is deliberately nothing an
    // observation can tell the chat pillar — so every outcome has to be a
    // resolution, not a signal.
    const outcomes: SlackWebhookIngestOutcome[] = [
      { status: "inserted", sourceId: "C01ABCDEF:1750000000.000100" },
      { status: "duplicate", sourceId: "C01ABCDEF:1750000000.000100" },
      { status: "refused", sourceId: "C01ABCDEF:1750000000.000100", pollBackstopped: true },
      { status: "refused", sourceId: "C01ABCDEF:1750000000.000100", pollBackstopped: false },
      { status: "skipped", reason: "disabled", pollBackstopped: true },
      { status: "skipped", reason: "channel_not_configured", pollBackstopped: true },
      { status: "skipped", reason: "ingest_failed", pollBackstopped: false },
      { status: "skipped", reason: "not_a_message", pollBackstopped: true },
      { status: "skipped", reason: "scope_unreadable", pollBackstopped: false },
    ];
    for (const outcome of outcomes) {
      const observe = createBrainChatMessageObserver({ ingest: spyIngest(outcome).ingest });
      await expect(observe(observation())).resolves.toBeUndefined();
    }
  });
});

describe("the not-stored report's level", () => {
  /** Collect (level, detail) pairs instead of asserting on a mocked logger. */
  function collect() {
    const seen: Array<{ level: string; reason: unknown }> = [];
    return {
      seen,
      report: (level: "warn" | "debug", detail: Record<string, unknown>) => {
        seen.push({ level, reason: detail.reason });
      },
    };
  }

  it("WARNS when the message has no poll backstop", async () => {
    // The finding this exists for: "the scheduled sync still covers it" is
    // false for a thread reply, because `conversations.history` never returns
    // replies. A single reassuring debug line for both cases would assert a
    // backstop that does not exist — worse than logging nothing, because it
    // tells an operator to stop looking.
    // The vehicle is `unresolvable_visibility` rather than
    // `channel_not_configured`: the channel IS in scope and the fast path still
    // failed to store the reply, so the evidence really is gone. See the
    // never-in-scope test below for why the other reason no longer belongs here.
    const sink = collect();
    const observe = createBrainChatMessageObserver({
      ingest: spyIngest({
        status: "skipped",
        reason: "unresolvable_visibility",
        pollBackstopped: false,
      }).ingest,
      report: sink.report,
    });
    await observe(observation());
    expect(sink.seen).toEqual([{ level: "warn", reason: "unresolvable_visibility" }]);
  });

  it("stays at debug when the poll will re-store the message", async () => {
    const sink = collect();
    const observe = createBrainChatMessageObserver({
      ingest: spyIngest({
        status: "skipped",
        reason: "unresolvable_visibility",
        pollBackstopped: true,
      }).ingest,
      report: sink.report,
    });
    await observe(observation());
    expect(sink.seen).toEqual([{ level: "debug", reason: "unresolvable_visibility" }]);
  });

  it("⭐ stays at debug for NEVER-IN-SCOPE traffic, even with no poll backstop", async () => {
    // The warn arm says "this evidence is LOST". For a thread reply in a channel
    // the admin deliberately never scoped, nothing was lost — there was nothing
    // to store. Left as a warn it fires once per thread reply, forever, on a
    // CORRECT configuration: any deployment whose admin excluded a channel the
    // bot is nonetheless in, or whose first post-#5203 sync has not reconciled
    // a pre-existing scope yet.
    //
    // That is the shape of alert that trains an operator to filter the channel
    // that also carries the real one, so the cost is paid by the warn above.
    //
    // `unmintable_subtype` rides along for a DIFFERENT reason, and the
    // difference matters. The other three were never in scope; a
    // `message_deleted` or `tombstone` IS in a scoped channel — but a deletion
    // carries no evidence to lose, and minting from the event's own `ts` would
    // produce an id the poll never mints. Warning "this evidence is lost" for a
    // deletion is as wrong as warning for out-of-scope traffic, and it would
    // arrive at the same steady-state volume the day the Chat SDK stops
    // filtering these before dispatch.
    //
    // ⚠️ `no_install` is GONE from this set, not renamed (#5203). Slack no
    // longer has an install to be missing — the source is dispatched over the
    // chat-pillar install, so a workspace with Slack connected always has the
    // source. That reason being classified "nothing to store" was the bug in
    // miniature: it made the four-day outage's own state read as steady-state
    // correct configuration.
    //
    // ⚠️ `scope_unreadable` is deliberately NOT added in its place. It looks
    // like `channel_not_configured` — both end with nothing stored — but one is
    // the workspace saying no and the other is a failed read, and a failed read
    // on a thread reply IS lost evidence. It belongs on the warn arm, which the
    // test below pins.
    //
    // MUTATION THIS CATCHES: removing the never-in-scope classification, or
    // dropping any single member from the set.
    for (const reason of [
      "unknown_workspace",
      "channel_not_configured",
      "unmintable_subtype",
    ] as const) {
      const sink = collect();
      const observe = createBrainChatMessageObserver({
        ingest: spyIngest({ status: "skipped", reason, pollBackstopped: false }).ingest,
        report: sink.report,
      });
      await observe(observation());
      expect([reason, sink.seen]).toEqual([reason, [{ level: "debug", reason }]]);
    }
  });

  // ⭐ #5203. The companion to the never-in-scope set above, and the reason
  // `scope_unreadable` had to be its own reason rather than folded into
  // `channel_not_configured`: one is the workspace saying no, the other is a
  // failed read. On a thread reply — which `conversations.history` never
  // returns, so the poll is not a backstop — a failed read is LOST EVIDENCE.
  //
  // MUTATION THIS CATCHES: adding `scope_unreadable` to NOTHING_TO_STORE, which
  // would silence exactly the alert that says the brain has stopped ingesting.
  it("⭐ WARNS when the ingest scope could not be read (#5203)", async () => {
    const sink = collect();
    const observe = createBrainChatMessageObserver({
      ingest: spyIngest({
        status: "skipped",
        reason: "scope_unreadable",
        pollBackstopped: false,
      }).ingest,
      report: sink.report,
    });
    await observe(observation());
    expect(sink.seen).toEqual([{ level: "warn", reason: "scope_unreadable" }]);
  });

  it("warns on a FAULT, which is never reported as backstopped", async () => {
    // `ingest_failed` means the path threw. If the internal DB is the cause,
    // the scheduled sync is failing too — so the reassurance would be exactly
    // backwards, which is why the writer reports that arm pessimistically.
    const sink = collect();
    const observe = createBrainChatMessageObserver({
      ingest: spyIngest({ status: "skipped", reason: "ingest_failed", pollBackstopped: false })
        .ingest,
      report: sink.report,
    });
    await observe(observation());
    expect(sink.seen).toEqual([{ level: "warn", reason: "ingest_failed" }]);
  });

  it("says nothing per-message while the knob is off", async () => {
    // `disabled` is the steady state, and at Slack volume a per-message line
    // would be the noisiest thing in the process — reporting the operator's own
    // configuration back to them.
    const sink = collect();
    const observe = createBrainChatMessageObserver({
      ingest: spyIngest({ status: "skipped", reason: "disabled", pollBackstopped: true }).ingest,
      report: sink.report,
    });
    await observe(observation());
    expect(sink.seen).toEqual([]);
  });

  it("says nothing when the message WAS stored", async () => {
    const sink = collect();
    for (const outcome of [
      { status: "inserted", sourceId: "C1:1.1" },
      { status: "duplicate", sourceId: "C1:1.1" },
    ] as SlackWebhookIngestOutcome[]) {
      const observe = createBrainChatMessageObserver({
        ingest: spyIngest(outcome).ingest,
        report: sink.report,
      });
      await observe(observation());
    }
    expect(sink.seen).toEqual([]);
  });
});
