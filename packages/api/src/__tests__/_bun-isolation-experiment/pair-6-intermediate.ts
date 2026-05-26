// Intermediate module for pair 6 — imports `_shared-target` transitively so
// the test below can probe whether `mock.module()` propagates through an
// indirect import graph under `--isolate`. Mirrors the production shape
// where `actions.test.ts` mocks `@atlas/api/lib/auth/middleware` and then
// imports `../index` (which imports the middleware transitively).
import { truth } from "./_shared-target";

export function truthIndirect(): string {
  return truth();
}
