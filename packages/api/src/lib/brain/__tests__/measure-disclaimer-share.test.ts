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
  measure,
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

describe("measure — cap pressure, #5420's second claim", () => {
  const FOOTER = ["", "Confidential and intended solely for the addressee.", "Acme Corp."];
  const footerText = FOOTER.join("\n");

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
   * times and measured a rescue count of 0 — the guard was right and the
   * fixture was wrong.
   */
  const trio = (novelLength: number): TailSample[] =>
    [0, 1, 2].map((i) => sample(`${"x".repeat(novelLength - 1)}${i}`));

  it("counts a capped message the tail would rescue", () => {
    // Just over the cap, and over it BY LESS than the footer costs — so
    // removing the footer would let the whole message through. This is the case
    // where the tail costs a claim rather than tokens: the cap cuts from the
    // end, and so does the footer.
    const result = measure("corpus", trio(MAX_BODY_CHARS - footerText.length + 20), 3);

    expect(result.capPressure.cap).toBe(MAX_BODY_CHARS);
    expect(result.capPressure.overCap).toBe(3);
    expect(result.capPressure.overCapRescuedByTail).toBe(3);
    expect(result.capPressure.overCapTailChars).toBeGreaterThan(0);
  });

  it("does not claim a rescue for a message that is long on its own", () => {
    // Genuinely long content. The footer comes off and it is still over the cap,
    // so the truncation was about the message, not about boilerplate — and
    // reporting it as rescued would argue for a stripper on false evidence.
    const result = measure("corpus", trio(MAX_BODY_CHARS * 2), 3);

    expect(result.capPressure.overCap).toBe(3);
    expect(result.capPressure.overCapRescuedByTail).toBe(0);
    // The footer is still detected — this test isolates the RESCUE claim, and
    // would pass vacuously if no tail had been found at all.
    expect(result.capPressure.overCapTailChars).toBeGreaterThan(0);
  });

  it("counts nothing as capped when everything fits", () => {
    const result = measure("corpus", [sample("short"), sample("also short"), sample("brief")], 3);
    expect(result.capPressure.overCap).toBe(0);
    expect(result.capPressure.overCapRescuedByTail).toBe(0);
    expect(result.report.messagesWithTail).toBe(3);
  });
});
