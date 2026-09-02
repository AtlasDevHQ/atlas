#!/usr/bin/env bun
/**
 * `bun scripts/measure-triage.ts` — #5338's synthetic harness (AC 7, first
 * half): the number, from a labelled fixture, with **no database**.
 *
 * The arithmetic is `lib/brain/triage-measure.ts` and the governance is
 * `lib/brain/triage-measure-record.ts`; this file is the CLI around them, on
 * the split `gate-export.ts` / `ops-gate-export.ts` uses. Nothing here touches
 * a database, a model, or a network — the real-workspace arm is
 * `atlas-operator ops heldout-manifest`, behind its region check and its gate.
 *
 * ## What it can measure TODAY, and what it is waiting for
 *
 * The threshold is a pair, and its yield half is **relative**: the composed
 * layer must drop strictly more than stage 0 alone at no worse recall. That
 * makes the stage-0 baseline a prerequisite of the comparison rather than a
 * by-product of it — so it is worth measuring now, before #5336's stage 1
 * exists, precisely so stage 1 lands against a number that is already on the
 * record instead of one invented alongside it. `practices.md`'s structural rule
 * (*the actor that builds a check may not be its only judge*) is doing real
 * work there.
 *
 * With no stage-1 adapter available this reports the baseline and says so. It
 * does NOT report a composed measurement equal to the baseline and let a reader
 * mistake it for a passing cascade — a layer that ties stage 0 fails the yield
 * half by construction, and printing that as a verdict would be a failing
 * result dressed as an absent one.
 *
 * ## Usage
 *
 *   bun scripts/measure-triage.ts --fixture scripts/heldout/fixtures/smoke.json
 *   bun scripts/measure-triage.ts --fixture <evaluation.json> --record
 *
 * `--record` takes no path by default and writes
 * `src/lib/brain/triage-measurements.json` — the store the triage-default gate
 * and the Coverage Surface read. Passing a different path is allowed and warns:
 * a run recorded where nothing reads it counts toward nothing.
 *
 * Exit codes: 0 reported · 1 threshold failed · 2 refused (a smoke fixture
 * cannot produce a gating verdict) · 3 bad input.
 */
import {
  replayTriage,
  scoreReplay,
  evaluateThreshold,
  tasteAlarm,
  RECALL_MIN,
  WILSON_LCB_MIN,
  type LayerMeasurement,
} from "@atlas/api/lib/brain/triage-measure";
import {
  assertCanGate,
  checkMeasurementBudget,
  parseMeasurementFixture,
  verifyRecordedVerdict,
  type RecordedMeasurement,
} from "@atlas/api/lib/brain/triage-measure-record";
import { deterministicTriager, type Triager } from "@atlas/api/lib/brain/triage";
import { RECORDED_MEASUREMENTS_PATH } from "@atlas/api/lib/brain/triage-measurements";

const TAG = "[measure-triage]";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  const value = process.argv[idx + 1];
  return value?.startsWith("--") ? undefined : value;
}

/**
 * The stage-1 adapter, when one exists.
 *
 * ⚠️ Deliberately a lookup that returns null rather than a stub that returns
 * "keep everything". A no-op stage 1 would compose to exactly stage 0's
 * numbers, and the yield half of the threshold would then report a clean,
 * specific failure about a layer that does not exist — which reads like a
 * measured result. The absence is reported as an absence.
 */
function loadStage1Triager(): Triager | null {
  // #5336 stage 1 (the CPU classifier) is not built. When it is, it mounts
  // here and composes BEHIND the deterministic floor via `composeTriagers`,
  // exactly as `triage.ts`'s header specifies.
  return null;
}

function formatLayer(label: string, m: LayerMeasurement): string {
  return [
    `${label}:`,
    `  episodes:            ${m.total}`,
    `  dropped (yield):     ${m.dropped}  (${(m.yieldRate * 100).toFixed(2)}%)`,
    `  positives:           ${m.positives}`,
    `  positives kept:      ${m.positivesKept}`,
    `  recall:              ${m.recall.toFixed(4)}`,
    `  recall 95% Wilson ≥: ${m.recallLowerBound.toFixed(4)}`,
    `  diagnostic recall:   ${m.diagnosticRecall.toFixed(4)}  (positives+rejected, UNGATED)`,
    m.misses.length > 0 ? `  MISSED positives:    ${m.misses.join(", ")}` : `  MISSED positives:    none`,
    `  by reason:           ${
      Object.keys(m.byReason).length === 0
        ? "—"
        : Object.entries(m.byReason)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([reason, n]) => `${reason}=${n}`)
            .join(" ")
    }`,
  ].join("\n");
}

async function main(): Promise<number> {
  const fixturePath = flag("--fixture");
  if (!fixturePath) {
    console.error(
      `${TAG} --fixture <path> is required. The harness measures a LABELLED set; it does not ` +
        `generate one. See scripts/heldout/README.md.`,
    );
    return 3;
  }

  let fixture;
  try {
    fixture = parseMeasurementFixture(JSON.parse(await Bun.file(fixturePath).text()));
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }

  console.log(`${TAG} fixture ${fixturePath} · role=${fixture.role} · ${fixture.episodes.length} episode(s)`);

  const baseline = scoreReplay(await replayTriage(deterministicTriager, fixture.episodes));
  console.log(formatLayer("stage 0 (deterministic rules) — the BASELINE", baseline));

  if (tasteAlarm(baseline)) {
    console.warn(
      `${TAG} ⚠️ TASTE ALARM: diagnostic recall (${baseline.diagnosticRecall.toFixed(4)}) sits ` +
        `materially below gating recall (${baseline.recall.toFixed(4)}). The layer is dropping ` +
        `episodes a reviewer SAW and rejected while keeping the ones a reviewer approved — that ` +
        `is a filter that learned reviewer TASTE rather than claim PRESENCE, which is a ` +
        `different artefact from the one #5334 asked for. Ungated by design; say it out loud.`,
    );
  }

  const stage1 = loadStage1Triager();
  if (!stage1) {
    console.log(
      `${TAG} No stage-1 adapter is available, so there is no COMPOSED layer to measure and no ` +
        `threshold verdict to give. The baseline above is the figure #5336 stage 1 must beat: ` +
        `strictly more yield than ${(baseline.yieldRate * 100).toFixed(2)}% at recall no worse ` +
        `than ${baseline.recall.toFixed(4)}, with its own recall ≥ ${RECALL_MIN} and a 95% ` +
        `Wilson lower bound ≥ ${WILSON_LCB_MIN}.`,
    );
    return 0;
  }

  // Unreachable until #5336 stage 1 lands; written now so the arm that produces
  // a verdict is not authored in the same hour the number is wanted.
  const refusal = assertCanGate(fixture);
  if (refusal) {
    console.error(`${TAG} REFUSED: ${refusal}`);
    return 2;
  }

  const { composeTriagers } = await import("@atlas/api/lib/brain/triage");
  const composed = scoreReplay(
    await replayTriage(composeTriagers(deterministicTriager, stage1), fixture.episodes),
  );
  console.log(formatLayer("composed (stage 0 → stage 1)", composed));

  const verdict = evaluateThreshold(composed, baseline);
  console.log(`${TAG} threshold pair: ${verdict.passed ? "PASS" : "FAIL"}`);
  for (const failure of verdict.failures) console.error(`${TAG}   ✗ ${failure}`);

  // `--record` with no path writes the canonical store — the one the default
  // gate and the Coverage Surface read. A DIFFERENT path is still honoured (a
  // scratch run is a legitimate thing to want) but says loudly that nothing
  // will consult it, because a measurement recorded where nothing reads it is
  // the same defect as a gate whose only caller passes `[]`.
  const recordFlagPresent = process.argv.includes("--record");
  const recordPath = recordFlagPresent ? (flag("--record") ?? RECORDED_MEASUREMENTS_PATH) : undefined;
  if (recordPath !== undefined) {
    if (recordPath !== RECORDED_MEASUREMENTS_PATH) {
      console.error(
        `${TAG} ⚠️ recording to ${recordPath}, which is NOT the store the triage-default gate ` +
          `and the Coverage Surface read (${RECORDED_MEASUREMENTS_PATH}). This run will not ` +
          `count toward the measurement budget and cannot license defaulting the dial on.`,
      );
    }
    const setId = fixture.provenance?.manifestCutAt ?? fixture.provenance?.labelsFrom ?? fixturePath;
    const record: RecordedMeasurement = {
      setId,
      measuredAt: new Date().toISOString(),
      candidate: flag("--candidate") ?? "unnamed",
      composed,
      baseline,
      passed: verdict.passed,
    };
    // A MISSING file is the first record and reads as an empty store. An
    // UNPARSEABLE one is not: swallowing it would rewrite the file with this
    // run alone, silently resetting every prior attempt's count to zero — which
    // spends the measurement budget's entire memory and looks like a clean
    // first run. The two cases are told apart rather than collapsed.
    const file = Bun.file(recordPath);
    let existing: unknown = [];
    if (await file.exists()) {
      try {
        existing = await file.json();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `${TAG} ${recordPath} exists and is not valid JSON (${message}). Refusing to write: ` +
            `overwriting it would discard every recorded attempt and reset the budget.`,
        );
        return 3;
      }
    }
    if (!Array.isArray(existing)) {
      console.error(
        `${TAG} ${recordPath} does not hold a JSON array. Refusing to write, for the same reason.`,
      );
      return 3;
    }
    const all = [...(existing as RecordedMeasurement[]), record];
    await Bun.write(recordPath, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`${TAG} recorded to ${recordPath}`);

    const mismatch = verifyRecordedVerdict(record);
    if (mismatch) console.error(`${TAG} ⚠️ ${mismatch}`);
    const overBudget = checkMeasurementBudget(all);
    if (overBudget) console.error(`${TAG} ⚠️ ${overBudget}`);
  }

  return verdict.passed ? 0 : 1;
}

process.exit(await main());
