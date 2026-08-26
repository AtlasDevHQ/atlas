import { describe, expect, test } from "bun:test";
import { PLATE_READER_VOCABULARY } from "../plate";
import { MARK_ORDER, PLATE_QUAD_RENDERS } from "../plate-model";

/**
 * The gate that says when a legibility demonstration has gone stale (#5422).
 *
 * ## The problem this exists for
 *
 * A "someone untrained can read it" finding is expensive: it costs a person, a
 * prod admin session, and a cold reader who can only be used once. And it decays
 * silently. #5427 closed on a browser read of `/admin/brain` at 12:41 UTC on
 * 2026-08-26; the Coverage Plate — a whole new claim-bearing layer — merged onto
 * the same page at 20:27 the same day. Nothing anywhere knew the read no longer
 * described the page.
 *
 * The instinct is to re-verify after the UI settles. **The UI does not settle**,
 * and a closing condition that waits for it never closes. So the condition has to
 * be scoped to something that CAN hold still.
 *
 * ## What actually invalidates a legibility finding
 *
 * Not the layout, the palette, the spacing, or the wording of a gloss. A reader
 * who understood a filled disc still understands it after a re-skin. What
 * invalidates the finding is the **vocabulary changing** — a sixth mark, a fifth
 * kind of blank quad, a renamed state. Then the thing they read is not the thing
 * shipping, and their answers are about a page that no longer exists.
 *
 * So: **this file is the invalidation rule, as a gate.** When it reddens, the
 * demonstration it names must be re-run before it can be cited again. When it is
 * green, the finding still describes what ships, however much the page has been
 * redrawn around it.
 *
 * `docs/agents/practices.md`: *"if you cannot say what would go red, you have not
 * closed anything — you have moved it to where it costs more."* This is what goes
 * red.
 *
 * ## Observed red, 2026-08-26
 *
 * `practices.md`: *"Not 'there is a test'; **this mutant turns it red**."* Each
 * of these was applied to the source, run, and reverted:
 *
 * | Mutation | Reddens |
 * |---|---|
 * | rename a mark — `Surveyed, stale` → `Surveyed, out of date` | the five soundings |
 * | collapse two blank states — `never succeeded` → `never enumerated` | the four kinds of blank |
 * | add a fifth quad render — `provisional` | the quad renders **and** the count |
 * | add a sixth mark kind — `surveyed-disputed` | the five soundings **and** the count |
 *
 * The third and fourth reddening two assertions is the point of the count check:
 * a set comparison alone catches renames and removals, and an ADDITION is the one
 * a careless edit to {@link DEMONSTRATED} could otherwise wave through.
 *
 * ## Deliberately NOT pinned
 *
 * Colours, geometry, font sizes, spacing, the order marks appear in the legend,
 * and every `MarkCopy.detail` gloss. Pinning those would make this fire on
 * ordinary polish, and a gate that cries wolf on every commit is one that gets
 * deleted — which is the failure mode `practices.md` was written about.
 */

/**
 * The vocabulary a demonstration was run against.
 *
 * ⚠️ **Do not edit this to make the suite green.** Editing it is the act of
 * saying "the demonstration is stale", so it comes with an obligation: re-run the
 * demonstration and update the issue that records it. Changing the literal
 * without re-running is how a stale finding becomes an invisible one.
 */
const DEMONSTRATED = {
  marks: [
    "Surveyed, current",
    "Surveyed, stale",
    "Surveyed, unverified",
    "In scope, nothing read yet",
    "Visible, not in scope",
  ],
  ground: ["Unsurveyed", "Torn edge"],
  blankStates: ["none found", "never enumerated", "never succeeded", "cannot establish"],
  quadRenders: ["soundings", "unsurveyed", "off-survey", "undrawable"],
} as const;

describe("Coverage Plate — the reader's vocabulary is what a demonstration is about", () => {
  test("the five soundings are the five that were demonstrated", () => {
    expect([...PLATE_READER_VOCABULARY.marks].toSorted()).toEqual(
      [...DEMONSTRATED.marks].toSorted(),
    );
  });

  test("the ground states are the two that were demonstrated", () => {
    expect([...PLATE_READER_VOCABULARY.ground].toSorted()).toEqual(
      [...DEMONSTRATED.ground].toSorted(),
    );
  });

  test("the four kinds of blank are the four that were demonstrated", () => {
    // These are the words under an empty quad, and they are the part of the
    // sheet most likely to be "tidied" into one — which would be the collapse
    // ADR-0041 refuses, arriving as copy-editing rather than as a design change.
    expect([...PLATE_READER_VOCABULARY.blankStates].toSorted()).toEqual(
      [...DEMONSTRATED.blankStates].toSorted(),
    );
  });

  test("the quad renders are the four that were demonstrated", () => {
    expect([...PLATE_QUAD_RENDERS].toSorted()).toEqual([...DEMONSTRATED.quadRenders].toSorted());
  });

  test("the count itself is pinned, so an addition cannot pass as a rename", () => {
    // Set comparison alone would catch a rename and a removal. This catches the
    // case the others can miss on a careless edit: the reader now has more to
    // learn than the person in the demonstration did.
    expect(MARK_ORDER).toHaveLength(DEMONSTRATED.marks.length);
    expect(PLATE_READER_VOCABULARY.marks).toHaveLength(5);
    expect(PLATE_QUAD_RENDERS).toHaveLength(4);
  });
});
