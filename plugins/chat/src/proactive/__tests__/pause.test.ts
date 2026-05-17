/**
 * Tests for the pure pause-detection + pause-request helpers (#2295).
 *
 * Keeps the listener test focussed on wiring by exercising the regex
 * detectors and the layer-resolver here.
 */
import { describe, expect, it } from "bun:test";
import {
  CHANNEL_PAUSE_DURATION_MS,
  detectPauseCommand,
  detectUnsubscribeDM,
  resolvePauseRequest,
} from "../pause";

// ---------------------------------------------------------------------------
// detectPauseCommand
// ---------------------------------------------------------------------------

describe("detectPauseCommand", () => {
  it("matches the bare `@atlas pause` form", () => {
    expect(detectPauseCommand("@atlas pause")).toBe(true);
  });
  it("matches when the command is the prefix of a longer message", () => {
    expect(detectPauseCommand("@atlas pause this channel for a bit")).toBe(true);
  });
  it("matches when the verb is preceded by punctuation", () => {
    expect(detectPauseCommand("@atlas, pause this channel")).toBe(true);
  });
  it("matches the Slack-style platform mention token", () => {
    expect(detectPauseCommand("<@U123|atlas> pause")).toBe(true);
  });
  it("matches the bare-name form (no @ prefix)", () => {
    expect(detectPauseCommand("atlas pause please")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(detectPauseCommand("@Atlas PAUSE")).toBe(true);
  });
  it("does NOT match `pause` alone", () => {
    expect(detectPauseCommand("pause")).toBe(false);
  });
  it("does NOT match an unrelated verb after @atlas", () => {
    expect(detectPauseCommand("@atlas reset")).toBe(false);
  });
  it("does NOT match a message where pause appears far from @atlas", () => {
    expect(
      detectPauseCommand(
        "Hey @atlas, can you look at MRR? I want to pause everything else and focus.",
      ),
    ).toBe(false);
  });
  it("returns false for the empty string", () => {
    expect(detectPauseCommand("")).toBe(false);
  });
  it("returns false for whitespace-only input", () => {
    expect(detectPauseCommand("   \n\t  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectUnsubscribeDM
// ---------------------------------------------------------------------------

describe("detectUnsubscribeDM", () => {
  it("matches the bare keyword", () => {
    expect(detectUnsubscribeDM("unsubscribe")).toBe(true);
  });
  it("matches with surrounding whitespace", () => {
    expect(detectUnsubscribeDM("  unsubscribe  ")).toBe(true);
  });
  it("matches with trailing punctuation", () => {
    expect(detectUnsubscribeDM("unsubscribe.")).toBe(true);
    expect(detectUnsubscribeDM("unsubscribe!")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(detectUnsubscribeDM("UNSUBSCRIBE")).toBe(true);
  });
  it("does NOT match a question containing the word", () => {
    expect(detectUnsubscribeDM("how do I unsubscribe?")).toBe(false);
  });
  it("does NOT match prefix words", () => {
    expect(detectUnsubscribeDM("unsubscribed")).toBe(false);
    expect(detectUnsubscribeDM("unsubscribe me")).toBe(false);
  });
  it("returns false for the empty string", () => {
    expect(detectUnsubscribeDM("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolvePauseRequest
// ---------------------------------------------------------------------------

describe("resolvePauseRequest", () => {
  it("maps an in-channel pause command to a 24h channel-scoped row", () => {
    const NOW = 1_000_000;
    const req = resolvePauseRequest("channel-pause-command", {
      workspaceId: "ws_1",
      channelId: "C_1",
      userId: "U_1",
      now: () => NOW,
    });
    expect(req).toEqual({
      workspaceId: "ws_1",
      channelId: "C_1",
      userId: "U_1",
      layer: "channel-24h",
      durationMs: CHANNEL_PAUSE_DURATION_MS,
      requestedAt: NOW,
    });
  });
  it("maps a DM unsubscribe to an indefinite workspace-scoped user-optout row", () => {
    const NOW = 2_000_000;
    const req = resolvePauseRequest("dm-unsubscribe", {
      workspaceId: "ws_1",
      channelId: "D_1",
      userId: "U_1",
      now: () => NOW,
    });
    expect(req).toEqual({
      workspaceId: "ws_1",
      // user-optout is workspace-scoped — channelId is dropped to NULL.
      channelId: null,
      userId: "U_1",
      layer: "user-optout",
      durationMs: null,
      requestedAt: NOW,
    });
  });
});
