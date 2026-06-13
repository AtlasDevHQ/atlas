/**
 * Structural guard (#3494): no production MCP module writes raw diagnostic
 * strings to `process.stderr` — every diagnostic site goes through the
 * structured `createMcpLogger` (stderr, JSON, requestId-correlated) instead.
 *
 * Mirrors the surface-stamper guard the PRD (#3483) references: it encodes
 * the acceptance criterion as a test so the class of regression ("someone
 * adds a `process.stderr.write` back") can't slip past CI.
 *
 * Excluded:
 * - `__tests__/` — test scaffolding may capture/emit freely.
 * - `eval/` — the offline eval harness, not a served diagnostic path.
 */

import { describe, test, expect } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const SRC = resolve(import.meta.dir, "..");

describe("no raw stderr diagnostics in production MCP modules", () => {
  test("process.stderr.write appears in no served module", async () => {
    const glob = new Glob("**/*.ts");
    const offenders: string[] = [];
    for await (const path of glob.scan({ cwd: SRC, absolute: true })) {
      const rel = relative(SRC, path);
      if (rel.startsWith("__tests__/") || rel.startsWith("eval/")) continue;
      const source = readFileSync(path, "utf8");
      if (source.includes("process.stderr.write")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
