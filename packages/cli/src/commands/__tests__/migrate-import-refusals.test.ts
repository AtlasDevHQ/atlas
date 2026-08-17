/**
 * The CLI's refusal disclosure (#5112).
 *
 * `renderRefusalNotice` is the ONLY operator-facing surface for a dropped human
 * review decision. Before review round 1 it was an inline block in
 * `handleMigrateImport` with no test file anywhere under `packages/cli`, and three
 * of its branches were free mutations:
 *
 *   - deleting the "target did not return the refused edges" arm collapsed two
 *     different states — "nothing was refused" and "N were refused and we cannot
 *     show you which" — into the same silence;
 *   - deleting the "N more were refused but not listed" line made the CLI report a
 *     smaller loss than happened;
 *   - `refused ?? 0` turned "this build cannot report the counter" into the positive
 *     claim "it refused nothing", and silenced the whole block.
 *
 * Every case here drives the real function with a captured sink, so a deleted branch
 * is a missing line rather than an unobserved one.
 */

import { describe, expect, it } from "bun:test";
import { renderRefusalNotice } from "../migrate-import";

/** One well-formed payload as a current target sends it. */
const detail = (fromNorm: string) => ({
  slotPosition: "predicate",
  fromNorm,
  toNorm: "priced at",
  approvedBy: "source-admin",
  approvedAt: "2026-06-01T00:00:00.000Z",
  refusal: "already-aliased",
  existingTarget: "cost",
  reason: `"${fromNorm}" is already aliased to "cost"`,
});

/** Render into an array instead of stdout, and join for substring assertions. */
function render(vocabulary: Parameters<typeof renderRefusalNotice>[0]): {
  lines: string[];
  text: string;
} {
  const lines: string[] = [];
  renderRefusalNotice(vocabulary, (line) => lines.push(line));
  // ANSI colour survives `pc.yellow`, so assertions match on substrings rather than
  // whole lines — the codes are not what any of these tests are about.
  return { lines, text: lines.join("\n") };
}

describe("renderRefusalNotice", () => {
  it("says nothing at all when the section is absent", () => {
    // A pre-#5022 target has no vocabulary section. Silence is right: there is no
    // counter, no payload, and nothing an operator could act on.
    expect(render(undefined).lines).toEqual([]);
  });

  it("says nothing when the target refused nothing", () => {
    // `0` is a positive claim and it needs no prose. A disclosure that fired here
    // would print on every import carrying a vocabulary and train an operator to
    // skip the block.
    expect(render({ imported: 4, skipped: 1, refused: 0 }).lines).toEqual([]);
  });

  it("⭐ WARNS when the target cannot report the counter — not silence, and not zero", () => {
    // The `?? 0` defect. A target between #5022 and #5036 omits `refused` entirely,
    // having folded contradictory decisions into `skipped` — so this is the one state
    // where the operator has to be told to go and compare by hand, and the old code
    // printed nothing at all.
    const { text } = render({ imported: 4, skipped: 2 });
    expect(text).toContain("does not report refused alias edges");
    expect(text).toContain("counted under Skipped");
    expect(text).toContain("brain_vocabulary_edge");
    // ⚠️ And it must NOT claim a number. Reporting `0 curated alias edge(s) were
    // REFUSED` here is the misleading render this branch exists to replace.
    expect(text).not.toContain("were REFUSED");
  });

  it("⭐ distinguishes a count with NO payloads from nothing to recover", () => {
    // A target between #5036 and #5112: it counted the refusals and carries none of
    // them. Deleting this branch makes it render as an empty list under a non-zero
    // count, which reads as "nothing to recover" — the opposite of the truth.
    const { text } = render({ imported: 2, skipped: 0, refused: 3 });
    expect(text).toContain("3 curated alias edge(s) were REFUSED");
    expect(text).toContain("did not return the refused edges");
    expect(text).toContain("its build predates them");
    // No per-edge lines, because there are none to print.
    expect(text).not.toContain("approved by");
  });

  it("⭐ enumerates the payloads, and names `existingTarget` when there is one", () => {
    const { text } = render({
      imported: 0,
      skipped: 0,
      refused: 2,
      refusalDetails: [detail("price"), { ...detail("margin"), existingTarget: null }],
    });
    expect(text).toContain('[predicate] "price" → "priced at" — already-aliased');
    // Present on the first, absent on the second — the two arms of the field, so a
    // render that always printed it or never did fails one of them.
    expect(text).toContain('(destination holds "cost")');
    expect(text).toContain('"margin" → "priced at" — already-aliased');
    expect(text.split("\n").filter((l) => l.includes("destination holds"))).toHaveLength(1);
    expect(text).toContain("approved by source-admin at 2026-06-01T00:00:00.000Z");
    // Both listed, so no truncation note.
    expect(text).not.toContain("more were refused");
  });

  it("⭐ `null` approvedBy is auto-approval; ABSENT is not", () => {
    // The distinction `?? "auto-approval"` destroyed. `null` is a real value — an
    // edge approved by the system — while a missing key means the target did not say,
    // and inventing an attribution for it is exactly the misread the server-side
    // screen treats as malformed.
    const autoApproved = render({
      refused: 1,
      refusalDetails: [{ ...detail("price"), approvedBy: null }],
    }).text;
    expect(autoApproved).toContain("approved by auto-approval at");

    const notReported = render({
      refused: 1,
      refusalDetails: [{ ...detail("price"), approvedBy: undefined }],
    }).text;
    expect(notReported).toContain("(approver not reported)");
    expect(notReported).not.toContain("auto-approval");
  });

  it("⭐ reports the SHORTFALL when fewer payloads arrive than were refused", () => {
    // Deleting this line makes the CLI report a smaller loss than happened, which is
    // the failure the response's own `detailsCarried`/`refused` pair exists to
    // prevent one layer up.
    const { text } = render({
      refused: 7,
      refusalDetails: [detail("price"), detail("margin")],
    });
    expect(text).toContain("7 curated alias edge(s) were REFUSED");
    expect(text).toContain("5 more were refused but not listed here");
  });

  it("counts unreadable entries instead of printing `undefined`", () => {
    // A malformed payload from a buggy target or a proxy. `[undefined] "undefined" →
    // "undefined"` is what the undefended render produced.
    const { text } = render({
      refused: 3,
      refusalDetails: [detail("price"), { reason: "no norms at all" }, "not an object" as never],
    });
    expect(text).toContain('"price" → "priced at"');
    expect(text).toContain("2 refusal record(s) were unreadable");
    expect(text).not.toContain("undefined");
  });

  it("fills the missing non-key fields with named placeholders", () => {
    // `fromNorm`/`toNorm` are the load-bearing pair — without them there is nothing
    // to re-author, which is why their absence makes an entry unreadable. The rest
    // degrade rather than disqualify: an entry that still names the two norms is
    // worth printing even if the target dropped the position or the reason.
    const { text } = render({
      refused: 1,
      refusalDetails: [{ fromNorm: "price", toNorm: "priced at" }],
    });
    expect(text).toContain('[unknown position] "price" → "priced at" — unreported reason');
    expect(text).toContain("(approver not reported) at (time not reported)");
    expect(text).not.toContain("unreadable");
  });

  it("always closes with the remedy", () => {
    // Every path that printed a loss must say what to do about it. Asserted on both
    // shapes, because the two arms build their prose separately.
    for (const vocabulary of [
      { refused: 1, refusalDetails: [detail("price")] },
      { refused: 1 },
    ]) {
      expect(render(vocabulary).text).toContain("Re-author them here");
    }
  });
});
