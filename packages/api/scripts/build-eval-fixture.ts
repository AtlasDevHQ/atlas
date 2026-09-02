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
  assertOutsideRepo,
  fixtureDigest,
  parseSheet,
  sheetProgress,
  sheetsToFixture,
  SheetFormatError,
} from "@atlas/api/lib/brain/eval-corpus";
import { flag, repeatedFlag } from "./argv";
import { assertCanGate } from "@atlas/api/lib/brain/triage-measure-record";
import { wilsonLowerBound, RECALL_MIN, WILSON_LCB_MIN } from "@atlas/api/lib/brain/triage-measure";

const TAG = "[build-eval-fixture]";


async function main(): Promise<number> {
  const sheetPaths = repeatedFlag("--sheet");
  const out = flag("-o") ?? flag("--out");
  const labeller = flag("--labeller");
  if (sheetPaths.length === 0) {
    console.error(`${TAG} usage: --sheet <sheet.json> [--sheet …] [--labeller <who> -o <fixture.json>]`);
    return 3;
  }
  // ⭐ Checked BEFORE the sheets are read, not after the fixture is built. A
  // missing labeller is a refusal on the whole run, so a labeller who forgot
  // the flag is told before waiting on the work rather than after it.
  if (out && !labeller) {
    console.error(`${TAG} --labeller is required to write a fixture: the set must record who judged it.`);
    return 3;
  }
  if (out) {
    // ⛔ A fixture carries bodies AND labels. Neither may enter the repo.
    const outside = assertOutsideRepo(out);
    if (outside) {
      console.error(`${TAG} ${outside}`);
      return 1;
    }
  }

  const sheets = [];
  for (const sheetPath of sheetPaths) {
    try {
      sheets.push(parseSheet(await Bun.file(sheetPath).json()));
    } catch (err) {
      console.error(`${TAG} ${sheetPath}: ${err instanceof Error ? err.message : String(err)}`);
      return err instanceof SheetFormatError ? 1 : 3;
    }
  }

  const progress = sheets
    .map(sheetProgress)
    .reduce((a, b) => ({
      total: a.total + b.total,
      labelled: a.labelled + b.labelled,
      unlabelled: [...a.unlabelled, ...b.unlabelled],
      byClass: {
        positive: a.byClass.positive + b.byClass.positive,
        rejected: a.byClass.rejected + b.byClass.rejected,
        negative: a.byClass.negative + b.byClass.negative,
      },
    }));
  console.error(
    `${TAG} ${sheetPaths.length} sheet(s): ${progress.labelled}/${progress.total} labelled — ` +
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
    const sources = sheets
      .map((s) => `${s.source.corpus}: ${s.source.repos.join(", ")} [${s.source.from}, ${s.source.to})`)
      .join(" + ");
    fixture = sheetsToFixture(sheets, {
      labelsFrom: `${sources} — labelled by ${labeller}`,
      cutAt: sheets.map((s) => s.collectedAt).toSorted().at(-1) ?? new Date().toISOString(),
    });
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const refusal = assertCanGate(fixture);
  if (refusal) {
    console.error(`${TAG} ${refusal}`);
    return 1;
  }

  await Bun.write(out, `${JSON.stringify(fixture, null, 2)}\n`);
  const digest = await fixtureDigest(fixture);
  console.error(`${TAG} wrote ${fixture.episodes.length} labelled episode(s) to ${out}`);
  // The digest is the ONE thing about this set that may live in git — the path
  // plan permits "the manifests' hashes if useful" while refusing text and
  // labels. Carrying it as the setId is what turns "measured on apache-2026-06"
  // from a string anybody could type into something checkable.
  console.error(`${TAG} sha256: ${digest}`);
  console.error(
    `${TAG} next: bun scripts/measure-triage.ts --fixture ${out} --candidate <name> --record\n` +
      `${TAG} the fixture stays OUT of git; the recorded measurement and this digest are what land in it.`,
  );
  return 0;
}

process.exit(await main());
