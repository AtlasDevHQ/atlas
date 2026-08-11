/**
 * Which fd the root logger writes to, and — the load-bearing half — that the
 * DEFAULT did not move (#5126).
 *
 * `atlas canonical-eval --json` pipes stdout into `eval-mcp-llm-output.json`
 * and uploads it as the adjudication artifact. The root logger's pino default
 * destination is fd 1, so every log frame the eval emitted landed in that file;
 * with `NODE_ENV` unset (deliberately, #5121) the dev branch is taken, so the
 * frames were `pino-pretty` output WITH ANSI COLOUR. `ATLAS_LOG_STDERR=1` moves
 * them to fd 2 for that one process.
 *
 * ⚠️ EVERY TEST HERE IS A SPAWN, AND NOT BY PREFERENCE. `rootLogger` is a
 * module-scope `const` — pino resolves the destination once, at construction —
 * so two arms need two module instances, which module caching forbids in one
 * process. On the dev branch it is worse still: the destination lives inside a
 * `pino-pretty` worker thread with its own fds, so there is nothing on the main
 * thread to intercept even in principle.
 *
 * ⚠️ BOTH BRANCHES ARE COVERED BECAUSE BOTH BRANCHES CHANGED. `isDev` selects
 * between a `pino-pretty` transport (whose `destination` is pino-pretty's own
 * option, read in the worker) and a plain `pino.destination`. Those are
 * different mechanisms with no shared implementation, so a fix that works on
 * one says nothing about the other — and the eval, running with `NODE_ENV`
 * unset, is on the branch that is easiest to forget is the CI one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "path";

const DRIVER = path.join(
  import.meta.dir,
  "fixtures",
  "logger-destination-driver.ts",
);

/** ESC (0x1b) — present only when the pretty transport colourizes. */
const ESC = "\u001b";

const children: Array<{ kill: () => void; exited: Promise<number> }> = [];

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (!child) continue;
    child.kill();
    await child.exited;
  }
});

interface Streams {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Assert the line on `carrier` actually carries the whole options set, not just
 * the message. `redactPaths` covers `password`, so a branch that dropped the
 * spread of `rootLoggerOptions` prints `hunter2` verbatim while every fd
 * assertion still passes.
 */
function expectRedactedProbe(carrier: string): void {
  expect(carrier).toContain("[Redacted]");
  expect(carrier).not.toContain("hunter2");
}

/**
 * `env` is built from scratch rather than spread from `process.env`, because
 * the runner sets `NODE_ENV=test` and that is the switch selecting the branch
 * under test — inheriting it would silently collapse the dev arms onto the
 * production one.
 */
async function runDriver(env: Record<string, string>): Promise<Streams> {
  const proc = Bun.spawn([process.execPath, DRIVER], {
    // packages/api, so pino-pretty's transport worker resolves its own deps.
    cwd: path.resolve(import.meta.dir, "..", "..", ".."),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // A driver that logged and then crashed would satisfy every fd assertion
  // below; this is what keeps them anchored to a completed run.
  expect(exitCode).toBe(0);
  return { stdout, stderr };
}

describe("root logger destination", () => {
  test(
    "defaults to fd 1 — the deployed contract, on both branches",
    async () => {
      // ⚠️ THIS IS THE TEST THAT MATTERS MOST. Structured logs on stdout is the
      // twelve-factor convention the deployments rely on (Railway reads fd 1),
      // so "fix the eval artifact" must not become "move production's logs".
      // Both arms assert fd 1 AND an empty fd 2, so a change that broadcast to
      // both streams would fail here rather than look like a pass.
      const dev = await runDriver({});
      expect(dev.stdout).toContain("probe log line");
      expect(dev.stderr).toBe("");
      // Unset NODE_ENV really did take the pretty+colour branch — without this
      // the dev arm could be silently testing the production one.
      expect(dev.stdout).toContain(ESC);
      expectRedactedProbe(dev.stdout);

      const prod = await runDriver({ NODE_ENV: "production" });
      expect(prod.stdout).toContain("probe log line");
      expect(prod.stderr).toBe("");
      // Structured JSON, no transport: the contrast that proves the two arms
      // are genuinely different branches and not the same one twice.
      expect(prod.stdout).not.toContain(ESC);
      expectRedactedProbe(prod.stdout);
    },
    120_000,
  );

  test(
    "ATLAS_LOG_STDERR=1 moves it to fd 2 on the dev branch",
    async () => {
      // The branch the eval is actually on: NODE_ENV unset, so `pino-pretty`
      // with `colorize: true`. The escapes have to travel WITH the line —
      // asserting only that stdout is empty would also pass if the logger had
      // stopped emitting.
      const { stdout, stderr } = await runDriver({ ATLAS_LOG_STDERR: "1" });
      expect(stderr).toContain("probe log line");
      expect(stderr).toContain(ESC);
      expectRedactedProbe(stderr);
      expect(stdout).toBe("");
    },
    120_000,
  );

  test(
    "ATLAS_LOG_STDERR=1 moves it to fd 2 on the production branch too",
    async () => {
      const { stdout, stderr } = await runDriver({
        ATLAS_LOG_STDERR: "1",
        NODE_ENV: "production",
      });
      expect(stderr).toContain("probe log line");
      expect(stdout).toBe("");
      expect(stderr).not.toContain(ESC);
      expectRedactedProbe(stderr);
    },
    120_000,
  );

  test(
    "any value other than exactly \"1\" leaves the default alone",
    async () => {
      // A `!== undefined` reading of the switch would make `ATLAS_LOG_STDERR=0`
      // — the spelling an operator reaches for to say NO — turn it on. Two
      // values, because `""` and `"0"` fail different plausible predicates
      // (truthiness and presence respectively).
      for (const value of ["0", ""]) {
        const { stdout, stderr } = await runDriver({
          ATLAS_LOG_STDERR: value,
          NODE_ENV: "production",
        });
        expect(stdout).toContain("probe log line");
        expectRedactedProbe(stdout);
        expect(stderr).toBe("");
      }
    },
    120_000,
  );
});
