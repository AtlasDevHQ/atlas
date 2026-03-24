/**
 * Tests for the status reaction lifecycle.
 *
 * Covers:
 * - Lifecycle transitions (received → processing → complete/error)
 * - Graceful degradation when adapter reactions fail
 * - Custom emoji overrides
 * - Disabled reactions (no-op stub)
 * - Type-safe emoji via StatusEmoji constants
 * - Failed addReaction does not leave stale currentEmoji
 * - Simultaneous addReaction + removeReaction failures
 * - Config schema validation (EmojiValue shape)
 */

import { describe, expect, it, mock } from "bun:test";
import { emoji } from "chat";
import {
  ReactionLifecycle,
  StatusEmoji,
  createReactionLifecycle,
} from "./reactions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(overrides?: Partial<{
  addReaction: ReturnType<typeof mock>;
  removeReaction: ReturnType<typeof mock>;
}>) {
  return {
    name: "slack",
    addReaction: overrides?.addReaction ?? mock(() => Promise.resolve()),
    removeReaction: overrides?.removeReaction ?? mock(() => Promise.resolve()),
  };
}

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// StatusEmoji constants
// ---------------------------------------------------------------------------

describe("StatusEmoji", () => {
  it("uses Chat SDK emoji singletons", () => {
    expect(StatusEmoji.received).toBe(emoji.eyes);
    expect(StatusEmoji.processing).toBe(emoji.hourglass);
    expect(StatusEmoji.complete).toBe(emoji.check);
    expect(StatusEmoji.error).toBe(emoji.warning);
  });

  it("emoji values have a name property", () => {
    expect(StatusEmoji.received.name).toBe("eyes");
    expect(StatusEmoji.processing.name).toBe("hourglass");
    expect(StatusEmoji.complete.name).toBe("check");
    expect(StatusEmoji.error.name).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// ReactionLifecycle
// ---------------------------------------------------------------------------

describe("ReactionLifecycle", () => {
  it("adds received reaction on markReceived", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();

    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
    expect(adapter.addReaction).toHaveBeenCalledWith("thread-1", "msg-1", emoji.eyes);
    expect(adapter.removeReaction).not.toHaveBeenCalled();
  });

  it("transitions from received → processing (remove + add)", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    await lifecycle.markProcessing();

    expect(adapter.removeReaction).toHaveBeenCalledTimes(1);
    expect(adapter.removeReaction).toHaveBeenCalledWith("thread-1", "msg-1", emoji.eyes);
    expect(adapter.addReaction).toHaveBeenCalledTimes(2);
    expect(adapter.addReaction).toHaveBeenLastCalledWith("thread-1", "msg-1", emoji.hourglass);
  });

  it("full success lifecycle: received → processing → complete", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    await lifecycle.markProcessing();
    await lifecycle.markComplete();

    // 3 adds: eyes, hourglass, check
    expect(adapter.addReaction).toHaveBeenCalledTimes(3);
    // 2 removes: eyes (before hourglass), hourglass (before check)
    expect(adapter.removeReaction).toHaveBeenCalledTimes(2);
  });

  it("full error lifecycle: received → processing → error", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    await lifecycle.markProcessing();
    await lifecycle.markError();

    expect(adapter.addReaction).toHaveBeenCalledTimes(3);
    expect(adapter.addReaction).toHaveBeenLastCalledWith("thread-1", "msg-1", emoji.warning);
  });

  it("uses custom emoji when configured", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const customReceived = emoji.star;
    const customComplete = emoji.rocket;

    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
      { customEmoji: { received: customReceived, complete: customComplete } },
    );

    await lifecycle.markReceived();
    expect(adapter.addReaction).toHaveBeenCalledWith("thread-1", "msg-1", emoji.star);

    await lifecycle.markProcessing();
    // Should still use default hourglass for processing
    expect(adapter.addReaction).toHaveBeenLastCalledWith("thread-1", "msg-1", emoji.hourglass);

    await lifecycle.markComplete();
    expect(adapter.addReaction).toHaveBeenLastCalledWith("thread-1", "msg-1", emoji.rocket);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe("graceful degradation", () => {
  it("continues when addReaction throws", async () => {
    const adapter = createMockAdapter({
      addReaction: mock(() => Promise.reject(new Error("API error"))),
    });
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    // Should not throw
    await lifecycle.markReceived();
    expect(log.debug).toHaveBeenCalled();
  });

  it("continues when removeReaction throws", async () => {
    const addReaction = mock(() => Promise.resolve());
    const removeReaction = mock(() => Promise.reject(new Error("API error")));
    const adapter = createMockAdapter({ addReaction, removeReaction });
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    // Transition should still add the new reaction even if remove fails
    await lifecycle.markProcessing();

    expect(removeReaction).toHaveBeenCalledTimes(1);
    expect(addReaction).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalled();
  });

  it("handles non-Error thrown values", async () => {
    const adapter = createMockAdapter({
      addReaction: mock(() => Promise.reject("string error")),
    });
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    expect(log.debug).toHaveBeenCalled();
  });

  it("does not attempt to remove a reaction that failed to add", async () => {
    let callCount = 0;
    const addReaction = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("API error"));
      return Promise.resolve();
    });
    const removeReaction = mock(() => Promise.resolve());
    const adapter = createMockAdapter({ addReaction, removeReaction });
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();   // fails to add
    await lifecycle.markProcessing(); // should NOT remove, should add

    expect(removeReaction).not.toHaveBeenCalled();
    expect(addReaction).toHaveBeenCalledTimes(2);
  });

  it("continues when both removeReaction and addReaction throw in one transition", async () => {
    let addCallCount = 0;
    const addReaction = mock(() => {
      addCallCount++;
      if (addCallCount === 1) return Promise.resolve(); // markReceived succeeds
      return Promise.reject(new Error("API down"));     // markProcessing fails
    });
    const removeReaction = mock(() => Promise.reject(new Error("API down")));
    const adapter = createMockAdapter({ addReaction, removeReaction });
    const log = createMockLogger();
    const lifecycle = new ReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    await lifecycle.markProcessing(); // both remove + add fail

    // Should have logged for both remove and add failures
    expect(log.debug).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createReactionLifecycle
// ---------------------------------------------------------------------------

describe("createReactionLifecycle", () => {
  it("returns a real lifecycle when enabled (default)", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = createReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
    );

    await lifecycle.markReceived();
    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
  });

  it("returns a no-op stub when disabled", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = createReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
      { enabled: false },
    );

    await lifecycle.markReceived();
    await lifecycle.markProcessing();
    await lifecycle.markComplete();
    await lifecycle.markError();

    // No adapter calls made
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(adapter.removeReaction).not.toHaveBeenCalled();
  });

  it("returns a real lifecycle when enabled is true", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = createReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
      { enabled: true },
    );

    await lifecycle.markReceived();
    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
  });

  it("passes custom emoji config through", async () => {
    const adapter = createMockAdapter();
    const log = createMockLogger();
    const lifecycle = createReactionLifecycle(
      adapter as never, "thread-1", "msg-1", log as never,
      { customEmoji: { received: emoji.sparkles } },
    );

    await lifecycle.markReceived();
    expect(adapter.addReaction).toHaveBeenCalledWith("thread-1", "msg-1", emoji.sparkles);
  });
});

// ---------------------------------------------------------------------------
// Config validation (reactions in ChatConfigSchema)
// ---------------------------------------------------------------------------

describe("ChatConfigSchema reactions field", () => {
  // Import here to avoid circular deps affecting other test groups
  const { ChatConfigSchema } = require("../config");

  const baseConfig = {
    adapters: { slack: { botToken: "xoxb-test", signingSecret: "test-secret" } },
    executeQuery: () => Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
  };

  it("accepts config without reactions (default)", () => {
    const result = ChatConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
  });

  it("accepts reactions with enabled: true", () => {
    const result = ChatConfigSchema.safeParse({
      ...baseConfig,
      reactions: { enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts reactions with enabled: false", () => {
    const result = ChatConfigSchema.safeParse({
      ...baseConfig,
      reactions: { enabled: false },
    });
    expect(result.success).toBe(true);
  });

  it("accepts reactions with custom emoji (EmojiValue objects)", () => {
    const result = ChatConfigSchema.safeParse({
      ...baseConfig,
      reactions: {
        enabled: true,
        customEmoji: { received: emoji.star },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-EmojiValue custom emoji values", () => {
    const result = ChatConfigSchema.safeParse({
      ...baseConfig,
      reactions: {
        customEmoji: { received: "raw-string" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects numeric custom emoji values", () => {
    const result = ChatConfigSchema.safeParse({
      ...baseConfig,
      reactions: {
        customEmoji: { received: 42 },
      },
    });
    expect(result.success).toBe(false);
  });
});
