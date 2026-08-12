/**
 * check-brain-settings-doc.ts — hold the Company Atlas env-var reference to
 * the settings registry it describes (#5161).
 *
 * WHY THIS EXISTS, AND WHY IT CHECKS A PREDICATE RATHER THAN A COUNT.
 *
 * The reference page asserts of its whole table: "All eleven are hidden from
 * the generic settings page on Atlas Cloud, so a workspace admin cannot read
 * or write any of them." That was true of the NINE keys the table listed when
 * it was written. #5159 added two more rows and incremented the number to
 * eleven — correctly — but the two new keys did not carry `saasVisible: false`,
 * so the sentence became false of its own enlarged subject while its count
 * stayed right. A guard that compared row-count to registry-count would have
 * passed that change unchanged, which is exactly the drift this file refuses.
 *
 * So the check is: for every variable named in the Company Atlas table, ask
 * the registry what it actually resolves to, and fail if the page's universal
 * claim does not hold of it. It also checks the stated count and the
 * workspace-scoped subset, because those are cheap once the table is parsed —
 * but the visibility predicate is the one that matters.
 *
 * Run locally: bun scripts/check-brain-settings-doc.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getSettingsRegistry } from "../packages/api/src/lib/settings";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "apps/docs/content/shared/reference/environment-variables.mdx");
/** The section whose prose makes the claim. Renaming it here is a deliberate act. */
const SECTION_HEADING = "## Company Atlas";

const failures: string[] = [];

const doc = readFileSync(DOC, "utf8");

// The section runs from its heading to the next `## ` heading (or EOF).
const sectionStart = doc.indexOf(SECTION_HEADING);
if (sectionStart === -1) {
  console.error(`FAIL: no "${SECTION_HEADING}" section in ${DOC}`);
  console.error("      If the section was renamed, update SECTION_HEADING — do not delete this gate.");
  process.exit(1);
}
const afterHeading = doc.slice(sectionStart + SECTION_HEADING.length);
const nextHeading = afterHeading.search(/\n## /);
const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

// Table rows look like: | `ATLAS_BRAIN_FOO` | `7` | description |
const documented = [...section.matchAll(/^\|\s*`(ATLAS_[A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

if (documented.length === 0) {
  console.error(`FAIL: parsed zero variable rows out of the "${SECTION_HEADING}" table.`);
  console.error("      The table shape changed and this gate went blind — fix the parser, not the page.");
  process.exit(1);
}

const byKey = new Map(getSettingsRegistry().map((s) => [s.key, s]));

// ---------------------------------------------------------------------------
// 1. The claim that broke: every documented key is hidden on Atlas Cloud.
// ---------------------------------------------------------------------------
for (const key of documented) {
  const def = byKey.get(key);
  if (!def) {
    failures.push(`${key} is documented in "${SECTION_HEADING}" but is not in the settings registry.`);
    continue;
  }
  // `saasVisible` DEFAULTS TO TRUE, so an omitted field is a visible key —
  // which is how both alias keys shipped visible without anyone writing
  // `saasVisible: true` anywhere. Compare against the resolved value.
  if (def.saasVisible !== false) {
    failures.push(
      `${key} resolves saasVisible=${String(def.saasVisible ?? true)}, but the page claims every ` +
        `variable in this table is hidden from the generic settings page on Atlas Cloud. ` +
        `Either add \`saasVisible: false\` to its definition, or change the prose to stop ` +
        `claiming it of the whole table.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. The stated count, and the workspace-scoped subset the same sentence names.
// ---------------------------------------------------------------------------
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
const toCount = (word: string): number | undefined => NUMBER_WORDS[word.toLowerCase()];

const claimedTotal = section.match(/All (\w+) are hidden from the generic settings page/);
if (!claimedTotal) {
  failures.push(
    `The "all N are hidden" sentence is gone from "${SECTION_HEADING}". If the claim was ` +
      `deliberately dropped, delete check 2 here; if it was reworded, update the pattern.`,
  );
} else {
  const stated = toCount(claimedTotal[1]);
  if (stated === undefined) {
    failures.push(`Could not read "${claimedTotal[1]}" as a number word in the hidden-count sentence.`);
  } else if (stated !== documented.length) {
    failures.push(
      `The page says "All ${claimedTotal[1]} are hidden" but the table lists ${documented.length} variables.`,
    );
  }
}

const claimedWorkspace = section.match(/(\w+) are \*\*workspace-scoped\*\*/);
const actualWorkspace = documented.filter((k) => byKey.get(k)?.scope === "workspace");
if (claimedWorkspace) {
  const stated = toCount(claimedWorkspace[1]);
  if (stated !== undefined && stated !== actualWorkspace.length) {
    failures.push(
      `The page says "${claimedWorkspace[1]} are workspace-scoped" but ${actualWorkspace.length} of the ` +
        `documented keys carry scope: "workspace" (${actualWorkspace.join(", ")}).`,
    );
  }
}

if (failures.length > 0) {
  console.error(`:: Company Atlas env-var reference is out of sync with the settings registry\n`);
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error(`\n${failures.length} problem(s). Page: ${DOC}`);
  process.exit(1);
}

console.log(
  `Brain settings doc check passed — ${documented.length} documented variables, all hidden on Atlas Cloud, ` +
    `${actualWorkspace.length} workspace-scoped.`,
);
