/**
 * A spy whose behaviour is swapped PER TEST and restored between tests.
 *
 * `mock.module()` is file-scoped: a specifier is registered once per test file
 * and the last registration wins. That is the constraint #5645 named as the
 * dominant driver of the suite's file count — one function under two mock
 * setups looked like it needed two files. It does not. The registration is
 * file-scoped; the spies INSIDE it are not. Register each module once with a
 * drivable spy per export, and every test drives the spy it needs through
 * `mockImplementation` / `mockImplementationOnce`.
 *
 * The one thing bun does not give you for free is the way back: `mockReset()`
 * clears the implementation along with the calls, so the spy then returns
 * `undefined` — jest semantics, not "back to what `mock(fn)` was given" — and a
 * suite that resets between tests loses its baseline. `reset()` here is
 * `mockReset()` followed by re-installing the default, which also flushes any
 * unconsumed `mockImplementationOnce` a previous test queued. (The measurement
 * behind this is in `docs/development/testing.md`.)
 *
 * Usage, from a test file (the `bun:test` import is the file's own, so bun's
 * per-file `--isolate` registry applies exactly as it does to an inline spy):
 *
 *   const getEntity = drivable(async (_org: string, name: string) => null);
 *   void mock.module("@atlas/api/lib/semantic/entities", () => ({ getEntity, … }));
 *   const { subject } = await import("../subject");
 *
 *   beforeEach(() => getEntity.reset());
 *   it("…", async () => {
 *     getEntity.mockImplementation(async () => row);
 *     …
 *   });
 *
 * Typed parameter lists matter: `.mock.calls[n][i]` on a bare `mock(async () =>
 * {})` infers a zero-arity call tuple, and positional assertions then fail to
 * type-check. Give the default the real signature.
 *
 * @module
 */

import { mock, type Mock } from "bun:test";

/**
 * The widest function shape bun's `Mock<T>` accepts — its own bound is
 * `(...args: any[]) => any`, and a narrower one (`never[]` / `unknown`) rejects
 * async signatures at the call site. The `any` is that third-party bound
 * restated, which is the one case CLAUDE.md admits it for.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- bun's own `Mock<T extends (...args: any[]) => any>` bound; a narrower bound rejects async signatures at the call site
export type DrivableFn = (...args: any[]) => any;

export type DrivableMock<T extends DrivableFn> = Mock<T> & {
  /**
   * Back to the default implementation with an empty call log and no queued
   * once-implementations. Call from `beforeEach`.
   */
  readonly reset: () => void;
};

/** Build a spy that starts as `defaultImpl` and can always be returned to it. */
export function drivable<T extends DrivableFn>(defaultImpl: T): DrivableMock<T> {
  const spy = mock(defaultImpl);
  const reset = (): void => {
    spy.mockReset();
    spy.mockImplementation(defaultImpl);
  };
  return Object.assign(spy, { reset });
}

/**
 * The stand-in for an export a fixture registers but does not drive. Throws on
 * first use with the export's name, so a module under test that reaches an
 * export the fixture never modelled fails at the call, loudly and by name —
 * instead of at link time with `Export named 'X' not found` (the failure that
 * the "mock all exports" rule in `.claude/rules/testing.md` exists to prevent)
 * or, worse, by returning `undefined` into a code path that tolerates it.
 */
export function notDriven(exportName: string, fixture: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(
      `${exportName} is registered by the ${fixture} fixture but not driven — ` +
        `drive it with mockImplementation, or the module under test reached an export this suite never modelled`,
    );
  };
}
