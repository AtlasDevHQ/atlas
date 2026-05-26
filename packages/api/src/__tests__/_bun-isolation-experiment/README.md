# bun `--isolate` / `--parallel` empirical evidence (#2801, #2811, milestone 1.5.4)

Two layers of evidence live in this directory:

1. **Pairs 1–5** (original 5a fixtures): leaker/observer pairs probing what
   `--isolate` resets *across files* in the same worker. Verdict on #2801:
   `mock.module()`, `globalThis`, and `mock(fn)` spies ARE reset; `process.chdir`
   is not (OS state survives the worker). Mock allowlist was dropped in 5b.
2. **Pairs 6–11** (the actual-bug investigation): narrowed the production
   `actions.test.ts` failure from "mock.module + --isolate is broken" (the
   #2811 hypothesis) down to the real bug — bun 1.3.14 `--isolate` does not
   await top-level-await chains in imported modules. Regression between
   1.3.13 and 1.3.14, almost certainly the test-runner Rust rewrite.

## The actual bug

Under bun 1.3.14 `--isolate` (and therefore `--parallel`, which implies it),
loading a module that uses top-level `await` does NOT wait for the await
chain to settle before exposing the module's bindings — the importer
resumes while the target is still initializing. The observable failure
mode depends on what the importer reads:

- **Reading a `const` exported AFTER the target's top-level await**
  throws `ReferenceError: Cannot access 'X' before initialization`
  (ESM TDZ semantics). This is what `pair-11` demonstrates and what
  upstream should see in the minimal repro.
- **Reading an object that the target mutates ACROSS top-level await
  boundaries** (e.g. an app instance that the target keeps `.route(...)`-ing
  after each `await import("./route-N")`) returns the object — but with
  the post-await mutations missing. This is what `pair-10` and the
  production `actions.test.ts` hit (`mod.app` is defined, but routes
  registered after the await chain return 404).

Both are surface manifestations of the same root cause: bun's `--isolate`
does not propagate the `await` through the module-evaluation graph.

`pair-11-tla-bare.experiment.ts` is the minimal repro — ~15 lines, zero
Atlas deps. Use it as the body of the upstream filing to `oven-sh/bun`.

Investigation also probed `beforeAll`-scoped, in-test-body, and static
hoisted `import` shapes — all failed the same way. The probe fixtures
for those (pair-12/13/14) were deleted as redundant once it was clear
the failure is property of `--isolate`'s TLA handling, not the import
shape. The "no in-test workaround" conclusion is empirical.

## How to run

Single fixture, manual:

```bash
cd packages/api
# bare — passes in all versions
bun test ./src/__tests__/_bun-isolation-experiment/pair-11-tla-bare.experiment.ts
# --isolate — passes on 1.3.13, fails on 1.3.14
bun test --isolate ./src/__tests__/_bun-isolation-experiment/pair-11-tla-bare.experiment.ts
```

The cross-file pairs (1–5) use `run-experiment.sh`; pairs 6–11 are
independent single-file repros and don't need the runner. All files use
the `.experiment.ts` suffix so the regular `**/*.test.ts` glob skips them.

## Pair index

### Cross-file (#2801 slice 5a)

| # | Question | Verdict on bun 1.3.13 |
|---|---|---|
| 1 | `mock.module()` survives across files? | No (reset) |
| 2 | `process.env.X = ...` survives? | No |
| 3 | `globalThis.X = ...` survives? | No (reset) |
| 4 | `process.chdir()` survives? | Yes (OS-level) |
| 5 | `mock(fn)` spy call history survives? | No (reset) |

### Within-file / actual-bug narrowing (#2811)

| # | Hypothesis tested | Result on 1.3.14 |
|---|---|---|
| 6 | `mock.module()` propagates to transitive consumer (relative path)? | Yes — works fine |
| 8 | `process.env.X ??= ...` propagates to dynamically-imported child? | Yes — works fine |
| 9 | Stacking 2+ `mock.module()` before env-set + dyn-import? | Yes — works fine |
| 10 | Production SUT (`@atlas/api/app`) loads to completion under --isolate? | **No — half-loaded** |
| 11 | Minimal: import a module with top-level await | **No — TDZ ReferenceError** |

Pair 11 is the smoking gun. Pairs 6, 8, 9 ruled out the framings that
#2811 originally proposed (mock.module, env propagation). Pair 10 revealed
the timing: `await import` returns before the imported module's TLA chain
finishes, so test code runs against a partially-initialized SUT.

## Version matrix (pair-11)

| bun | bare | --isolate | --parallel |
|---|:---:|:---:|:---:|
| 1.3.11 | ✅ | ✅ | ✅ |
| 1.3.13 | ✅ | ✅ | ✅ |
| 1.3.14 | ✅ | ❌ | ❌ |

The single-version regression at 1.3.14 is what drives the engine pin to
`>=1.3.13 <1.3.14` in the workspace root `package.json`. Unpin once the
upstream fix lands.
