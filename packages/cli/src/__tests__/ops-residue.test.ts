/**
 * Tests for `atlas-operator ops sweep-residue` (#5185). The sweep's own logic
 * lives in `@atlas/api/lib/db/residue-sweep` and is falsified there (unit +
 * `residue-sweep-pg.test.ts`); what this file pins is the operator surface,
 * which is where the destructive-command safety actually lives:
 *   1. The execute double-gate (ATLAS_RESIDUE_OK=1 + --confirm) — missing
 *      either falls back to DRY RUN, never an accidental delete.
 *   2. The backup gate: EXECUTE refuses without --pg-dump naming a real,
 *      non-empty, RECENT file. "Recorded" is not the same as "taken", and last
 *      month's dump of another region is the realistic operator error.
 *   3. Region-DB resolution refuses without an explicit region/url, and the
 *      bound pool is VERIFIED with current_database() before anything deletes.
 *   4. The exit code. A scripted `for region in us eu apac` loop reads that, not
 *      the report, so every outcome where residue survived or could not be
 *      looked for has to be visible there.
 *
 * ⚠️ Every test that reaches `handleSweepResidue` past its refusals injects a
 * fake `sweep`/`query`. Nothing here may be able to touch a real database: the
 * ordering test at the bottom deliberately sets `ATLAS_REGION_US_DB_URL` to an
 * unreachable sentinel, because on a machine where that variable IS set (an
 * operator's shell, a Railway session) a regression that moved the region
 * resolution above the backup gate would otherwise have run a real sweep
 * against the live US region before failing its assertion.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  MAX_PG_DUMP_AGE_MS,
  RESIDUE_OK_ENV,
  checkPgDump,
  checkResidueGate,
  countOverDeletes,
  handleSweepResidue,
  isResidueDryRun,
  printResidueReport,
  residueExitCode,
  statProbe,
  type FileProbe,
  type ResidueHandlerDeps,
} from "../commands/operator/ops-residue";
import { handleOps } from "../commands/operator/ops";
import type { ResidueSweepReport } from "@atlas/api/lib/db/residue-sweep";

const NOW = 1_760_000_000_000;

/** A DB URL that cannot connect, for tests that must never reach Postgres. */
const UNREACHABLE_DB_URL = "postgresql://sweep-residue-test:0@127.0.0.1:1/never";

// --- checkResidueGate (mirrors checkWipeGate / checkTeardownGate) ---

describe("checkResidueGate", () => {
  it("returns a reason when ATLAS_RESIDUE_OK is missing", () => {
    expect(checkResidueGate(["--confirm"], {} as NodeJS.ProcessEnv)).toContain(
      "ATLAS_RESIDUE_OK",
    );
  });

  it("names the env var the docs and help text hard-code", () => {
    // Two prose surfaces (operator-help.ts, platform-admin.mdx) carry the
    // literal; comparing the constant only against itself would let a rename
    // drift them silently.
    expect(RESIDUE_OK_ENV).toBe("ATLAS_RESIDUE_OK");
  });

  it("returns a reason when --confirm is missing", () => {
    expect(checkResidueGate([], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv)).toContain(
      "--confirm",
    );
  });

  it("returns null only when BOTH halves are present", () => {
    expect(
      checkResidueGate(["--confirm"], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('requires exactly "1" — a truthy-looking value does not open the gate', () => {
    expect(
      checkResidueGate(["--confirm"], { [RESIDUE_OK_ENV]: "true" } as NodeJS.ProcessEnv),
    ).toContain(RESIDUE_OK_ENV);
  });
});

describe("isResidueDryRun", () => {
  it("is a DRY RUN when the gate is shut", () => {
    expect(isResidueDryRun([], {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isResidueDryRun(["--confirm"], {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isResidueDryRun([], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("is an EXECUTE when the gate is open", () => {
    expect(isResidueDryRun(["--confirm"], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  it("--dry-run forces preview even with the gate open", () => {
    expect(
      isResidueDryRun(["--confirm", "--dry-run"], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

// --- checkPgDump: the backup gate ---

describe("checkPgDump", () => {
  const freshDump: FileProbe = () => ({ ok: true, isFile: true, size: 4096, mtimeMs: NOW - 60_000 });

  it("refuses when --pg-dump is absent", () => {
    expect(checkPgDump(["--confirm"], freshDump, NOW)).toContain("--pg-dump <path> is required");
  });

  it("refuses when the path cannot be read, and carries the errno", () => {
    // ENOENT and EACCES want different remedies; a probe that returned null for
    // both made the refusal tell an operator to take a backup they had taken.
    const denied: FileProbe = () => ({ ok: false, error: "EACCES: permission denied" });
    const refusal = checkPgDump(["--pg-dump", "/root/x.dump"], denied, NOW);
    expect(refusal).toContain("could not be read");
    expect(refusal).toContain("EACCES");
  });

  it("refuses a directory", () => {
    const dir: FileProbe = () => ({ ok: true, isFile: false, size: 4096, mtimeMs: NOW });
    expect(checkPgDump(["--pg-dump", "/tmp"], dir, NOW)).toContain("not a regular file");
  });

  it("refuses an empty file — pg_dump produced nothing", () => {
    const empty: FileProbe = () => ({ ok: true, isFile: true, size: 0, mtimeMs: NOW });
    expect(checkPgDump(["--pg-dump", "/tmp/empty.dump"], empty, NOW)).toContain("empty (0 bytes)");
  });

  it("refuses a STALE dump — the realistic wrong-region error", () => {
    // The runbook hands operators `residue-us.dump` as a copy-pasteable example,
    // so `--region eu --pg-dump residue-us.dump` is one paste away. Freshness is
    // the cheap proxy for "this backup was taken for THIS sweep".
    const stale: FileProbe = () => ({
      ok: true,
      isFile: true,
      size: 4096,
      mtimeMs: NOW - MAX_PG_DUMP_AGE_MS - 1,
    });
    const refusal = checkPgDump(["--pg-dump", "/tmp/old.dump"], stale, NOW);
    expect(refusal).toContain("last written");
    expect(refusal).toContain("Re-run pg_dump");
  });

  it("clears a real, non-empty, recent file", () => {
    expect(checkPgDump(["--pg-dump", "/tmp/residue-us.dump"], freshDump, NOW)).toBeNull();
  });

  it("clears a dump right at the age limit", () => {
    const atLimit: FileProbe = () => ({
      ok: true,
      isFile: true,
      size: 1,
      mtimeMs: NOW - MAX_PG_DUMP_AGE_MS,
    });
    expect(checkPgDump(["--pg-dump", "/tmp/x.dump"], atLimit, NOW)).toBeNull();
  });

  it("statProbe reports a missing path as unreadable rather than throwing", () => {
    const facts = statProbe("/tmp/definitely-not-here-5185.dump");
    expect(facts.ok).toBe(false);
    expect(facts.ok === false && facts.error).toContain("ENOENT");
  });

  it("statProbe reads a real file's size and mtime", () => {
    // This source file exists and is non-empty — the probe's happy path.
    const facts = statProbe(import.meta.path);
    expect(facts.ok).toBe(true);
    expect(facts.ok === true && facts.size).toBeGreaterThan(0);
    expect(facts.ok === true && facts.mtimeMs).toBeGreaterThan(0);
  });
});

// --- report shapes ---

const BASE_REPORT: ResidueSweepReport = {
  dryRun: true,
  tablesConsidered: 87,
  targets: [{ table: "sla_thresholds", column: "workspace_id" }],
  skipped: [
    {
      kind: "no-scope-column",
      table: "messages",
      column: null,
      reason: "no workspace scope column — via conversations.",
    },
  ],
  withheld: [
    {
      table: "sla_thresholds",
      column: "workspace_id",
      value: "_default",
      rows: 1,
      reason: "the deployment-wide default tier row.",
    },
  ],
  wouldDelete: [
    {
      table: "workspace_proactive_config",
      column: "workspace_id",
      value: "jukFiKym65bnNAYGiY1zdthspoNUYpov",
      rows: 1,
    },
  ],
  deletions: [],
  errors: [],
  refusedToExecute: null,
  totals: {
    rowsWouldDelete: 1,
    rowsDeleted: 0,
    rowsWithheld: 1,
    tablesNotInScope: 1,
    tablesUnreadable: 0,
    errors: 0,
  },
};

describe("residueExitCode", () => {
  it("is 0 on a clean run", () => {
    expect(residueExitCode(BASE_REPORT)).toBe(0);
  });

  it("is 1 when a delete failed — residue survives while the report says it ran", () => {
    expect(
      residueExitCode({
        ...BASE_REPORT,
        errors: [
          {
            table: "brain_episodes",
            column: "workspace_id",
            values: ["wsAAA"],
            expectedRows: 4,
            message: "violates foreign key constraint",
          },
        ],
        totals: { ...BASE_REPORT.totals, errors: 1 },
      }),
    ).toBe(1);
  });

  it("is 1 when a table could not be READ — 'we could not look' is not 'it was clean'", () => {
    // The round-1 finding: three `permission denied` tables landed among the
    // benign skips and the run exited 0 with "No residue found".
    expect(
      residueExitCode({
        ...BASE_REPORT,
        totals: { ...BASE_REPORT.totals, tablesUnreadable: 3 },
      }),
    ).toBe(1);
  });

  it("is 1 when the blast-radius cap refused the execute", () => {
    expect(
      residueExitCode({ ...BASE_REPORT, dryRun: false, refusedToExecute: "too many" }),
    ).toBe(1);
  });

  it("is 1 on an OVER-delete — rows destroyed that the report never listed", () => {
    expect(
      residueExitCode({
        ...BASE_REPORT,
        dryRun: false,
        wouldDelete: [],
        deletions: [
          {
            table: "crm_outbox",
            column: "workspace_id",
            values: ["wsAAA"],
            expectedRows: 1,
            deletedRows: 4,
          },
        ],
        totals: { ...BASE_REPORT.totals, rowsWouldDelete: 0, rowsDeleted: 4 },
      }),
    ).toBe(1);
  });

  it("is 0 on an UNDER-delete — benign, and the opposite direction", () => {
    const under: ResidueSweepReport = {
      ...BASE_REPORT,
      dryRun: false,
      wouldDelete: [],
      deletions: [
        {
          table: "crm_outbox",
          column: "workspace_id",
          values: ["wsAAA"],
          expectedRows: 5,
          deletedRows: 1,
        },
      ],
      totals: { ...BASE_REPORT.totals, rowsWouldDelete: 0, rowsDeleted: 1 },
    };
    expect(countOverDeletes(under)).toBe(0);
    expect(residueExitCode(under)).toBe(0);
  });
});

describe("printResidueReport", () => {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it("prints the withheld value WITH its reason — nothing is filtered silently", () => {
    printResidueReport(BASE_REPORT);
    const text = out.join("\n");
    expect(text).toContain("WITHHELD");
    expect(text).toContain("_default");
    expect(text).toContain("the deployment-wide default tier row.");
  });

  it("prints every not-in-scope table with its reason", () => {
    printResidueReport(BASE_REPORT);
    const text = out.join("\n");
    expect(text).toContain("messages");
    expect(text).toContain("no workspace scope column");
  });

  it("prints WITHHELD before WOULD DELETE — the sentinel must not be scrolled past", () => {
    printResidueReport(BASE_REPORT);
    const text = out.join("\n");
    // Both indices must be real: `-1 < positive` would "pass" with the WITHHELD
    // block missing entirely.
    expect(text.indexOf("WITHHELD")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("WOULD DELETE")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("WITHHELD")).toBeLessThan(text.indexOf("WOULD DELETE"));
  });

  it("names the gate an operator has to open to execute", () => {
    printResidueReport(BASE_REPORT);
    expect(out.join("\n")).toContain(RESIDUE_OK_ENV);
  });

  it("puts an UNREADABLE table on stderr, separately from the benign skips", () => {
    printResidueReport({
      ...BASE_REPORT,
      skipped: [
        ...BASE_REPORT.skipped,
        {
          kind: "unreadable",
          table: "crm_outbox",
          column: "workspace_id",
          reason: "orphan query failed: permission denied for table",
        },
      ],
      totals: { ...BASE_REPORT.totals, tablesUnreadable: 1 },
    });
    const errText = err.join("\n");
    expect(errText).toContain("UNREADABLE");
    expect(errText).toContain("UNKNOWN, not clean");
    expect(errText).toContain("permission denied");
    // ...and it is NOT filed under the benign heading.
    expect(out.join("\n")).not.toContain("crm_outbox");
  });

  it("reports an OVER-delete on stderr, saying rows were destroyed unlisted", () => {
    printResidueReport({
      ...BASE_REPORT,
      dryRun: false,
      wouldDelete: [],
      deletions: [
        {
          table: "crm_outbox",
          column: "workspace_id",
          values: ["wsAAA"],
          expectedRows: 1,
          deletedRows: 4,
        },
      ],
      totals: { ...BASE_REPORT.totals, rowsWouldDelete: 0, rowsDeleted: 4 },
    });
    expect(err.join("\n")).toContain("OVER-DELETE");
    expect(err.join("\n")).toContain("never listed");
  });

  it("reports an UNDER-delete as benign, on stdout, WITHOUT asserting a cause", () => {
    // The two directions are not the same event. An earlier revision gave both
    // the same sentence — "the difference is concurrent writes" — asserting a
    // cause it had not established, in the more consequential direction.
    printResidueReport({
      ...BASE_REPORT,
      dryRun: false,
      wouldDelete: [],
      deletions: [
        {
          table: "crm_outbox",
          column: "workspace_id",
          values: ["wsAAA"],
          expectedRows: 5,
          deletedRows: 1,
        },
      ],
      totals: { ...BASE_REPORT.totals, rowsWouldDelete: 0, rowsDeleted: 1 },
    });
    expect(err.join("\n")).not.toContain("OVER-DELETE");
    expect(out.join("\n")).toContain("were not removed");
  });

  it("prints a failed delete with the row count that SURVIVES", () => {
    printResidueReport({
      ...BASE_REPORT,
      dryRun: false,
      wouldDelete: [],
      errors: [
        {
          table: "brain_episodes",
          column: "workspace_id",
          values: ["wsAAA"],
          expectedRows: 41,
          message: "violates foreign key constraint",
        },
      ],
      totals: { ...BASE_REPORT.totals, rowsWouldDelete: 0, errors: 1 },
    });
    expect(err.join("\n")).toContain("41 row(s) SURVIVE");
  });

  it("prints a blast-radius refusal and still lists what it would have deleted", () => {
    printResidueReport({ ...BASE_REPORT, dryRun: false, refusedToExecute: "too many ids" });
    expect(err.join("\n")).toContain("REFUSED");
    expect(out.join("\n")).toContain("WOULD DELETE");
  });
});

// --- handler wiring ---

describe("handleSweepResidue", () => {
  const savedExit = process.exit;
  const savedError = console.error;
  const savedLog = console.log;
  const savedWarn = console.warn;
  let errors: string[] = [];
  let exitCalls: (number | undefined)[] = [];

  beforeEach(() => {
    errors = [];
    exitCalls = [];
    process.exitCode = undefined;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    console.log = () => {};
    console.warn = () => {};
    process.exit = ((code?: number) => {
      exitCalls.push(code);
      throw new Error("__exit__");
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = savedExit;
    console.error = savedError;
    console.log = savedLog;
    console.warn = savedWarn;
    process.exitCode = undefined;
  });

  /** Deps that answer current_database() for the scratch URL and fake the sweep. */
  function deps(report: ResidueSweepReport, seen?: { dryRun?: boolean }): ResidueHandlerDeps {
    return {
      sweep: (async (_q, opts) => {
        if (seen) seen.dryRun = opts.dryRun;
        return report;
      }) as ResidueHandlerDeps["sweep"],
      query: (async () => [{ db: "never" }]) as ResidueHandlerDeps["query"],
      now: () => NOW,
      probe: () => ({ ok: true, isFile: true, size: 4096, mtimeMs: NOW }),
    };
  }

  async function withRegionUrl(url: string, fn: () => Promise<void>): Promise<void> {
    const saved = process.env.ATLAS_REGION_US_DB_URL;
    process.env.ATLAS_REGION_US_DB_URL = url;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.ATLAS_REGION_US_DB_URL;
      else process.env.ATLAS_REGION_US_DB_URL = saved;
    }
  }

  it("refuses without an explicit region — there is no DATABASE_URL fallback", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://should-never-be-used/atlas";
    try {
      await expect(handleOps(["ops", "sweep-residue"])).rejects.toThrow("__exit__");
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
    expect(exitCalls).toEqual([1]);
    expect(errors.join("\n")).toContain("No region DB selected");
  });

  it("refuses an EXECUTE with no --pg-dump BEFORE it resolves a region", async () => {
    // ⚠️ ATLAS_REGION_US_DB_URL is set to an unreachable sentinel on purpose. If
    // the backup gate were ever moved below the region resolution, this test
    // would otherwise resolve a REAL region URL on any machine that has one set
    // and run a live sweep before failing.
    const savedOk = process.env[RESIDUE_OK_ENV];
    process.env[RESIDUE_OK_ENV] = "1";
    try {
      await withRegionUrl(UNREACHABLE_DB_URL, async () => {
        await expect(
          handleOps(["ops", "sweep-residue", "--confirm", "--region", "us"]),
        ).rejects.toThrow("__exit__");
      });
    } finally {
      if (savedOk === undefined) delete process.env[RESIDUE_OK_ENV];
      else process.env[RESIDUE_OK_ENV] = savedOk;
    }
    expect(exitCalls).toEqual([1]);
    expect(errors.join("\n")).toContain("--pg-dump <path> is required");
  });

  it("passes DRY RUN through to the sweep when the gate is shut", async () => {
    const seen: { dryRun?: boolean } = {};
    await withRegionUrl(UNREACHABLE_DB_URL, async () => {
      await handleSweepResidue(["ops", "sweep-residue", "--region", "us"], deps(BASE_REPORT, seen));
    });
    expect(seen.dryRun).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("passes EXECUTE through when both gates and the backup clear", async () => {
    const savedOk = process.env[RESIDUE_OK_ENV];
    process.env[RESIDUE_OK_ENV] = "1";
    const seen: { dryRun?: boolean } = {};
    try {
      await withRegionUrl(UNREACHABLE_DB_URL, async () => {
        await handleSweepResidue(
          ["ops", "sweep-residue", "--region", "us", "--confirm", "--pg-dump", "/tmp/x.dump"],
          deps({ ...BASE_REPORT, dryRun: false, wouldDelete: [] }, seen),
        );
      });
    } finally {
      if (savedOk === undefined) delete process.env[RESIDUE_OK_ENV];
      else process.env[RESIDUE_OK_ENV] = savedOk;
    }
    expect(seen.dryRun).toBe(false);
  });

  it("exits non-zero when the sweep reports a failed delete", async () => {
    await withRegionUrl(UNREACHABLE_DB_URL, async () => {
      await handleSweepResidue(
        ["ops", "sweep-residue", "--region", "us"],
        deps({
          ...BASE_REPORT,
          errors: [
            {
              table: "brain_episodes",
              column: "workspace_id",
              values: ["wsAAA"],
              expectedRows: 2,
              message: "violates foreign key constraint",
            },
          ],
          totals: { ...BASE_REPORT.totals, errors: 1 },
        }),
      );
    });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("delete failed");
  });

  it("exits non-zero when a table was unreadable", async () => {
    await withRegionUrl(UNREACHABLE_DB_URL, async () => {
      await handleSweepResidue(
        ["ops", "sweep-residue", "--region", "us"],
        deps({ ...BASE_REPORT, totals: { ...BASE_REPORT.totals, tablesUnreadable: 2 } }),
      );
    });
    expect(process.exitCode).toBe(1);
  });

  it("refuses to sweep when the bound pool is a DIFFERENT database than resolved", async () => {
    // The rebind is verified, not assumed: `closeInternalDB` is a no-op that
    // leaves `_sqlClient` bound when the pool is Effect-managed, which would run
    // every DELETE against the previous region while the banner named the new one.
    let swept = false;
    await withRegionUrl(UNREACHABLE_DB_URL, async () => {
      await handleSweepResidue(["ops", "sweep-residue", "--region", "us"], {
        ...deps(BASE_REPORT),
        query: (async () => [{ db: "some-other-region" }]) as ResidueHandlerDeps["query"],
        sweep: (async () => {
          swept = true;
          return BASE_REPORT;
        }) as ResidueHandlerDeps["sweep"],
      });
    });
    expect(swept).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("bound to");
  });

  it("reports a thrown sweep (e.g. the zero-organizations refusal) and exits 1", async () => {
    await withRegionUrl(UNREACHABLE_DB_URL, async () => {
      await handleSweepResidue(["ops", "sweep-residue", "--region", "us"], {
        ...deps(BASE_REPORT),
        sweep: (async () => {
          throw new Error("Refusing to sweep: public.organization has 0 rows");
        }) as ResidueHandlerDeps["sweep"],
      });
    });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("organization has 0 rows");
  });

  it("an unknown ops subcommand prints usage naming sweep-residue", async () => {
    await expect(handleOps(["ops", "not-a-subcommand"])).rejects.toThrow("__exit__");
    expect(errors.join("\n")).toContain("sweep-residue");
  });
});
