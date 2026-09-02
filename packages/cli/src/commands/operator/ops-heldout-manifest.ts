/**
 * `atlas-operator ops heldout-manifest` — cut, or re-verify, the FROZEN
 * held-out set #5338 measures the extraction cascade against.
 *
 * The window, the classes, the dial evidence and every refusal live in
 * `@atlas/api/lib/brain/heldout-manifest`; this file is the operator surface
 * around them — target selection, the execute double-gate, the audit row, and
 * the file write. Same split as `ops-gate-export.ts`, for the same reason: the
 * cut's semantics are then testable with a literal handle and no CLI at all.
 *
 * ## Why this is gated like `gate-export` even though it writes no tenant text
 *
 * A manifest carries ids and labels, never bodies — so the exfiltration
 * argument that gates `gate-export` is genuinely weaker here. Two things keep
 * the gate:
 *
 *   1. **The read is identical.** The cut runs the same joins over
 *      `brain_episodes` and `brain_facts` that a bundle does. A preview of
 *      tenant content is a read of tenant content whatever it prints, which is
 *      the same reasoning that puts `gate-export`'s DRY RUN in the audit log.
 *   2. **The write is a FREEZE.** This file is meant to be committed and never
 *      regenerated — #5338 forbids re-cutting a set to make a number look
 *      better. An act whose whole value is that it happened exactly once should
 *      not be a thing an operator can do by reflex.
 *
 * So: DRY RUN by default (the query runs, the counts printed are exact, no file
 * is written); EXECUTE requires `ATLAS_HELDOUT_OK=1` **and** `--confirm`.
 *
 * `--verify <path>` is the exception and is deliberately ungated. It writes
 * nothing, and everything it prints — an episode id that no longer resolves —
 * is already in the file the operator handed it. Re-resolution is what keeps a
 * frozen manifest honest, and a gate on it would be a gate on the safety
 * mechanism.
 */
import {
  internalQuery,
  closeInternalDB,
  getWorkspaceRegion,
} from "@atlas/api/lib/db/internal";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { checkRegionContainment } from "@atlas/api/lib/brain/gate-export";
import {
  cutHeldoutManifest,
  isUnderpowered,
  parseHeldoutManifest,
  resolveHeldoutManifest,
  HELDOUT_MIN_POSITIVES,
  type HeldoutManifest,
  type TriageDialEvidence,
} from "@atlas/api/lib/brain/heldout-manifest";
import { getFlag } from "../../../lib/cli-utils";
import { resolveRegionDbUrl } from "./ops-gate-export";

/** Env var that, set to exactly "1", is one half of the execute double-gate. */
export const HELDOUT_OK_ENV = "ATLAS_HELDOUT_OK";

const TAG = "[ops:heldout-manifest]";

/**
 * How many episode ids `--verify` prints before summarising the rest.
 *
 * Named rather than a bare `20` beside a named constant, on
 * `ops-gate-export.ts`'s `CONSOLE_PREDICATE_ROWS` precedent — and it appears at
 * two call sites, which is exactly where a bare literal drifts.
 */
export const CONSOLE_ID_ROWS = 20;

/**
 * The execute double-gate. Returns null when the run is cleared to EXECUTE, or
 * a human-readable reason when it is not — in which case the caller falls back
 * to a DRY RUN rather than erroring, exactly as `gate-export` does, so a
 * gate-less invocation previews instead of freezing a set by accident.
 */
export function checkHeldoutGate(args: string[], env: NodeJS.ProcessEnv): string | null {
  if (env[HELDOUT_OK_ENV] !== "1") {
    return `${HELDOUT_OK_ENV} is not set to 1`;
  }
  if (!args.includes("--confirm")) {
    return "--confirm was not passed";
  }
  return null;
}

/** Whether this invocation is a DRY RUN. `--dry-run` forces preview even when
 *  the gate is open, so an operator can belt-and-braces a gated run. */
export function isHeldoutDryRun(args: string[], env: NodeJS.ProcessEnv): boolean {
  return checkHeldoutGate(args, env) !== null || args.includes("--dry-run");
}

/**
 * Render the dial evidence for the console.
 *
 * `cyclesObserved: 0` prints as UNATTESTED rather than as a pass. The audit half
 * of the evidence is the only probe that survives a re-queue, so an operator
 * needs to know when it had nothing to look at — and "0 cycles reporting triage"
 * out of 0 cycles observed reads like a clean bill of health if you do not print
 * the denominator.
 */
export function formatDialEvidence(evidence: TriageDialEvidence): string {
  const attested = evidence.cyclesObserved > 0;
  return [
    `  triaged-out marks in window: ${evidence.markedEpisodes}`,
    `  extraction cycles observed:  ${evidence.cyclesObserved}${
      attested ? "" : "  ⚠️ UNATTESTED — audit rows pruned, or the fiber never ran"
    }`,
    `  cycles reporting triage:     ${evidence.cyclesReportingTriage}`,
    `  platform dial setting:       ${
      evidence.platformDialSetting === null
        ? "no override row (default: off)"
        : evidence.platformDialSetting
    }`,
    // ⚠️ Printed on every run, because #5338 AC 2 says "off in EVERY region"
    // and each probe above read exactly one. A process may only read its own
    // (ADR-0024), so covering the fleet means running this command in each
    // region and keeping each manifest — and an operator who is not told the
    // scope will read a one-region pass as a fleet-wide one.
    `  attests region:              ${
      evidence.attestsRegion === null
        ? "unregioned deployment (single region / self-hosted)"
        : `${evidence.attestsRegion} ONLY — other regions are not probed and are not attested`
    }`,
  ].join("\n");
}

/** Render the class counts for the console. */
export function formatCounts(manifest: HeldoutManifest): string {
  return [
    `  positive (published):   ${manifest.counts.positive}`,
    `  rejected (retracted):   ${manifest.counts.rejected}`,
    `  negative (no claim):    ${manifest.counts.negative}`,
    `  excluded (undecided):   ${manifest.counts.excluded}`,
    `    …of which draining:   ${manifest.counts.stillDraining}`,
    `  manifest rows:          ${manifest.entries.length}`,
  ].join("\n");
}

/**
 * Bind the internal-DB pool to the chosen region DB.
 *
 * Closes any pre-bound pool first so the rebind is authoritative rather than a
 * silent no-op against a previously-bound DB — the same hazard and the same
 * handling as `ops-gate-export.ts` and `ops-teardown-verify.ts`.
 */
async function bindRegionDb(url: string): Promise<void> {
  await closeInternalDB().catch(() => {
    // intentionally ignored: best-effort discard of any pre-bound pool before
    // rebinding. Not reachable from the one-shot CLI (no AppLayer boots here),
    // which is why it stays best-effort rather than fatal.
  });
  process.env.DATABASE_URL = url;
}

/**
 * Containment for the VERIFY path: null to proceed, or the operator-facing
 * refusal.
 *
 * ⚠️ **Not decoration, and its absence was the sharpest defect in the first cut
 * of this command.** Re-resolution's whole value is that an id which no longer
 * resolves is a LOUD purge signal. Point a `us` manifest at `--region eu` and
 * every row fails to resolve — so the alarm the design rests on would fire, at
 * full volume, on a flag typo. The cut path has always refused to cross a
 * boundary; the path that PRINTS the alarm has to refuse on the same terms or
 * the alarm means nothing.
 *
 * Composed from `checkRegionContainment` rather than re-deciding: one
 * containment rule for the whole brain, including its fail-closed
 * unproven-region arm, which is the one that matters on the `--database-url`
 * path.
 */
export function checkVerifyContainment(
  apiRegion: string | null,
  manifestRegion: string | null,
): string | null {
  if (!checkRegionContainment(apiRegion, manifestRegion)) return null;
  return (
    `this manifest was cut in region ${JSON.stringify(manifestRegion)} and this invocation is ` +
    `reading ${JSON.stringify(apiRegion)}. Every row would fail to resolve and be reported as a ` +
    `purge, which is a false alarm rather than a finding. Re-run with ` +
    `--region ${manifestRegion ?? "<the manifest's region>"}.`
  );
}

/**
 * Release the region pool, reporting a failure to close rather than swallowing
 * it. Both entry points end here, and both used to carry a byte-identical copy
 * of it — as does `ops-gate-export.ts`, which is where the shape comes from.
 */
async function closeRegionDb(): Promise<void> {
  await closeInternalDB().catch((closeErr) => {
    console.warn(
      `${TAG} failed to close the internal DB pool: ${
        closeErr instanceof Error ? closeErr.message : String(closeErr)
      }`,
    );
  });
}

const reader = {
  query: async (sql: string, params?: unknown[]) => ({ rows: await internalQuery(sql, params) }),
};

async function handleVerify(args: string[], path: string): Promise<void> {
  const resolved = resolveRegionDbUrl(args, process.env);
  if (!resolved.ok) {
    console.error(`${TAG} ${resolved.error}`);
    process.exit(1);
  }
  await bindRegionDb(resolved.url);

  console.log(`${TAG} target DB: ${resolved.source} · VERIFY · ${path}`);
  try {
    const manifest = parseHeldoutManifest(JSON.parse(await Bun.file(path).text()));

    // ⚠️ Containment on the VERIFY path, and it is not decoration.
    //
    // Re-resolution's whole value is that an id which no longer resolves is a
    // LOUD purge signal. Point a `us` manifest at `--region eu` and every row
    // fails to resolve — so the alarm the design rests on would fire, at full
    // volume, on a flag typo. The cut path has always refused to cross a
    // boundary; the path that PRINTS the alarm has to refuse on the same terms
    // or the alarm means nothing.
    const apiRegion = process.env.ATLAS_API_REGION ?? resolved.region ?? null;
    const containment = checkVerifyContainment(apiRegion, manifest.region);
    if (containment) {
      console.error(`${TAG} REFUSED (region-boundary): ${containment}`);
      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.brain.heldoutManifest,
        targetType: "brain",
        targetId: manifest.workspaceId,
        status: "failure",
        scope: "platform",
        systemActor: "system:atlas-operator",
        metadata: {
          mode: "verify",
          refusal: "region-boundary",
          manifestRegion: manifest.region,
          apiRegion,
          targetDb: resolved.source,
        },
      });
      process.exitCode = 1;
      return;
    }

    const resolution = await resolveHeldoutManifest(reader, manifest);

    console.log(
      `${TAG} ${resolution.resolved}/${resolution.checked} row(s) still resolve in workspace ${manifest.workspaceId}`,
    );
    if (resolution.missing.length > 0) {
      // Loud, and named as a purge rather than as a gap. The one wrong response
      // is to re-cut the manifest until the count comes back up — #5338 forbids
      // regenerating the set, and a shrinking denominator is a fact about the
      // corpus that belongs beside the number.
      console.warn(
        `${TAG} ⚠️ ${resolution.missing.length} row(s) NO LONGER RESOLVE. These episodes were ` +
          `purged after the cut. Record the shrunken denominator beside any number computed from ` +
          `this set — do NOT re-cut the manifest to replace them.`,
      );
      for (const id of resolution.missing.slice(0, CONSOLE_ID_ROWS)) {
        console.warn(`${TAG}   missing ${id}`);
      }
      if (resolution.missing.length > CONSOLE_ID_ROWS) {
        console.warn(`${TAG}   … and ${resolution.missing.length - CONSOLE_ID_ROWS} more`);
      }
    }
    if (resolution.drifted.length > 0) {
      // NOT a failure. The manifest owns the label as of its cutAt precisely
      // because decision time is not queryable; a reviewer retracting a
      // published claim after the cut is the corpus moving, not the set rotting.
      console.log(
        `${TAG} ${resolution.drifted.length} row(s) have drifted class since the cut (a decision ` +
          `landed after cutAt). The frozen label stands — this is information, not a defect.`,
      );
      for (const d of resolution.drifted.slice(0, CONSOLE_ID_ROWS)) {
        console.log(`${TAG}   ${d.episodeId}: ${d.frozen} → ${d.live ?? "no arm"}`);
      }
      if (resolution.drifted.length > CONSOLE_ID_ROWS) {
        console.log(`${TAG}   … and ${resolution.drifted.length - CONSOLE_ID_ROWS} more`);
      }
    }

    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.brain.heldoutManifest,
      targetType: "brain",
      targetId: manifest.workspaceId,
      scope: "platform",
      systemActor: "system:atlas-operator",
      metadata: {
        mode: "verify",
        manifestCutAt: manifest.cutAt,
        checked: resolution.checked,
        resolved: resolution.resolved,
        missing: resolution.missing.length,
        drifted: resolution.drifted.length,
        targetDb: resolved.source,
      },
    });
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeRegionDb();
  }
}

export async function handleHeldoutManifest(args: string[]): Promise<void> {
  const verifyPath = getFlag(args, "--verify");
  if (verifyPath) return handleVerify(args, verifyPath);

  const dryRun = isHeldoutDryRun(args, process.env);

  const workspaceId = getFlag(args, "--workspace");
  const from = getFlag(args, "--from");
  const to = getFlag(args, "--to");
  if (!workspaceId || !from || !to) {
    console.error(
      `${TAG} --workspace <orgId>, --from <iso> and --to <iso> are all required. The set is cut ` +
        `MECHANICALLY over a time window (half-open, [from, to)) rather than sampled, so that it ` +
        `has no author to be conflicted (#5338 AC 1). There is no "just give me N rows" mode.`,
    );
    process.exit(1);
  }

  const resolved = resolveRegionDbUrl(args, process.env);
  if (!resolved.ok) {
    console.error(`${TAG} ${resolved.error}`);
    process.exit(1);
  }

  const output =
    getFlag(args, "--output") ??
    getFlag(args, "-o") ??
    `./atlas-heldout-${workspaceId}-${to.slice(0, 10)}.json`;

  await bindRegionDb(resolved.url);

  console.log(
    `${TAG} target DB: ${resolved.source} · ${dryRun ? "DRY RUN" : "EXECUTE"} · workspace ${workspaceId} · [${from}, ${to})`,
  );
  if (dryRun) {
    const why = checkHeldoutGate(args, process.env);
    console.log(
      `${TAG} DRY RUN${why ? ` (${why})` : " (--dry-run)"} — the query runs and the counts below ` +
        `are exact; no manifest is written.`,
    );
  }

  try {
    // The region label on the workspace row, not the physical DB. Both matter:
    // `--database-url` can point anywhere, and the stamped label is what
    // ADR-0024 treats as the workspace's residency.
    const workspaceRegion = await getWorkspaceRegion(workspaceId);
    const apiRegion = process.env.ATLAS_API_REGION ?? resolved.region ?? null;

    const cut = await cutHeldoutManifest(reader, {
      workspaceId,
      apiRegion,
      workspaceRegion,
      from,
      to,
    });

    if (!cut.ok) {
      console.error(`${TAG} REFUSED (${cut.refusal.refusal}): ${cut.refusal.detail}`);
      // Audit the refusal, and this row is load-bearing rather than tidy: a
      // `triage-active` refusal is the durable record that this region's #5338
      // window had closed by this date, and the mark it refused on is erased by
      // a re-queue.
      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.brain.heldoutManifest,
        targetType: "brain",
        targetId: workspaceId,
        status: "failure",
        scope: "platform",
        systemActor: "system:atlas-operator",
        metadata: {
          mode: "cut",
          refusal: cut.refusal.refusal,
          window: { from, to },
          dryRun,
          targetDb: resolved.source,
        },
      });
      process.exitCode = 1;
      return;
    }

    const { manifest } = cut;

    console.log(`${TAG} dial evidence:`);
    console.log(formatDialEvidence(manifest.dialEvidence));
    console.log(`${TAG} classes:`);
    console.log(formatCounts(manifest));

    if (manifest.dialEvidence.cyclesObserved === 0) {
      console.warn(
        `${TAG} ⚠️ the audit half of the dial evidence is UNATTESTED — no extraction-cycle rows ` +
          `exist between the window's start and now. The triaged_out_at probe still passed, but ` +
          `that mark is cleared by a re-queue, so this manifest's "the dial was off" claim rests ` +
          `on one erasable signal. Say so wherever its number is reported.`,
      );
    }
    if (manifest.counts.stillDraining > 0) {
      // The limit `checkCutWindow` cannot enforce, said out loud. `to <= now`
      // does not mean the drain caught up, and these episodes would have been
      // decisions in a cut taken a day later — so the negative arm's size
      // depends on when this ran.
      console.warn(
        `${TAG} ⚠️ ${manifest.counts.stillDraining} episode(s) in this window are STILL ON THE ` +
          `DRAIN and are frozen as excluded rather than as the decision they are about to reach. ` +
          `The negative arm's size therefore depends on when this cut ran. Either wait for the ` +
          `drain to clear and cut again, or report the number beside any result from this set.`,
      );
    }
    if (manifest.entries.length === 0) {
      // The shape an operator typo takes. There is no "unknown workspace"
      // refusal to lean on — after a purge, a purged workspace and a mistyped
      // id are indistinguishable to every query this command can run.
      console.warn(
        `${TAG} ⚠️ NOTHING IN THIS WINDOW for workspace ${workspaceId}. Either nothing was ` +
          `ingested and decided in [${from}, ${to}), or the workspace was purged, or the id is ` +
          `wrong — this command cannot tell those apart. Check the id before reading anything ` +
          `into an empty manifest.`,
      );
    }
    if (isUnderpowered(manifest.counts)) {
      console.warn(
        `${TAG} ⚠️ UNDERPOWERED: ${manifest.counts.positive} positive(s), and #5338's threshold ` +
          `pair needs ~${HELDOUT_MIN_POSITIVES} for its 95% Wilson lower bound to clear 95%. ` +
          `This is a real and expected state on a young workspace — the gating number is set on ` +
          `the synthetic set and this cut is the smoke test. Do not widen the window to chase the ` +
          `count unless you also say the window moved.`,
      );
    }

    if (!dryRun) {
      await Bun.write(output, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`${TAG} wrote ${output}`);
      console.log(
        `${TAG} ⚠️ This set is now FROZEN. Commit it under packages/api/scripts/heldout/ and do ` +
          `not re-cut it: #5338's measurement budget is candidates declared before the cut, each ` +
          `measured once, and more than three attempts means cutting a SECOND set rather than ` +
          `replacing this one.`,
      );
    }

    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.brain.heldoutManifest,
      targetType: "brain",
      targetId: workspaceId,
      scope: "platform",
      systemActor: "system:atlas-operator",
      metadata: {
        mode: "cut",
        window: { from, to },
        cutAt: manifest.cutAt,
        dryRun,
        counts: manifest.counts,
        dialEvidence: manifest.dialEvidence,
        targetDb: resolved.source,
        // The path, never the contents — and never an episode id.
        output: dryRun ? null : output,
      },
    });
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeRegionDb();
  }
}
