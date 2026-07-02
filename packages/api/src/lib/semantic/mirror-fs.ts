/**
 * Shared leaf helpers for the per-org, per-mode disk mirrors (the entity
 * mode-root in `semantic/sync.ts` and the knowledge mirror in
 * `knowledge/mirror.ts`). One implementation of path-segment safety and
 * atomic writes, so the two mirror producers can't drift — the knowledge
 * mirror shipped with a plain (non-atomic) `writeFile` while the entity
 * mirror deliberately used temp+rename to prevent partial reads by
 * concurrent explore commands.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename (atomic on POSIX — same filesystem). Prevents partial reads by
 * concurrent explore commands. Creates the parent directory.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${Date.now()}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, "utf-8");
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // intentionally ignored: temp file may not exist if writeFile failed
    }
    throw err;
  }
}

/**
 * True when `value` is safe as a single path segment — no separators or `..`
 * traversal that could escape the mirror root. Returns a boolean (rather than
 * throwing) so the best-effort DB→disk writers can skip an unsafe row rather
 * than aborting the whole rebuild.
 */
export function isSafePathSegment(value: string): boolean {
  return (
    value === path.basename(value) &&
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}
