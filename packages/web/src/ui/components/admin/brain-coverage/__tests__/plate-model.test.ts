import { describe, expect, test } from "bun:test";
import type { BrainCoverage } from "@/ui/lib/types";
import {
  MARKS_PER_QUAD_MAX,
  buildSheet,
  scaleMarks,
  type PlateQuad,
  type PlateQuadSurveyed,
} from "../plate-model";
import { chatArm, coverage, warehouseArm } from "./_fixtures";

/**
 * The Coverage Plate's ARITHMETIC (#5422, ADR-0041).
 *
 * The plate is a picture of counts, so every way it can lie is a value and not a
 * layout. Each arm below is a false statement the sheet would be making if it
 * broke:
 *
 *   - **Marks come from the COUNTS, never from the unit list.** The list is
 *     clipped and label-policy-filtered; a quad derived from it would draw the
 *     disclosure rule and call it coverage.
 *   - **A non-zero count never renders as no marks.** A silent zero here is *"a
 *     false statement, not an error state"*, and rounding is the way one gets in.
 *   - **The three freshness renderings stay three.** They are three mark kinds on
 *     the sheet, not a gradient and not one badge.
 *   - **Four kinds of blank are four statements.** A measured emptiness is a
 *     finding; the other three are absences of looking, and the fault among them
 *     is a fault.
 *   - **Non-surveyable is off the survey, never unsurveyed ground.** Hatching an
 *     affirmative refusal would draw it as a gap somebody could fill.
 *   - **Counts that disagree are refused, not drawn.** There is no honest number
 *     of marks when the tally and the ratio contradict.
 *   - **Nothing counts the unenumerable.** State 3 reaches the sheet as a
 *     boolean, so there is no field an edge count could occupy.
 */

function quadFor(sheet: ReturnType<typeof buildSheet>, cls: string): PlateQuad {
  const found = sheet.quads.find((q) => q.sourceClass === cls);
  if (!found) throw new Error(`no quad for ${cls}`);
  return found;
}

function soundingsFor(sheet: ReturnType<typeof buildSheet>, cls: string): PlateQuadSurveyed {
  const quad = quadFor(sheet, cls);
  if (quad.render !== "soundings") throw new Error(`${cls} is ${quad.render}, not soundings`);
  return quad;
}

function unitsOf(quad: PlateQuadSurveyed, kind: string): number {
  return quad.runs.find((run) => run.kind === kind)?.units ?? 0;
}

describe("Coverage Plate — soundings come from counts, not from the unit list", () => {
  test("a class whose every unit is withheld still draws a full quad", () => {
    // The failure this exists to prevent: `arm.units` holds only the units a
    // clause admitted, so drawing from it would render an EMPTY quad over a card
    // reporting seven channels — the label policy, drawn as coverage.
    const sheet = buildSheet(
      coverage({ availability: { chat: { ...chatArm(), units: [], unitsWithheld: 7 } } }),
    );
    const chat = soundingsFor(sheet, "chat");
    expect(chat.markTotal).toBe(7);
  });

  test("the clipped listing does not shrink the quad", () => {
    // 281 pairs behind a listing capped at 200. The quad draws 281.
    const sheet = buildSheet({
      ...coverage(),
      availability: { ...coverage().availability, warehouse: warehouseArm() },
    } as BrainCoverage);
    expect(soundingsFor(sheet, "warehouse").markTotal).toBe(281);
  });

  test("every run sums back to the ratio it was built from", () => {
    const arm = chatArm();
    const sheet = buildSheet(coverage({ availability: { chat: arm } }));
    const chat = soundingsFor(sheet, "chat");
    const total = chat.runs.reduce((sum, run) => sum + run.units, 0);
    expect(total).toBe(arm.ratio.enumerable);
  });
});

describe("Coverage Plate — no count above zero renders as nothing", () => {
  test("scaleMarks floors at one mark, at any scale", () => {
    expect(scaleMarks(1, 40)).toBe(1);
    expect(scaleMarks(19, 40)).toBe(1);
    expect(scaleMarks(0, 40)).toBe(0);
  });

  test("a lone surveyed unit survives a re-scaled sheet", () => {
    // The realistic shape of the defect: one surveyed channel beside a warehouse
    // quad big enough to force a scale change. `round(1 / 12)` is 0, and a quad
    // drawn with no surveyed soundings over a card reporting one is the silent
    // zero ADR-0041 refuses.
    const big = MARKS_PER_QUAD_MAX * 12;
    const sheet = buildSheet(
      coverage({
        availability: {
          chat: {
            ...chatArm(),
            ratio: {
              surveyed: 1,
              enumerated: 0,
              enumerable: 1,
              inPerimeterWithoutEvidence: 0,
              unit: "chat-channel-roster",
            },
            freshness: { current: 1, stale: 0, unverified: 0 },
          },
          warehouse: warehouseArm({ enumerable: big, surveyed: 0, unitCount: 0 }),
        },
      }),
    );
    expect(sheet.unitsPerMark).toBeGreaterThan(1);
    expect(soundingsFor(sheet, "chat").markTotal).toBe(1);
  });

  test("the sheet stays at one-to-one for the largest arm this page is known to carry", () => {
    // 281 entity–dimension pairs is the prod shape that produced #5357. It draws
    // unscaled, so the realistic sheet never rounds at all.
    const sheet = buildSheet(coverage({ availability: { warehouse: warehouseArm() } }));
    expect(sheet.unitsPerMark).toBe(1);
  });

  test("the scale is one number for the whole sheet, taken from the largest quad", () => {
    // A per-quad scale would make a mark mean different amounts in adjacent
    // quads, which is a comparison the reader would make and the sheet would
    // lose.
    const sheet = buildSheet(
      coverage({
        availability: {
          chat: chatArm(),
          warehouse: warehouseArm({ enumerable: MARKS_PER_QUAD_MAX * 3, surveyed: 0, unitCount: 0 }),
        },
      }),
    );
    expect(sheet.unitsPerMark).toBe(3);
  });
});

describe("Coverage Plate — the three freshness renderings survive as three marks", () => {
  test("the tally becomes three distinct mark kinds, never one and never a gradient", () => {
    const sheet = buildSheet(coverage());
    const chat = soundingsFor(sheet, "chat");
    expect(unitsOf(chat, "surveyed-current")).toBe(1);
    expect(unitsOf(chat, "surveyed-stale")).toBe(1);
    expect(unitsOf(chat, "surveyed-unverified")).toBe(1);
  });

  test("a class with only one freshness state draws only that mark", () => {
    // The warehouse declares no activity metadata, so every surveyed pair is
    // `unverified` forever. It must not borrow the `current` mark to look better.
    const sheet = buildSheet(coverage({ availability: { warehouse: warehouseArm() } }));
    const wh = soundingsFor(sheet, "warehouse");
    expect(unitsOf(wh, "surveyed-unverified")).toBe(4);
    expect(unitsOf(wh, "surveyed-current")).toBe(0);
    expect(unitsOf(wh, "surveyed-stale")).toBe(0);
  });

  test("in-scope-with-no-evidence is its own mark, not folded into unsurveyed ground", () => {
    // The M1 sentence: invited, configured, reading nothing. Folding it in would
    // draw it identically to a channel nobody ever touched.
    const chat = soundingsFor(buildSheet(coverage()), "chat");
    expect(unitsOf(chat, "in-scope-no-evidence")).toBe(1);
    expect(unitsOf(chat, "visible-not-in-scope")).toBe(3);
  });
});

describe("Coverage Plate — four kinds of blank are four statements", () => {
  test("an enumerated class with nothing in it is a MEASURED emptiness", () => {
    const sheet = buildSheet(
      coverage({
        availability: {
          chat: {
            ...chatArm(),
            ratio: {
              surveyed: 0,
              enumerated: 0,
              enumerable: 0,
              inPerimeterWithoutEvidence: 0,
              unit: "chat-channel-roster",
            },
            freshness: { current: 0, stale: 0, unverified: 0 },
            units: [],
            unitsWithheld: 0,
          },
        },
      }),
    );
    const chat = quadFor(sheet, "chat");
    expect(chat.render).toBe("unsurveyed");
    expect(chat.render === "unsurveyed" && chat.reason).toBe("measured-empty");
    expect(chat.render === "unsurveyed" && chat.fault).toBe(false);
  });

  test("never-looked and tried-and-always-failed are different quads", () => {
    const sheet = buildSheet(coverage());
    const transcript = quadFor(sheet, "transcript");
    const email = quadFor(sheet, "email");
    expect(transcript.render === "unsurveyed" && transcript.reason).toBe("never-enumerated");
    expect(email.render === "unsurveyed" && email.reason).toBe("enumeration-never-succeeded");
  });

  test("cannot-establish is the one blank that is a fault", () => {
    const wh = quadFor(buildSheet(coverage()), "warehouse");
    expect(wh.render === "unsurveyed" && wh.reason).toBe("cannot-establish");
    expect(wh.render === "unsurveyed" && wh.fault).toBe(true);
  });
});

describe("Coverage Plate — not-surveyable is off the survey, never unsurveyed ground", () => {
  test("the non-surveyable class leaves the neatline rather than being hatched", () => {
    // Hatch means ground a survey could cover and has not. `human`'s units would
    // be people: ADR-0041 calls it "correctly absent from every ratio, forever;
    // not a gap", and hatching it would draw the refusal as a hole.
    const sheet = buildSheet(coverage());
    expect(sheet.quads.some((q) => q.sourceClass === "human")).toBe(false);
    expect(sheet.margin.map((q) => q.sourceClass)).toEqual(["human"]);
  });

  test("it is still on the sheet — drawn in the margin, never dropped", () => {
    const sheet = buildSheet(coverage());
    expect(sheet.margin).toHaveLength(1);
    expect(sheet.margin[0]?.render).toBe("off-survey");
  });
});

describe("Coverage Plate — counts that disagree are refused, not drawn", () => {
  test("a freshness tally that does not sum to surveyed draws nothing", () => {
    const sheet = buildSheet(
      coverage({
        availability: { chat: { ...chatArm(), freshness: { current: 9, stale: 0, unverified: 0 } } },
      }),
    );
    expect(quadFor(sheet, "chat").render).toBe("undrawable");
  });

  test("a denominator that is not surveyed plus enumerated draws nothing", () => {
    const arm = chatArm();
    const sheet = buildSheet(
      coverage({
        availability: { chat: { ...arm, ratio: { ...arm.ratio, enumerable: 99 } } },
      }),
    );
    expect(quadFor(sheet, "chat").render).toBe("undrawable");
  });

  test("refusing to draw is NOT the same quad as unsurveyed ground", () => {
    // "We cannot draw this" rendered as "there is nothing here" is a silent zero
    // with extra steps.
    const sheet = buildSheet(
      coverage({
        availability: { chat: { ...chatArm(), freshness: { current: 9, stale: 0, unverified: 0 } } },
      }),
    );
    const chat = quadFor(sheet, "chat");
    expect(chat.render).not.toBe("unsurveyed");
    expect(chat.render).not.toBe("soundings");
  });

  test("an undrawable quad does not drag the sheet's scale with it", () => {
    const sheet = buildSheet(
      coverage({
        availability: {
          chat: { ...chatArm(), freshness: { current: 99_999, stale: 0, unverified: 0 } },
        },
      }),
    );
    expect(sheet.unitsPerMark).toBe(1);
  });
});

describe("Coverage Plate — the unenumerable reaches the sheet without a number", () => {
  test("map edges become a torn edge, and the sheet carries no count of them", () => {
    const sheet = buildSheet(coverage());
    const chat = soundingsFor(sheet, "chat");
    expect(chat.tornEdge).toBe(true);
    // A boolean, structurally: there is no field on the quad an edge count could
    // occupy, which is the same guarantee `MapEdgeList` gives in `arms.tsx`.
    expect(typeof chat.tornEdge).toBe("boolean");
  });

  test("two edges and one edge are the same torn edge", () => {
    const two = buildSheet(
      coverage({
        availability: {
          chat: {
            ...chatArm(),
            mapEdges: ["chat-public-roster-truncated", "chat-activity-unreadable"],
          },
        },
      }),
    );
    const one = buildSheet(coverage());
    expect(soundingsFor(two, "chat").tornEdge).toBe(soundingsFor(one, "chat").tornEdge);
  });

  test("a class with no map edges is not torn", () => {
    const sheet = buildSheet(coverage({ availability: { chat: { ...chatArm(), mapEdges: [] } } }));
    expect(soundingsFor(sheet, "chat").tornEdge).toBe(false);
  });
});

describe("Coverage Plate — order and the day-one state", () => {
  test("quads keep the page's class order and are never sorted by coverage", () => {
    // Sorting by how much is surveyed would let the sheet lead with whichever
    // class happens to look best today — the objection `vocabulary.ts` records
    // against sorting the paragraph, in a picture.
    const sheet = buildSheet(coverage());
    expect(sheet.quads.map((q) => q.sourceClass)).toEqual([
      "chat",
      "transcript",
      "email",
      "warehouse",
    ]);
  });

  test("a first-week workspace lights the quads that have something and no others", () => {
    // AC4's falsifiable test, as arithmetic: the day-one sheet is a small number
    // of lit quads on ground that is drawn and mostly empty. Nothing is padded
    // to make it look fuller.
    const sheet = buildSheet(
      coverage({
        availability: {
          chat: {
            ...chatArm(),
            ratio: {
              surveyed: 1,
              enumerated: 6,
              enumerable: 7,
              inPerimeterWithoutEvidence: 0,
              unit: "chat-channel-roster",
            },
            freshness: { current: 1, stale: 0, unverified: 0 },
            units: [],
            unitsWithheld: 7,
            mapEdges: [],
          },
          warehouse: warehouseArm({ enumerable: 281, surveyed: 0, unitCount: 0 }),
        },
      }),
    );
    expect(sheet.litQuads).toBe(2);
    expect(quadFor(sheet, "transcript").render).toBe("unsurveyed");
    expect(quadFor(sheet, "email").render).toBe("unsurveyed");
  });
});
