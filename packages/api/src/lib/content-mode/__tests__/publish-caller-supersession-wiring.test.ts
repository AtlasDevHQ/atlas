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
 * invokes `runPublishPhases` is in scope the day it lands — across every root
 * that can reach `@atlas/api/lib/**`, not just `packages/api`.
 *
 * What this does NOT prove: that the swept records are then persisted. It is a
 * source-shape guard — it pins that a caller binds the reports and passes them
 * into the shared sweep. What each caller DOES with the result is pinned
 * behaviorally by that caller's own suite, so a sweep whose result is then
 * dropped, or one sitting in a dead branch, passes here by design.
 *
 * One discovery blind spot, currently unreachable: a destructured or aliased
 * call (`const { runPublishPhases } = registry; runPublishPhases(...)`) has no
 * `.runPublishPhases(` and would not be found. Verified zero such call sites
 * today; if an Effect-style service destructure becomes idiomatic here, widen
 * `CALL_SITE` to a bare-identifier pattern.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const API_SRC = join(import.meta.dir, "..", "..", "..");
const REPO = join(API_SRC, "..", "..", "..");

/**
 * Every root a publish surface could PLAUSIBLY land in — not just
 * `packages/api/src`. `ee/`, `packages/mcp` and `packages/cli` all import
 * `@atlas/api/lib/**` and all three already host admin-shaped or
 * content-shaped code, so a fourth caller landing in any of them is exactly the
 * silent-inheritance scenario this file exists to prevent, and a single-root
 * walk would never see it. (Same reason the repo's audit greps are required to
 * cover `ee/`. `packages/cli` is here because
 * `docs/development/content-mode.md` already describes a CLI publish surface.)
 * Other workspaces import `@atlas/api` too — `sandbox-sidecar`,
 * `fumadocs-okf` — and are deliberately out: neither could host a publish
 * surface without a redesign that would surface this file anyway.
 *
 * NOT filtered by `existsSync` — a renamed or restructured root would silently
 * shrink the guarded surface, which is the same failure shape as the bug being
 * guarded. Existence is ASSERTED below instead, so the guard goes red rather
 * than quietly narrowing.
 */
const ROOTS = [
  API_SRC,
  join(REPO, "ee", "src"),
  join(REPO, "packages", "mcp", "src"),
  join(REPO, "packages", "cli", "src"),
];

/** The module that DEFINES the method — this is a caller list, not a mention list. */
const REGISTRY_MODULE = join("lib", "content-mode", "registry.ts");

const CALL_SITE = ".runPublishPhases(";

function sourceFiles(dir: string, out: string[] = []): string[] {
  // A missing root yields nothing here so the roots assertion below reports it
  // as a readable failure rather than a module-load ENOENT — the scan still
  // narrows, but never silently: that test is what makes it visible.
  if (!existsSync(dir)) return out;
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

/** Files that CALL `runPublishPhases`, relative to the repo root. A doc mention is not a call. */
function publishPhaseCallers(): string[] {
  return ROOTS.flatMap((root) => sourceFiles(root))
    .filter((full) => !full.endsWith(REGISTRY_MODULE))
    // Discovery runs on STRIPPED source too, not just the shape checks: this
    // file's neighbours (`promoted.ts`, `tables.ts`) discuss `runPublishPhases`
    // in prose, and one `.` away from `.runPublishPhases(` a comment would
    // enrol a non-caller and immediately red both shape checks against it.
    .filter((full) => stripCommentsAndStrings(readFileSync(full, "utf8")).includes(CALL_SITE))
    .map((full) => full.slice(REPO.length + 1))
    .sort();
}

/**
 * Drop comments AND string/template literals, so neither prose nor a log
 * message can satisfy or break the shape checks below.
 *
 * Strings first, deliberately: this codebase's log messages routinely name the
 * helpers they describe, so `log.info(…, "…collectSupersessions(reports) is the
 * projection")` would otherwise satisfy the sweep check on a caller that swept
 * nothing. Stripping strings before comments also stops a `//` inside a URL
 * literal from eating the rest of its line.
 */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/`(?:\\.|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, " ")
    .replace(/'(?:\\.|[^'\\\n])*'/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * Comparison and arrow operators, blanked so they cannot pass for an
 * assignment. Without this, `if (mode === "publish") await Effect.runPromise(
 * reg.runPublishPhases(...))` and an arrow-bodied `const run = async (...) =>
 * Effect.runPromise(reg.runPublishPhases(...))` both satisfy the bind check on
 * their `===` / `=>` while discarding the reports — two ordinary refactors of
 * the very code this guards.
 */
function blankNonAssignmentOperators(src: string): string {
  return src.replace(/=>|[=!<>]==?/g, "  ");
}

/**
 * For each call site, the source between the enclosing statement's start and
 * the call. A caller that KEEPS the reports binds them (`=`) or hands them on
 * (`return` / `yield`); the pre-#4937 shape — `await Effect.runPromise(...)`
 * for side effects alone, return value dropped on the floor — has none of the
 * three.
 */
function callStatementPrefixes(src: string): string[] {
  const clean = blankNonAssignmentOperators(stripCommentsAndStrings(src));
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
  it("walks every root that can reach @atlas/api/lib", () => {
    // Asserted, not filtered: a root that moves must red this test rather than
    // silently drop out of the scan.
    for (const root of ROOTS) expect({ root, exists: existsSync(root) }).toEqual({
      root,
      exists: true,
    });
  });

  it("strips nothing that changes WHO is a caller", () => {
    // The stripper is the one thing standing between discovery and a silent
    // miss, in both directions: the template-literal pattern is deliberately
    // not newline-bounded (templates are multi-line), so an ODD number of
    // backticks in a comment can swallow a real call site and drop the file out
    // of CALLERS entirely; and a prose mention in raw source would enrol a
    // non-caller. Asserting the two sets agree catches both, and prints the
    // delta rather than a bare boolean.
    const raw = ROOTS.flatMap((root) => sourceFiles(root))
      .filter((full) => !full.endsWith(REGISTRY_MODULE))
      .filter((full) => readFileSync(full, "utf8").includes(CALL_SITE))
      .map((full) => full.slice(REPO.length + 1))
      .sort();
    expect({ onlyInRaw: raw.filter((f) => !CALLERS.includes(f)) }).toEqual({ onlyInRaw: [] });
    expect({ onlyInStripped: CALLERS.filter((f) => !raw.includes(f)) }).toEqual({
      onlyInStripped: [],
    });
  });

  it("discovers the known callers", () => {
    // A floor plus the three known names, so a broken predicate cannot make
    // every assertion below pass vacuously by discovering nothing.
    expect(CALLERS.length).toBeGreaterThanOrEqual(3);
    const API = join("packages", "api", "src");
    expect(CALLERS).toContain(join(API, "api", "routes", "admin-publish.ts"));
    expect(CALLERS).toContain(join(API, "lib", "datasources", "mcp-lifecycle.ts"));
    expect(CALLERS).toContain(join(API, "lib", "knowledge", "ingest-bundle.ts"));
  });

  for (const file of CALLERS) {
    describe(file, () => {
      const src = readFileSync(join(REPO, file), "utf8");
      // Both shape checks run on source with comments AND string literals
      // stripped, so neither prose nor a log message can satisfy or break them:
      // a caller could otherwise pass by writing `// deliberately not calling
      // collectSupersessions(reports)` or by naming the helper inside a log
      // message, and a comment quoting the forbidden `.find(...)` shape could
      // false-FAIL an innocent file.
      const clean = stripCommentsAndStrings(src);

      it("sweeps the reports through the shared collectSupersessions helper", () => {
        // The shared sweep, never a hand-rolled `reports.find(...)?.superseded`
        // fan-out — that layout is what let knowledge documents ship
        // under-reported in milestone #81, and what `promoted.ts` exists to end.
        expect(clean).toContain("collectSupersessions(");
        expect(clean).not.toMatch(/\.find\([^)]*\)[^;\n]*\.superseded/);
      });

      it("passes the bound reports INTO the sweep, not merely alongside it", () => {
        // Closes the "binds and discards" gap: the two checks either side of
        // this one are satisfied by `const reports = await ...` plus a
        // `collectSupersessions(` anywhere in the file, even on an unrelated
        // value. EVERY call site's bound identifier must reach the sweep —
        // directly (`collectSupersessions(reports)`) or relayed out of the
        // transaction closure it was bound in, as `admin-publish.ts` does with
        // `collectSupersessions(tx.reports)`. Every, not some: a file with two
        // call sites where only one is swept is the #4937 regression at a finer
        // granularity.
        //
        // The per-name check alone would NOT catch that, because `reachesSweep`
        // is textual per identifier: two call sites both binding `reports` are
        // satisfied by a single sweep — and all three callers today bind exactly
        // `reports`, so that is the likeliest shape the regression would take.
        // The sweep COUNT is what closes it: one `collectSupersessions(` per
        // call site.
        //
        // Known false-FAIL shapes, all currently unused: a destructured bind
        // (`const { reports } = await …`), an assignment to a pre-declared
        // `let`, a bind into an object literal, an inline compose
        // (`return collectSupersessions(await …)`), and `export const`. If one
        // becomes the natural way to write a caller, broaden the pattern — do
        // not delete the assertion.
        const prefixes = callStatementPrefixes(src);
        const bound = prefixes
          .map((prefix) => /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(prefix)?.[1])
          .filter((name): name is string => name !== undefined);
        expect(bound).toHaveLength(prefixes.length);
        expect(bound.length).toBeGreaterThan(0);
        expect(clean.match(/collectSupersessions\(/g) ?? []).toHaveLength(prefixes.length);
        for (const name of bound) {
          // `$` is a regex anchor and a legal identifier character, so it is
          // escaped rather than interpolated raw. The class is deliberately
          // TOTAL (`\` too) even though `bound` only ever yields
          // `[A-Za-z0-9_$]` — a partial escape trips CodeQL's
          // js/incomplete-sanitization (#4958). Do not narrow it back.
          const ident = name.replace(/[\\$]/g, "\\$&");
          expect({
            name,
            reachesSweep: new RegExp(
              `collectSupersessions\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)*${ident}\\b`,
            ).test(clean),
          }).toEqual({ name, reachesSweep: true });
        }
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
