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
 *                                get PAST the seed without a live Postgres.
 *   ATLAS_TEST_FAIL_CP_FROM=…  — make `fs.cpSync` throw when copying FROM that
 *                                path, so `restoreSemanticLayer` fails.
 *
 * ⚠️ Why the switch keys on the copy SOURCE. `restoreSemanticLayer` runs
 * `rmSync(SEMANTIC_DIR)` → `cpSync(BACKUP_DIR → SEMANTIC_DIR)` → `rmSync(BACKUP_DIR)`.
 * Pointing the switch at `BACKUP_DIR` as a cpSync SOURCE selects exactly one
 * call in the whole run — `installSchemaSemanticLayer` copies FROM the seed
 * fixture and `backupSemanticLayer` copies FROM `semantic/`, so neither is hit.
 * It also selects the branch that MOTIVATES exit 2: the removal has already
 * happened, so `semantic/` is genuinely gone and the CRITICAL message telling
 * the operator where the backup is, is true. Blocking the trailing
 * `rmSync(BACKUP_DIR)` instead would exercise a benign branch where the layer
 * was restored fine and every line of that message is false.
 *
 * ⚠️ Why a stub and not a chmod: every directory `restoreSemanticLayer` touches
 * arrives via `fs.cpSync`, and cpSync does NOT preserve directory modes — a
 * read-only fixture directory is copied back as 0755, measured. So no
 * permission trick on disk can reach the restore.
 *
 * Verified on bun 1.3.13: `mock.module` from `bun:test` applies in a plain
 * `bun --preload` process, not just under `bun test`.
 */
import * as realFs from "fs";
import { mock } from "bun:test";
// ⚠️ Hoisted above the `fs` patch below, so this module's whole graph loads
// against the REAL `fs`. That is correct — the patch is for the CLI's later
// restore call, not for module init — but it means the two are order-coupled:
// if `bin/atlas.ts` ever pulls `src/commands/init` before the preload runs, the
// cpSync patch stops applying. It fails safe (the exit-2 tests would report 1
// and go red), just opaquely.
import * as realInit from "../../../src/commands/init";

const failCpFrom = process.env.ATLAS_TEST_FAIL_CP_FROM;
if (failCpFrom) {
  // ⚠️ Capture the real implementation BEFORE `mock.module` runs. Bun rebinds
  // the namespace object in place, so `realFs.cpSync` read from inside the
  // patch resolves to the PATCH — every non-blocked copy then recurses until
  // the stack blows, which surfaces as a restore failure for entirely the
  // wrong reason.
  const originalCpSync = realFs.cpSync;
  // Annotating with `typeof realFs.cpSync` rather than hand-writing the
  // parameter types makes the substitution compiler-checked: a spread simply
  // replaces the property, so a hand-written signature that drifts from
  // @types/node would raise no error at all.
  const patchedCpSync: typeof realFs.cpSync = (source, destination, options) => {
    if (String(source) === failCpFrom) {
      throw new Error(`EACCES: permission denied, cp '${failCpFrom}'`);
    }
    originalCpSync(source, destination, options);
  };
  // Annotated `typeof realFs` rather than left inferred: without it a misspelled
  // key (`cpSyncc`) is a legal extra property on an object literal and the whole
  // module goes out unpatched with no diagnostic. With it, TS2561 names the typo.
  const patchedFs: typeof realFs = { ...realFs, cpSync: patchedCpSync };
  // `default` must point at the patched surface too — spreading `realFs` copies
  // its own `default` key straight through, leaving an unpatched escape hatch.
  const fsFactory = () => ({ ...patchedFs, default: patchedFs });
  // Both specifiers resolve to the same builtin but are separate registry keys
  // in bun, and the code under test imports the bare form.
  void mock.module("fs", fsFactory);
  void mock.module("node:fs", fsFactory);
}

if (process.env.ATLAS_TEST_STUB_SEED === "1") {
  const stubbedSeed: typeof realInit.seedDemoPostgres = async () => {};
  // Spread the real module: `bin/atlas.ts` re-exports five symbols from here
  // and a partial factory would leave the rest undefined at import time.
  void mock.module("../../../src/commands/init", () => ({
    ...realInit,
    seedDemoPostgres: stubbedSeed,
  }));
}
