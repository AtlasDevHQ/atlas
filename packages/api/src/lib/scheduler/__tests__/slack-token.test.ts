/**
 * Tests for `resolveSlackBotToken` (#3379) — the single statement of the
 * scheduled-delivery Slack sender-resolution rule: per-team bot token from the
 * store first, then the `SLACK_BOT_TOKEN` env fallback. Coverage added by #4195
 * (the periodic-DB-job runner pass) — the delivery + preflight consumers relied
 * on this seam being correct but it had no direct unit test.
 *
 * The `getBotTokenImpl` injection parameter is the intended test seam: it lets
 * these cases exercise the store-first-then-env chain without dragging the
 * dynamically-imported `@atlas/api/lib/slack/store` into the module graph.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveSlackBotToken } from "../slack-token";

const KEY = "SLACK_BOT_TOKEN";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("resolveSlackBotToken", () => {
  it("returns the per-team bot token when the store has one (env not consulted)", async () => {
    process.env[KEY] = "xoxb-env-fallback";
    let seenTeam: string | undefined;
    const token = await resolveSlackBotToken("T123", async (id) => {
      seenTeam = id;
      return "xoxb-team-token";
    });
    expect(seenTeam).toBe("T123");
    expect(token).toBe("xoxb-team-token");
  });

  it("prefers a non-empty team token over a set env token when both exist", async () => {
    process.env[KEY] = "xoxb-env";
    const token = await resolveSlackBotToken("T999", async () => "xoxb-team");
    expect(token).toBe("xoxb-team");
  });

  it("falls back to SLACK_BOT_TOKEN when the store returns null for the team", async () => {
    process.env[KEY] = "xoxb-env-fallback";
    const token = await resolveSlackBotToken("T123", async () => null);
    expect(token).toBe("xoxb-env-fallback");
  });

  it("treats an empty-string team token as absent and falls back to env", async () => {
    process.env[KEY] = "xoxb-env";
    const token = await resolveSlackBotToken("T123", async () => "");
    expect(token).toBe("xoxb-env");
  });

  it("skips the store lookup entirely when teamId is undefined and uses the env token", async () => {
    process.env[KEY] = "xoxb-env-fallback";
    let called = false;
    const token = await resolveSlackBotToken(undefined, async () => {
      called = true;
      return "unreachable";
    });
    expect(called).toBe(false);
    expect(token).toBe("xoxb-env-fallback");
  });

  it("returns null when there is neither a team token nor an env token", async () => {
    const token = await resolveSlackBotToken("T123", async () => null);
    expect(token).toBeNull();
  });

  it("treats an empty-string SLACK_BOT_TOKEN as absent (no sender)", async () => {
    process.env[KEY] = "";
    const token = await resolveSlackBotToken("T123", async () => null);
    expect(token).toBeNull();
  });

  it("returns null with no team and no env — the fully-unconfigured case", async () => {
    const token = await resolveSlackBotToken(undefined, async () => "unreachable");
    expect(token).toBeNull();
  });
});
