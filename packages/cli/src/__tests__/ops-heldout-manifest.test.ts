/**
 * Gate + reporting coverage for `atlas-operator ops heldout-manifest` (#5338).
 *
 * The cut's semantics — the window, the classes, the dial evidence and every
 * refusal — live in `lib/brain/heldout-manifest.ts` and are tested there,
 * against a literal handle and against a real Postgres. What is this file's is
 * the operator surface: the double-gate that decides DRY RUN vs EXECUTE, and
 * the two console renderings whose whole job is to stop an operator reading a
 * clean bill of health into a number that has none.
 */
import { describe, expect, it } from "bun:test";
import {
  HELDOUT_OK_ENV,
  checkHeldoutGate,
  formatCounts,
  formatDialEvidence,
  isHeldoutDryRun,
} from "../commands/operator/ops-heldout-manifest";
import {
  HELDOUT_MANIFEST_NOTICE,
  HELDOUT_MANIFEST_VERSION,
  type HeldoutManifest,
} from "@atlas/api/lib/brain/heldout-manifest";

const OPEN_GATE = { [HELDOUT_OK_ENV]: "1" } as NodeJS.ProcessEnv;

describe("ops heldout-manifest — the execute double-gate", () => {
  it("refuses to execute with neither half", () => {
    expect(checkHeldoutGate([], {})).toBe(`${HELDOUT_OK_ENV} is not set to 1`);
  });

  it("refuses to execute with either half alone", () => {
    expect(checkHeldoutGate([], OPEN_GATE)).toBe("--confirm was not passed");
    expect(checkHeldoutGate(["--confirm"], {})).toBe(`${HELDOUT_OK_ENV} is not set to 1`);
  });

  it("clears only when BOTH halves are present", () => {
    expect(checkHeldoutGate(["--confirm"], OPEN_GATE)).toBeNull();
  });

  it('treats any value other than exactly "1" as closed', () => {
    // "true", "yes" and "0" are all the shape of an operator who thinks the
    // gate is open. It is not. Freezing a set is a once-only act.
    for (const value of ["true", "yes", "0", "", "01"]) {
      expect(checkHeldoutGate(["--confirm"], { [HELDOUT_OK_ENV]: value })).toBe(
        `${HELDOUT_OK_ENV} is not set to 1`,
      );
    }
  });
});

describe("ops heldout-manifest — DRY RUN is the default", () => {
  it("previews when the gate is closed", () => {
    expect(isHeldoutDryRun([], {})).toBe(true);
    expect(isHeldoutDryRun(["--confirm"], {})).toBe(true);
    expect(isHeldoutDryRun([], OPEN_GATE)).toBe(true);
  });

  it("executes only when the gate is fully open", () => {
    expect(isHeldoutDryRun(["--confirm"], OPEN_GATE)).toBe(false);
  });

  it("honours an explicit --dry-run against an open gate", () => {
    expect(isHeldoutDryRun(["--confirm", "--dry-run"], OPEN_GATE)).toBe(true);
  });
});

describe("ops heldout-manifest — the dial-evidence report", () => {
  it("prints an unobserved audit half as UNATTESTED, not as a pass", () => {
    // The failure this exists to prevent: "cycles reporting triage: 0" out of
    // ZERO cycles observed reads exactly like a clean bill of health unless the
    // denominator is printed beside it. The audit probe is the only one that
    // survives a re-queue, so an operator has to know when it saw nothing.
    const out = formatDialEvidence({
      markedEpisodes: 0,
      cyclesObserved: 0,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
    });
    expect(out).toContain("UNATTESTED");
  });

  it("does not cry unattested when cycles were observed", () => {
    const out = formatDialEvidence({
      markedEpisodes: 0,
      cyclesObserved: 96,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
    });
    expect(out).not.toContain("UNATTESTED");
    expect(out).toContain("96");
  });

  it("renders an absent settings row as the default, never as an empty value", () => {
    // The dial's off state writes no row at all, so a blank here would read as
    // "we could not tell" when in fact we could.
    const out = formatDialEvidence({
      markedEpisodes: 0,
      cyclesObserved: 1,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
    });
    expect(out).toContain("no override row (default: off)");
  });

  it("prints the settings row verbatim when one exists", () => {
    const out = formatDialEvidence({
      markedEpisodes: 2,
      cyclesObserved: 1,
      cyclesReportingTriage: 3,
      platformDialSetting: "true",
    });
    expect(out).toContain("true");
    expect(out).toContain("triaged-out marks in window: 2");
    expect(out).toContain("cycles reporting triage:     3");
  });
});

describe("ops heldout-manifest — the class report", () => {
  const manifest: HeldoutManifest = {
    version: HELDOUT_MANIFEST_VERSION,
    notice: HELDOUT_MANIFEST_NOTICE,
    issue: 5338,
    workspaceId: "ws-1",
    region: "us",
    window: {
      column: "ingested_at",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    },
    cutAt: "2026-09-02T00:00:00.000Z",
    dialEvidence: {
      markedEpisodes: 0,
      cyclesObserved: 10,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
    },
    counts: { positive: 37, rejected: 4, negative: 210, excluded: 9 },
    entries: [
      {
        episodeId: "11111111-1111-4111-8111-111111111111",
        class: "positive",
        positiveFacts: 1,
        rejectedFacts: 0,
      },
    ],
  };

  it("prints the excluded arm rather than hiding it", () => {
    // Excluded episodes — undecided drafts, unkeyable-import tombstones,
    // episodes still pending extraction — are a real population, and a report
    // that summed to fewer than the window held would read as a lost row.
    const out = formatCounts(manifest);
    expect(out).toContain("excluded (undecided):   9");
    expect(out).toContain("positive (published):   37");
    expect(out).toContain("manifest rows:          1");
  });

  it("names no episode id", () => {
    // The console output is the surface most likely to end up pasted into a
    // ticket. The counts are safe there; the ids are the manifest's business.
    expect(formatCounts(manifest)).not.toContain("11111111-1111-4111-8111-111111111111");
  });
});
