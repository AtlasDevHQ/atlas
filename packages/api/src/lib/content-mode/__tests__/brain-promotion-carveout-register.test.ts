/**
 * `docs/development/content-mode.md` is the REGISTER a `brain_facts` promotion
 * carve-out has to appear in — and nothing checked that it did (#4939).
 *
 * `.claude/rules/content-mode.md` says a carve-out "needs a recorded rationale
 * (migration comment + the content-mode doc)". #4915 duly recorded its
 * rationale — in `lib/brain/correction.ts`'s header, in the guard's own
 * `ALLOWLIST` comment, and in the guard's failure text — and not in the doc the
 * rule names. The doc meanwhile went on asserting the two things that had just
 * stopped being true: that there was exactly *one* carve-out, and that the gate
 * covered *both* columns when #4912 had made it three. A reader following the
 * rule to the register was misinformed by it.
 *
 * So the register is checked against the guard SCRIPT, which is the enforcement
 * and therefore the only honest source:
 *
 *   1. every allowlisted file is NAMED in the doc;
 *   2. every gated COLUMN is named in the doc;
 *   3. every "N carve-out(s)" claim in the doc counts the same N the allowlist
 *      does.
 *
 * (3) is the one that catches the sentence that actually shipped. (1) alone
 * would go green on a doc that mentioned `correction.ts` in passing while still
 * opening with "the one carve-out is the region import" — which is roughly the
 * state a hurried fix lands in.
 *
 * Deliberately parsed out of the script rather than restated here. A copy of
 * the allowlist in this file would drift in exactly the direction the doc did,
 * and the failure would then be a test agreeing with a stale test.
 *
 * What this does NOT prove: that the recorded rationale is any good. It is a
 * presence-and-arithmetic guard. The argument itself is prose a human reviews.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
const GUARD = join(REPO, "scripts", "check-brain-fact-promotion.sh");
const DOC = join(REPO, "docs", "development", "content-mode.md");

const guardSource = readFileSync(GUARD, "utf8");
const doc = readFileSync(DOC, "utf8");

/**
 * The `ALLOWLIST=( … )` entries, in the script's own spelling.
 *
 * Throws rather than returning `[]` on a shape change: an empty list would make
 * every assertion below vacuous, which is the failure mode a guard that reads
 * another file exists to avoid.
 */
function allowlistEntries(): string[] {
  const block = /^ALLOWLIST=\(\n([\s\S]*?)^\)/m.exec(guardSource);
  if (!block) {
    throw new Error(
      "check-brain-fact-promotion.sh no longer declares `ALLOWLIST=(` … `)` at the start of a line — re-point this parse, or every assertion below passes vacuously",
    );
  }
  const entries = [...block[1].matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (entries.length === 0) {
    throw new Error("check-brain-fact-promotion.sh's ALLOWLIST parsed to zero entries");
  }
  return entries;
}

/**
 * The column names the UPDATE arm gates.
 *
 * The script writes them as regex alternations with an OPTIONAL prefix group
 * (`(pre_widening_)?visible_to`), so expanding that group is what turns the
 * three alternations into the four real column names. Without the expansion
 * `pre_widening_visible_to` — the column whose corruption is silent in both
 * directions — would never be required of the doc.
 *
 * ⚠️ `UPDATE_GATED_COLUMNS` is the guard's DECLARED vocabulary, not the thing
 * that runs: `statement_writes_gated_column` matches with inline `grep -qiE`
 * patterns instead. Reading the declaration is right for a DOC guard — the doc
 * documents the vocabulary — but it means the declaration could drift from the
 * enforcement and this test would keep checking the stale list. So the
 * declaration is separately cross-checked against the enforcing patterns
 * below.
 */
function gatedColumns(): string[] {
  const names = new Set<string>();
  // The SQL spellings only. The doc is written in raw column names, and the
  // ORM twin (`ORM_UPDATE_GATED_COLUMNS`) carries the same columns in
  // camelCase — requiring those too would force `visibleTo` into English prose
  // to satisfy a guard, which is a test dictating style rather than coverage.
  const decl = /^UPDATE_GATED_COLUMNS='\(([^']+)\)'/m.exec(guardSource);
  if (!decl) {
    throw new Error(
      "check-brain-fact-promotion.sh no longer declares UPDATE_GATED_COLUMNS='(…)' — re-point this parse",
    );
  }
  for (const alternative of decl[1].split("|")) {
    const optional = /^\(([a-zA-Z_]+)\)\?(.+)$/.exec(alternative);
    if (optional) {
      names.add(optional[2]);
      names.add(optional[1] + optional[2]);
    } else {
      names.add(alternative);
    }
  }
  return [...names];
}

/**
 * The doc section that documents this gate — `## The fact class …` up to the
 * next `## `.
 *
 * EVERY assertion is scoped to it, and the scoping is the guard rather than a
 * tidiness choice. Two independent reasons, and the first is a false pass this
 * test actually had:
 *
 * 1. A doc-wide file-name check is satisfied by any mention ANYWHERE. This doc
 *    is long and names source paths in unrelated sections (semantic-improve
 *    names `lib/semantic/expert/apply.ts`), so allowlisting a path the doc
 *    happens to mention elsewhere passed while the register itself said
 *    nothing about it — and the count could then be repaired by editing one
 *    number word, with no bullet and no rationale. That is the exact defect
 *    #4939 was filed for, wearing a green guard.
 * 2. "Carve-out" is a word this doc uses for TWO different things: a table
 *    that bypasses content mode at all (`/use-demo`, semantic-improve) and a
 *    second writer on the promotion guard's allowlist. Only the second is what
 *    the allowlist counts.
 */
function factClassSection(): string {
  const start = /^## The fact class\b.*$/m.exec(doc);
  if (!start || start.index === undefined) {
    throw new Error(
      `${DOC} no longer has a "## The fact class" heading — re-point this scope, or the count assertion covers the wrong prose`,
    );
  }
  const rest = doc.slice(start.index + start[0].length);
  const end = /^## /m.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;
  if (!section.includes("check-brain-fact-promotion.sh")) {
    throw new Error(
      `${DOC}'s "## The fact class" section no longer mentions check-brain-fact-promotion.sh — the gate moved sections, so this scope is now the wrong prose`,
    );
  }
  return section;
}

/**
 * An allowlist entry is a CARVE-OUT unless it is the promotion path itself.
 *
 * Structural, not a name list: `lib/content-mode/adapters/` is where
 * `promoteBrainFacts` lives, and an adapter writing `status` is the rule rather
 * than an exception to it. Everything else on the allowlist is a second writer
 * that had to argue its way on.
 */
const isCarveOut = (entry: string): boolean => !entry.includes("lib/content-mode/adapters/");

/** The `create-atlas/templates/*` mirrors are the same files, listed twice. */
const isCanonical = (entry: string): boolean => entry.startsWith("packages/api/");

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

describe("the brain-fact promotion carve-out register (#4939)", () => {
  it("names every allowlisted file, so following the rule to the doc finds the carve-out", () => {
    const canonical = allowlistEntries().filter(isCanonical);
    // The mirrors make the list longer than the set of real files; if the
    // canonical half ever empties, the loop below would assert nothing.
    expect(
      canonical.length,
      "no ALLOWLIST entry is under `packages/api/` — the entry-shape assumption behind this guard changed",
    ).toBeGreaterThan(0);

    const section = factClassSection();
    for (const entry of canonical) {
      // The path relative to `packages/api/src/`, which is how the doc refers
      // to a source file. Matched as a SUFFIX so the doc may write
      // `lib/brain/correction.ts` or the full path and satisfy this either way.
      const relative = entry.replace(/^packages\/api\/src\//, "");
      expect(
        section.includes(relative),
        `${DOC}'s fact-class section never names \`${relative}\`, which is on ` +
          "check-brain-fact-promotion.sh's ALLOWLIST. `.claude/rules/content-mode.md` points a reader at that " +
          "section as the register a carve-out is recorded in, so an unlisted writer is one nobody following " +
          "the rule can discover. A mention elsewhere in this doc does not count — it is not where the reader " +
          "was sent.",
      ).toBe(true);
    }
  });

  it("names every gated column, so a doc reader learns which writes are refused", () => {
    const section = factClassSection();
    for (const column of gatedColumns()) {
      // Backtick-delimited, in the gate's own section. A bare `includes` over
      // the whole doc was two-thirds vacuous: `status` appears dozens of times
      // in a content-mode doc as an ordinary English word, and `visible_to` is
      // satisfied by any mention of `pre_widening_visible_to`. Requiring the
      // column as CODE in the section that documents the gate is the claim
      // this test means to make.
      expect(
        section.includes(`\`${column}\``),
        `${DOC}'s fact-class section never names \`${column}\` as a gated column (in backticks). The guard ` +
          "refuses writes to it outside the allowlist; a doc that lists only some of the gated columns " +
          "understates the gate.",
      ).toBe(true);
    }
  });

  // The declared vocabulary this file reads is not the code that runs — the
  // gate matches with inline patterns inside `statement_writes_gated_column`.
  // A declaration that drifted from the enforcement would make BOTH this
  // guard's column assertion and the doc it checks describe a gate that no
  // longer exists, quietly. Discovered while mutation-testing the arm above:
  // deleting `(pre_widening_)?` from the DECLARATION changed nothing at all.
  it("enforces every gated column it declares", () => {
    // One direction only — `declared ⊆ enforced` — and the name says so. A
    // column enforced by an arm but absent from the declaration passes here;
    // that direction is the harmless one (the gate is stricter than its
    // documentation), and the adversarial fixture suite covers behaviour
    // either way. What this catches is the dangerous direction: a declaration,
    // and the doc built from it, describing a gate that no longer applies.
    //
    // The scan is from the function's start to EOF rather than to its closing
    // brace, so it also sees the helpers below it. That is deliberately loose
    // in the safe direction: it can only ever find MORE enforcement, never
    // less, so a column it reports as enforced really is matched somewhere the
    // gate runs.
    const body = guardSource.slice(guardSource.indexOf("statement_writes_gated_column()"));
    expect(
      body.length,
      "check-brain-fact-promotion.sh no longer defines statement_writes_gated_column() — re-point this cross-check",
    ).toBeGreaterThan(0);

    // The arms spell a column the same way the declaration does — `\b`-bounded,
    // with the same optional prefix group — so the enforced set is read with
    // the same expansion the declared set gets, and the two are compared as
    // SETS rather than by substring.
    const enforced = new Set<string>();
    for (const [, prefix, name] of body.matchAll(
      /\\b(?:\(([a-z_]+)\)\?)?([a-z][a-z_]*)\\b/g,
    ) as Iterable<RegExpMatchArray>) {
      enforced.add(name!);
      if (prefix) enforced.add(prefix + name!);
    }

    for (const column of gatedColumns()) {
      expect(
        enforced.has(column),
        `check-brain-fact-promotion.sh declares \`${column}\` in UPDATE_GATED_COLUMNS but nothing from ` +
          "statement_writes_gated_column() onward matches it. The declaration is documentation; the inline " +
          "patterns are the gate. A column that is declared and not enforced is a gate everyone believes in " +
          "and nothing applies.",
      ).toBe(true);
    }
  });

  it("counts carve-outs the same way the allowlist does", () => {
    const expected = allowlistEntries().filter(isCanonical).filter(isCarveOut).length;
    // Every "<number word> carve-out(s)" claim in the gate's own section. At
    // most one intervening word, so "two carve-outs, both recorded here" and
    // "the one carve-out is the region import" both match while an unrelated
    // number earlier in the sentence does not.
    const claims = [
      ...factClassSection().matchAll(
        /\b(one|two|three|four|five|six)\s+(?:[a-z]+\s+)?carve-outs?\b/gi,
      ),
    ];
    expect(
      claims.length,
      `${DOC}'s fact-class section makes no counted claim about carve-outs at all. State the number — the ` +
        'sentence that shipped ("The one carve-out is the region import") was wrong precisely because it ' +
        "counted, and dropping the count rather than fixing it would leave this guard with nothing to check.",
    ).toBeGreaterThan(0);

    for (const claim of claims) {
      const stated = NUMBER_WORDS[claim[1].toLowerCase()];
      expect(
        stated,
        `${DOC} says "${claim[0].trim()}", but check-brain-fact-promotion.sh's ALLOWLIST carries ${expected} ` +
          "carve-out(s) beyond the promotion adapter itself. Update the doc, or drop the carve-out.",
      ).toBe(expected);
    }

    // …and the number has to be backed by an ENUMERATION, so the doc cannot be
    // repaired by editing one word. The bullet list under the counted claim is
    // where each carve-out states which writer it trusts and why; a count that
    // outran its list would leave the new writer named nowhere a reader looks.
    const enumerated = factClassSection()
      .slice(claims[0]!.index)
      .split(/\n\s*\n/)
      .flatMap((block) => [...block.matchAll(/^- \*\*/gm)]).length;
    expect(
      enumerated,
      `${DOC}'s fact-class section counts ${expected} carve-out(s) but lists ${enumerated}. Bumping the ` +
        "number without adding the bullet is how this register drifted in the first place — every carve-out " +
        "has to state which file it trusts and why.",
    ).toBe(expected);
  });
});
