/**
 * The stage-0 triage rules (#5336) — pure predicates, no database, no model.
 *
 * Two directions, tested with opposite weights on purpose. The routed-OUT side
 * checks that the enumerated noise shapes are caught. The PASSED-THROUGH side
 * is the load-bearing one: a false drop is a real claim silently lost — the
 * exact failure the issue's marking scheme exists to make impossible to hide —
 * so most of this file is claims that MUST reach the model, including ones
 * that superficially resemble the noise shapes.
 */
import { describe, expect, it } from "bun:test";
import {
  TRIAGE_MIN_MEANINGFUL_CHARS,
  TRIAGE_RULES,
  TRIAGE_RULE_IDS,
  emptyTriageMatchCounts,
  normalizeForAck,
  triageEpisodeBody,
} from "@atlas/api/lib/brain/triage";

describe("the rule list itself", () => {
  it("is the one enumerable place — every rule carries an id from the closed vocabulary and a rationale", () => {
    // #5336's first acceptance criterion, structurally: the rules ARE this
    // list. An id outside TRIAGE_RULE_IDS cannot compile, but a duplicate or
    // an empty rationale can — and an admin page rendering this list needs
    // both to hold.
    const ids = TRIAGE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of TRIAGE_RULES) {
      expect(TRIAGE_RULE_IDS).toContain(rule.id);
      expect(rule.rationale.length).toBeGreaterThan(20);
    }
  });

  it("emptyTriageMatchCounts covers every rule id with a zero", () => {
    const counts = emptyTriageMatchCounts();
    expect(Object.keys(counts).sort()).toEqual([...TRIAGE_RULE_IDS].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe("routed out — the obvious majority", () => {
  it("catches bare acknowledgements by exact shape", () => {
    for (const body of ["+1", "on it", "ok", "thanks", "will do", "lgtm", "sounds good"]) {
      expect(triageEpisodeBody(body)).not.toBeNull();
    }
  });

  it("folds case, edge punctuation and whitespace before the ack match", () => {
    expect(triageEpisodeBody("  Thanks!!  ")).toBe("known_ack");
    expect(triageEpisodeBody("On it.")).toBe("known_ack");
    expect(triageEpisodeBody("SOUNDS   GOOD")).toBe("known_ack");
    expect(triageEpisodeBody("you’re welcome")).toBe("known_ack");
  });

  it("catches bodies too short to state a claim", () => {
    expect(triageEpisodeBody("k")).toBe("below_min_length");
    expect(triageEpisodeBody("👍")).toBe("below_min_length");
    // The boundary itself: one under the floor matches, the floor does not.
    expect(triageEpisodeBody("x".repeat(TRIAGE_MIN_MEANINGFUL_CHARS - 1))).toBe(
      "below_min_length",
    );
    expect(triageEpisodeBody("x".repeat(TRIAGE_MIN_MEANINGFUL_CHARS))).toBeNull();
  });

  it("catches pure emoji reactions, unicode and Slack-code form alike", () => {
    expect(triageEpisodeBody("🎉🎉🎉")).toBe("pure_reaction");
    expect(triageEpisodeBody("👍🏽 🙏 ✨")).toBe("pure_reaction");
    expect(triageEpisodeBody(":+1:")).toBe("pure_reaction");
    expect(triageEpisodeBody(":thumbsup: :tada:")).toBe("pure_reaction");
  });
});

describe("⭐ passed through — the direction stage 0 must not be wrong in", () => {
  it("passes ordinary claims", () => {
    for (const body of [
      "the deploy window moved to Thursdays",
      "Dana owns the billing pipeline now",
      "we dropped support for MySQL 5.7 last sprint",
    ]) {
      expect(triageEpisodeBody(body)).toBeNull();
    }
  });

  it("⭐ passes compounds that CONTAIN an ack — the ack match is equality, never containment", () => {
    // The cheapest wrong implementation is `body.includes("thanks")`, and it
    // silently drops the second half of every "thanks, and also <claim>"
    // message. These are real claims wearing an ack prefix.
    for (const body of [
      "thanks — deploy is moving to 5pm",
      "ok so the deploy window moved to Thursdays",
      "+1, and note the billing owner changed to Dana",
      "on it, the fix ships in 2.3.1",
    ]) {
      expect(triageEpisodeBody(body)).toBeNull();
    }
  });

  it("⭐ passes short-but-claim-bearing bodies — the length floor is timid on purpose", () => {
    // Three characters is enough to be a claim in context ("CEO", a ticket
    // id); the floor exists for one- and two-character bodies only. Raising
    // it is how a false drop gets introduced.
    expect(triageEpisodeBody("v2?")).toBeNull();
    expect(triageEpisodeBody("CEO")).toBeNull();
  });

  it("⭐ passes emoji mixed with words — only PURE reactions are reactions", () => {
    expect(triageEpisodeBody("ship it friday 🚀")).toBeNull();
    expect(triageEpisodeBody("the 🚀 launch is friday")).toBeNull();
  });

  it("passes digit-only bodies — Emoji_Component alone must not read digits as emoji", () => {
    // "123" is all Emoji_Component (keycap bases). Without the pictograph
    // requirement the reaction rule would eat numeric answers.
    expect(triageEpisodeBody("1234")).toBeNull();
  });

  it("passes negations and modified acks that stopped being acks", () => {
    // "not ok" and "ok but why" carry information the bare shapes do not.
    expect(triageEpisodeBody("not ok")).toBeNull();
    expect(triageEpisodeBody("ok but why")).toBeNull();
  });

  it("returns null for whitespace-only bodies — that class belongs to the no_body skip", () => {
    // Two modules claiming one body class would make the cycle counters
    // disagree; extract.ts routes these to `no_body` before triage runs, and
    // the pure function honors the same boundary for a caller that does not.
    expect(triageEpisodeBody("   ")).toBeNull();
    expect(triageEpisodeBody("")).toBeNull();
  });
});

describe("normalizeForAck", () => {
  it("strips edge punctuation but preserves interior structure", () => {
    expect(normalizeForAck("Thanks!!")).toBe("thanks");
    // Interior punctuation survives, so a compound can never fold into a bare
    // ack shape.
    expect(normalizeForAck("thanks, deploy is at 5")).toBe("thanks, deploy is at 5");
  });
});
