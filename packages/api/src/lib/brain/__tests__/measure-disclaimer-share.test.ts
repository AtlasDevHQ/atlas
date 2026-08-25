/**
 * The #5420 measurement script's two non-pure seams (`scripts/measure-disclaimer-share.ts`).
 *
 * `boilerplate-tail.test.ts` covers the detector. What is left here is the part
 * that talks to the world, driven through a hand-rolled pg stub so no database
 * is involved:
 *
 *   1. The workspace read selects the right rows, groups them at the right
 *      grain, and hands the detector the STRIPPED view rather than the stored
 *      body. A measurement taken over unstripped bodies would count quoted
 *      history as boilerplate and report a share #5354 already removed.
 *   2. Cap pressure — #5420's second claim, that a disclaimer "eats into
 *      `MAX_BODY_CHARS` on exactly the messages already closest to the cap".
 *      This is the one case where a tail costs a CLAIM and not just tokens,
 *      because the cap cuts from the end and so does the tail.
 */

import { describe, expect, it } from "bun:test";
import {
  groupOf,
  measure,
  parseRfc822,
  readWorkspaceSamples,
} from "../../../../scripts/measure-disclaimer-share";
import { MAX_BODY_CHARS } from "@atlas/api/lib/brain/extract-contract";
import type { TailSample } from "@atlas/api/lib/brain/boilerplate-tail";

interface Captured {
  sql: string;
  params: unknown[];
}

/** Minimal pg stub that records what it was asked for and returns canned rows. */
function makeClient(rows: Record<string, unknown>[], captured: Captured[]) {
  return {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> => {
      captured.push({ sql, params: params ?? [] });
      return { rows: rows as T[] };
    },
  };
}

describe("groupOf — the grouping key", () => {
  it("takes the domain out of every address shape a mail header uses", () => {
    expect(groupOf("Sam Reyes <sam@acme.com>")).toBe("acme.com");
    expect(groupOf("sam@acme.com")).toBe("acme.com");
    expect(groupOf("  <SAM@ACME.COM>  ")).toBe("acme.com");
  });

  it("falls back rather than inventing a domain", () => {
    // A malformed sender must not silently join some other sender's group,
    // where its text would count toward that group's repeated tails.
    expect(groupOf(null)).toBe("(unknown)");
    expect(groupOf("not-an-address")).toBe("not-an-address");
    expect(groupOf("trailing@")).toBe("trailing@");
  });
});

describe("parseRfc822 — the corpus lane's reader", () => {
  const raw = `Message-ID: <1@acme.com>
X-Folder: \\Sent
Subject: Re: Launch
From: Sam Reyes <sam@acme.com>
To: Dana
 Kim <dana@beta.com>
Date: Mon, 24 Aug 2026 09:20:00 -0000

The migration finished Tuesday.`;

  it("keeps only the headers composeEmailBody stores, in its order", () => {
    // Fidelity to production is the point: a corpus file carries dozens of
    // headers the extractor never sees, and measuring those would inflate the
    // denominator with text that costs nothing.
    const parsed = parseRfc822(raw);
    const headerBlock = parsed?.body.split("\n\n")[0] ?? "";

    expect(headerBlock.split("\n").map((l) => l.split(":")[0])).toEqual([
      "Subject",
      "From",
      "To",
      "Date",
    ]);
    expect(headerBlock).not.toContain("Message-ID");
    expect(headerBlock).not.toContain("X-Folder");
  });

  it("unfolds a continuation line rather than dropping it", () => {
    expect(parseRfc822(raw)?.body).toContain("To: Dana Kim <dana@beta.com>");
  });

  it("reports the sender so the caller can group by it", () => {
    expect(parseRfc822(raw)?.sender).toBe("Sam Reyes <sam@acme.com>");
  });

  it("declines a file with no header/body split or no body", () => {
    // Counted as `unreadable` by the caller. Returning an empty sample instead
    // would put a zero-length message into the denominator.
    expect(parseRfc822("no blank line here")).toBeNull();
    expect(parseRfc822("Subject: x\n\n   \n  ")).toBeNull();
  });
});

describe("readWorkspaceSamples — what it asks the database for", () => {
  it("scopes to the workspace and to EMAIL-CLASS sources, derived not hard-coded", async () => {
    const captured: Captured[] = [];
    await readWorkspaceSamples(makeClient([], captured), "ws_1", 500);

    const call = captured[0];
    expect(call?.params[0]).toBe("ws_1");
    expect(call?.params[2]).toBe(500);

    const sources = call?.params[1] as string[];
    // The mail vendor of the day is in…
    expect(sources).toContain("outlook");
    // …and every non-mail class is out. `quoted-reply.ts` gates on CLASS
    // precisely so a second mail vendor inherits the strip with no code change;
    // a measurement that hard-coded "outlook" would quietly stop covering the
    // thing it measures on the day that happens, and under-report while doing it.
    for (const nonMail of ["slack", "zoom", "warehouse", "human"]) {
      expect(sources).not.toContain(nonMail);
    }
  });

  it("never asks for rows with no body", async () => {
    const captured: Captured[] = [];
    await readWorkspaceSamples(makeClient([], captured), "ws_1", 10);
    expect(captured[0]?.sql).toContain("body IS NOT NULL");
  });
});

describe("readWorkspaceSamples — what it does with the rows", () => {
  const row = (actor: string | null, body: string) => ({
    source: "outlook",
    source_actor: actor,
    body,
  });

  it("hands the detector the STRIPPED view, not the stored body", async () => {
    // The stored body carries quoted history. #5354 already removes that, and
    // counting it here would inflate the disclaimer share with text the
    // extractor never sees.
    const samples = await readWorkspaceSamples(
      makeClient(
        [
          row(
            "Sam <sam@acme.com>",
            `Subject: Re: Launch
From: Sam <sam@acme.com>

Yes, ship it Friday.

On Mon, Aug 24, 2026 at 9:14 AM Dana <dana@x.com> wrote:
> Are we ready for Friday?`,
          ),
        ],
        [],
      ),
      "ws_1",
      10,
    );

    expect(samples[0]?.text).toContain("Yes, ship it Friday.");
    expect(samples[0]?.text).not.toContain("Are we ready for Friday?");
  });

  it("groups by sender DOMAIN, so one gateway footer is seen across senders", async () => {
    // A legal disclaimer is appended by the org's mail gateway, so it repeats
    // across every sender at that org. At address grain it would need
    // `minRepeats` messages from each individual person before it counted.
    const samples = await readWorkspaceSamples(
      makeClient(
        [
          row("Sam Reyes <sam@acme.com>", "one"),
          row("dana@ACME.com", "two"),
          row("Kim <kim@beta.com>", "three"),
          row(null, "four"),
        ],
        [],
      ),
      "ws_1",
      10,
    );

    expect(samples.map((s) => s.group)).toEqual([
      "acme.com",
      "acme.com",
      "beta.com",
      "(unknown)",
    ]);
  });

  it("drops a row whose body came back null rather than measuring an empty string", async () => {
    const samples = await readWorkspaceSamples(
      makeClient(
        [row("sam@acme.com", "real body"), { source: "outlook", source_actor: "x@y.com", body: null }],
        [],
      ),
      "ws_1",
      10,
    );
    expect(samples).toHaveLength(1);
  });
});

describe("measure — how the cap and the tail actually interact", () => {
  const FOOTER = ["", "Confidential and intended solely for the addressee.", "Acme Corp."];
  const footerText = FOOTER.join("\n");
  const footerCost = FOOTER.reduce((sum, line) => sum + line.length + 1, 0);

  const sample = (novel: string): TailSample => ({
    group: "acme.com",
    text: `${novel}\n${footerText}`,
  });

  /**
   * Three messages of the given novel length that share the footer but NOT each
   * other's body.
   *
   * The distinct suffix per message is load-bearing, not decoration: identical
   * bodies trip the whole-message guard, which attributes zero and reports them
   * as duplicates. An earlier draft of this fixture repeated one body three
   * times and measured zero — the guard was right and the fixture was wrong.
   */
  const trio = (novelLength: number): TailSample[] =>
    [0, 1, 2].map((i) => sample(`${"x".repeat(novelLength - 1)}${i}`));

  it("charges the model for a tail that fits under the cap", () => {
    const result = measure("corpus", trio(200), 3);

    expect(result.capInteraction.cap).toBe(MAX_BODY_CHARS);
    expect(result.capInteraction.overCap).toBe(0);
    // Nothing was truncated, so the whole footer reached the model and none of
    // it lies beyond the cap.
    expect(result.capInteraction.tailCharsSent).toBe(3 * footerCost);
    expect(result.capInteraction.tailCharsBeyondCap).toBe(0);
    // With nothing truncated the two shares agree; below they must not.
    expect(result.capInteraction.sentShare).toBeCloseTo(result.report.share, 12);
  });

  it("does NOT charge for a tail that sits entirely beyond the cap", () => {
    // Real content alone overruns the cap, so the footer begins past position
    // 8000 and is never sent. It is already free: no stripper can recover it.
    const result = measure("corpus", trio(MAX_BODY_CHARS * 2), 3);

    expect(result.capInteraction.overCap).toBe(3);
    expect(result.capInteraction.tailCharsSent).toBe(0);
    expect(result.capInteraction.tailCharsBeyondCap).toBe(3 * footerCost);
    expect(result.capInteraction.sentShare).toBe(0);
    // …while the stored-text share still counts it. That gap IS the finding:
    // an unqualified `report.share` overstates the cost on capped messages.
    expect(result.report.tailChars).toBe(3 * footerCost);
    expect(result.report.share).toBeGreaterThan(0);
  });

  it("charges only the part of a straddling tail that falls inside the cap", () => {
    // The cut at MAX_BODY_CHARS lands INSIDE the footer: part of it is sent and
    // the rest is not.
    const novelLength = MAX_BODY_CHARS - 20;
    // The tail begins after the novel line AND the newline that terminates it —
    // `lineChars` counts that newline, so the boundary is novelLength + 1, not
    // novelLength. Derived rather than written as a literal because getting it
    // wrong by exactly one newline is how this measurement goes quietly wrong.
    const tailStart = novelLength + 1;
    const expectedSent = MAX_BODY_CHARS - tailStart;

    const result = measure("corpus", trio(novelLength), 3);

    expect(result.capInteraction.overCap).toBe(3);
    expect(expectedSent).toBeGreaterThan(0);
    expect(expectedSent).toBeLessThan(footerCost);
    expect(result.capInteraction.tailCharsSent).toBe(3 * expectedSent);
    expect(result.capInteraction.tailCharsBeyondCap).toBe(3 * (footerCost - expectedSent));
  });

  it("reports zero recoverable claims, because a trailing tail cannot cost one", () => {
    // The correction to #5420's second claim. The cap is a FRONT slice and the
    // tail is at the BACK, so real content delivered is min(cap, L - T) both
    // before and after a strip. This is asserted on the straddling fixture —
    // the only shape where "the strip would un-truncate it" is even tempting.
    const straddling = measure("corpus", trio(MAX_BODY_CHARS - 20), 3);
    const longOnItsOwn = measure("corpus", trio(MAX_BODY_CHARS * 2), 3);

    expect(straddling.capInteraction.claimsRecoverableByStripping).toBe(0);
    expect(longOnItsOwn.capInteraction.claimsRecoverableByStripping).toBe(0);
  });

  it("counts nothing as capped when everything fits", () => {
    const result = measure("corpus", [sample("short"), sample("also short"), sample("brief")], 3);
    expect(result.capInteraction.overCap).toBe(0);
    expect(result.report.messagesWithTail).toBe(3);
  });
});
