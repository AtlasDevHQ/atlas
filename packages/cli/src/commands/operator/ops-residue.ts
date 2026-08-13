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
 * `purge-scope.ts`, the registry it derives its table set from. This file is the
 * operator surface: the gates, the region binding, and the report.
 *
 * Safety (this targets a PROD region DB):
 *   - One region DB per invocation (`--region` or `--database-url`); no silent
 *     DATABASE_URL fallback, reusing `ops teardown-verify-accounts`'s resolver
 *     so there is one wrong-DB rule rather than two. The bound pool is then
 *     VERIFIED with `current_database()` before anything is deleted, rather
 *     than assumed from the rebind.
 *   - DRY RUN by default. Executing requires BOTH `ATLAS_RESIDUE_OK=1` and
 *     `--confirm` (the same double-gate as `ops wipe`).
 *   - EXECUTE additionally requires `--pg-dump <path>` naming a backup that
 *     EXISTS, is a regular file, is non-empty, and is RECENT. There is no undo,
 *     and a path that is merely recorded is a string that can lie.
 *   - Sentinel scope values are never deleted, and a database with no
 *     organizations is refused outright — see `residue-sweep.ts`.
 *   - Nothing is filtered silently: every skipped table and every withheld
 *     value is printed with its reason, and a table the sweep could not READ is
 *     reported separately from one that was never in scope. The exit code is
 *     non-zero on ANY of: a failed delete · a table that could not be read · a
 *     blast-radius refusal on an EXECUTE **or a blast-radius flag on a DRY RUN**
 *     (the surprising one) · a delete that removed more rows than the report
 *     listed. "We could not look" must never be scripted as "it was clean".
 */
import { statSync } from "node:fs";
import {
  sweepResidue,
  isBenignSkip,
  type ResidueSweepReport,
} from "@atlas/api/lib/db/residue-sweep";
import { internalQuery, closeInternalDB } from "@atlas/api/lib/db/internal";
import { getFlag } from "../../../lib/cli-utils";
import { resolveRegionDbUrl } from "./ops-teardown-verify";

/** Env var that, set to exactly "1", is one half of the execute double-gate. */
export const RESIDUE_OK_ENV = "ATLAS_RESIDUE_OK";

/**
 * How stale a `--pg-dump` file may be and still count as this run's backup.
 *
 * The point of the flag is that a backup was taken FOR THIS SWEEP. Without a
 * freshness bound, last month's dump of a different region clears the gate — and
 * the runbook hands operators `residue-us.dump` as a copy-pasteable example, so
 * the eu/apac runs are one paste away from exactly that.
 */
export const MAX_PG_DUMP_AGE_MS = 6 * 60 * 60 * 1000;

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

/**
 * What {@link checkPgDump} needs to know about a path.
 *
 * A tagged union rather than `FileFacts | null`, because "absent" and
 * "unreadable" want different remedies — take the backup vs fix the permission
 * — and collapsing them produced a refusal that gave the wrong advice for
 * `EACCES`.
 */
export type FileFacts =
  | { readonly ok: true; readonly isFile: boolean; readonly size: number; readonly mtimeMs: number }
  | { readonly ok: false; readonly error: string };

/** Probe a path for {@link checkPgDump}. Real in the handler, a fake in tests. */
export type FileProbe = (path: string) => FileFacts;

/**
 * The default probe. The errno is CARRIED rather than discarded, so the refusal
 * can name the operator's actual next move — `ENOENT` means take the backup,
 * `EACCES` means fix the permission, and telling someone to take a backup they
 * already took is how a safety gate loses its credibility.
 */
export const statProbe: FileProbe = (path) => {
  try {
    const stat = statSync(path);
    return { ok: true, isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * The backup gate: EXECUTE refuses without `--pg-dump <path>` pointing at a
 * real, non-empty, recent file. Returns null when cleared, or the refusal.
 *
 * Existence and freshness are checked rather than trusted because this command
 * destroys rows with no undo, and "I took a dump" recorded as a flag value is
 * exactly the claim an operator makes when they have not. `now` is injected so
 * the freshness arm is deterministic under test.
 */
export function checkPgDump(args: string[], probe: FileProbe, now: number): string | null {
  const path = getFlag(args, "--pg-dump");
  if (!path) {
    return (
      "Refusing to execute: --pg-dump <path> is required. Take a backup first " +
      '(`pg_dump "$ATLAS_REGION_US_DB_URL" -Fc -f residue-us.dump`) and pass its path — ' +
      "this delete has no undo."
    );
  }
  const facts = probe(path);
  if (!facts.ok) {
    return `Refusing to execute: --pg-dump path "${path}" could not be read (${facts.error}). Take the backup before the sweep, not after.`;
  }
  if (!facts.isFile) {
    return `Refusing to execute: --pg-dump path "${path}" is not a regular file.`;
  }
  // `!Number.isFinite(...)`, not just `=== 0`: NaN compares false against BOTH
  // `=== 0` and `> MAX`, so a probe yielding one would clear every arm of a gate
  // whose whole job is refusing. `statProbe` cannot produce it, but `FileProbe`
  // is exported, so other probes exist.
  if (!Number.isFinite(facts.size) || facts.size === 0) {
    return `Refusing to execute: --pg-dump path "${path}" reports size ${facts.size} — it is empty, or its size could not be established.`;
  }
  const ageMs = now - facts.mtimeMs;
  if (!Number.isFinite(ageMs)) {
    return `Refusing to execute: --pg-dump path "${path}" has no readable modification time, so its freshness cannot be established.`;
  }
  if (ageMs > MAX_PG_DUMP_AGE_MS) {
    const ageHours = Math.round(ageMs / 3.6e6);
    return (
      `Refusing to execute: --pg-dump path "${path}" was last written ${ageHours}h ago ` +
      `(limit ${MAX_PG_DUMP_AGE_MS / 3.6e6}h). A dump that old does not cover the rows this ` +
      "sweep is about to delete, and is usually a different region's file. Re-run pg_dump " +
      "against the region you are sweeping."
    );
  }
  return null;
}

/**
 * The report's three operator-facing modes, derived once.
 *
 * `dryRun` + `refusedToExecute` + `blastRadiusWarning` are three independent
 * fields encoding one mode, and branching on `report.dryRun ||
 * report.refusedToExecute` in several places let a state exist where an
 * EXECUTED run printed "do not act on the list below as a finding" over rows
 * that were already gone. Deriving the mode once makes the printer say one
 * thing — every branch below reads it, except the banner, which is legitimately
 * about `dryRun` alone.
 */
export type ResidueReportMode = "dry-run" | "refused" | "executed";

export function residueReportMode(report: ResidueSweepReport): ResidueReportMode {
  if (report.dryRun) return "dry-run";
  if (report.refusedToExecute) return "refused";
  return "executed";
}

/** Render the report as operator-facing console lines. */
export function printResidueReport(report: ResidueSweepReport): void {
  const mode = residueReportMode(report);
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

  const unreadable = report.skipped.filter((s) => !isBenignSkip(s));
  if (unreadable.length > 0) {
    console.error(
      `\n⚠ UNREADABLE — ${report.totals.tablesUnreadable} table(s) could NOT be checked. ` +
        "Their residue state is UNKNOWN, not clean:",
    );
    for (const s of unreadable) {
      console.error(`  ? ${s.table}${s.column ? `.${s.column}` : ""}`);
      console.error(`      ${s.reason}`);
    }
  }

  if (report.refusedToExecute) {
    console.error(`\n✗ REFUSED — nothing was deleted: ${report.refusedToExecute}`);
  } else if (report.blastRadiusWarning && mode === "dry-run") {
    // The DRY-RUN half. The preview below still lists everything — nothing is
    // hidden — but it is FLAGGED, because a preview of a broken-premise state
    // that reads as an ordinary finding is the failure the sweep refuses
    // outright for on an empty `organization`.
    console.error(
      `\n⚠ IMPLAUSIBLE RESULT — do not act on the list below as a finding: ${report.blastRadiusWarning}`,
    );
  }

  if (mode !== "executed") {
    if (report.wouldDelete.length === 0) {
      console.log(
        report.totals.tablesUnreadable > 0
          ? `\nNo residue found in the tables that could be READ — nothing would be deleted. ${report.totals.tablesUnreadable} table(s) were not checked at all.`
          : "\nNo residue found — nothing would be deleted.",
      );
    } else {
      console.log("\nWOULD DELETE — orphaned tenant rows:");
      for (const d of report.wouldDelete) {
        console.log(`  → ${d.table}.${d.column} = ${JSON.stringify(d.value)} (${d.rows} row(s))`);
      }
    }
  } else if (report.deletions.length === 0 && report.errors.length === 0) {
    console.log("\nNo residue found — nothing was deleted.");
  } else if (report.deletions.length === 0) {
    // EVERY planned delete failed. The old branch printed "No residue found —
    // nothing was deleted", which is the opposite of what happened and is the
    // line an operator's `grep -q` would read as clean.
    console.error(
      "\n✗ Nothing was deleted — EVERY planned delete FAILED. Residue SURVIVES; see the errors below.",
    );
  } else {
    console.log("\nDELETED:");
    for (const d of report.deletions) {
      console.log(
        `  ✓ ${d.table}.${d.column} — ${d.deletedRows} row(s) across ${d.values.length} workspace id(s)`,
      );
      // The two directions are NOT the same event and must not share a message.
      // Under-delete is benign (rows went away, or the DELETE's own orphan
      // re-check spared a re-created workspace). Over-delete means rows this
      // report never listed were destroyed, which is the worst outcome short of
      // a wrong-DB run — it is an error, on stderr, and it sets the exit code.
      if (d.deletedRows > d.expectedRows) {
        console.error(
          `      ⚠ OVER-DELETE: removed ${d.deletedRows} but enumeration counted ${d.expectedRows} — ` +
            `${d.deletedRows - d.expectedRows} row(s) this report never listed were destroyed. ` +
            `Check ${JSON.stringify(d.values)} against the pg_dump before proceeding.`,
        );
      } else if (d.deletedRows < d.expectedRows) {
        console.log(
          `      · ${d.expectedRows - d.deletedRows} of ${d.expectedRows} enumerated row(s) were not removed — ` +
            "deleted concurrently, or spared by the DELETE's own orphan re-check.",
        );
      }
    }
  }

  const benign = report.skipped.filter(isBenignSkip);
  if (benign.length > 0) {
    console.log("\nNOT IN SCOPE (never candidates — nothing to sweep here):");
    for (const s of benign) {
      console.log(`  – ${s.table}${s.column ? `.${s.column}` : ""}`);
      console.log(`      ${s.reason}`);
    }
  }

  for (const e of report.errors) {
    console.error(`\n  ✗ ${e.table}.${e.column} delete failed: ${e.message}`);
    console.error(`      ${e.expectedRows} row(s) SURVIVE. values: ${e.values.join(", ")}`);
  }

  const t = report.totals;
  console.log(
    `\n[ops:sweep-residue] ${mode === "executed" ? `deleted ${t.rowsDeleted}` : `would delete ${t.rowsWouldDelete}`} row(s), ` +
      `withheld ${t.rowsWithheld}, ${t.tablesNotInScope} table(s) not in scope` +
      (t.tablesUnreadable > 0 ? `, ${t.tablesUnreadable} UNREADABLE` : "") +
      (t.errors > 0 ? `, ${t.errors} error(s)` : ""),
  );
}

/**
 * Total rows destroyed BEYOND what the report enumerated, across all deletions.
 *
 * Counts rows, not deletions — the name said rows and the body returned groups,
 * so a 4,000-row over-delete reported as `1`. Only ever compared `> 0` today,
 * but it is exported and the number is the one an operator actually needs.
 */
export function countOverDeletes(report: ResidueSweepReport): number {
  return report.deletions.reduce((n, d) => n + Math.max(0, d.deletedRows - d.expectedRows), 0);
}

/**
 * Whether this run must exit non-zero. A scripted `for region in us eu apac`
 * loop reads the exit code, not the report, so every outcome where residue
 * survived, could not be looked for, or more was destroyed than was listed has
 * to be visible there.
 */
export function residueExitCode(report: ResidueSweepReport): number {
  if (report.errors.length > 0) return 1;
  // The ARRAY, not `totals.tablesUnreadable`. The two are representations of one
  // fact and the printer already reads both; gating on the counter alone means a
  // report listing three unreadable tables with a stale `0` counter exits clean —
  // the round-1 defect exactly, one indirection over.
  if (report.skipped.some((s) => !isBenignSkip(s))) return 1;
  if (report.refusedToExecute) return 1;
  // Both modes. A flagged DRY RUN exiting 0 would let a scripted preview report
  // a wrong-DB result set as an ordinary finding — the same failure one mode
  // over, which is exactly how this guard was wrong the first time.
  if (report.blastRadiusWarning) return 1;
  if (countOverDeletes(report) > 0) return 1;
  return 0;
}

/** Injected seams — real in the handler, fakes in unit tests. */
export interface ResidueHandlerDeps {
  readonly sweep: typeof sweepResidue;
  readonly query: typeof internalQuery;
  readonly now: () => number;
  readonly probe: FileProbe;
}

const REAL_DEPS: ResidueHandlerDeps = {
  sweep: sweepResidue,
  query: internalQuery,
  now: () => Date.now(),
  probe: statProbe,
};

/** Wire the command: resolve gate/backup/region, bind the pool, sweep, report. */
export async function handleSweepResidue(
  args: string[],
  deps: ResidueHandlerDeps = REAL_DEPS,
): Promise<void> {
  const dryRun = isResidueDryRun(args, process.env);

  if (!dryRun) {
    const backupRefusal = checkPgDump(args, deps.probe, deps.now());
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
  // pool first. ⚠️ The sibling command's comment claims a close failure "doesn't
  // change which URL the next getInternalDB() binds to" — that is TRUE for the
  // lazy fallback pool, which is nulled before the await, and FALSE when the
  // pool is Effect-managed: `closeInternalDB` then returns as a no-op WITHOUT
  // clearing `_sqlClient`, and every later statement runs against the previously
  // bound database while the banner below prints the newly resolved one. Not
  // reachable from the one-shot CLI today, and far too consequential to rest on
  // that, so the binding is VERIFIED rather than assumed, immediately below.
  await closeInternalDB().catch(() => {
    // intentionally ignored: best-effort discard of any pre-bound pool. The
    // current_database() check below is what establishes the binding, so a
    // failure here cannot silently become a wrong-region delete.
  });
  process.env.DATABASE_URL = resolved.url;
  console.log(
    `[ops:sweep-residue] target DB: ${resolved.source} · ${dryRun ? "DRY RUN" : "EXECUTE"}`,
  );

  try {
    const bound = await deps.query<{ db: string }>(`SELECT current_database() AS db`);
    const actual = bound[0]?.db;
    const expected = decodeURIComponent(new URL(resolved.url).pathname.replace(/^\//, ""));
    if (!expected) {
      // `if (expected && …)` silently SKIPPED the whole verification for a URL
      // with no path (`postgres://host:5432`, valid libpq — the database
      // defaults to the role name) or a trailing slash. A check that could not
      // be performed reading as a pass is the exact shape this command exists
      // to refuse, and it is the backstop that licenses the silent
      // `closeInternalDB()` catch above.
      console.error(
        `[ops:sweep-residue] Refusing to sweep: ${resolved.source} names no database in its ` +
          "URL path, so the pool binding cannot be verified. Pass a URL that names the " +
          "database explicitly.",
      );
      process.exitCode = 1;
      return;
    }
    if (actual !== expected) {
      console.error(
        `[ops:sweep-residue] Refusing to sweep: the internal-DB pool is bound to ` +
          `"${actual ?? "unknown"}" but ${resolved.source} names "${expected}". A pre-bound pool ` +
          "was not released — re-run in a fresh process.",
      );
      process.exitCode = 1;
      return;
    }

    const report = await deps.sweep(deps.query, { dryRun });
    printResidueReport(report);
    process.exitCode = residueExitCode(report);
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
