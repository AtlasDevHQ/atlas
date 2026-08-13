/**
 * Tests for `atlas-operator ops sweep-residue` (#5185). The sweep's own logic
 * lives in `@atlas/api/lib/db/residue-sweep` and is falsified there (unit +
 * `residue-sweep-pg.test.ts`); what this file pins is the operator surface,
 * which is where the destructive-command safety actually lives:
 *   1. The execute double-gate (ATLAS_RESIDUE_OK=1 + --confirm) — missing
 *      either falls back to DRY RUN, never an accidental delete.
 *   2. The backup gate: EXECUTE refuses without --pg-dump naming a real,
 *      non-empty file. "Recorded" is not the same as "taken".
 *   3. Region-DB resolution refuses to run without an explicit region/url, so
 *      there is no DATABASE_URL fallback to sweep the wrong region with.
 *   4. `ops sweep-residue` is reachable through the ops dispatcher at all.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  RESIDUE_OK_ENV,
  checkResidueGate,
  isResidueDryRun,
  checkPgDump,
  printResidueReport,
  statProbe,
  type FileProbe,
} from "../commands/operator/ops-residue";
import { handleOps } from "../commands/operator/ops";
import type { ResidueSweepReport } from "@atlas/api/lib/db/residue-sweep";

// --- checkResidueGate (mirrors checkWipeGate / checkTeardownGate) ---

describe("checkResidueGate", () => {
  it("returns a reason when ATLAS_RESIDUE_OK is missing", () => {
    expect(checkResidueGate(["--confirm"], {} as NodeJS.ProcessEnv)).toContain(RESIDUE_OK_ENV);
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

  it("requires exactly \"1\" — a truthy-looking value does not open the gate", () => {
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
    expect(
      isResidueDryRun(["--confirm"], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("--dry-run forces preview even with the gate open", () => {
    expect(
      isResidueDryRun(["--confirm", "--dry-run"], { [RESIDUE_OK_ENV]: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

// --- checkPgDump: the backup gate ---

describe("checkPgDump", () => {
  const realDump: FileProbe = () => ({ isFile: true, size: 4096 });

  it("refuses when --pg-dump is absent", () => {
    expect(checkPgDump(["--confirm"], realDump)).toContain("--pg-dump <path> is required");
  });

  it("refuses when the path does not exist — a recorded path can lie", () => {
    const absent: FileProbe = () => null;
    expect(checkPgDump(["--pg-dump", "/tmp/nope.dump"], absent)).toContain("does not exist");
  });

  it("refuses a directory", () => {
    const dir: FileProbe = () => ({ isFile: false, size: 4096 });
    expect(checkPgDump(["--pg-dump", "/tmp"], dir)).toContain("not a regular file");
  });

  it("refuses an empty file — pg_dump produced nothing", () => {
    const empty: FileProbe = () => ({ isFile: true, size: 0 });
    expect(checkPgDump(["--pg-dump", "/tmp/empty.dump"], empty)).toContain("empty (0 bytes)");
  });

  it("clears a real, non-empty file", () => {
    expect(checkPgDump(["--pg-dump", "/tmp/residue-us.dump"], realDump)).toBeNull();
  });

  it("statProbe reports a missing path as absent rather than throwing", () => {
    expect(statProbe("/tmp/definitely-not-here-5185.dump")).toBeNull();
  });

  it("statProbe reads a real file's size", () => {
    // This source file exists and is non-empty — the probe's happy path.
    const facts = statProbe(import.meta.path);
    expect(facts?.isFile).toBe(true);
    expect(facts?.size).toBeGreaterThan(0);
  });
});

// --- printResidueReport: withheld values and skips must reach the operator ---

describe("printResidueReport", () => {
  const lines: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    lines.length = 0;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  const report: ResidueSweepReport = {
    dryRun: true,
    tablesConsidered: 90,
    targets: [{ table: "sla_thresholds", column: "workspace_id" }],
    skipped: [
      { table: "messages", column: null, reason: "no workspace scope column — via conversations." },
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
    totals: {
      rowsWouldDelete: 1,
      rowsDeleted: 0,
      rowsWithheld: 1,
      tablesSkipped: 1,
      errors: 0,
    },
  };

  it("prints the withheld value WITH its reason — nothing is filtered silently", () => {
    printResidueReport(report);
    const text = lines.join("\n");
    expect(text).toContain("WITHHELD");
    expect(text).toContain("_default");
    expect(text).toContain("the deployment-wide default tier row.");
  });

  it("prints every skipped table with its reason", () => {
    printResidueReport(report);
    const text = lines.join("\n");
    expect(text).toContain("messages");
    expect(text).toContain("no workspace scope column");
  });

  it("prints WITHHELD before WOULD DELETE — the sentinel must not be scrolled past", () => {
    printResidueReport(report);
    const text = lines.join("\n");
    expect(text.indexOf("WITHHELD")).toBeLessThan(text.indexOf("WOULD DELETE"));
  });

  it("names the gate an operator has to open to execute", () => {
    printResidueReport(report);
    expect(lines.join("\n")).toContain(RESIDUE_OK_ENV);
  });

  it("surfaces an enumeration/delete count mismatch rather than reporting a clean run", () => {
    printResidueReport({
      ...report,
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
      totals: { ...report.totals, rowsWouldDelete: 0, rowsDeleted: 1 },
    });
    expect(lines.join("\n")).toContain("enumeration counted 5");
  });
});

// --- dispatch + the no-DATABASE_URL-fallback rule ---

describe("ops sweep-residue dispatch", () => {
  const savedExit = process.exit;
  const savedError = console.error;
  let errors: string[] = [];
  let exitCode: number | undefined;

  beforeEach(() => {
    errors = [];
    exitCode = undefined;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    // `handleSweepResidue` calls process.exit on a refusal; capture instead.
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("__exit__");
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = savedExit;
    console.error = savedError;
  });

  it("refuses without an explicit region — there is no DATABASE_URL fallback", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://should-never-be-used/atlas";
    try {
      await handleOps(["ops", "sweep-residue"]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err instanceof Error && err.message).toBe("__exit__");
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("No region DB selected");
  });

  it("refuses an EXECUTE with no --pg-dump BEFORE it resolves a region", async () => {
    const saved = process.env[RESIDUE_OK_ENV];
    process.env[RESIDUE_OK_ENV] = "1";
    try {
      await handleOps(["ops", "sweep-residue", "--confirm", "--region", "us"]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err instanceof Error && err.message).toBe("__exit__");
    } finally {
      if (saved === undefined) delete process.env[RESIDUE_OK_ENV];
      else process.env[RESIDUE_OK_ENV] = saved;
    }
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--pg-dump <path> is required");
  });

  it("an unknown ops subcommand still prints usage naming sweep-residue", async () => {
    try {
      await handleOps(["ops", "not-a-subcommand"]);
    } catch (err) {
      expect(err instanceof Error && err.message).toBe("__exit__");
    }
    expect(errors.join("\n")).toContain("sweep-residue");
  });
});
