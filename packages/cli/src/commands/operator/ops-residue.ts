/**
 * `atlas-operator ops sweep-residue` — clear orphaned-workspace residue from one
 * region's internal DB (#5185).
 *
 * Residue is tenant data whose `organization` row is already gone: rows a purge
 * left behind because their table entered the purge path after the purge ran.
 * The normal path cannot reach them — `hardDeleteWorkspace` requires the
 * workspace to exist and be soft-deleted, and answers `409` otherwise — so this
 * is the mechanism `platform-admin.mdx` §Residue prescribed. Until #5185 the
 * runbook forbade hand-running the delete and named a double-gated operator
 * command to run instead; that command did not exist, so the only forbidden
 * path was also the only available one.
 *
 * The sweep itself lives in `@atlas/api/lib/db/residue-sweep` beside
 * `purge-scope.ts`, which is the registry it derives its table set from. This
 * file is the operator surface: the gates, the region binding, and the report.
 *
 * Safety (this targets a PROD region DB):
 *   - One region DB per invocation (`--region` or `--database-url`); no silent
 *     DATABASE_URL fallback, reusing `ops teardown-verify-accounts`'s resolver
 *     so there is one wrong-DB rule rather than two.
 *   - DRY RUN by default. Executing requires BOTH `ATLAS_RESIDUE_OK=1` and
 *     `--confirm` (the same double-gate as `ops wipe`).
 *   - EXECUTE additionally requires `--pg-dump <path>` naming a backup that
 *     EXISTS and is non-empty. There is no undo, and a path that is merely
 *     recorded is a string that can lie.
 *   - Sentinel scope values are never deleted — see `classifyScopeValue`. Of the
 *     9 rows the 2026-08-12 prod sweep flagged, 8 were sentinels and one of them
 *     (`_default` in `sla_thresholds`) is the deployment-wide SLA default tier.
 *   - Nothing is filtered silently: every skipped table and every withheld value
 *     is printed with its reason.
 */
import { statSync } from "node:fs";
import {
  sweepResidue,
  type ResidueSweepReport,
} from "@atlas/api/lib/db/residue-sweep";
import { internalQuery, closeInternalDB } from "@atlas/api/lib/db/internal";
import { getFlag } from "../../../lib/cli-utils";
import { resolveRegionDbUrl } from "./ops-teardown-verify";

/** Env var that, set to exactly "1", is one half of the execute double-gate. */
export const RESIDUE_OK_ENV = "ATLAS_RESIDUE_OK";

/**
 * The execute double-gate, mirroring `checkWipeGate` / `checkTeardownGate`.
 * Returns null when the run is cleared to EXECUTE, or a human-readable reason
 * when it is not — in which case the caller falls back to a DRY RUN rather than
 * erroring, so a gate-less invocation safely previews instead of deleting.
 */
export function checkResidueGate(args: string[], env: NodeJS.ProcessEnv): string | null {
  if (env[RESIDUE_OK_ENV] !== "1") {
    return `${RESIDUE_OK_ENV} is not set to 1`;
  }
  if (!args.includes("--confirm")) {
    return "--confirm was not passed";
  }
  return null;
}

/**
 * Whether this invocation is a DRY RUN (preview, no deletes). True unless the
 * execute double-gate is satisfied — and `--dry-run` always forces preview even
 * when the gate is open, so an operator can belt-and-braces a gated run.
 */
export function isResidueDryRun(args: string[], env: NodeJS.ProcessEnv): boolean {
  return checkResidueGate(args, env) !== null || args.includes("--dry-run");
}

/** What {@link checkPgDump} needs to know about a path — null when absent. */
export interface FileFacts {
  readonly isFile: boolean;
  readonly size: number;
}

/** Probe a path for {@link checkPgDump}. Real in the handler, a fake in tests. */
export type FileProbe = (path: string) => FileFacts | null;

/** The default probe. A missing/unreadable path is reported as absent by the
 *  caller's error message, so the failure is surfaced rather than swallowed. */
export const statProbe: FileProbe = (path) => {
  try {
    const stat = statSync(path);
    return { isFile: stat.isFile(), size: stat.size };
  } catch {
    // intentionally ignored: an unreadable path IS the "no backup here" answer,
    // and checkPgDump turns it into the operator-facing refusal.
    return null;
  }
};

/**
 * The backup gate: EXECUTE refuses without `--pg-dump <path>` pointing at a
 * real, non-empty file. Returns null when cleared, or the refusal.
 *
 * Existence is checked rather than trusted because this command destroys rows
 * with no undo, and "I took a dump" recorded as a flag value is exactly the
 * claim an operator makes when they have not.
 */
export function checkPgDump(args: string[], probe: FileProbe): string | null {
  const path = getFlag(args, "--pg-dump");
  if (!path) {
    return (
      "Refusing to execute: --pg-dump <path> is required. Take a backup first " +
      "(`pg_dump \"$ATLAS_REGION_US_DB_URL\" -Fc -f residue-us.dump`) and pass its path — " +
      "this delete has no undo."
    );
  }
  const facts = probe(path);
  if (facts === null) {
    return `Refusing to execute: --pg-dump path "${path}" does not exist or is unreadable. Take the backup before the sweep, not after.`;
  }
  if (!facts.isFile) {
    return `Refusing to execute: --pg-dump path "${path}" is not a regular file.`;
  }
  if (facts.size === 0) {
    return `Refusing to execute: --pg-dump path "${path}" is empty (0 bytes) — the backup did not produce anything.`;
  }
  return null;
}

/** Render the report as operator-facing console lines. */
export function printResidueReport(report: ResidueSweepReport): void {
  const banner = report.dryRun
    ? `DRY RUN — set ${RESIDUE_OK_ENV}=1 and pass --confirm (plus --pg-dump <path>) to execute`
    : "EXECUTE";
  console.log(`[ops:sweep-residue] ${banner}`);
  console.log(
    `[ops:sweep-residue] ${report.tablesConsidered} purged-class table(s) in the registry · ` +
      `${report.targets.length} (table, scope column) pair(s) swept`,
  );

  // Withheld first: a sentinel deleted by hand after reading this report is the
  // failure this command exists to prevent, so it must not be scrolled past.
  if (report.withheld.length > 0) {
    console.log("\nWITHHELD — matched no organization, but is NOT tenant residue:");
    for (const w of report.withheld) {
      console.log(`  • ${w.table}.${w.column} = ${JSON.stringify(w.value)} (${w.rows} row(s))`);
      console.log(`      ${w.reason}`);
    }
  }

  if (report.dryRun) {
    if (report.wouldDelete.length === 0) {
      console.log("\nNo residue found — nothing would be deleted.");
    } else {
      console.log("\nWOULD DELETE — orphaned tenant rows:");
      for (const d of report.wouldDelete) {
        console.log(`  → ${d.table}.${d.column} = ${JSON.stringify(d.value)} (${d.rows} row(s))`);
      }
    }
  } else if (report.deletions.length === 0) {
    console.log("\nNo residue found — nothing was deleted.");
  } else {
    console.log("\nDELETED:");
    for (const d of report.deletions) {
      console.log(
        `  ✓ ${d.table}.${d.column} — ${d.deletedRows} row(s) across ${d.values.length} workspace id(s)`,
      );
      if (d.deletedRows !== d.expectedRows) {
        console.log(
          `      ⚠ enumeration counted ${d.expectedRows} — the difference is concurrent writes, not a partial delete.`,
        );
      }
    }
  }

  if (report.skipped.length > 0) {
    console.log("\nSKIPPED (not swept — nothing here was checked for residue):");
    for (const s of report.skipped) {
      console.log(`  – ${s.table}${s.column ? `.${s.column}` : ""}`);
      console.log(`      ${s.reason}`);
    }
  }

  for (const e of report.errors) {
    console.log(`\n  ✗ ${e.table}.${e.column} delete failed: ${e.message}`);
    console.log(`      values: ${e.values.join(", ")}`);
  }

  const t = report.totals;
  console.log(
    `\n[ops:sweep-residue] ${report.dryRun ? `would delete ${t.rowsWouldDelete}` : `deleted ${t.rowsDeleted}`} row(s), ` +
      `withheld ${t.rowsWithheld}, skipped ${t.tablesSkipped} table(s)` +
      (t.errors > 0 ? `, ${t.errors} error(s)` : ""),
  );
}

/** Wire the command: resolve gate/backup/region, bind the pool, sweep, report. */
export async function handleSweepResidue(args: string[]): Promise<void> {
  const dryRun = isResidueDryRun(args, process.env);

  if (!dryRun) {
    const backupRefusal = checkPgDump(args, statProbe);
    if (backupRefusal) {
      console.error(`[ops:sweep-residue] ${backupRefusal}`);
      process.exit(1);
    }
  }

  const resolved = resolveRegionDbUrl(args, process.env);
  if (!resolved.ok) {
    console.error(`[ops:sweep-residue] ${resolved.error}`);
    process.exit(1);
  }

  // Bind the internal-DB pool to the chosen region DB, closing any pre-bound
  // pool FIRST so the rebind is authoritative rather than a silent no-op against
  // a previously-bound DB. Same reasoning as ops-teardown-verify: the wrong-DB
  // footgun here would delete from the wrong region.
  await closeInternalDB().catch(() => {
    // intentionally ignored: best-effort discard of any pre-bound pool before
    // rebinding; a close failure here doesn't change which URL the next
    // getInternalDB() binds to.
  });
  process.env.DATABASE_URL = resolved.url;
  console.log(
    `[ops:sweep-residue] target DB: ${resolved.source} · ${dryRun ? "DRY RUN" : "EXECUTE"}`,
  );

  try {
    const report = await sweepResidue(internalQuery, { dryRun });
    printResidueReport(report);
    // A failed delete means residue survives while the report says the sweep
    // ran — a scripted cleanup must fail loudly rather than exit 0 on it.
    if (report.errors.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(
      `[ops:sweep-residue] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await closeInternalDB().catch((closeErr) => {
      console.warn(
        `[ops:sweep-residue] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}
