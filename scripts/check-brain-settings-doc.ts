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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getSettingsRegistry } from "../packages/api/src/lib/settings";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "apps/docs/content/shared/reference/environment-variables.mdx");
/** The section whose prose makes the claim. Renaming it here is a deliberate act. */
const SECTION_HEADING = "## Company Atlas";
/**
 * The registry namespace this page documents. Both locators in this file — the
 * heading above and this prefix — select a whole check's subject, so both carry
 * a vacuity floor: matching nothing must fail, never pass quietly.
 */
const BRAIN_KEY_PREFIX = "ATLAS_BRAIN_";

const failures: string[] = [];

/** Every `.mdx` under `dir`, recursively — check 4's scan surface. */
function listMdx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMdx(full));
    else if (entry.name.endsWith(".mdx")) out.push(full);
  }
  return out;
}

const doc = readFileSync(DOC, "utf8");

// The section runs from its heading to the next `## ` heading (or EOF).
//
// ⚠️ LINE-ANCHORED, not `indexOf`. A substring search matches the PREFIX of a
// longer heading, so renaming the section to "## Company Atlas Settings" left
// the guard happily parsing it — caught by this file's own fixture suite, which
// is the reason that suite exists. The `m` flag plus `$` makes the heading match
// the whole line or nothing.
const headingRe = new RegExp(`^${SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
const headingMatch = headingRe.exec(doc);
if (!headingMatch) {
  console.error(`FAIL: no "${SECTION_HEADING}" section in ${DOC}`);
  console.error("      If the section was renamed, update SECTION_HEADING — do not delete this gate.");
  process.exit(1);
}
const afterHeading = doc.slice(headingMatch.index + SECTION_HEADING.length);
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
  // BOTH halves of "cannot read OR WRITE". The two axes are independently
  // settable — this registry already ships keys with `saasVisible: false,
  // saasWritable: true` (managed by a dedicated admin page), so a brain key
  // taking that split would satisfy the read check while the sentence's second
  // half is false. `admin.ts`'s PUT/DELETE resolve exactly this expression.
  const writable = def.saasWritable ?? def.saasVisible ?? true;
  if (writable !== false) {
    failures.push(
      `${key} resolves saasWritable=${String(writable)} (saasWritable ?? saasVisible ?? true), but ` +
        `the page claims a workspace admin cannot read OR WRITE any variable in this table. ` +
        `A dedicated-admin-page split (saasVisible: false, saasWritable: true) is legitimate ` +
        `elsewhere in the registry but contradicts this page's sentence.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1b. The other direction: a registry key that never reached the table.
// ---------------------------------------------------------------------------
// Every check above is driven by `documented`, so a NEW brain key added to the
// registry with `saasVisible` omitted and no doc row is invisible to all of
// them — visible and writable on Cloud, with this gate green. That is #5161
// exactly, one level over, which is why the closure is checked rather than
// assumed.
const documentedSet = new Set(documented);
const registryBrainKeys = getSettingsRegistry().filter((d) => d.key.startsWith(BRAIN_KEY_PREFIX));

// ⚠️ ITS OWN VACUITY FLOOR, for the same reason the row parser has one — and
// this one was caught by a fix-vs-finding pass on the commit that added the
// loop below, which is the point of running that check on your own fixes.
// `BRAIN_KEY_PREFIX` is a hardcoded locator selecting this check's ENTIRE
// subject, exactly as `indexOf(SECTION_HEADING)` was before it was anchored. A
// namespace rename in the registry — live pressure here, since ADR-0038 renamed
// the product noun and keeps `ATLAS_BRAIN_*` only deliberately — empties the
// selector, and the loop would then measure nothing and pass.
//
// Zero can never be the true answer: the page's own sentence asserts eleven
// variables, and every one of them carries this prefix.
if (registryBrainKeys.length === 0) {
  console.error(`FAIL: no settings-registry keys start with "${BRAIN_KEY_PREFIX}".`);
  console.error(
    "      The registry namespace moved and this gate went blind — update BRAIN_KEY_PREFIX, do not delete this check.",
  );
  process.exit(1);
}

for (const def of registryBrainKeys) {
  if (documentedSet.has(def.key)) continue;
  failures.push(
    `${def.key} is in the settings registry but has no row in the "${SECTION_HEADING}" table. ` +
      `Add it (and give it \`saasVisible: false\` unless it is deliberately Cloud-writable), or ` +
      `move it out of the ${BRAIN_KEY_PREFIX} namespace if it is not a Company Atlas knob.`,
  );
}

// ---------------------------------------------------------------------------
// 2. The stated count, and the workspace-scoped subset the same sentence names.
// ---------------------------------------------------------------------------
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
// Digits too: "3 are workspace-scoped" is a legitimate reword, and a matcher
// that only knows number WORDS goes silently blind on it rather than failing.
const toCount = (word: string): number | undefined => {
  const asWord = NUMBER_WORDS[word.toLowerCase()];
  if (asWord !== undefined) return asWord;
  return /^\d+$/.test(word) ? Number(word) : undefined;
};

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

// ⚠️ MIRRORS CHECK 2's TWO FAILURE PUSHES EXACTLY, and the asymmetry that used
// to be here is why: `if (match) { if (stated !== undefined && …) }` passes
// green on BOTH a reworded sentence and a numeral. Review falsified it — "Three
// of them are **workspace-scoped**" and "3 are **workspace-scoped**" each
// disabled this check at exit 0 with no output, while the identical shapes in
// check 2 fail loudly. A matcher that silently matches nothing is the
// gate-went-blind class this file's header claims to refuse.
const claimedWorkspace = section.match(/(\w+) are \*\*workspace-scoped\*\*/);
const actualWorkspace = documented.filter((k) => byKey.get(k)?.scope === "workspace");
if (!claimedWorkspace) {
  failures.push(
    `The "N are **workspace-scoped**" sentence is gone from "${SECTION_HEADING}". Reworded? ` +
      `Update the pattern. Deliberately dropped? Delete check 3 — do not leave a matcher that ` +
      `matches nothing and reports success.`,
  );
} else {
  const stated = toCount(claimedWorkspace[1]);
  if (stated === undefined) {
    failures.push(
      `Could not read "${claimedWorkspace[1]}" as a count in the workspace-scoped sentence. ` +
        `Reword it so the count is a number word or digits immediately before "are ` +
        `**workspace-scoped**", or update the pattern.`,
    );
  } else if (stated !== actualWorkspace.length) {
    failures.push(
      `The page says "${claimedWorkspace[1]} are workspace-scoped" but ${actualWorkspace.length} of the ` +
        `documented keys carry scope: "workspace" (${actualWorkspace.join(", ")}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Defaults RESTATED IN PROSE elsewhere in the docs (#5158).
// ---------------------------------------------------------------------------
// Checks 1-3 hold the reference table to the registry. They do not see a GUIDE
// that repeats a default in a sentence — `guides/brain-vocabulary.mdx` says the
// auto-approve knobs "ship as `warehouse_key`" and "ship as `1`" — and that
// restatement is what a reader acts on, since nobody consults a reference table
// to learn what the shipped behaviour is. A default changed in the registry
// updates the table through check 1 and leaves the guide asserting the old
// value, with every gate green.
//
// The matcher is deliberately narrow: a backticked ATLAS_BRAIN_ key, then
// "ships as", then the first backticked token on the same line. It is a
// CONCEPT matcher only in that it accepts any key and any value — the phrase is
// pinned, because a phrase-free version would have to guess which of a
// sentence's backticks is the default and would answer wrongly rather than not
// at all.
//
// ⚠️ The spans are `[^`\n]` and NOT `[^\n]`, so a match cannot cross another
// backticked token. With `[^\n]` the sentence "`KEY_A` is unrelated to `KEY_B`,
// which ships as `1`" binds KEY_A to KEY_B's value, and `matchAll`'s lastIndex
// then skips past the real pair — a MISPAIRING that reads as a confident
// finding about the wrong key, and goes silent whenever the two defaults agree.
const PROSE_DEFAULT_RE = /`(ATLAS_BRAIN_[A-Z0-9_]+)`[^`\n]*?\bships as\b[^`\n]*?`([^`\n]+)`/g;
const proseClaims: { file: string; key: string; claimed: string }[] = [];
for (const rel of listMdx(join(ROOT, "apps/docs/content"))) {
  const text = readFileSync(rel, "utf8");
  for (const m of text.matchAll(PROSE_DEFAULT_RE)) {
    proseClaims.push({ file: rel, key: m[1], claimed: m[2] });
  }
}

// ⚠️ THE CLOSURE, not an aggregate floor — check 1b's lesson applied to check 4.
//
// The first cut asked only `proseClaims.length === 0`, which detects TOTAL
// blindness and nothing finer. With two claims live, rewording ONE of them
// ("whose shipped value is `1`") leaves the other matching, the floor silent,
// and that claim unguarded forever — the exact drift this check exists to
// catch, reproduced inside the check. Caught by a fix-vs-finding pass on the
// commit that added it, which is the second time that pass has found an
// assumed closure in this file.
//
// So the expected claims are ENUMERATED. A guide that stops restating a default
// must be removed from this list deliberately, which is a reviewable act;
// silence is not.
const EXPECTED_PROSE_CLAIMS: readonly { readonly file: string; readonly key: string }[] = [
  {
    file: "apps/docs/content/shared/guides/brain-vocabulary.mdx",
    key: "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES",
  },
  {
    file: "apps/docs/content/shared/guides/brain-vocabulary.mdx",
    key: "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD",
  },
];

for (const expected of EXPECTED_PROSE_CLAIMS) {
  const found = proseClaims.some(
    (c) => c.key === expected.key && c.file === join(ROOT, expected.file),
  );
  if (!found) {
    console.error(
      `FAIL: ${expected.file} no longer carries a "\`${expected.key}\` … ships as \`value\`" sentence.`,
    );
    console.error(
      "      Either the phrasing drifted (update PROSE_DEFAULT_RE) or the claim was removed on purpose",
    );
    console.error(
      "      (drop its entry from EXPECTED_PROSE_CLAIMS). Do NOT leave the claim unmatched and unchecked.",
    );
    process.exit(1);
  }
}

for (const { file, key, claimed } of proseClaims) {
  const def = byKey.get(key);
  if (!def) {
    failures.push(`${file} states a shipped default for ${key}, which is not in the settings registry.`);
    continue;
  }
  if (def.default !== claimed) {
    failures.push(
      `${file} says ${key} ships as \`${claimed}\`, but the registry default is \`${String(def.default)}\`. ` +
        `A guide's restatement is what a reader acts on — update the prose, or change the registry deliberately.`,
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
