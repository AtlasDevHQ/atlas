#!/usr/bin/env bun
/**
 * `bun scripts/build-eval-fixture.ts` — turn a labelled sheet into the
 * evaluation fixture `scripts/measure-triage.ts` measures (#5338 AC 3).
 *
 * Separate from the collector because the two are separated by a human, and
 * separate from `measure-triage.ts` because building a set and measuring
 * against it are the two things `practices.md`'s structural rule says must not
 * collapse into one actor's single command.
 *
 * ## Usage
 *
 *   bun scripts/build-eval-fixture.ts --sheet <sheet.json> \
 *     --labeller "<who>" -o scripts/heldout/fixtures/<name>.json
 *
 *   bun scripts/build-eval-fixture.ts --sheet <sheet.json>     # progress only
 *
 * Exit codes: 0 written (or progress reported) · 1 refused · 3 bad input.
 */
import {
  parseSheet,
  sheetProgress,
  sheetToFixture,
  SheetFormatError,
} from "@atlas/api/lib/brain/eval-corpus";
import { assertCanGate } from "@atlas/api/lib/brain/triage-measure-record";
import { wilsonLowerBound, RECALL_MIN, WILSON_LCB_MIN } from "@atlas/api/lib/brain/triage-measure";

const TAG = "[build-eval-fixture]";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  const value = process.argv[idx + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<number> {
  const sheetPath = flag("--sheet");
  const out = flag("-o") ?? flag("--out");
  const labeller = flag("--labeller");
  if (!sheetPath) {
    console.error(`${TAG} usage: --sheet <sheet.json> [--labeller <who> -o <fixture.json>]`);
    return 3;
  }

  let sheet;
  try {
    sheet = parseSheet(await Bun.file(sheetPath).json());
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof SheetFormatError ? 1 : 3;
  }

  const progress = sheetProgress(sheet);
  console.error(
    `${TAG} ${sheetPath}: ${progress.labelled}/${progress.total} labelled — ` +
      `positive=${progress.byClass.positive} rejected=${progress.byClass.rejected} ` +
      `negative=${progress.byClass.negative}`,
  );

  // ⭐ The set-size verdict is printed BEFORE any fixture is written, and it is
  // printed from the positives actually labelled rather than from the target.
  // At a perfect score the Wilson bound is `n/(n + z²)`, so this says whether
  // the sheet as labelled could clear the threshold even if triage misses
  // nothing — the question a labeller wants answered at row 200, not after.
  const best = wilsonLowerBound(progress.byClass.positive, progress.byClass.positive);
  console.error(
    `${TAG} at ${progress.byClass.positive} positive(s), a PERFECT recall would carry a 95% ` +
      `Wilson lower bound of ${best.toFixed(4)} against the ${WILSON_LCB_MIN} floor` +
      (best >= WILSON_LCB_MIN
        ? " — this sheet is large enough to produce a gating number."
        : ` — NOT enough. Collect and label more; recall ≥ ${RECALL_MIN} on too few positives clears nothing.`),
  );

  if (!out) return 0;

  let fixture;
  try {
    fixture = sheetToFixture(sheet, {
      labelsFrom: `${sheet.source.corpus}: ${sheet.source.repos.join(", ")} [${sheet.source.from}, ${sheet.source.to}) — labelled by ${labeller ?? "UNRECORDED"}`,
      cutAt: sheet.collectedAt,
    });
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!labeller) {
    // The provenance field exists so the structural rule has teeth — #5338:
    // whoever builds #5336 stage 1 may not author the set. A fixture that
    // cannot say who labelled it is a fixture whose author is unrecorded, and
    // the field would then be a formality rather than a check.
    console.error(`${TAG} --labeller is required to write a fixture: the set must record who judged it.`);
    return 3;
  }

  const refusal = assertCanGate(fixture);
  if (refusal) {
    console.error(`${TAG} ${refusal}`);
    return 1;
  }

  await Bun.write(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(`${TAG} wrote ${fixture.episodes.length} labelled episode(s) to ${out}`);
  console.error(`${TAG} next: bun scripts/measure-triage.ts --fixture ${out}`);
  return 0;
}

process.exit(await main());
