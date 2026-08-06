/**
 * The mutation list behind `object-cmp.test.ts`'s table (#5060).
 *
 * This file replaces sixteen hand-typed numbers in that suite's docstring. The
 * numbers now come from running the suite; what lives here is only the exact
 * text of each mutation, which is the one thing a human genuinely has to
 * choose.
 *
 * Anchors are deliberately long. An anchor is required to match exactly once,
 * so a short one that later becomes ambiguous ABORTS its row rather than
 * silently mutating whichever site came first.
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCE = "src/lib/brain/object-cmp.ts";

const spec: MutationSpec = {
  title: "Mutations `object-cmp.test.ts` catches",
  out: "scripts/mutations/object-cmp.md",
  targets: [{ name: "object-cmp.test.ts", file: "src/lib/brain/__tests__/object-cmp.test.ts" }],
  preamble: `
Source: \`${SOURCE}\`. Mutation list: \`scripts/mutations/object-cmp.mutations.ts\`.

The load-bearing half of this suite is the REFUSALS — a canonicalizer that
returned the raw surface instead of \`null\` would collapse \`unknown\` to empty
and restore exact-string matching with extra machinery, while every test that
only asserted successful parses stayed green. The raw-surface-collapse row
below is the direct measurement of that.
`,
  mutations: [
    {
      label: "`DECIMAL_RE` loses its anchors (`^…$`)",
      edits: [
        {
          file: SOURCE,
          oldString: "const DECIMAL_RE = /^-?\\d+(?:\\.\\d+)?$/;",
          newString: "const DECIMAL_RE = /-?\\d+(?:\\.\\d+)?/;",
        },
      ],
      note: "Unanchored, `1,499 USD` and `$499` start parsing as numbers — the surface that must stay unknown becomes a value two producers can be stamped against.",
    },
    {
      label:
        '`parseSurface` returns `{tag:"number", payload: trimmed}` for any unmatched surface — the raw-surface collapse',
      edits: [
        {
          file: SOURCE,
          oldString: `  // knows (the entity store, a producer declaration) says otherwise.
  return null;
}`,
          newString: `  // knows (the entity store, a producer declaration) says otherwise.
  return { tag: "number", payload: trimmed };
}`,
        },
      ],
      note: "The mutation the suite exists for: it destroys the abstain band without failing any test that merely asserts a successful parse.",
    },
    {
      label: "`canonicalCurrency` loses its upper-case fold",
      edits: [
        { file: SOURCE, oldString: "  const upper = raw.toUpperCase();", newString: "  const upper = raw;" },
      ],
    },
    {
      label: "`canonicalCurrency` drops the `ISO_4217` membership test (back to any three letters)",
      edits: [
        {
          file: SOURCE,
          oldString: "  return ISO_4217.has(upper) ? upper : null;",
          newString: "  return upper;",
        },
      ],
      note: "Every three-letter unit token (`mos`, `yrs`, `kgs`, `net`, `min`) becomes a currency, and two spellings of one quantity read as provably different.",
    },
    {
      label: "`canonicalInstant` loses its calendar round-trip",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (canonicalDate(`${year}-${month}-${day}`) === null) return null;\n",
          newString: "",
        },
      ],
      note: "`new Date` rolls an impossible calendar day forward rather than refusing it, so `2026-02-31T10:00:00Z` becomes byte-identical to a real neighbouring day.",
    },
    {
      label: "`canonicalDate` loses its calendar round-trip",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (
    stamp.getUTCFullYear() !== Number(year) ||
    stamp.getUTCMonth() !== Number(month) - 1 ||
    stamp.getUTCDate() !== Number(day)
  ) {
    return null;
  }
`,
          newString: "",
        },
      ],
      note: "`Date.UTC` normalizes rather than rejecting — without the round-trip `2026-02-31` and `2026-03-03` compare EQUAL.",
    },
    {
      label: "`canonicalDecimal` loses its trailing-zero trim",
      edits: [
        {
          file: SOURCE,
          oldString: '  const trimmedFraction = fraction.replace(/0+$/, "");',
          newString: "  const trimmedFraction = fraction;",
        },
      ],
    },
    {
      label: "a declaration OVERRIDES the surface instead of narrowing it",
      edits: [
        {
          file: SOURCE,
          oldString: `      return parsed !== null && parsed.tag === declared.kind
        ? tagged(parsed.tag, parsed.payload)
        : null;`,
          newString: `      return parsed !== null
        ? tagged(declared.kind, parsed.payload)
        : null;`,
        },
      ],
      note: "The four payload-free kinds may only ever CONFIRM the surface. Overriding lets a producer declaration re-label a date as a number. The docstring this table replaced carried 3; two independent spellings of the mutation (re-tagging from the declaration, and simply dropping the `parsed.tag === declared.kind` narrowing) both measure 4, so that cell was stale rather than ambiguous.",
    },
    {
      label: "`comparableValueWithReason` collapses `declaration-rejected` into `abstained`",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (declared.kind === "money" && canonicalCurrency(declared.currency) === null) {
    return { value: null, reason: "declaration-rejected" };
  }`,
          newString: `  if (declared.kind === "money" && canonicalCurrency(declared.currency) === null) {
    return { value: null, reason: "abstained" };
  }`,
        },
        {
          file: SOURCE,
          oldString: '  return { value: null, reason: parsed === null ? "abstained" : "declaration-rejected" };',
          newString: '  return { value: null, reason: "abstained" };',
        },
      ],
      note: "Both return sites, because collapsing only one leaves the other still reporting the distinction — which is not what the label says. Measured: both sites 3, the final return alone 2. The docstring this table replaced carried 2 without recording which spelling it meant, and that ambiguity is the whole reason the spelling is now the input rather than a description of it.",
    },
    {
      label: "`MONEY_RE` back to `\\s+` (a newline separates the tokens)",
      edits: [
        {
          file: SOURCE,
          oldString: "const MONEY_RE = /^(\\S+)[ \\t]+(\\S+)$/;",
          newString: "const MONEY_RE = /^(\\S+)\\s+(\\S+)$/;",
        },
      ],
    },
    {
      label: "`canonicalDecimal` loses its `-0` fold",
      edits: [{ file: SOURCE, oldString: '  if (magnitude === "0") return "0";\n', newString: "" }],
    },
    {
      label: "`comparableTag` loses its `boundary === -1` arm (`moneys` reads as `money`)",
      edits: [{ file: SOURCE, oldString: "  if (boundary === -1) return null;\n", newString: "" }],
    },
    {
      label: "`comparableValue` prefers the surface parse over `entityId`",
      edits: [
        {
          file: SOURCE,
          // Re-anchored by #5032: the entity arm moved into `entityComparable`
          // so the SUBJECT position could reach the same spelling of
          // `entity:<id>`. The mutation is unchanged in substance — demote the
          // store below the parser — and is now spelled at the branch that
          // consumes it.
          oldString: "  const resolved = entityComparable(entityId);\n  if (resolved !== null) return { value: resolved, reason: \"resolved\" };",
          newString: "  const resolved = entityComparable(entityId);\n  if (resolved !== null && parseSurface(surface) === null) return { value: resolved, reason: \"resolved\" };",
        },
      ],
      note: "Demotes the entity store below the parser, so a resolved `Enterprise tier` / `Enterprise Plan` pair stops comparing equal the moment either surface happens to parse.",
    },
    {
      label: "`comparableDifferentSql` loses its `split_part` tag equality arm",
      edits: [
        {
          file: SOURCE,
          oldString:
            "      AND split_part(${a}, '${TAG_SEPARATOR}', 1) = split_part(${b}, '${TAG_SEPARATOR}', 1)\n",
          newString: "",
        },
      ],
      note: "Whatever dies here is LEXICAL — the SQL-arms assertion at the bottom of the suite — because `agree` is the TypeScript twin and deleting a SQL arm does not touch it. The behavioural falsifiers live in `identity-consumers-pg.test.ts` and `object-cmp-pg.test.ts`.",
    },
    {
      label: "`comparableDifferentSql` loses its known-tag `IN` arm",
      edits: [
        {
          file: SOURCE,
          oldString: "      AND split_part(${a}, '${TAG_SEPARATOR}', 1) IN (${KNOWN_TAGS_SQL})\n",
          newString: "",
        },
      ],
      note: "Covered behaviourally by `object-cmp-pg.test.ts`'s unknown-tag test, not here.",
    },
    {
      label: "`comparableDifferentSql` loses its `strpos(…) > 0` separator arms",
      edits: [
        {
          file: SOURCE,
          oldString: ` IN (\${KNOWN_TAGS_SQL})
      AND strpos(\${a}, '\${TAG_SEPARATOR}') > 0
      AND strpos(\${b}, '\${TAG_SEPARATOR}') > 0)\`;`,
          newString: ` IN (\${KNOWN_TAGS_SQL}))\`;`,
        },
      ],
      note: "Both arms together — they are one guard. `split_part` returns the WHOLE STRING for a separator-less value, so without them the six bare tag names read as provably different from every real value of their own type. Covered behaviourally in `object-cmp-pg.test.ts`.",
    },
  ],
};

export default spec;
