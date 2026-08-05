/**
 * The tier guard, measured (#5033, ADR-0037 §4) — PROMOTED from a hand-typed
 * table in `promotion-pg.test.ts` by #5027.
 *
 * The table this replaces was correct when it was written and went stale one
 * slice later: #5027 added a test to `promotion-pg.test.ts` that asserts a
 * STAMP, which moved the population of the `absent-key disjunct removed` row
 * from 8 to 9 and falsified the prose paragraph that enumerated the 8. Nobody
 * touched the guard.
 *
 * That is the whole argument for the runner (#5060). A hand-measured cell is a
 * claim nothing can falsify: add a test and N cells silently become false, under
 * a comment that reads as measurement. The three sites that went stale here
 * (`the 8 is: …`, the cell, and the "four bold rows" count that depends on it)
 * are three chances to be wrong about one number.
 *
 * Both suites need `TEST_DATABASE_URL`; without it they skip and every cell is 0
 * for a reason that has nothing to do with coverage:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCE = "src/lib/content-mode/adapters/brain-facts.ts";

const ALLOWLIST_ARM = `  return \`(NOT jsonb_exists(\${alias}.provenance, 'source')
      OR \${alias}.provenance->>'source' = ANY (\${NON_WAREHOUSE_SOURCE_ARRAY_SQL}))\`;`;

const spec: MutationSpec = {
  title: "Mutations the tier-guard suites catch",
  out: "scripts/mutations/tier-guard.md",
  targets: [
    { name: "promotion-pg.test.ts", file: "src/lib/brain/__tests__/promotion-pg.test.ts" },
    {
      name: "identity-consumers-pg.test.ts",
      file: "src/lib/brain/__tests__/identity-consumers-pg.test.ts",
    },
  ],
  preamble: `
Source: \`${SOURCE}\` (\`supersedableTierSql\`, \`TIER_HELD_BACK_COUNT_SQL\`).
Mutation list: \`scripts/mutations/tier-guard.mutations.ts\`.

Read the two columns against each other rather than each on its own — that is
what the table is for. The corpus suite lands every pair through
\`reconcileFacts\`, which always writes \`source\`, and it never reads
\`PromotionReport.supersessionHeldBack\`; \`promotion-pg.test.ts\` seeds
provenance directly and does read it. So each file is blind to arms the other
covers, and a row that is non-zero in exactly one column is that file's unique
contribution rather than a gap in the other.

Every mutation is spelled out in full, because two of them have more than one
plausible spelling and the numbers differ between them — the first hand-typed
cut of this table measured a denylist as \`IS DISTINCT FROM 'warehouse'\` in one
file and \`<> 'warehouse'\` in the other, and published a cell true of neither.
`,
  mutations: [
    {
      label: "the tier guard deleted entirely",
      edits: [
        {
          file: SOURCE,
          oldString: `     AND \${supersedableTierSql(p)}
     AND \${supersedableTierSql(d)}`,
          newString: "",
        },
      ],
      note: "An LLM-extracted draft may then stamp `valid_to` on a warehouse-derived belief that has no correction path at all — the irreversible direction, retiring an authoritative fact no verb can restore.",
    },
    {
      label: "the tier guard applied to the PUBLISHED side only",
      edits: [
        {
          file: SOURCE,
          oldString: `     AND \${supersedableTierSql(p)}
     AND \${supersedableTierSql(d)}`,
          newString: `     AND \${supersedableTierSql(p)}`,
        },
      ],
      note: "A warehouse-derived DRAFT could retire a tier-2 belief on promotion — the direction the corpus suite's `*-draft` entries exist for, and the one `promotion-pg` cannot see because all three of its prohibitions put the offending provenance on the published side.",
    },
    {
      label: "the tier guard applied to the DRAFT side only",
      edits: [
        {
          file: SOURCE,
          oldString: `     AND \${supersedableTierSql(p)}
     AND \${supersedableTierSql(d)}`,
          newString: `     AND \${supersedableTierSql(d)}`,
        },
      ],
      note: "The mirror, and the one both files see.",
    },
    {
      label: "the allowlist arm replaced by `<> 'warehouse'`, disjunct kept",
      edits: [
        {
          file: SOURCE,
          oldString: ALLOWLIST_ARM,
          newString: `  return \`(NOT jsonb_exists(\${alias}.provenance, 'source')
      OR \${alias}.provenance->>'source' <> 'warehouse')\`;`,
        },
      ],
      note: "The allowlist→denylist inversion. An UNRECOGNISED kind (`warehouse:prod`, `snowflake`) then reads as supersedable — the population a region import produces, restoring a bundle's `source` verbatim with no vocabulary gate. `<> 'warehouse'` is SQL NULL for a null-valued `source`, so the denylist still blocks the `{\"source\": null}` pair exactly as the allowlist does; the corpus's `warehouse:prod` fixtures are the only coverage on either side.",
    },
    {
      label: "the absent-key disjunct removed",
      edits: [
        {
          file: SOURCE,
          oldString: `  return \`(NOT jsonb_exists(\${alias}.provenance, 'source')
      OR `,
          newString: "  return `(",
        },
      ],
      note: "The carve-out for a provenance with no `source` at all — a shape that predates the tier lane and that nothing structurally guarantees. Removing it retires the supersession path for facts no import ever touched: a regression dressed as a fix. Every test that reaches the guard through `seedFact`'s `source`-less provenance default dies, which is why that default carries the warning it does.",
    },
    {
      label: "the carve-out simplified to `->>'source' IS NULL`",
      edits: [
        {
          file: SOURCE,
          oldString: "NOT jsonb_exists(${alias}.provenance, 'source')",
          newString: "${alias}.provenance->>'source' IS NULL",
        },
      ],
      note: "Reads as a tidy-up and is not: `->>` returns SQL NULL for a JSON `null` as well as for an ABSENT key, so this admits `{\"source\": null}` — the unresolvable shape the guard excludes on purpose — into the supersedable population.",
    },
    {
      label: "`TIER_HELD_BACK_COUNT_SQL`'s `IS NOT TRUE` → `NOT (…)`",
      edits: [
        {
          file: SOURCE,
          oldString: `     AND (\${supersedableTierSql("p")} AND \${supersedableTierSql("d")}) IS NOT TRUE`,
          newString: `     AND NOT (\${supersedableTierSql("p")} AND \${supersedableTierSql("d")})`,
        },
      ],
      note: "`NOT (NULL)` is NULL, so the `{\"source\": null}` population — the single most subtle held-back case — drops out of the count that exists to make it visible. The guard still blocks the pair; the operator just never learns it did.",
    },
    {
      label: "`TIER_HELD_BACK_COUNT_SQL` hard-wired to `SELECT 0`",
      edits: [
        {
          file: SOURCE,
          oldString: "  SELECT COUNT(*)::int AS held_back\n    FROM brain_facts d\n    JOIN brain_facts p\n      ON ${collisionIdentityPredicate(\"d\", \"p\")}",
          newString: "  SELECT 0::int AS held_back\n    FROM brain_facts d\n    JOIN brain_facts p\n      ON ${collisionIdentityPredicate(\"d\", \"p\")}",
        },
      ],
      note: "The diagnostic reporting the safe answer regardless. A publish then says `superseded: []`, `heldBack: 0` and emits no log line — byte-identical to *nothing collided* — which is the exact ambiguity #5033 exists to remove.",
    },
  ],
};

export default spec;
