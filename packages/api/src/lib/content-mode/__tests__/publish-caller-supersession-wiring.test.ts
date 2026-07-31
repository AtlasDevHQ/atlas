/**
 * Every `runPublishPhases` caller must handle the supersession report (#4937).
 *
 * Why a source-level test rather than a behavioral one: #4912 changed SHARED
 * machinery. `promoteBrainFacts` began stamping `valid_to` and returning
 * `PromotionReport.superseded`, and the milestone wired the disclosure into the
 * two callers that were in its own diff — the REST publish route and the MCP
 * lib seam. The third, `lib/knowledge/ingest-bundle.ts`'s "upload & publish",
 * lives in another subsystem, was untouched, and inherited the new behaviour
 * with the reports discarded: a published fact's `valid_to` stamped, a
 * `supersedes` edge written, and no record of either.
 *
 * That regression is invisible to every per-caller suite. Each one asserts what
 * its own path returns, and a dropped report changes nothing any of them looks
 * at — the promotion still commits, the counts still match, and the superseded
 * side is hidden from every as-of-now read by construction, which is precisely
 * why the disclosure is the point. So the property under test is the WIRING,
 * asserted where a fourth caller cannot dodge it.
 *
 * The caller list is DISCOVERED, not enumerated: any non-test source file that
 * invokes `runPublishPhases` is in scope the day it lands.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const API_SRC = join(import.meta.dir, "..", "..", "..");

/** The module that DEFINES the method — this is a caller list, not a mention list. */
const REGISTRY_MODULE = join("lib", "content-mode", "registry.ts");

const CALL_SITE = ".runPublishPhases(";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Files that CALL `runPublishPhases`, relative to `src/`. A doc mention is not a call. */
function publishPhaseCallers(): string[] {
  return sourceFiles(API_SRC)
    .filter((full) => !full.endsWith(REGISTRY_MODULE))
    .filter((full) => readFileSync(full, "utf8").includes(CALL_SITE))
    .map((full) => full.slice(API_SRC.length + 1))
    .sort();
}

/** Drop comments so prose can neither satisfy nor break the shape checks below. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * For each call site, the source between the enclosing statement's start and
 * the call. A caller that KEEPS the reports binds them (`=`) or hands them on
 * (`return` / `yield`); the pre-#4937 shape — `await Effect.runPromise(...)`
 * for side effects alone, return value dropped on the floor — has none of the
 * three.
 */
function callStatementPrefixes(src: string): string[] {
  const clean = stripComments(src);
  const out: string[] = [];
  for (let from = 0; ; ) {
    const at = clean.indexOf(CALL_SITE, from);
    if (at === -1) break;
    const boundary = Math.max(
      clean.lastIndexOf(";", at),
      clean.lastIndexOf("{", at),
      clean.lastIndexOf("}", at),
    );
    out.push(clean.slice(boundary + 1, at));
    from = at + CALL_SITE.length;
  }
  return out;
}

const CALLERS = publishPhaseCallers();

describe("every runPublishPhases caller handles the supersession report (#4937)", () => {
  it("discovers the known callers", () => {
    // A floor plus the three known names, so a broken predicate cannot make
    // every assertion below pass vacuously by discovering nothing.
    expect(CALLERS.length).toBeGreaterThanOrEqual(3);
    expect(CALLERS).toContain(join("api", "routes", "admin-publish.ts"));
    expect(CALLERS).toContain(join("lib", "datasources", "mcp-lifecycle.ts"));
    expect(CALLERS).toContain(join("lib", "knowledge", "ingest-bundle.ts"));
  });

  for (const file of CALLERS) {
    describe(file, () => {
      const src = readFileSync(join(API_SRC, file), "utf8");

      it("sweeps the reports through the shared collectSupersessions helper", () => {
        // The shared sweep, never a hand-rolled `reports.find(...)?.superseded`
        // fan-out — that layout is what let knowledge documents ship
        // under-reported in milestone #81, and what `promoted.ts` exists to end.
        expect(src).toContain("collectSupersessions(");
        expect(src).not.toMatch(/\.find\([^)]*\)[^;\n]*\.superseded/);
      });

      it("binds the promotion reports rather than discarding them", () => {
        const prefixes = callStatementPrefixes(src);
        expect(prefixes.length).toBeGreaterThan(0);
        for (const prefix of prefixes) {
          expect(prefix).toMatch(/=|\breturn\b|\byield\b/);
        }
      });
    });
  }
});
