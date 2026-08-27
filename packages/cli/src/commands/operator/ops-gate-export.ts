/**
 * `atlas-operator ops gate-export` — cut an EVALUATION bundle of one
 * workspace's review-gate decisions (#5335).
 *
 * The query, the classes and the refusals live in
 * `@atlas/api/lib/brain/gate-export`; this file is the operator surface around
 * them — target selection, the execute double-gate, the audit row, and the
 * file write. Splitting it that way is what lets the decision semantics be
 * tested with a literal handle and no CLI at all.
 *
 * ## ⚠️ EVALUATION ONLY
 *
 * ADR-0043 (#5339): brain facts are never trained into weights, and customer
 * data is never a training corpus. A bundle this command writes exists to
 * MEASURE the extraction cascade (#5338 — stage-1 recall and gate agreement),
 * is read once, and is destroyed. It is outside `purge-scope.ts` by
 * construction, which is the same objection #5339 raises against weights — so
 * cut one for a named evaluation and delete it afterwards. The bundle carries
 * that sentence in its own header so a reader who never saw this file cannot
 * miss it.
 *
 * ## Why a read is double-gated like a delete
 *
 * `ops wipe` and `ops teardown-verify-accounts` are gated because they
 * DESTROY. This one is gated because it EXFILTRATES: it reads verbatim tenant
 * content — Slack messages, Zoom transcript lines, mail bodies, and the claims
 * a human ruled on — and writes them to a portable file that leaves every
 * mechanism the platform has for reaching tenant data. A purge cannot reach a
 * bundle; residency routing cannot recall one. The asymmetry that usually
 * makes reads cheaper than writes does not hold when the read's output
 * outlives the system's control over it, so this takes `ops wipe`'s shape:
 * DRY RUN by default, EXECUTE requires `ATLAS_GATE_EXPORT_OK=1` **and**
 * `--confirm`.
 *
 * A DRY RUN runs the identical query and reports the exact counts and
 * analytics — it just never writes the file. That is deliberate: the preview
 * an operator uses to decide whether to export has to be the thing that would
 * be exported, or the gate is protecting a decision made on different numbers.
 */
import {
  internalQuery,
  closeInternalDB,
  getWorkspaceRegion,
} from "@atlas/api/lib/db/internal";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  buildGateExportBundle,
  GATE_EXPORT_ROW_MAX,
  type GateAnalytics,
} from "@atlas/api/lib/brain/gate-export";
import { getFlag } from "../../../lib/cli-utils";

/** Env var that, set to exactly "1", is one half of the execute double-gate. */
export const GATE_EXPORT_OK_ENV = "ATLAS_GATE_EXPORT_OK";

/** The real prod residency regions whose DB URL `--region` can resolve. */
export const REGION_DB_ENV = {
  us: "ATLAS_REGION_US_DB_URL",
  eu: "ATLAS_REGION_EU_DB_URL",
  apac: "ATLAS_REGION_APAC_DB_URL",
} as const;

export type GateExportRegion = keyof typeof REGION_DB_ENV;

/**
 * The execute double-gate, mirroring `checkTeardownGate`. Returns null when
 * the run is cleared to EXECUTE, or a human-readable reason when it is not —
 * in which case the caller falls back to a DRY RUN rather than erroring, so a
 * gate-less invocation safely previews instead of writing tenant content to
 * disk.
 */
export function checkGateExportGate(
  args: string[],
  env: NodeJS.ProcessEnv,
): string | null {
  if (env[GATE_EXPORT_OK_ENV] !== "1") {
    return `${GATE_EXPORT_OK_ENV} is not set to 1`;
  }
  if (!args.includes("--confirm")) {
    return "--confirm was not passed";
  }
  return null;
}

/**
 * Whether this invocation is a DRY RUN (preview, no file written). True unless
 * the execute double-gate is satisfied — and `--dry-run` always forces preview
 * even when the gate is open, so an operator can belt-and-braces a gated run.
 */
export function isDryRun(args: string[], env: NodeJS.ProcessEnv): boolean {
  return checkGateExportGate(args, env) !== null || args.includes("--dry-run");
}

export type RegionDbResolution =
  | { ok: true; url: string; source: string; region: GateExportRegion | null }
  | { ok: false; error: string };

/**
 * Resolve which region DB to read. Precedence: an explicit `--database-url`
 * wins; otherwise `--region <us|eu|apac>` maps to that region's
 * `ATLAS_REGION_*_DB_URL`. Returns `{ ok: false, error }` (never throws) when
 * neither is usable — there is deliberately NO bare `DATABASE_URL` fallback,
 * on `ops-teardown-verify`'s reasoning: an operator must never read the wrong
 * region's tenant data by forgetting a flag.
 */
export function resolveRegionDbUrl(
  args: string[],
  env: NodeJS.ProcessEnv,
): RegionDbResolution {
  const explicit = getFlag(args, "--database-url");
  if (explicit) return { ok: true, url: explicit, source: "--database-url", region: null };

  const region = getFlag(args, "--region");
  if (region) {
    // Own-key check (not `in`, which walks the prototype chain and would let
    // `--region constructor` slip past) — keeps the runtime whitelist locked to
    // the `GateExportRegion` keyof so the cast below is provably sound.
    if (!Object.hasOwn(REGION_DB_ENV, region)) {
      return {
        ok: false,
        error: `--region must be one of: ${Object.keys(REGION_DB_ENV).join(", ")} (got "${region}")`,
      };
    }
    const regionKey = region as GateExportRegion;
    const envVar = REGION_DB_ENV[regionKey];
    const url = env[envVar];
    if (!url) {
      return {
        ok: false,
        error: `--region ${region} requires ${envVar} to be set in the environment.`,
      };
    }
    return { ok: true, url, source: `region ${region} (${envVar})`, region: regionKey };
  }

  return {
    ok: false,
    error:
      "No region DB selected. Pass --region <us|eu|apac> (resolves ATLAS_REGION_<R>_DB_URL) " +
      "or --database-url <url>. There is no DATABASE_URL fallback — pick the region explicitly.",
  };
}

/**
 * How many of the ranked predicates the console prints. The bundle carries
 * `TOP_REJECTED_PREDICATE_MAX`; a terminal summary wants the head of that list,
 * not all of it — named rather than a bare `5` beside a named constant.
 */
export const CONSOLE_PREDICATE_ROWS = 5;

/** Render the analytics block for the operator's console. */
export function formatAnalytics(analytics: GateAnalytics): string {
  const lines = [
    `  positives (published):  ${analytics.positives}`,
    `  rejected  (retracted):  ${analytics.rejected}`,
    `  negatives (no claim):   ${analytics.negatives}`,
    `  approval rate:          ${
      analytics.approvalRate === null
        ? "n/a (nothing decided yet)"
        : `${(analytics.approvalRate * 100).toFixed(1)}%`
    }`,
    `  median hrs to retract:  ${
      analytics.medianHoursToRetraction === null
        ? "n/a"
        : analytics.medianHoursToRetraction.toFixed(2)
    }`,
  ];
  if (analytics.topRejectedPredicates.length > 0) {
    lines.push("  most-rejected predicates:");
    for (const entry of analytics.topRejectedPredicates.slice(0, CONSOLE_PREDICATE_ROWS)) {
      lines.push(`    ${entry.predicate}: ${entry.rejections}`);
    }
  }
  return lines.join("\n");
}

const TAG = "[ops:gate-export]";

export async function handleGateExport(args: string[]): Promise<void> {
  const dryRun = isDryRun(args, process.env);

  const workspaceId = getFlag(args, "--workspace");
  if (!workspaceId) {
    console.error(
      `${TAG} --workspace <orgId> is required. This command exports ONE workspace — ` +
        `there is no "every workspace" mode, because an evaluation set is chosen, not swept.`,
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
    `./atlas-gate-decisions-${workspaceId}.json`;

  // Bind the internal-DB pool to the chosen region DB, closing any pre-bound
  // pool first so the rebind is authoritative rather than a silent no-op
  // against a previously-bound DB. Same hazard and same handling as
  // `ops-teardown-verify.ts`; in the normal one-shot CLI path no pool exists
  // yet, so this is a cheap no-op.
  await closeInternalDB().catch(() => {
    // intentionally ignored: best-effort discard of any pre-bound pool before
    // rebinding. Not reachable from the one-shot CLI (no AppLayer boots here),
    // which is why it stays best-effort rather than fatal.
  });
  process.env.DATABASE_URL = resolved.url;

  console.log(
    `${TAG} target DB: ${resolved.source} · ${dryRun ? "DRY RUN" : "EXECUTE"} · workspace ${workspaceId}`,
  );
  if (dryRun) {
    const why = checkGateExportGate(args, process.env);
    console.log(
      `${TAG} DRY RUN${why ? ` (${why})` : " (--dry-run)"} — the query runs and the counts below ` +
        `are exact; no file is written.`,
    );
  }

  try {
    // The region label on the workspace row, not the physical DB. Both arms
    // matter: `--database-url` can point anywhere, and the stamped label is
    // what ADR-0024 treats as the workspace's residency.
    const workspaceRegion = await getWorkspaceRegion(workspaceId);
    const apiRegion = process.env.ATLAS_API_REGION ?? resolved.region ?? null;

    const built = await buildGateExportBundle(
      { query: async (sql, params) => ({ rows: await internalQuery(sql, params) }) },
      { workspaceId, apiRegion, workspaceRegion },
    );

    if (!built.ok) {
      console.error(`${TAG} REFUSED (${built.refusal.refusal}): ${built.refusal.detail}`);
      // Audit the refusal too. A refused export is a real operator act on a
      // real workspace, and a forensic query asking "who tried to cut a bundle
      // of this tenant" must not have to infer the attempt from its absence.
      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.brain.gateExport,
        targetType: "brain",
        targetId: workspaceId,
        status: "failure",
        scope: "platform",
        systemActor: "system:atlas-operator",
        metadata: {
          workspaceId,
          refusal: built.refusal.refusal,
          dryRun,
          targetDb: resolved.source,
        },
      });
      process.exitCode = 1;
      return;
    }

    const { bundle, capped } = built;
    const rowCount = bundle.decisions.length;

    console.log(`${TAG} ${rowCount} decision row(s)`);
    if (rowCount === 0) {
      // Loud, because this is the shape an operator typo takes. There is no
      // "unknown workspace" refusal to lean on — after a purge, a purged
      // workspace and a mistyped id are indistinguishable to every query this
      // command can run, and refusing would break the purged-exports-zero
      // criterion. So the empty result is REPORTED rather than returned as a
      // quiet success. See the note in `lib/brain/gate-export.ts`.
      console.warn(
        `${TAG} ⚠️ NOTHING TO EXPORT for workspace ${workspaceId}. Either the workspace has no ` +
          `decided claims yet, or it was purged, or the id is wrong — this command cannot tell ` +
          `those apart. Check the id before reading anything into an empty bundle.`,
      );
    }
    console.log(formatAnalytics(bundle.analytics));
    if (capped) {
      console.warn(
        `${TAG} ⚠️ row cap ${GATE_EXPORT_ROW_MAX} reached — this bundle is a PREFIX of the ` +
          `workspace, not all of it. Any rate computed from it describes the prefix only.`,
      );
    }

    if (!dryRun) {
      await Bun.write(output, `${JSON.stringify(bundle, null, 2)}\n`);
      console.log(`${TAG} wrote ${output}`);
      console.log(
        `${TAG} ⚠️ EVALUATION ONLY — this file is outside purge-scope.ts. Destroy it when the ` +
          `evaluation it was cut for is done, and never train on it (ADR-0043, issue 5339).`,
      );
    }

    // Acceptance criterion 2: every run lands in the admin action log with the
    // workspace and the row count — the DRY RUN included. A preview of tenant
    // content is itself a read of tenant content, and an audit trail that
    // recorded only the writes would leave the reads invisible.
    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.brain.gateExport,
      targetType: "brain",
      targetId: workspaceId,
      scope: "platform",
      systemActor: "system:atlas-operator",
      metadata: {
        workspaceId,
        rowCount,
        dryRun,
        capped,
        positives: bundle.analytics.positives,
        rejected: bundle.analytics.rejected,
        negatives: bundle.analytics.negatives,
        targetDb: resolved.source,
        // The path, never the contents.
        output: dryRun ? null : output,
      },
    });
  } catch (err) {
    console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeInternalDB().catch((closeErr) => {
      console.warn(
        `${TAG} failed to close the internal DB pool: ${
          closeErr instanceof Error ? closeErr.message : String(closeErr)
        }`,
      );
    });
  }
}
