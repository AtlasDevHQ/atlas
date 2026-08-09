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
          oldString: `    return {
      pass: 0,
      fail: 0,
      error: firstError ?? "bun printed no pass/fail summary (compile or import error)",
    };`,
          newString: `    return { pass: 0, fail: 0 };`,
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
    {
      label: "an errored cell renders as its `fail` number instead of a warning",
      edits: [
        {
          file: SOURCE,
          oldString: '  if (cell.kind === "error") return `⚠️ ${cell.flag ?? "ERROR"}`;\n',
          newString: "",
        },
      ],
      note: "Turns *nothing was measured* into a published `0`, which is the exact lie the anchor guard exists to prevent — arriving through the renderer instead.",
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
