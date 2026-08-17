/**
 * The mutation runner measured against its own guardrails (#5060).
 *
 * The runner is now the thing every other table in this repo trusts, so "the
 * guardrail tests pass" is not enough — a passing test proves nothing until
 * removing the behaviour it describes makes it fail. Every row here deletes one
 * guardrail and records how many tests notice.
 *
 * A `0` in this table is a defect, not a note. It means a guardrail can be
 * removed with the suite staying green, and the next reader to "simplify" it
 * gets no signal at all.
 *
 * Safe to run against a tree where `mutation-core.ts` is being edited: the
 * runner imports its own copy at startup, so mutating the file mid-run cannot
 * change the runner's behaviour, only the suite's view of it.
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCE = "scripts/mutation-core.ts";

const spec: MutationSpec = {
  title: "Mutations `mutate-core.test.ts` catches",
  out: "scripts/mutations/mutation-core.md",
  targets: [{ name: "mutate-core.test.ts", file: "src/__tests__/mutate-core.test.ts" }],
  preamble: `
Source: \`${SOURCE}\`. Mutation list: \`scripts/mutations/mutation-core.mutations.ts\`.

Each row removes one guardrail. The guardrails are the whole value of the
runner — one that silently measures nothing is strictly worse than measuring by
hand, because it emits a number under a generated-file header that vouches for
it, and that header is exactly what stops a reviewer looking closer.
`,
  mutations: [
    {
      label: "the anchor check accepts a 2-match (`!== 1` → `=== 0`)",
      edits: [
        {
          file: SOURCE,
          oldString: "    if (matches !== 1) throw new AnchorError(edit.file, matches);",
          newString: "    if (matches === 0) throw new AnchorError(edit.file, matches);",
        },
      ],
      note: "Mutates whichever of two sites string order happens to reach first, and reports a number for a mutation nobody chose.",
    },
    {
      label: "the anchor check is removed entirely",
      edits: [
        {
          file: SOURCE,
          oldString: "    if (matches !== 1) throw new AnchorError(edit.file, matches);\n",
          newString: "",
        },
      ],
      note: "A 0-match then applies nothing and the suite runs clean, publishing a confident `0` that reads as *the tests do not catch this*.",
    },
    {
      label: "`applyMutation` snapshots lazily instead of before any write",
      edits: [
        {
          file: SOURCE,
          oldString: `  for (const edit of mutation.edits) {
    const abs = resolve(root, edit.file);
    if (!backups.has(abs)) backups.set(abs, store.read(abs));
  }
`,
          newString: "",
        },
      ],
      note: "Without the pre-pass, a mutation whose second edit throws leaves the first edit's file mutated and unrecoverable — the developer's next test run blames their own tree.",
    },
    {
      label: "`restoreAll` forgets to clear the backup map",
      edits: [{ file: SOURCE, oldString: "  backups.clear();\n", newString: "" }],
      note: "A stale backup resurrects itself over real work on the next restore — the `git checkout --` failure this tool exists to avoid, reintroduced from the other end.",
    },
    {
      label: "`parseBunSummary` reports `0 fail` for a suite that never ran",
      edits: [
        {
          file: SOURCE,
          oldString: "    return {\n      pass: 0,\n      fail: 0,\n      skip: 0,\n      todo: 0,\n      ran: null,\n      error: firstError ?? \"bun printed no pass/fail summary (compile or import error)\",\n    };",
          newString: `    return { pass: 0, fail: 0, skip: 0, todo: 0, ran: null };`,
        },
      ],
      note: "The single most misleading cell the table can contain: a compile error rendered as *the suite does not catch this mutation*.",
    },
    {
      label: "`parseBunSummary` stops anchoring the count to a line start",
      edits: [
        {
          file: SOURCE,
          oldString: '  const fails = /^\\s*(\\d+)\\s+fail\\b/m.exec(output);',
          newString: '  const fails = /(\\d+)\\s+fail\\b/.exec(output);',
        },
      ],
    },
    {
      label: "`parseBunSummary` stops anchoring the PASS count to a line start",
      edits: [
        {
          file: SOURCE,
          oldString: "  const pass = /^\\s*(\\d+)\\s+pass\\b/m.exec(output);",
          newString: "  const pass = /(\\d+)\\s+pass\\b/.exec(output);",
        },
      ],
      note: "The pass count is the table's denominator and the input to `isWholeSuite`, so corrupting it silently rescales every flag decision.",
    },
    {
      label: "`isWholeSuite` only fires on an exact total (`>=` ratio → `>= total`)",
      edits: [
        {
          file: SOURCE,
          oldString: "  return total > 0 && fail >= Math.ceil(total * WHOLE_SUITE_WARN_RATIO);",
          newString: "  return total > 0 && fail >= total;",
        },
      ],
      note: "A setup break that spares one trivially-green test is the same defect, and this spelling lets it through unflagged.",
    },
    {
      label: "`validateSpec` stops rejecting a no-op edit",
      edits: [
        {
          file: SOURCE,
          oldString: `      if (edit.oldString === edit.newString) {
        problems.push(\`\${mutation.label}: oldString === newString (a no-op measures the baseline)\`);
      }
`,
          newString: "",
        },
      ],
    },
    {
      label: "`validateSpec` stops rejecting an empty anchor",
      edits: [
        {
          file: SOURCE,
          oldString: '      if (edit.oldString === "") problems.push(`${mutation.label}: empty oldString`);\n',
          newString: "",
        },
      ],
    },
    {
      label: "`validateSpec` returns the FIRST problem instead of all of them",
      edits: [
        {
          file: SOURCE,
          oldString: "  return problems;\n}",
          newString: "  return problems.slice(0, 1);\n}",
        },
      ],
    },
    {
      label: "`countOccurrences` loops forever on an empty needle (guard removed)",
      edits: [
        {
          file: SOURCE,
          oldString: '  if (needle === "") return 0;\n',
          newString: "",
        },
      ],
      note: "Left in the list deliberately: if this row ever reports a count rather than a timeout, the guard is genuinely gone and the empty-needle case hangs the runner.",
    },
    // ⚠️ The row that stood here — *"an errored cell renders as its `fail`
    // number instead of a warning"* — is DELETED rather than re-anchored, and
    // that is the honest move (#5097). It deleted `renderCell`'s error arm so
    // the `fail: 0` sitting on an error cell would be published as a `0`. That
    // `fail` no longer exists: `Cell` is a discriminated union and the no-count
    // variants carry no count to leak. There is nothing to move the anchor to,
    // and inventing a successor pointing at whatever replaced it would record a
    // number for a state no input can reach.
    //
    // The rows below price the guards that made it unreachable instead — those
    // have tests, and therefore real numbers.
    {
      label: "`renderCell` loses its `unmeasured` arm (a no-count cell renders as `undefined`)",
      edits: [
        {
          file: SOURCE,
          oldString: '    case "unmeasured":\n      return `⚠️ ${cell.reason}`;\n',
          newString: "",
        },
      ],
      note: "The successor to the deleted `fail`-leak row: the same defect one variant over. A cell that measured nothing must never render as anything a reader could take for a measurement.",
    },
    {
      label: "⚠️ the refusal narrows to the DEAD-ANCHOR member again (#5077's shape)",
      edits: [
        {
          file: SOURCE,
          // ⚠️ Extended past the `case` line: `cellFlag` has the identical two
          // lines, so the short anchor matched TWICE and the runner refused it —
          // which is guardrail 2 doing its job on this very spec.
          oldString:
            '    case "unmeasured":\n      return cell.reason;\n    // The one committable no-count cell: a real measurement of a real hang.',
          newString:
            '    case "unmeasured":\n      return cell.reason.startsWith("ANCHOR") ? cell.reason : null;\n    // The one committable no-count cell: a real measurement of a real hang.',
        },
      ],
      note: "The single row this whole change exists for. It reinstates exactly what #5077 shipped — one member refused, the rest rendered as honest numbers — so a `0` here would mean nothing notices the class reopening.",
    },
    {
      label: "`unmeasurableOutcome` stops refusing a SKIPPED or TODO'd run",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (outcome.skip !== 0 || outcome.todo !== 0) {",
          newString: "  if (false) {",
        },
      ],
      note: "Kills the baseline guard and the per-mutation refusal at once, which is the point of there being one copy.",
    },
    {
      label: "`unmeasurableOutcome` stops cross-checking the buckets against `Ran N`",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (outcome.ran !== null && accounted !== outcome.ran) {",
          newString: "  if (false) {",
        },
      ],
      note: "The general arm — the one that closes a bucket bun invents later without naming it.",
    },
    {
      label: "⚠️ `unmeasurableOutcome` stops refusing a run that registered ZERO tests",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (outcome.pass === 0 && outcome.fail === 0) {",
          newString: "  if (false) {",
        },
      ],
      note: "MEASURED live on bun 1.3.13: an emptied corpus prints `0 pass` / `0 fail` and no other arm fires, so before this guard `measure()` published a `0` — the byte the generated header defines as *the suite does not catch it* — from a run that measured nothing.",
    },
    {
      label: "`unmeasurableOutcome`'s EMPTY arm swallows a whole-suite kill (`&& fail === 0` dropped)",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (outcome.pass === 0 && outcome.fail === 0) {",
          newString: "  if (outcome.pass === 0) {",
        },
      ],
      note: "The other direction, and the one that would refuse real results: a mutation that kills every test reports `0 pass` with a large `fail`, which is the strongest measurement the runner can make.",
    },
    {
      label: "the `-pg` hint decision is re-derived instead of read off the problem",
      edits: [
        {
          file: SOURCE,
          oldString: "      pgHint: false,\n    };\n  }\n  return null;\n}",
          newString: "      pgHint: true,\n    };\n  }\n  return null;\n}",
        },
      ],
      note: "Flips the EMPTY arm's hint to true, which is what a hand-copied kind list or a structural `\"cell\" in problem` test both produce — sending an operator to start Postgres and hunt a `.skip` in a suite that registered no tests.",
    },
    {
      label: "`countCell` stops deriving `wholeSuite`, so a near-total publishes unflagged",
      edits: [
        {
          file: SOURCE,
          oldString:
            '  return isWholeSuite(fail, total) ? { kind: "count", fail, wholeSuite: true } : { kind: "count", fail };',
          newString: '  return { kind: "count", fail };',
        },
      ],
    },
    {
      label: "`cellFlag` stops naming WHY a row measured nothing",
      edits: [
        {
          file: SOURCE,
          oldString:
            '    case "unmeasured":\n      return cell.reason;\n    case "timeout":\n      return "HANGS — timed out";',
          newString:
            '    case "unmeasured":\n      return "unmeasured";\n    case "timeout":\n      return "HANGS — timed out";',
        },
      ],
      note: "The flag IS the repair information a reader meets in the Flagged section — which mutation measured nothing, and why. A `toBeDefined()` assertion could not see this.",
    },
    {
      label: "the TIMEOUT cell carries a wall-clock number again (determinism lost)",
      edits: [
        {
          file: SOURCE,
          oldString: 'export const TIMEOUT_CELL = "⚠️ HANGS — timed out";',
          newString: 'export const TIMEOUT_CELL = "⚠️ HANGS — timed out after 30s";',
        },
      ],
      note: "The one committable no-count cell. Its first spelling interpolated `round(timeoutMs / 1000)`, which derives from the baseline's MEASURED duration — so the byte was stable only while that suite stayed under 3s, and for a `-pg` target never. `--check` compares bytes and is a required gate.",
    },
    {
      label: "`importSpecifiers` sees only SINGLE-LINE import statements",
      edits: [
        {
          file: SOURCE,
          oldString: `  const found: string[] = [];
  for (const match of source.matchAll(/\\bfrom\\s*["']([^"'\\n]+)["']/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  for (const match of source.matchAll(/\\bimport\\s*["']([^"'\\n]+)["']/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;`,
          newString: `  const found: string[] = [];
  for (const match of source.matchAll(/^\\s*import[^;\\n]*?\\bfrom\\s*["']([^"'\\n]+)["']/gm)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;`,
        },
      ],
      note: "The spelling a reader reaches for, and the one that misses every multi-line import — which is how `__tests__/*-corpus.ts` stayed invisible to `--files` after #5077 claimed to have fixed the class.",
    },
    {
      label: "`importCandidates` drops the `@atlas/api/*` alias arm",
      edits: [
        {
          file: SOURCE,
          oldString: '  } else if (specifier.startsWith("@atlas/api/")) {\n    base = `src/${specifier.slice("@atlas/api/".length)}`;\n',
          newString: "  } else if (false) {\n",
        },
      ],
    },
    {
      label: "`render` defaults an unmeasured cell to `0` instead of a dash",
      edits: [
        {
          file: SOURCE,
          oldString: '      return cell === undefined ? "—" : renderCell(cell);',
          newString: '      return cell === undefined ? "0" : renderCell(cell);',
        },
      ],
    },
    {
      label: "`escapeCell` stops escaping `|`",
      edits: [
        {
          file: SOURCE,
          oldString: "  return text.replace(/\\\\?\\|/g, (match) => (match.startsWith(\"\\\\\") ? \"\\\\\\\\\\\\|\" : \"\\\\|\"));",
          newString: "  return text;",
        },
      ],
    },
    {
      label: "`render` stamps the output with a date (determinism lost)",
      edits: [
        {
          file: SOURCE,
          oldString: '  lines.push("<!-- GENERATED by packages/api/scripts/mutate.ts — DO NOT EDIT BY HAND. -->");',
          newString:
            '  lines.push("<!-- GENERATED by packages/api/scripts/mutate.ts — DO NOT EDIT BY HAND. -->");\n  lines.push(`<!-- measured ${new Date().toISOString().slice(0, 10)} -->`);',
        },
      ],
      note: "A `--check` gate needs byte-identical regeneration; a timestamp makes every run diff, and a diff that always appears is a diff nobody reads.",
    },
    {
      label: "`render` drops the DO-NOT-EDIT header",
      edits: [
        {
          file: SOURCE,
          oldString: '  lines.push("<!-- GENERATED by packages/api/scripts/mutate.ts — DO NOT EDIT BY HAND. -->");\n',
          newString: "",
        },
      ],
    },
    {
      label: "`render` drops the suite-size line",
      edits: [
        {
          file: SOURCE,
          oldString: `  lines.push(
    \`Suite sizes: \${targets
      .map((t) => \`**\${escapeCell(t.name)}** \${baselines.get(t.name) ?? 0} tests (\\\`\${t.file}\\\`)\`)
      .join(" · ")}.\`,
  );
`,
          newString: "",
        },
      ],
      note: "Without the denominator a reader cannot tell 3-of-5 from 3-of-500.",
    },
  ],
};

export default spec;
