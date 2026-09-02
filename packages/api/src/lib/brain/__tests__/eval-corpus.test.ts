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
  SHEET_NOTES,
  SHEET_CLASS_PRECEDENCE,
  SheetFormatError,
  assertOutsideRepo,
  checkSheetSize,
  fixtureDigest,
  parseSheet,
  pseudonymise,
  sheetProgress,
  sheetToFixture,
  sheetsToFixture,
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

  test("an address is rewritten whole, not left half-resolvable", () => {
    const out = pseudonymise("mail dev@kafka.apache.org about it", new Map());
    expect(out).not.toContain("kafka.apache.org");
    expect(out).toMatch(/person-\d+@example\.invalid/);
  });

  test("⭐ the LOOKBEHIND is what protects an address, not the replacement order", () => {
    // This test previously claimed the email-then-mention order was what
    // stopped the mention pattern eating an address's local-part-then-`@`.
    // Measured, that hazard does not exist: `(?<![\w/])` refuses to start a
    // match after a word character, so a mention-only pass leaves the address
    // untouched. The assertion was true and its stated mechanism was fiction —
    // so the mechanism is asserted directly here, and the ordering is what it
    // actually is: harmless belt-and-braces.
    const mentionOnly = /(?<![\w/])@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})\b/g;
    expect("mail dev@kafka.apache.org about it".replace(mentionOnly, "@REWRITTEN")).toBe(
      "mail dev@kafka.apache.org about it",
    );
  });

  test("⚠️ a non-GitHub handle shape passes through, and that is the documented limit", () => {
    // `@foo_bar` is not a legal GitHub login (no underscores), so leaving it is
    // correct for a GitHub corpus and a real gap for any other source. Pinned
    // as the limit rather than left to be discovered by whoever adds a corpus
    // with different handle rules.
    expect(pseudonymise("@foo_bar shipped it", new Map())).toContain("@foo_bar");
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

describe("⛔ corpus text never enters the repository", () => {
  test("a path inside the working tree is REFUSED, quoting the prohibition", () => {
    // The defect this closes shipped in the first draft of this lane: sheets
    // and fixtures were written to `packages/api/scripts/heldout/fixtures/`,
    // which is tracked — in the same directory whose README already argues a
    // manifest may live in git precisely because it carries no bodies.
    const refusal = assertOutsideRepo("packages/api/scripts/heldout/fixtures/x.json");
    expect(refusal).toContain("Committing any corpus text to this repository");
    expect(refusal).toContain("never corpus text, never labels");
    expect(refusal).toContain("read once and discarded");
  });

  test("…including one that walks back in through `..`", () => {
    // The check is on the RESOLVED path, so an absolute-looking escape that
    // lands back inside the tree is caught.
    expect(assertOutsideRepo(`${import.meta.dir}/../../../../scratch.json`)).not.toBeNull();
  });

  test("a path outside the tree is allowed", () => {
    expect(assertOutsideRepo("/tmp/atlas-eval/apache-2026-06.sheet.json")).toBeNull();
  });

  test("a sibling directory sharing the repo's name prefix is not swept up", () => {
    // Prefix tests on paths are a classic off-by-one: `/home/x/atlas` must not
    // capture `/home/x/atlas-scratch`. The check compares on a separator
    // boundary.
    expect(assertOutsideRepo("/home/msywu/oss/atlas-scratch/eval.json")).toBeNull();
  });
});

describe("the annotation keys are pinned, not merely permitted", () => {
  function withNote(note: unknown) {
    return { ...sheet(), _note: note };
  }

  test("⭐ an edited `_note` is refused — an allow-listed free field is a channel", () => {
    // `_note` passes the undeclared-key check by construction, so without this
    // a sheet could carry "gh-14 would be dropped by known_ack" and anchor the
    // labeller to the layer under test exactly as a `triage` key would.
    expect(() => parseSheet(withNote(["gh-14 is dropped by known_ack"]))).toThrow(
      /not the shipped note set/,
    );
  });

  test("the shipped `_guide` and `_note` round-trip through the parser", () => {
    // A collector whose own output its parser rejects is a broken lane, so the
    // exact values the collector writes are asserted to parse.
    const ok = { ...sheet(), _guide: SHEET_LABEL_GUIDE, _note: SHEET_NOTES };
    expect(() => parseSheet(ok)).not.toThrow();
  });

  test("an edited `_guide` is refused", () => {
    const edited = { ...sheet(), _guide: { ...SHEET_LABEL_GUIDE, positive: "anything goes" } };
    expect(() => parseSheet(edited)).toThrow(/not the shipped label guide/);
  });

  test("the class precedence is stated, and matches the manifest's collapse", () => {
    // `heldout-manifest.ts` fixes positive ▸ rejected ▸ negative for prod cuts.
    // A hand-labelled set using a different rule would compute the number over
    // a differently-shaped population than the corpus it mirrors.
    expect(SHEET_CLASS_PRECEDENCE).toEqual(["positive", "rejected", "negative"]);
    expect(SHEET_NOTES.join(" ")).toContain("POSITIVE beats REJECTED beats NEGATIVE");
  });
});

describe("a blank body is not an episode", () => {
  test("refused at the sheet, because the harness refuses it later", () => {
    // Accepting it here would let a labeller spend a decision on a row
    // `parseMeasurementFixture` then rejects — the work discarded at the far
    // end of the lane rather than the near one.
    const blank = sheet({ episodes: [{ id: "gh-1", body: "   \n ", class: "negative" }] });
    expect(() => parseSheet(blank)).toThrow(/blank body/);
  });
});

describe("merging sheets", () => {
  function labelled(ids: readonly string[]): EvalSheet {
    return sheet({
      episodes: ids.map((id) => ({ id, body: `body ${id}`, class: "negative" as const })),
    });
  }

  test("⭐ a set may span several sheets, so the per-sheet cap is not a ceiling on the SET", () => {
    // Without a merge, `SHEET_MAX_EPISODES` would cap the whole set — and at a
    // positive rate below ~28% that makes 110 positives unreachable by
    // construction. The refusal would have become the thing it protects
    // against.
    const fixture = sheetsToFixture([labelled(["a", "b"]), labelled(["c"])], PROVENANCE);
    expect(fixture.episodes.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  test("an id in two sheets is refused, never de-duplicated", () => {
    // The same episode labelled twice may carry two different classes, and
    // silently keeping one picks a label nobody chose.
    expect(() => sheetsToFixture([labelled(["a"]), labelled(["a"])], PROVENANCE)).toThrow(
      /appears in sheet 1 and sheet 2/,
    );
  });

  test("no sheets is a refusal, not an empty fixture", () => {
    expect(() => sheetsToFixture([], PROVENANCE)).toThrow(/no sheets given/);
  });
});

describe("the fixture digest", () => {
  test("is stable for the same fixture and differs when a label changes", async () => {
    // The one thing about a set that may live in git — the path plan permits
    // "the manifests' hashes if useful" while refusing text and labels. It is
    // what turns a recorded `setId` from a string anybody could type into
    // something checkable against a privately-held fixture.
    const a = await fixtureDigest(sheetToFixture(sheet(), PROVENANCE));
    const b = await fixtureDigest(sheetToFixture(sheet(), PROVENANCE));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    const flipped = sheet({
      episodes: [
        { id: "gh-1", body: "Priya owns the consumer rebalance path now.", class: "negative" },
        { id: "gh-2", body: "+1", class: "negative" },
      ],
    });
    expect(await fixtureDigest(sheetToFixture(flipped, PROVENANCE))).not.toBe(a);
  });
});
