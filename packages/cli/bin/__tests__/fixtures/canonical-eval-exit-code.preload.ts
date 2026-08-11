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
 *   ATLAS_TEST_STUB_SEED=1     — replace `seedDemoPostgres` with a stub that
 *                                REPORTS THE LABEL THROUGH THE INJECTED SINK
 *                                (see below — a no-op would delete the very
 *                                polluter the suite exists to detect) and skips
 *                                the live Postgres.
 *   ATLAS_TEST_FAIL_CP_FROM=…  — make `fs.cpSync` throw when copying FROM that
 *                                path, so `restoreSemanticLayer` fails.
 *   ATLAS_TEST_EMIT_LOG=1      — with the seed stub, emit one real app-logger
 *                                line from inside the run (#5126). Requires
 *                                ATLAS_TEST_STUB_SEED=1; see the stub below.
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
 * arrives via `fs.cpSync`, and cpSync does NOT preserve directory modes — a 0500
 * fixture directory is copied back as 0755, measured. So no permission trick on
 * the COPIED directories can reach the restore. (Chmod'ing the sandbox cwd would
 * reach it, but that breaks the earlier backup step first, and it assumes a
 * non-root runner.)
 *
 * Verified on bun 1.3.13: `mock.module` from `bun:test` applies in a plain
 * `bun --preload` process, not just under `bun test`.
 */
// ⚠️ FIRST, AND FOR THE SAME REASON IT IS FIRST IN `bin/atlas.ts` (#5126). A
// `--preload` module is evaluated BEFORE the entry module, so this fixture —
// not `bin/atlas.ts` — is what reaches `@atlas/api/lib/logger` first here, via
// the `realInit` import below. Without this line the logger is constructed on
// fd 1 before the CLI's own stamp ever runs, and every `--json` spawn in this
// suite would see the pre-#5126 behaviour no matter what the CLI does.
//
// It imports the REAL stamp module rather than assigning the env var by hand,
// so a stamp whose argv condition is wrong fails these tests instead of being
// papered over. What it cannot cover is the stamp's POSITION in `bin/atlas.ts`,
// which `../eval-json-stdout.test.ts` asserts against the source directly.
import "../../eval-log-destination";
import * as realFs from "fs";
import { mock } from "bun:test";
// Hoisted above the `fs` patch below, so this module's graph loads against the
// real `fs`. That is only true AT LOAD TIME and it does not weaken the patch:
// bun rebinds the namespace in place, so an already-loaded module's later
// `fs.cpSync` calls still go through the patch. Measured on bun 1.3.13 with a
// helper imported by a preload before its own `mock.module("fs")`.
import * as realInit from "../../../src/commands/init";

const failCpFrom = process.env.ATLAS_TEST_FAIL_CP_FROM;
if (failCpFrom) {
  // ⚠️ Capture the real implementation BEFORE `mock.module` runs. Bun rebinds
  // the namespace object in place, so `realFs.cpSync` read from inside the
  // patch resolves to the PATCH — every non-blocked copy then recurses until
  // the stack blows, which surfaces as a restore failure for entirely the
  // wrong reason.
  const originalCpSync = realFs.cpSync;
  // `typeof realFs.cpSync` rather than hand-written parameter types: the params
  // are then contextually typed, so no signature can drift from @types/node in
  // the first place, and a mismatch is reported HERE rather than one line down
  // on the object literal.
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
  // Both specifiers are patched defensively. On bun 1.3.13 either call alone
  // patches both — measured in both directions — but that equivalence is
  // undocumented, so don't rely on it in the next fixture.
  void mock.module("fs", fsFactory);
  void mock.module("node:fs", fsFactory);
}

if (process.env.ATLAS_TEST_STUB_SEED === "1") {
  const stubbedSeed: typeof realInit.seedDemoPostgres = async (_conn, report) => {
    // ⚠️ THE STUB REPORTS THE LABEL THROUGH THE INJECTED SINK. It must, and the
    // reason is the sharpest lesson of #5126's review: the real
    // `seedDemoPostgres` was the THIRD writer on fd 1, and a stub that simply
    // did nothing deleted the polluter and then let the suite confirm the
    // polluter was absent — the artifact parsed in a world where the bug had
    // been removed by the fixture. Reporting through `report` instead makes
    // this an assertion about the CALL SITE: does `runInstalledCanonicalEval`
    // hand `seedDemoPostgres` the resolved human writer, or `console.log`?
    // (The real function's own use of the sink is covered in-process by
    // `../../../src/__tests__/seed-demo-report.test.ts`, which the stub cannot reach.)
    report(`${realInit.DEMO_DATASET.label}\n`);

    // ⚠️ Emitted from INSIDE the run, through the real `createLogger`, because
    // that is the mechanism (#5126): the polluting frames come from modules the
    // eval pulls in mid-flight, not from anything the driver writes. A line
    // emitted at preload time instead would land before the first driver write
    // and could be stripped by a `tail`, which is exactly the diagnosis the
    // issue rules out. `seedDemoPostgres` runs after the banner and before the
    // question loop, so this lands mid-stream like the real ones.
    if (process.env.ATLAS_TEST_EMIT_LOG !== "1") return;
    const { createLogger } = await import("@atlas/api/lib/logger");
    createLogger("canonical-eval-probe").error(
      { probe: "eval-log-destination" },
      "probe log line",
    );
  };
  // Spread the real module: `bin/atlas.ts` re-exports five symbols from here
  // and a partial factory would leave the rest undefined at import time.
  void mock.module("../../../src/commands/init", () => ({
    ...realInit,
    seedDemoPostgres: stubbedSeed,
  }));
}
