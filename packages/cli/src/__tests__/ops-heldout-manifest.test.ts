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
  checkVerifyContainment,
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
      attestsRegion: "us",
    });
    expect(out).toContain("UNATTESTED");
  });

  it("does not cry unattested when cycles were observed", () => {
    const out = formatDialEvidence({
      markedEpisodes: 0,
      cyclesObserved: 96,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
      attestsRegion: "us",
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
      attestsRegion: "us",
    });
    expect(out).toContain("no override row (default: off)");
  });

  it("⭐ says the attestation covers ONE region, because AC 2 asks about every one", () => {
    // ADR-0024 makes the process the region, so every probe read exactly one
    // database. An operator not told the scope will read a one-region pass as a
    // fleet-wide one — which is the specific misreading #5338 AC 2 invites.
    const out = formatDialEvidence({
      markedEpisodes: 0,
      cyclesObserved: 96,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
      attestsRegion: "us",
    });
    expect(out).toContain("us ONLY");
    expect(out).toContain("not attested");
  });

  it("names an unregioned deployment rather than printing null", () => {
    const out = formatDialEvidence({
      markedEpisodes: 0,
      cyclesObserved: 1,
      cyclesReportingTriage: 0,
      platformDialSetting: null,
      attestsRegion: null,
    });
    expect(out).toContain("single region / self-hosted");
    expect(out).not.toContain("null");
  });

  it("prints the settings row verbatim when one exists", () => {
    const out = formatDialEvidence({
      markedEpisodes: 2,
      cyclesObserved: 1,
      cyclesReportingTriage: 3,
      platformDialSetting: "true",
      attestsRegion: "us",
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
      attestsRegion: "us",
    },
    counts: { positive: 37, rejected: 4, negative: 210, excluded: 9, stillDraining: 2 },
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
    // The drain shortfall is broken out of `excluded`, because a reviewer's
    // backlog and a set that has not finished freezing are different problems.
    expect(out).toContain("…of which draining:   2");
    expect(out).toContain("positive (published):   37");
    expect(out).toContain("manifest rows:          1");
  });

  it("names no episode id", () => {
    // The console output is the surface most likely to end up pasted into a
    // ticket. The counts are safe there; the ids are the manifest's business.
    expect(formatCounts(manifest)).not.toContain("11111111-1111-4111-8111-111111111111");
  });
});

describe("ops heldout-manifest — --verify refuses to cross a region boundary", () => {
  it("⭐ refuses rather than reporting every row as purged", () => {
    // The fix for the sharpest defect in this command. Re-resolution's whole
    // value is that an unresolvable id is a LOUD purge signal — so pointing a
    // `us` manifest at `--region eu` would fire that alarm, at full volume, on
    // a flag typo. The path that PRINTS the alarm has to refuse on the same
    // terms as the path that cuts, or the alarm means nothing.
    const refusal = checkVerifyContainment("eu", "us");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("false alarm");
    expect(refusal).toContain("--region us");
  });

  it("proceeds when the regions agree", () => {
    expect(checkVerifyContainment("us", "us")).toBeNull();
  });

  it("proceeds for an unregioned manifest on an unregioned deployment", () => {
    // Self-hosted: no regions at all, so there is no boundary to cross —
    // `checkRegionContainment`'s own call, not a second opinion about it.
    expect(checkVerifyContainment(null, null)).toBeNull();
  });

  it("refuses when the manifest names a region this process cannot prove it serves", () => {
    // Unproven containment fails closed, which is the arm that matters on the
    // `--database-url` path: that one invocation can point at any region on
    // earth and carries no ATLAS_API_REGION to check itself against.
    expect(checkVerifyContainment(null, "us")).not.toBeNull();
  });
});
