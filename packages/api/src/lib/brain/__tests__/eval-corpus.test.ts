/**
 * The evaluation set's collection contract (#5338 AC 3).
 *
 * Tested as REFUSALS, for the reason the schema suites one package over give:
 * a green "a well-formed sheet parses" proves nothing about the properties this
 * module exists to hold. Each refusal below is a set that would have produced a
 * number, computed over a population it does not describe.
 */
import { describe, expect, test } from "bun:test";
import {
  SHEET_MAX_EPISODES,
  SHEET_LABEL_GUIDE,
  SheetFormatError,
  checkSheetSize,
  parseSheet,
  pseudonymise,
  sheetProgress,
  sheetToFixture,
  type EvalSheet,
} from "@atlas/api/lib/brain/eval-corpus";

function sheet(over: Partial<EvalSheet> = {}): EvalSheet {
  return {
    sheet: 1,
    source: {
      corpus: "github-issue-comments",
      repos: ["apache/kafka"],
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
    },
    collectedAt: "2026-09-02T12:00:00.000Z",
    episodes: [
      { id: "gh-1", body: "Priya owns the consumer rebalance path now.", class: "positive" },
      { id: "gh-2", body: "+1", class: "negative" },
    ],
    ...over,
  };
}

const PROVENANCE = { labelsFrom: "apache/kafka", cutAt: "2026-09-02T12:00:00.000Z" };

describe("the window refuses rather than truncates", () => {
  test("an oversized window is a refusal that names the fix", () => {
    // `heldout-manifest.ts`'s argument, restated: a set clipped at a cap is
    // sampled by sort order, which is exactly the authorship a mechanical
    // window exists to remove.
    const refusal = checkSheetSize(SHEET_MAX_EPISODES + 1);
    expect(refusal).toContain("Narrow the window");
    expect(refusal).toContain("sampled by sort order");
  });

  test("a window at the cap is fine — the boundary is not off by one", () => {
    expect(checkSheetSize(SHEET_MAX_EPISODES)).toBeNull();
  });
});

describe("pseudonymisation", () => {
  test("a handle is the same pseudonym everywhere in one set", () => {
    // A set where "person-4" means three different people cannot carry a
    // coherent ownership claim — and ownership claims are most of what makes an
    // episode a positive.
    const map = new Map<string, string>();
    const a = pseudonymise("@mjsax can you look at this", map);
    const b = pseudonymise("agreed with @mjsax, shipping it", map);
    const handle = a.match(/@(person-\d+)/)?.[1];
    expect(handle).toBeDefined();
    expect(b).toContain(`@${handle}`);
    expect(a).not.toContain("mjsax");
    expect(b).not.toContain("mjsax");
  });

  test("case does not mint a second identity for one person", () => {
    const map = new Map<string, string>();
    const out = pseudonymise("@Alice and @alice", map);
    expect(map.size).toBe(1);
    expect(out).toBe("@person-1 and @person-1");
  });

  test("⭐ an address is rewritten whole, not left half-resolvable", () => {
    // The ordering bug this pins: with mentions first, the mention pattern eats
    // the local-part-then-`@` of an address, leaving a fragment that is still
    // resolvable and no longer looks like an address — so a later reader would
    // not know to check it.
    const out = pseudonymise("mail dev@kafka.apache.org about it", new Map());
    expect(out).not.toContain("kafka.apache.org");
    expect(out).toMatch(/person-\d+@example\.invalid/);
  });

  test("⚠️ a name in free text SURVIVES, and the guide says so", () => {
    // Pinned as the honest limit rather than left for a reader to discover.
    // The claim is "no handle you can resolve and no address you can mail",
    // not anonymity, and a test asserting the weaker true thing is worth more
    // than a comment asserting the stronger false one.
    const out = pseudonymise("Marco said he'd take this", new Map());
    expect(out).toContain("Marco");
  });

  test("an email inside a code fence is still an address", () => {
    // No parsing of markdown structure: the rewrite is unconditional, because
    // a "this one is inside a fence" exception is how an address survives.
    const out = pseudonymise("```\ncontact: ops@example.com\n```", new Map());
    expect(out).not.toContain("ops@example.com");
  });
});

describe("a sheet cannot carry triage output", () => {
  test("⭐ an undeclared top-level key is refused, not stripped", () => {
    // The circularity this exists to stop: a labeller who can see which rule
    // fires is labelling the thing under test. Stripping would let the anchored
    // labels through with the evidence removed, which is strictly worse.
    const withVerdicts = { ...sheet(), triage: { "gh-2": "pure_reaction" } };
    expect(() => parseSheet(withVerdicts)).toThrow(SheetFormatError);
    expect(() => parseSheet(withVerdicts)).toThrow(/labelling the thing under test/);
  });

  test("an undeclared key on one ROW is refused too", () => {
    const rowed = sheet({
      episodes: [{ id: "gh-1", body: "x", class: "negative", rule: "known_ack" }] as never,
    });
    expect(() => parseSheet(rowed)).toThrow(/undeclared key/);
  });

  test("the format marker is required, so a fixture cannot be renamed into a sheet", () => {
    const { sheet: _marker, ...withoutMarker } = sheet();
    expect(() => parseSheet(withoutMarker)).toThrow(/format marker/);
  });

  test("a duplicate id is refused — it would be counted twice", () => {
    const dupes = sheet({
      episodes: [
        { id: "gh-1", body: "a", class: "positive" },
        { id: "gh-1", body: "b", class: "negative" },
      ],
    });
    expect(() => parseSheet(dupes)).toThrow(/appears twice/);
  });

  test("an unrecognised class is refused rather than coerced", () => {
    const bad = sheet({ episodes: [{ id: "gh-1", body: "a", class: "maybe" }] as never });
    expect(() => parseSheet(bad)).toThrow(/expected null or one of/);
  });

  test("a null class parses — that is an unlabelled row, not a broken one", () => {
    const partial = sheet({ episodes: [{ id: "gh-1", body: "a", class: null }] });
    expect(parseSheet(partial).episodes[0]?.class).toBeNull();
  });
});

describe("building the fixture", () => {
  test("⭐ a partly-labelled sheet is REFUSED, never filtered", () => {
    // Filtering would silently redefine the set as "the episodes somebody got
    // round to" — a curated set wearing a mechanical one's provenance — and it
    // would do so most on the rows a labeller found hardest to call, which are
    // the rows a triage layer is most likely to get wrong.
    const partial = sheet({
      episodes: [
        { id: "gh-1", body: "a", class: "positive" },
        { id: "gh-2", body: "b", class: null },
      ],
    });
    expect(() => sheetToFixture(partial, PROVENANCE)).toThrow(/1 of 2 episodes are unlabelled/);
    expect(() => sheetToFixture(partial, PROVENANCE)).toThrow(/hardest to call/);
  });

  test("a complete sheet becomes an evaluation fixture with its provenance", () => {
    const fixture = sheetToFixture(sheet(), PROVENANCE);
    expect(fixture.role).toBe("evaluation");
    expect(fixture.provenance).toEqual(PROVENANCE);
    expect(fixture.episodes).toEqual([
      { id: "gh-1", class: "positive", body: "Priya owns the consumer rebalance path now." },
      { id: "gh-2", class: "negative", body: "+1" },
    ]);
  });

  test("bodies travel to the fixture unmodified", () => {
    // Triage reads the STORED body; the quoted-reply strip and the 8k cap run
    // later and only for the model call. A fixture that normalised here would
    // hand triage a shape production never gives it, and stage 0's rules are
    // length- and shape-sensitive.
    const quoted = "> earlier message\n> second line\n\nAgreed, Dana owns it now.";
    const fixture = sheetToFixture(
      sheet({ episodes: [{ id: "gh-9", body: quoted, class: "positive" }] }),
      PROVENANCE,
    );
    expect(fixture.episodes[0]?.body).toBe(quoted);
  });

  test("progress counts every class and names what is left", () => {
    const progress = sheetProgress(
      sheet({
        episodes: [
          { id: "a", body: "x", class: "positive" },
          { id: "b", body: "y", class: "rejected" },
          { id: "c", body: "z", class: null },
        ],
      }),
    );
    expect(progress).toEqual({
      total: 3,
      labelled: 2,
      unlabelled: ["c"],
      byClass: { positive: 1, rejected: 1, negative: 0 },
    });
  });
});

describe("the label guide", () => {
  test("every class a labeller may write has a definition", () => {
    // A class with no guidance is a class labelled by whatever the person was
    // thinking that hour, and the three are not intuitively distinct —
    // `rejected` in particular is a claim a reviewer SAW, not an absence.
    expect(Object.keys(SHEET_LABEL_GUIDE).toSorted()).toEqual([
      "negative",
      "positive",
      "rejected",
    ]);
    expect(SHEET_LABEL_GUIDE.positive).toContain("PUBLISH");
    expect(SHEET_LABEL_GUIDE.rejected).toContain("REJECT");
  });
});
