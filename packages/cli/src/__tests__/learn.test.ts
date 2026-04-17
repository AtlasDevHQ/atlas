/**
 * Tests for the `atlas learn` command — specifically the argument-parsing
 * guards that prevent user intent from being silently ignored.
 *
 * The `--auto-approve` flag only affects query-suggestion rows, so it
 * must be combined with `--suggestions`. Without this guard, an operator
 * could pass `atlas learn --auto-approve` expecting rows to be published,
 * and get the YAML improvement path instead — with zero rows written.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";

// --- Capture console + process.exit without exiting the test runner. ---
const errors: string[] = [];
const origConsoleError = console.error;
const origExit = process.exit;

let exitCode: number | null = null;

beforeEach(() => {
  errors.length = 0;
  exitCode = null;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  // Cast via unknown so TypeScript accepts the thrower signature — the
  // production exit() never returns either, so behaviorally this is
  // equivalent. We catch the thrown sentinel in each test.
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__process_exit__:${exitCode}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  console.error = origConsoleError;
  process.exit = origExit;
  mock.restore();
});

const { handleLearn } = await import("../commands/learn");

describe("handleLearn — --auto-approve guard", () => {
  it("exits 1 when --auto-approve is passed without --suggestions", async () => {
    let caught: Error | null = null;
    try {
      await handleLearn(["--auto-approve"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(exitCode).toBe(1);
    // The error message must tell the operator WHY the command failed —
    // a generic "invalid arguments" would hide the coupling between
    // --auto-approve and --suggestions.
    expect(errors.some((line) => line.includes("--auto-approve") && line.includes("--suggestions"))).toBe(true);
  });
});
