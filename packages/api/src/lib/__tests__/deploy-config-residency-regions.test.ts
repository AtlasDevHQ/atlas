/**
 * Regression: the production deploy config must keep "staging" as a configured
 * residency region (so the api-staging soak service can boot) BUT must flag it
 * non-selectable so it never appears in the signup data-residency picker (#3948).
 *
 * Background — why "staging" lives in this map at all. The api-staging soak
 * service builds from the SAME image/config as prod
 * (`RAILWAY_DOCKERFILE_PATH=deploy/api/Dockerfile`, which COPYs
 * `deploy/api/atlas.config.ts`) and claims `ATLAS_API_REGION=staging`.
 * `RegionGuardLive` (lib/effect/saas-guards.ts) fail-closes boot if the claimed
 * region is absent from `residency.regions`, so the `staging` arm is
 * load-bearing for the staging service's boot. Deleting it crash-loops
 * api-staging ("Layer DAG could not initialize") — which is exactly what
 * happened (#3948 → PR #3951 → staging crash loop).
 *
 * The bug #3948 was actually about: the onboarding `/regions` endpoint returned
 * `getConfiguredRegions()` verbatim, so the signup picker (`/signup/region`)
 * offered "Staging" as a selectable residency region to real production users —
 * who could route workspace metadata to the staging Postgres. The fix is
 * `selectable: false` on the staging arm + a picker filter (see
 * `lib/residency/picker.ts` + its test), NOT removing the region. Existence ≠
 * selectability.
 *
 * Why parse the source rather than import the config: the deploy config uses
 * container-root-relative imports (`./packages/api/src/lib/config`) that only
 * resolve from `/app/` inside the SaaS image, so it cannot be `import()`-ed
 * from a unit test. We extract the `residency.regions` shape from the source
 * text instead — comments are stripped first so prose mentioning "staging" (the
 * load-bearing tombstone comment) never counts as a region entry.
 *
 * Invariant pinned:
 *   - prod  (`deploy/api/atlas.config.ts`):  regions == { us, eu, apac, staging },
 *       and EXACTLY the staging arm carries `selectable: false` (us/eu/apac stay
 *       selectable).
 *
 * There is no separate staging config to pin: the half-built
 * `deploy/api-staging/atlas.config.ts` was retired in #3958 in favour of the
 * shared-config-+-env-vars model — api-staging builds from THIS file and claims
 * `ATLAS_API_REGION=staging`, so the one `staging` arm here is its sole region
 * declaration. The api-eu / api-apac Railway services likewise reuse
 * `deploy/api/atlas.config.ts` (only their `railway.json` differs), so this one
 * prod assertion covers all three production regions plus the staging soak
 * service.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const PROD_CONFIG = resolve(REPO_ROOT, "deploy/api/atlas.config.ts");

interface ParsedRegions {
  /** Region-id keys declared inline under `residency.regions`. */
  keys: string[];
  /** The `residency.regions { … }` body with `//` comments stripped (strings kept). */
  body: string;
  /** Same body, but string interiors AND comments blanked — used for brace matching. */
  braceBody: string;
}

const blank = (s: string) => " ".repeat(s.length);

/**
 * Parse the `residency.regions { … }` object out of a deploy config source file.
 * See the inline notes on `braceScan` vs `commentless` — two offset-preserving
 * copies so a single `[open, end]` range slices both. A region entry is a quoted
 * key whose value is an object literal (`"<id>": {`). The scan is brace-bounded
 * to the `regions` object so unrelated later config can never leak in, never
 * fooled by `//` inside a URL, `{`/`}` inside a string, or a quoted slug in
 * comment prose.
 */
function parseResidencyRegions(filePath: string): ParsedRegions {
  const src = readFileSync(filePath, "utf8");

  // Brace-matching copy: blank string interiors (keep quotes so offsets + the
  // `""` shape survive) and `//` line comments.
  const braceScan = src
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => `"${" ".repeat(s.length - 2)}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (s) => `'${" ".repeat(s.length - 2)}'`)
    .replace(/\/\/[^\n]*/g, blank);

  // Key/content copy: strip `//` line comments, keep strings.
  const commentless = src.replace(/\/\/[^\n]*/g, blank);

  const residencyIdx = braceScan.indexOf("residency:");
  if (residencyIdx === -1) throw new Error(`No 'residency:' block in ${filePath}`);
  const regionsIdx = braceScan.indexOf("regions:", residencyIdx);
  if (regionsIdx === -1) throw new Error(`No 'regions:' in residency block of ${filePath}`);

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

  const body = commentless.slice(open + 1, end);
  const braceBody = braceScan.slice(open + 1, end);

  // Spread guard: a spread (`...someRegions`) injects regions with no quoted key
  // and could hide a region (e.g. staging) from these assertions. The deploy
  // configs declare every region inline; fail loudly if that ever changes.
  if (/\.\.\./.test(body)) {
    throw new Error(
      `Spread operator in residency.regions of ${filePath} — this parser only ` +
        `validates inline "<id>": { … } entries and cannot see spread-in regions.`,
    );
  }

  // Object-valued region entries: a quoted slug key immediately followed by `{`.
  const objectKeys: string[] = [];
  const objectRe = /["']([a-z0-9_-]+)["']\s*:\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = objectRe.exec(body)) !== null) objectKeys.push(m[1]);

  // Every line-leading quoted key directly under `regions`, regardless of value
  // shape. If a future re-add uses a referenced const/spread, this would exceed
  // `objectKeys` — fail loudly rather than let a divergent entry slip past.
  const quotedKeys: string[] = [];
  const keyRe = /(?:^|\n)\s*["']([a-z0-9_-]+)["']\s*:/gi;
  while ((m = keyRe.exec(body)) !== null) quotedKeys.push(m[1]);
  if (quotedKeys.length !== objectKeys.length) {
    throw new Error(
      `Quoted-key vs object-value mismatch in residency.regions of ${filePath} ` +
        `(quoted [${quotedKeys.join(", ")}] vs object-valued [${objectKeys.join(", ")}]). ` +
        `A region with a non-object value could hide from the assertions below.`,
    );
  }

  return { keys: objectKeys, body, braceBody };
}

/**
 * Brace-match a single region's object-literal body (`"<id>": { … }`) out of the
 * already-parsed regions block. Brace matching runs over `braceBody` (string
 * interiors blanked) so a `{`/`}` inside a URL value can't throw off the match;
 * the returned slice comes from `body` (real content, comments stripped).
 */
function sliceRegionBody(parsed: ParsedRegions, id: string): string {
  // Locate the key in `body` (keys intact — `braceBody` blanks string interiors,
  // including region-key strings). `body` and `braceBody` are equal-length and
  // offset-aligned (both sliced from same-length transforms of src), so the
  // index found here maps 1:1 into `braceBody` for safe brace counting.
  const keyRe = new RegExp(`["']${id}["']\\s*:\\s*\\{`, "g");
  const km = keyRe.exec(parsed.body);
  if (!km) throw new Error(`Region "${id}" not found in parsed regions block`);
  const open = parsed.body.indexOf("{", km.index);
  let depth = 0;
  let end = -1;
  for (let i = open; i < parsed.braceBody.length; i++) {
    const ch = parsed.braceBody[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`Unbalanced braces in region "${id}"`);
  return parsed.body.slice(open + 1, end);
}

const SELECTABLE_FALSE = /selectable\s*:\s*false/;

describe("deploy config residency regions (#3948)", () => {
  it("prod config keeps us/eu/apac/staging — staging present so api-staging boots", () => {
    const parsed = parseResidencyRegions(PROD_CONFIG);
    expect(parsed.keys.toSorted()).toEqual(["apac", "eu", "staging", "us"]);
    // Load-bearing: staging must stay in the map. Removing it crash-loops the
    // api-staging soak service (RegionGuardLive fail-closes on an unknown
    // claimed region). See #3948 → PR #3951 → the staging crash loop.
    expect(parsed.keys).toContain("staging");
  });

  it("prod config flags ONLY staging non-selectable — us/eu/apac stay selectable (#3948)", () => {
    const parsed = parseResidencyRegions(PROD_CONFIG);

    // The actual #3948 fix: staging exists for boot/routing but is excluded from
    // the signup picker via `selectable: false`.
    expect(sliceRegionBody(parsed, "staging")).toMatch(SELECTABLE_FALSE);

    // Real prod regions must remain selectable — a stray `selectable: false` on
    // us/eu/apac would silently drop a region from the signup picker.
    for (const id of ["us", "eu", "apac"]) {
      expect(sliceRegionBody(parsed, id)).not.toMatch(SELECTABLE_FALSE);
    }

    // Exactly one region in the whole map is non-selectable (staging).
    const count = (parsed.body.match(/selectable\s*:\s*false/g) ?? []).length;
    expect(count).toBe(1);
  });
});
