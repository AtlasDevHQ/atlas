/**
 * The mutation list behind `reconcile-logging.test.ts`'s table (#5061,
 * promoted from a hand-typed table by #5060's runner).
 *
 * What this suite guards is a LEAK: `degenerateSurfaces` puts claim text into a
 * log line, and it is only safe to do so where the cause is
 * `degenerate-surface` — by construction such a surface is separators and
 * whitespace and carries no content. Every mutation here either widens that
 * filter or scrambles the classification feeding it, which is the same defect
 * arriving from two directions.
 *
 * No database: every case blocks in the preparation loop, above the
 * transaction, so this table needs no `TEST_DATABASE_URL`.
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCE = "src/lib/brain/reconcile.ts";

/** The three-way classification, verbatim. Both cause mutations rewrite it. */
const CLASSIFIER = `        cause:
          candidate.inheritedSlot !== undefined && role !== "object"
            ? "inherited"
            : identityKey(surfaces[role]) === null
              ? "degenerate-surface"
              : "vocabulary-target",`;

const spec: MutationSpec = {
  title: "Mutations `reconcile-logging.test.ts` catches",
  out: "scripts/mutations/reconcile-logging.md",
  targets: [
    { name: "here", file: "src/lib/brain/__tests__/reconcile-logging.test.ts" },
  ],
  preamble: `
Source: \`${SOURCE}\` (the unkeyed-slot \`log.warn\`).
Mutation list: \`scripts/mutations/reconcile-logging.mutations.ts\`.

⚠️ The logger is mocked process-wide here, so the sinks are per-LEVEL arrays
rather than one merged list. That matters for reading a count: a mutation that
demotes \`log.error\` to \`log.warn\` is visible to this suite, which is not true
of every logging suite in the tree.
`,
  mutations: [
    {
      label: "`degenerateSurfaces`' `.filter(cause === \"degenerate-surface\")` deleted",
      edits: [
        {
          file: SOURCE,
          oldString: `          degenerateSurfaces: unkeyed
            .filter((slot) => slot.cause === "degenerate-surface")
            .map((slot) => ({ role: slot.role, surface: surfaces[slot.role] })),`,
          newString: `          degenerateSurfaces: unkeyed
            .map((slot) => ({ role: slot.role, surface: surfaces[slot.role] })),`,
        },
      ],
      note: "⭐ THE leak. Every unkeyed position's surface is logged, including a real one — a human's perfectly good replacement text lands in a warn line because their workspace's vocabulary maps it to nothing.",
    },
    {
      label:
        "the two non-inherited causes SWAPPED (a `vocabulary-target` labelled `degenerate-surface`)",
      edits: [
        {
          file: SOURCE,
          oldString: CLASSIFIER,
          newString: `        cause:
          candidate.inheritedSlot !== undefined && role !== "object"
            ? "inherited"
            : identityKey(surfaces[role]) === null
              ? "vocabulary-target"
              : "degenerate-surface",`,
        },
      ],
      note: "The leak reached the other way — the filter is intact and the label lies, so a real surface passes it. The ⭐ falsifier is one of the deaths, and the rest are the cause assertions that make the label mean something.",
    },
    {
      label:
        "`cause` gates on the POSITION instead of the CAUSE (`role === \"object\" ? \"degenerate-surface\" : …`)",
      edits: [
        {
          file: SOURCE,
          oldString: CLASSIFIER,
          newString: `        cause:
          candidate.inheritedSlot !== undefined && role !== "object"
            ? "inherited"
            : role === "object"
              ? "degenerate-surface"
              : "vocabulary-target",`,
        },
      ],
      note: "#5047's own defect, one layer over: a classifier keyed on where the failure happened rather than on why. ONLY the two-causes-in-one-claim case sees it, which is why that case is not redundant with the single-cause ones — in every single-cause test the position and the cause happen to line up, so a position-based classifier agrees with the real one by coincidence.",
    },
  ],
};

export default spec;
