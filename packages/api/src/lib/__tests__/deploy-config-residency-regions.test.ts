/**
 * Regression: the production deploy config must NOT offer "staging" as a
 * data-residency region (#3948).
 *
 * The bug: `deploy/api/atlas.config.ts` declared a `staging` arm in
 * `residency.regions` alongside us/eu/apac. The onboarding `/regions`
 * endpoint returns `getConfiguredRegions()` verbatim, so the signup region
 * picker (`/signup/region`) offered "Staging" as a selectable residency
 * region to real production users — who could then route their workspace
 * metadata to the staging Postgres. Staging must stay scoped to the staging
 * deploy only.
 *
 * Why parse the source rather than import the config: the deploy configs use
 * container-root-relative imports (`./packages/api/src/lib/config`) that only
 * resolve from `/app/` inside the SaaS image, so they cannot be `import()`-ed
 * from a unit test. We extract the `residency.regions` keys from the source
 * text instead — comments are stripped first so prose mentioning "staging"
 * (the explanatory comment that replaced the removed arm) never counts as a
 * region entry.
 *
 * Invariant pinned:
 *   - prod  (`deploy/api/atlas.config.ts`):        regions == { us, eu, apac }
 *   - staging (`deploy/api-staging/atlas.config.ts`): regions == { staging }
 *
 * The api-eu / api-apac Railway services reuse `deploy/api/atlas.config.ts`
 * (only their `railway.json` differs), so this one prod assertion covers all
 * three production regions.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const PROD_CONFIG = resolve(REPO_ROOT, "deploy/api/atlas.config.ts");
const STAGING_CONFIG = resolve(REPO_ROOT, "deploy/api-staging/atlas.config.ts");

/**
 * Extract the region-id keys declared inside `residency.regions: { ... }`.
 *
 * A region entry is a quoted key whose value is an object literal
 * (`"<id>": {`). The scan is brace-bounded to the `regions` object so
 * unrelated later config (e.g. a `configSchema` key) can never leak in.
 *
 * Correctness against the test's own purpose (catching a future staging
 * re-add) demands the parser never be fooled by characters that LOOK
 * structural but aren't:
 *   - `//` inside a URL string (`apiUrl: "https://api.staging..."`) must NOT
 *     read as a line comment.
 *   - `{` / `}` INSIDE a string value (a URL) must NOT be brace-counted.
 *   - a quoted slug in COMMENT prose (this file's own "staging" tombstone)
 *     must NOT be matched as a region key.
 *
 * Two offset-preserving copies of the source, same length as `src` so a single
 * `[open, end]` range slices both:
 *   - `braceScan`: string-literal INTERIORS and `//` line comments blanked to
 *     spaces — used only to brace-match the `regions { … }` body. Region KEYS
 *     survive as `""` (interior blanked, quotes kept), which is fine: we never
 *     read keys off this copy, only braces, and a blanked URL can't inject one.
 *   - `commentless`: ONLY `//` line comments blanked. Region KEYS stay intact;
 *     URL string VALUES may be truncated at an embedded `//` (`"https:` + blank)
 *     — harmless, because keys are matched by the `"<id>": {` shape, never by
 *     URL content. A URL value never matches `"<id>": {` (it isn't followed by
 *     `: {`), and comment prose is gone, so the only `"<slug>": {` matches are
 *     real region entries.
 *
 * Guard against a non-inline re-add so a divergent shape fails LOUDLY instead
 * of silently slipping a region past the assertion:
 *   - `"staging": someConst` (referenced value) → caught by the quoted-key vs
 *     object-key count mismatch below.
 *   - `...someRegions` (spread) → caught by the explicit spread guard below
 *     (a spread carries no quoted key, so the count check alone would miss it).
 */
function extractResidencyRegionKeys(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const blank = (s: string) => " ".repeat(s.length);

  // Copy used ONLY for brace-counting: blank string interiors (keep the quotes
  // so offsets and the `""` shape survive) and `//` line comments.
  const braceScan = src
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => `"${" ".repeat(s.length - 2)}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (s) => `'${" ".repeat(s.length - 2)}'`)
    .replace(/\/\/[^\n]*/g, blank);

  // Copy used ONLY for key extraction: strip `//` line comments, keep strings.
  // (The deploy configs put `//` only at line-start or inside URL values — never
  // as a trailing inline comment in the residency block — so blanking every
  // `//`-to-EOL run also blanks the `//` in a URL, which is harmless here
  // because keys are matched by the `"<id>": {` shape, never by URL content.)
  const commentless = src.replace(/\/\/[^\n]*/g, blank);

  const residencyIdx = braceScan.indexOf("residency:");
  if (residencyIdx === -1) throw new Error(`No 'residency:' block in ${filePath}`);

  const regionsIdx = braceScan.indexOf("regions:", residencyIdx);
  if (regionsIdx === -1) throw new Error(`No 'regions:' in residency block of ${filePath}`);

  // Brace-match (over `braceScan`) from the first `{` after `regions:` to its
  // close so we only scan the regions object body.
  const open = braceScan.indexOf("{", regionsIdx);
  if (open === -1) throw new Error(`No '{' after 'regions:' in ${filePath}`);
  let depth = 0;
  let end = -1;
  for (let i = open; i < braceScan.length; i++) {
    const ch = braceScan[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`Unbalanced braces in regions object of ${filePath}`);
  // Slice the SAME [open+1, end] range from the keys copy (identical offsets).
  const regionsBody = commentless.slice(open + 1, end);

  // Spread guard: a spread (`...someRegions`) injects regions with no quoted key,
  // so the quoted-vs-object count check below can't see it. Refuse to validate a
  // regions map that uses a spread — a spread could pull `staging` back in
  // invisibly. The deploy configs declare every region inline; this fails loudly
  // if that ever changes rather than silently under-reporting the region set.
  if (/\.\.\./.test(regionsBody)) {
    throw new Error(
      `Spread operator in residency.regions of ${filePath} — this parser only ` +
        `validates inline "<id>": { … } entries and cannot see regions pulled in ` +
        `via a spread, which could hide a region from the residency assertion.`,
    );
  }

  // Object-valued region entries: a quoted slug key immediately followed by `{`.
  const objectKeys: string[] = [];
  const objectRe = /["']([a-z0-9_-]+)["']\s*:\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = objectRe.exec(regionsBody)) !== null) {
    objectKeys.push(m[1]);
  }

  // Every quoted slug key directly under `regions`, regardless of value shape.
  // If a future re-add uses a non-inline value (a referenced const or a
  // spread), `quotedKeys` would exceed `objectKeys` — fail loudly rather than
  // let the divergent entry slip the assertion below. Match quoted keys only at
  // the start of an indented line so nested object keys (label/databaseUrl/
  // apiUrl, none of which are quoted anyway) can't inflate the count.
  const quotedKeys: string[] = [];
  const keyRe = /(?:^|\n)\s*["']([a-z0-9_-]+)["']\s*:/gi;
  while ((m = keyRe.exec(regionsBody)) !== null) {
    quotedKeys.push(m[1]);
  }
  if (quotedKeys.length !== objectKeys.length) {
    throw new Error(
      `Quoted-key vs object-value mismatch in residency.regions of ${filePath} ` +
        `(quoted keys [${quotedKeys.join(", ")}] vs object-valued ` +
        `[${objectKeys.join(", ")}]). Likely a region with a non-object value ` +
        `(e.g. "<id>": someConst) — this parser only validates inline ` +
        `"<id>": { … } entries, so such a region could hide from the residency ` +
        `assertion. (A line-leading quoted key NESTED inside a region's value ` +
        `object would also trip this — region values use unquoted keys today.)`,
    );
  }

  return objectKeys;
}

describe("deploy config residency regions (#3948)", () => {
  it("prod config offers exactly us/eu/apac — never staging", () => {
    const keys = extractResidencyRegionKeys(PROD_CONFIG);
    expect(keys.toSorted()).toEqual(["apac", "eu", "us"]);
    // The load-bearing assertion: staging must never be a selectable prod
    // residency region. A future edit re-adding it fails here.
    expect(keys).not.toContain("staging");
  });

  it("staging config keeps the single staging region (scoped to the staging deploy)", () => {
    const keys = extractResidencyRegionKeys(STAGING_CONFIG);
    expect(keys).toEqual(["staging"]);
  });
});
