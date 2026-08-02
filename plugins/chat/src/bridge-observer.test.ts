/**
 * Tests for `buildObservedMessageHandler` — the per-message observer wrapper
 * extracted from the `chat.onNewMention/onSubscribedMessage/onNewMessage`
 * registrations inside `createChatBridge` (#4967), following the same
 * extract-then-unit-test pattern as `bridge-actions.test.ts`.
 *
 * There is exactly ONE load-bearing property here and the rest is plumbing:
 * **the handler never rejects.** The Chat SDK's `runHandlers` awaits each
 * handler in turn with no try/catch of its own, and the observer is registered
 * FIRST so the brain's write is not queued behind a full agent turn. A
 * rejecting observer would therefore abort every handler after it — the brain
 * fast-path taking the chat pillar's answer down with it, for a side-channel
 * whose failure the scheduled poll already covers.
 *
 * The chat-sdk `Thread` is structurally compatible with the handler's
 * `ObservedMessageThread` subset, so these pass plain objects rather than
 * construct real SDK types.
 */

import { describe, expect, it } from "bun:test";
import {
  buildObservedMessageHandler,
  OBSERVE_ANY_MESSAGE_PATTERN,
  OBSERVE_DEADLINE_MS,
  registerMessageObserver,
  type MessageObserverRegistrar,
  type ObservedMessageThread,
} from "./bridge";
import type { ChatMessageObservation } from "./config";
import type { Message } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";

function makeLogger(): { log: PluginLogger; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const log = {
    info: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
    error: () => {},
    debug: () => {},
  } as unknown as PluginLogger;
  return { log, warns };
}

const THREAD: ObservedMessageThread = { adapter: { name: "slack" } };

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "1750000000.000100",
    raw: { type: "message", channel: "C01ABCDEF", ts: "1750000000.000100" },
    text: "the deploy window is Thursdays",
    ...overrides,
  } as unknown as Message;
}

describe("buildObservedMessageHandler", () => {
  it("hands the observer the platform, the message id, and the RAW payload", () => {
    // The raw payload is the whole point of the seam: the brain's writer reads
    // Slack's own `channel` / `ts` / `channel_type` off it, which no normalised
    // SDK field carries. Passing it through by reference (not a copy) keeps the
    // plugin from having to know the vendor's shape.
    const seen: ChatMessageObservation[] = [];
    const { log } = makeLogger();
    const handler = buildObservedMessageHandler(async (o) => {
      seen.push(o);
    }, log);

    const msg = message();
    return handler(THREAD, msg).then(() => {
      expect(seen).toHaveLength(1);
      expect(seen[0]?.platform).toBe("slack");
      expect(seen[0]?.message.id).toBe("1750000000.000100");
      expect(seen[0]?.message.raw).toBe(msg.raw);
    });
  });

  it("reports the platform that actually delivered the message", () => {
    // Every wired adapter routes through this one observer, and only Slack has
    // a brain source today. The host's platform switch is what refuses the
    // others, so it has to be told the truth about which one this was.
    const seen: string[] = [];
    const { log } = makeLogger();
    const handler = buildObservedMessageHandler(async (o) => {
      seen.push(o.platform);
    }, log);
    return handler({ adapter: { name: "teams" } }, message()).then(() => {
      expect(seen).toEqual(["teams"]);
    });
  });

  it("does NOT reject when the observer throws synchronously", async () => {
    const { log, warns } = makeLogger();
    const handler = buildObservedMessageHandler(() => {
      throw new Error("brain writer exploded");
    }, log);
    // `resolves.toBeUndefined()` rather than a bare await: an unhandled
    // rejection here is the exact failure this wrapper exists to prevent, so
    // the assertion has to be about the promise, not about reaching the next
    // line.
    await expect(handler(THREAD, message())).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
  });

  it("does NOT reject when the observer rejects asynchronously", async () => {
    const { log, warns } = makeLogger();
    const handler = buildObservedMessageHandler(
      async () => {
        throw new Error("internal DB unreachable");
      },
      log,
    );
    await expect(handler(THREAD, message())).resolves.toBeUndefined();
    // Swallowed, but never SILENT: a fast path failing while the poll covers
    // for it is invisible from the outside — the episodes still appear, just a
    // sync tick late.
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0])).toContain("internal DB unreachable");
  });

  it("names the message in the warning so a failure is traceable to one event", () => {
    const { log, warns } = makeLogger();
    const handler = buildObservedMessageHandler(async () => {
      throw new Error("boom");
    }, log);
    return handler(THREAD, message({ id: "1750000123.000456" } as Partial<Message>)).then(() => {
      expect(JSON.stringify(warns[0])).toContain("1750000123.000456");
      expect(JSON.stringify(warns[0])).toContain("slack");
    });
  });
});

describe("OBSERVE_ANY_MESSAGE_PATTERN", () => {
  it("matches any message carrying at least one character", () => {
    expect(OBSERVE_ANY_MESSAGE_PATTERN.test("hello")).toBe(true);
    expect(OBSERVE_ANY_MESSAGE_PATTERN.test(" ")).toBe(true);
    // `.` would NOT match this one. The difference is one input, and it is the
    // reason the pattern is a shared constant rather than restated at the
    // registration site.
    expect(OBSERVE_ANY_MESSAGE_PATTERN.test("\n")).toBe(true);
  });

  it("does not match an empty message", () => {
    // Not a coverage gap: an empty body is refused outright by
    // `chk_brain_episodes_body_xor_locator`, and the poll skips those too
    // (`toEpisode`'s `emptyText` arm). The pattern arm and the ingest agree.
    expect(OBSERVE_ANY_MESSAGE_PATTERN.test("")).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Which dispatch arms the observer is registered on
// ---------------------------------------------------------------------------

/** Records every registration so a test can assert the arm SET, not the effect. */
function recordingRegistrar(): {
  registrar: MessageObserverRegistrar;
  arms: string[];
  patterns: RegExp[];
  handlers: Array<(t: ObservedMessageThread, m: Message) => Promise<void>>;
} {
  const arms: string[] = [];
  const patterns: RegExp[] = [];
  const handlers: Array<(t: ObservedMessageThread, m: Message) => Promise<void>> = [];
  return {
    arms,
    patterns,
    handlers,
    registrar: {
      onNewMention(h) {
        arms.push("onNewMention");
        handlers.push(h);
      },
      onSubscribedMessage(h) {
        arms.push("onSubscribedMessage");
        handlers.push(h);
      },
      onNewMessage(p, h) {
        arms.push("onNewMessage");
        patterns.push(p);
        handlers.push(h);
      },
      onDirectMessage(h) {
        arms.push("onDirectMessage");
        handlers.push(h);
      },
    },
  };
}

describe("registerMessageObserver", () => {
  it("registers on mention, subscribed AND pattern — not the pattern arm alone", () => {
    // `Chat.dispatchToHandlers` is a router with early returns, so a
    // pattern-only registration silently misses every @-mention and every
    // follow-up in a subscribed thread — the highest-value messages in the
    // channel. This is the assertion that would go red if someone "simplified"
    // the registration down to the one arm the proactive listener uses.
    const { registrar, arms } = recordingRegistrar();
    registerMessageObserver(registrar, async () => {}, makeLogger().log);
    expect(arms).toEqual(["onNewMention", "onSubscribedMessage", "onNewMessage"]);
  });

  it("never registers on the DM arm", () => {
    // Separate assertion from the set above, because this one is a POSTURE:
    // 1:1 DMs are not admissible channels for the brain's chat source, and a
    // registration here would spend a DB round trip per DM to reach a
    // guaranteed refusal. Asserted negatively so the omission cannot be
    // reversed silently.
    const { registrar, arms } = recordingRegistrar();
    registerMessageObserver(registrar, async () => {}, makeLogger().log);
    expect(arms).not.toContain("onDirectMessage");
  });

  it("registers the shared pattern constant on the pattern arm", () => {
    const { registrar, patterns } = recordingRegistrar();
    registerMessageObserver(registrar, async () => {}, makeLogger().log);
    expect(patterns).toEqual([OBSERVE_ANY_MESSAGE_PATTERN]);
  });

  it("registers the WRAPPED handler on every arm, not the raw host callback", () => {
    // If the raw callback were registered, a host throw would abort the pillar
    // handler for that message. Proven by behaviour rather than by identity:
    // every registered handler must swallow a rejection.
    const { registrar, handlers } = recordingRegistrar();
    registerMessageObserver(
      registrar,
      async () => {
        throw new Error("host observer exploded");
      },
      makeLogger().log,
    );
    expect(handlers).toHaveLength(3);
    return Promise.all(
      handlers.map((h) => expect(h(THREAD, message())).resolves.toBeUndefined()),
    );
  });
});

describe("registration ORDER inside createChatBridge", () => {
  it("registers the observer before the pillar's own mention handler", async () => {
    // Pinned against the SOURCE, which is unusual and deliberate. The ordering
    // is invisible at runtime — both handlers run either way — but it is the
    // entire latency win: registered after `handleMentionOrDM`, the brain write
    // would wait for a full agent turn, seconds to minutes. There is no
    // behavioural assertion that distinguishes the two orders without standing
    // up the whole SDK, so the source pin is the honest instrument.
    const src = await Bun.file(new URL("./bridge.ts", import.meta.url)).text();
    // Anchored on the STATEMENT form (newline + indent + call), not on the bare
    // call text: both lines are also named in the comment above them, and an
    // `indexOf` that matched the prose would compare two comment positions and
    // pass regardless of the real order.
    const observerAt = src.indexOf("\n    registerMessageObserver(chat, config.observeMessage, log);");
    const pillarAt = src.indexOf("\n  chat.onNewMention(handleMentionOrDM);");
    expect(observerAt).toBeGreaterThan(-1);
    expect(pillarAt).toBeGreaterThan(-1);
    expect(observerAt).toBeLessThan(pillarAt);
  });

  it("registers the observer only when the host wired one", async () => {
    // The seam is additive and host-optional: self-host without the brain
    // fast-path must behave exactly as before.
    const src = await Bun.file(new URL("./bridge.ts", import.meta.url)).text();
    expect(src).toContain("if (config.observeMessage) {");
  });
});

// ---------------------------------------------------------------------------
// The deadline — the invariant the try/catch does NOT cover
// ---------------------------------------------------------------------------

describe("observer deadline", () => {
  it("stops waiting on an observer that never settles", async () => {
    // The damaging failure is BLOCKING, not throwing: the observer runs first,
    // inline, while the SDK holds the thread lock, and the Atlas host wires it
    // to uncached DB round trips. Without this bound a degraded internal DB
    // turns a "contributes nothing to correctness" feature into a chat-pillar
    // stall. A short deadline is injected so the test does not sleep for the
    // production one.
    const { log, warns } = makeLogger();
    const handler = buildObservedMessageHandler(() => new Promise<void>(() => {}), log, 25);

    // Raced against a test-side timer rather than plain `await`. With the
    // deadline REMOVED — the mutation this test exists to catch — a bare await
    // never settles, and the suite HANGS instead of failing. A hang is a much
    // worse signal than a red assertion: it reports nothing and stalls CI. This
    // shape turns the same defect into `expected "settled", got "hung"`.
    const outcome = await Promise.race([
      handler(THREAD, message()).then(() => "settled" as const),
      new Promise<"hung">((resolve) => {
        setTimeout(() => resolve("hung"), 1_000);
      }),
    ]);
    expect(outcome).toBe("settled");
    expect(JSON.stringify(warns[0])).toContain("exceeded");
  });

  it("does not penalise an observer that settles inside the deadline", async () => {
    const { log, warns } = makeLogger();
    let seen = 0;
    const handler = buildObservedMessageHandler(
      async () => {
        seen++;
      },
      log,
      25,
    );
    await handler(THREAD, message());
    expect(seen).toBe(1);
    expect(warns).toHaveLength(0);
  });

  it("ships a production deadline well under the SDK's 30s thread-lock TTL", () => {
    // The number matters, not just its existence: past `DEFAULT_LOCK_TTL_MS`
    // the lock expires mid-handler and a second message can acquire it,
    // breaking the SDK's per-thread isolation.
    expect(OBSERVE_DEADLINE_MS).toBeLessThan(30_000);
    expect(OBSERVE_DEADLINE_MS).toBeGreaterThan(0);
  });
});
