/**
 * `bun --preload` fixture for the canonical-eval exit-code spawn tests
 * (`../canonical-eval-exit-code.test.ts`, #5130).
 *
 * Those tests assert the code the CLI hands the SHELL, so the harness has to be
 * a real child process — which rules out in-process `mock.module`. This module
 * is preloaded into that child instead, and stubs only what the two otherwise
 * unreachable paths need. It is inert unless one of its env switches is set, so
 * a spawn that wants the untouched CLI simply omits `--preload`.
 *
 *   ATLAS_TEST_STUB_SEED=1     — make `seedDemoPostgres` a no-op, so a run can
 *                                get PAST the seed and into `--mcp-llm` without
 *                                a live Postgres.
 *   ATLAS_TEST_FAIL_RM_PATH=…  — make `fs.rmSync` throw for exactly that one
 *                                path, so `restoreSemanticLayer` fails on its
 *                                final step and returns false.
 *
 * Why `rmSync` and not a chmod: every directory `restoreSemanticLayer` touches
 * arrives via `fs.cpSync`, and cpSync does NOT preserve directory modes — a
 * read-only fixture directory is copied back as 0755, so no permission trick on
 * disk can make the restore fail. Blocking the one call is the only lever that
 * reaches it without rewriting the code under test.
 */
import * as realFs from "fs";
import { mock } from "bun:test";
import * as realInit from "../../../src/commands/init";

const failRmPath = process.env.ATLAS_TEST_FAIL_RM_PATH;
if (failRmPath) {
  // ⚠️ Capture the real implementation BEFORE `mock.module` runs. Bun rebinds
  // the namespace object in place, so `realFs.rmSync` read from inside the
  // patch resolves to the PATCH — every non-blocked path then recurses until
  // the stack blows, which surfaces as a restore failure for entirely the wrong
  // reason and never reaches the seed at all.
  const originalRmSync = realFs.rmSync;
  const patchedFs = {
    ...realFs,
    rmSync(target: realFs.PathLike, options?: realFs.RmOptions): void {
      if (String(target) === failRmPath) {
        throw new Error(`EACCES: permission denied, rm '${failRmPath}'`);
      }
      originalRmSync(target, options);
    },
  };
  // Both specifiers resolve to the same builtin but are separate registry keys
  // in bun, and the code under test imports the bare form.
  mock.module("fs", () => ({ ...patchedFs, default: patchedFs }));
  mock.module("node:fs", () => ({ ...patchedFs, default: patchedFs }));
}

if (process.env.ATLAS_TEST_STUB_SEED === "1") {
  // Spread the real module: `bin/atlas.ts` re-exports six symbols from here and
  // a partial factory would leave the rest undefined at import time.
  mock.module("../../../src/commands/init", () => ({
    ...realInit,
    seedDemoPostgres: async (): Promise<void> => {},
  }));
}
