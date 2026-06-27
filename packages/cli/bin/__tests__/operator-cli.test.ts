/**
 * Operator-CLI split (ADR-0025 sub-decision 1 / sequencing step 4, #4045).
 *
 * Locks the packaging boundary: the operator-only subcommands
 * (ops/seed/proactive/export/learn) are NOT reachable from the published
 * `atlas` CLI and ARE reachable from the `atlas-operator` binary. Behavior +
 * gates of the commands themselves are covered by the per-command suites in
 * src/__tests__/{ops,seed,proactive,learn,ops-smoke-crm-cli,ops-teardown-verify}.test.ts
 * (only the command *source* moved into commands/operator/; the suites stayed
 * put). `export` has no standalone suite — its handler is exercised only by the
 * routing/discriminator test in this file. This file pins the routing/help partition.
 */

import { describe, expect, test } from "bun:test";
import * as path from "path";
import {
  OPERATOR_COMMANDS,
  OPERATOR_SUBCOMMAND_HELP,
  printOperatorOverviewHelp,
  type OperatorCommand,
} from "../../lib/operator-help";
import {
  SUBCOMMAND_HELP,
  printSubcommandHelp,
  printOverviewHelp,
} from "../../lib/help";

// Hardcoded on purpose (not derived from OPERATOR_COMMAND_NAMES) so the
// equality assertion below actually catches drift in the source list. Typed as
// OperatorCommand[] so it can index the now-literal-keyed OPERATOR_SUBCOMMAND_HELP.
const OPERATOR_NAMES: OperatorCommand[] = [
  "ops",
  "seed",
  "proactive",
  "export",
  "learn",
];
const BIN_DIR = path.join(import.meta.dir, "..");

/**
 * Run a CLI binary in a child process and capture its streams + exit code.
 * `unsetEnv` removes those keys from the inherited environment (Bun.spawn's
 * `env` replaces rather than merges, so we spread `process.env` first) — used to
 * make the `export` DB-required path deterministic regardless of the runner's env.
 */
async function runBin(
  file: string,
  args: string[],
  unsetEnv: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let env: Record<string, string | undefined> | undefined;
  if (unsetEnv.length) {
    env = { ...process.env };
    for (const key of unsetEnv) delete env[key];
  }
  const proc = Bun.spawn({
    // Reuse the bun that's running the tests so PATH resolution can't miss.
    cmd: [process.execPath, path.join(BIN_DIR, file), ...args],
    cwd: BIN_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Capture everything a function writes via console.log. */
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("operator CLI split (ADR-0025 step 4)", () => {
  describe("command partitioning", () => {
    test("OPERATOR_COMMANDS is exactly the five operator subcommands", () => {
      expect([...OPERATOR_COMMANDS].sort()).toEqual([...OPERATOR_NAMES].sort());
    });

    test("operator help defines every operator subcommand", () => {
      for (const name of OPERATOR_NAMES) {
        expect(OPERATOR_SUBCOMMAND_HELP[name]).toBeDefined();
      }
    });

    test("published SUBCOMMAND_HELP advertises none of them", () => {
      for (const name of OPERATOR_NAMES) {
        expect(SUBCOMMAND_HELP[name]).toBeUndefined();
      }
    });

    test("published overview help lists no operator command", () => {
      const text = captureLog(() => printOverviewHelp());
      for (const name of OPERATOR_NAMES) {
        // Command-column entries look like "  ops   …" / "  seed  …".
        expect(text).not.toMatch(new RegExp(`^\\s+${name}\\s{2,}`, "m"));
      }
    });

    test("operator overview help lists every operator command", () => {
      const text = captureLog(() => printOperatorOverviewHelp());
      for (const name of OPERATOR_NAMES) {
        expect(text).toMatch(new RegExp(`^\\s+${name}\\s{2,}`, "m"));
      }
    });
  });

  describe("help rendering", () => {
    test("printSubcommandHelp honors the operator bin name", () => {
      const text = captureLog(() =>
        printSubcommandHelp(OPERATOR_SUBCOMMAND_HELP.ops, "atlas-operator"),
      );
      expect(text).toContain("Usage: atlas-operator ops");
    });

    test("operator examples never reference the bare `atlas` bin", () => {
      for (const name of OPERATOR_NAMES) {
        for (const ex of OPERATOR_SUBCOMMAND_HELP[name].examples ?? []) {
          expect(ex).not.toMatch(/(^|\s)atlas (ops|seed|proactive|export|learn)\b/);
        }
      }
    });
  });

  describe("dispatch routing", () => {
    test("`atlas` redirects operator commands to atlas-operator (exit 1, echoes the command)", async () => {
      const { stderr, exitCode } = await runBin("atlas.ts", ["ops", "--help"]);
      expect(exitCode).toBe(1);
      expect(stderr.toLowerCase()).toContain("operator-only");
      // The redirect must reconstruct the exact re-run invocation, command + args.
      expect(stderr).toContain("atlas-operator -- ops --help");
    }, 30000);

    test("`atlas-operator` dispatches operator subcommand help (exit 0)", async () => {
      const { stdout, exitCode } = await runBin("atlas-operator.ts", [
        "ops",
        "--help",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: atlas-operator ops");
    }, 30000);

    test("`atlas-operator` top-level help exits 0", async () => {
      const { stdout, exitCode } = await runBin("atlas-operator.ts", ["--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: atlas-operator <command>");
    }, 30000);

    // The `--help` cases short-circuit before the dispatch chain; these drive a
    // real handler so a copy-paste mis-wire (e.g. the `seed` branch calling
    // handleProactive, which still type-checks) is caught. Each command's
    // no-subcommand path prints its own distinctive "Usage: atlas-operator <cmd>"
    // and exits 1 without touching a DB, so reaching the WRONG handler prints the
    // wrong banner. `export`/`learn` are covered separately below — their
    // no-subcommand path connects to the internal DB rather than printing a
    // usage banner, so they need a different DB-free discriminator.
    for (const cmd of ["ops", "seed", "proactive"]) {
      test(`\`atlas-operator ${cmd}\` reaches the ${cmd} handler`, async () => {
        const { stdout, stderr, exitCode } = await runBin("atlas-operator.ts", [
          cmd,
        ]);
        expect(exitCode).toBe(1);
        expect(stdout + stderr).toContain(`Usage: atlas-operator ${cmd}`);
      }, 30000);
    }

    test("`atlas-operator learn` reaches the learn handler", async () => {
      // `--auto-approve` without `--suggestions` is rejected by handleLearn
      // before any DB/fs access — a discriminator unique to that handler.
      const { stdout, stderr, exitCode } = await runBin("atlas-operator.ts", [
        "learn",
        "--auto-approve",
      ]);
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain("--suggestions");
    }, 30000);

    test("`atlas-operator export` reaches the export handler", async () => {
      // With DATABASE_URL unset, handleExport fails fast with its own message
      // before connecting — uniquely identifies that handler, DB-free.
      const { stdout, stderr, exitCode } = await runBin(
        "atlas-operator.ts",
        ["export"],
        ["DATABASE_URL", "ATLAS_TEAM_PG_URL"],
      );
      expect(exitCode).not.toBe(0);
      expect(stdout + stderr).toContain(
        "DATABASE_URL is required for atlas-operator export",
      );
    }, 30000);

    test("`atlas-operator` rejects unknown commands (exit 1)", async () => {
      const { stderr, exitCode } = await runBin("atlas-operator.ts", [
        "definitely-not-a-command",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Unknown operator command");
    }, 30000);
  });
});
