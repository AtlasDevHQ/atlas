# `bun test --parallel` / `--isolate` empirical experiment (#2801, slice 5a)

Bun 1.3.13 added `--parallel` (implies `--isolate`). The docs claim `--isolate`
gives each test file a "fresh global object" — but the failure modes we
observed in PR #2794 are consistent with some state leaking across files
sharing a worker even with `--isolate` on.

Before slice 5b can decide whether to do a 365-file `mock.restore()` sweep or
a handful of targeted patches, we need an empirical answer to: **what
specifically does `--isolate` reset between files in the same bun worker?**

This dir is the fixture. It is **not part of the regular test run** — files
use the `.experiment.ts` suffix (the runner globs `**/*.test.ts`) so they
only execute when `run-experiment.sh` invokes them by absolute path.

## How to run (requires bun ≥ 1.3.13 — the container has 1.3.11)

```bash
cd packages/api
bash src/__tests__/_bun-isolation-experiment/run-experiment.sh
```

The script forces both files into the **same worker** (`--max-workers=1`)
under `--isolate`, captures the output, and prints a verdict matrix.
Re-running is idempotent — no state survives between invocations.

## What we measure

Each pair is `pair-<N>-leaker.experiment.ts` (mutates) → `pair-<N>-observer.experiment.ts`
(asserts what survived). File names are sorted alphabetically so the leaker
always runs first within a worker.

| # | Question | Leaker mutates… | Observer asserts… |
|---|---|---|---|
| 1 | Does `mock.module()` survive into the next file? | a module mock | the real module re-imports |
| 2 | Does a top-level `process.env.X = ...` survive? | env var | env var is unset (control: we know this leaks) |
| 3 | Does `globalThis.X = ...` survive? | global property | global is undefined |
| 4 | Does a top-level `process.chdir` survive? | cwd | cwd is the original (control) |
| 5 | Does a `mock(fn)` spy retain call history across files? | calls the spy | spy is fresh / call count is 0 |

## How to post the verdict on #2801

Run the script and paste the verdict matrix as a comment on #2801. Then 5b
decides:

- **All "isolated" except env/chdir** → 5b is a no-op for module mocks. The
  280 mock allowlist entries collapse without code changes; we just drop
  the rule from `check-test-discipline.sh`.
- **Module mocks leak** → 5b needs a codemod that pairs every `mock.module()`
  with `mock.restore()` in `afterAll`. ~365 file mechanical sweep.
- **Spies leak but mocks don't** → narrow audit, only the files holding
  spy references at module scope need patches.

The verdict drives slice 6's cutover too: any "leaks" category that we can't
patch around blocks the swap to `bun test --parallel`.
