/**
 * The Slack brain source's stored-config contract (#4770).
 *
 * `parseSlackHistoryConfig` is the READ side — it runs per cycle against a row
 * the install handler wrote, which means it also runs against a row somebody
 * edited by hand. Its errors land in `knowledge_sync_state.error`, so each one
 * has to say what to do about it.
 */

import { describe, expect, it } from "bun:test";
import {
  SLACK_CHANNEL_ID_PATTERN,
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_MAX_CHANNELS,
  SLACK_HISTORY_SLUG,
  SLACK_HISTORY_SOURCE,
  parseSlackHistoryConfig,
  slackEpisodeSourceId,
} from "@atlas/api/lib/brain/ingest/slack/config";

describe("identity constants", () => {
  it("keeps the catalog id and slug in lockstep", () => {
    expect(SLACK_HISTORY_CATALOG_ID).toBe(`catalog:${SLACK_HISTORY_SLUG}`);
  });

  it("uses the class name, not the vendor-qualified one, as the stored source", () => {
    // ADR-0036 is class-major, vendor-minor; `brain_episodes.source` carries
    // the vendor within the chat class.
    expect(SLACK_HISTORY_SOURCE).toBe("slack");
  });
});

describe("SLACK_CHANNEL_ID_PATTERN", () => {
  it("admits public and legacy-private channel ids", () => {
    expect(SLACK_CHANNEL_ID_PATTERN.test("C01ABCDEF")).toBe(true);
    expect(SLACK_CHANNEL_ID_PATTERN.test("G0123456789")).toBe(true);
  });

  it("refuses DM ids — a DM's audience is two people", () => {
    // ADR-0036 puts source-principal-resolution failure on the BLOCK side, and
    // DM membership is #4771's work.
    expect(SLACK_CHANNEL_ID_PATTERN.test("D01ABCDEF")).toBe(false);
  });

  it("refuses names, urls, and lowercase", () => {
    expect(SLACK_CHANNEL_ID_PATTERN.test("#general")).toBe(false);
    expect(SLACK_CHANNEL_ID_PATTERN.test("c01abcdef")).toBe(false);
    expect(SLACK_CHANNEL_ID_PATTERN.test("https://slack.com/C1")).toBe(false);
  });
});

describe("parseSlackHistoryConfig", () => {
  it("parses a normal config", () => {
    const parsed = parseSlackHistoryConfig({ channels: ["C01ABCDEF", "G0123456789"] });
    expect(parsed).toEqual({ ok: true, channels: ["C01ABCDEF", "G0123456789"] });
  });

  it("normalises case and drops duplicates", () => {
    const parsed = parseSlackHistoryConfig({ channels: ["c01abcdef", "C01ABCDEF"] });
    expect(parsed.ok && parsed.channels).toEqual(["C01ABCDEF"]);
  });

  it("refuses a missing or non-array channel list with a repair instruction", () => {
    for (const config of [null, {}, { channels: "C1" }]) {
      const parsed = parseSlackHistoryConfig(config as Record<string, unknown> | null);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toMatch(/re-install/i);
    }
  });

  it("refuses an out-of-band-edited channel id rather than silently skipping it", () => {
    // Silently dropping it would mean a source that reports success while
    // never reading a channel the admin believes is connected.
    const parsed = parseSlackHistoryConfig({ channels: ["C01ABCDEF", "D01DIRECT"] });
    expect(parsed.ok).toBe(false);
  });

  it("refuses an empty usable set", () => {
    expect(parseSlackHistoryConfig({ channels: [] }).ok).toBe(false);
    expect(parseSlackHistoryConfig({ channels: [42, null] }).ok).toBe(false);
  });

  it("refuses more channels than one source may scope", () => {
    const many = Array.from({ length: SLACK_HISTORY_MAX_CHANNELS + 1 }, (_, i) =>
      `C${String(i).padStart(8, "0")}`,
    );
    const parsed = parseSlackHistoryConfig({ channels: many });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain(String(SLACK_HISTORY_MAX_CHANNELS));
  });
});

describe("slackEpisodeSourceId", () => {
  it("is the documented `<channelId>:<ts>` format", () => {
    expect(slackEpisodeSourceId("C1", "1.000001")).toBe("C1:1.000001");
  });
});
