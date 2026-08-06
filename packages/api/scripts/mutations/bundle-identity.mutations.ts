/**
 * The v3 bundle's identity carry, measured (#5035, ADR-0037 §8).
 *
 * Every row removes one part of the change and records how many tests notice.
 * The reason to measure this slice rather than trust it is that BOTH of its
 * failure directions are silent, and they are silent in opposite ways:
 *
 *   - **Re-deriving a key at import** OVER-matches. Imported facts merge into a
 *     slot they never belonged to, and publish stamps `valid_to` across the
 *     merge. Nothing errors; a belief is retired.
 *   - **Carrying an `entity:` id** manufactures positive evidence of DIFFERENCE.
 *     A destination draft about the SAME real entity then supersedes the
 *     imported claim, autonomously, on the one write ADR-0036 reserves for a
 *     human.
 *
 * Both read as *more* correct in a diff — one reuses the destination's curated
 * vocabulary, the other preserves data. A `0` in this table means the suites
 * cannot tell that apart.
 *
 * `migrate-roundtrip-pg.test.ts` needs `TEST_DATABASE_URL`; without it the suite
 * SKIPS and every cell in its column reads 0 for a reason that has nothing to do
 * with coverage. Run it with:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 *   bun run scripts/mutate.ts scripts/mutations/bundle-identity.mutations.ts
 */

import type { MutationSpec } from "../mutation-spec";

const IMPORT = "src/api/routes/admin-migrate.ts";
const EXPORT = "src/lib/residency/export.ts";
const OBJECT_CMP = "src/lib/brain/object-cmp.ts";

const spec: MutationSpec = {
  title: "Mutations the #5035 bundle-identity suites catch",
  out: "scripts/mutations/bundle-identity.md",
  targets: [
    { name: "roundtrip-pg", file: "src/lib/residency/__tests__/migrate-roundtrip-pg.test.ts" },
    { name: "admin-migrate", file: "src/api/__tests__/admin-migrate.test.ts" },
    { name: "export", file: "src/lib/residency/__tests__/export.test.ts" },
    { name: "object-cmp", file: "src/lib/brain/__tests__/object-cmp.test.ts" },
    { name: "v3 pin", file: "src/lib/residency/__tests__/bundle-identity-v3.test.ts" },
  ],
  preamble: `
Sources: \`${IMPORT}\`, \`${EXPORT}\`, \`${OBJECT_CMP}\`. Mutation list:
\`scripts/mutations/bundle-identity.mutations.ts\`.

The first three rows are the ones to read. Each is the slice's own decision
reverted to the alternative that was actually on the table in ADR-0037 §8, and
each reads as an improvement rather than a regression when you meet it in a
diff.

No row is zero across every column, but that was not true of the first
measurement: *\`provisional\` is written for EVERY imported row* killed nothing,
because every fact in the corpus carried a store-local id and so was
legitimately provisional. The two programs were the same program against those
fixtures. Its note records the fixture that separates them.
`,
  mutations: [
    {
      label: "the importer RE-DERIVES a v3 fact's keys instead of carrying them",
      edits: [
        {
          file: IMPORT,
          oldString: `    subjectKey: fact.subjectKey ?? null,
    predicateKey: fact.predicateKey ?? null,
    objectKey: fact.objectKey ?? null,`,
          newString: `    subjectKey: slotKey(fact.subject, identityVocabulary.subject),
    predicateKey: slotKey(fact.predicate, identityVocabulary.predicate),
    objectKey: slotKey(fact.object, identityVocabulary.object),`,
        },
        // The mutation has to compile: `identityVocabulary` is not otherwise
        // imported here. Adding the import is part of the mutation, not a
        // separate change — a mutation that fails to build measures nothing.
        {
          file: IMPORT,
          oldString: `  slotKey,
  type ClaimVocabulary,`,
          newString: `  slotKey,
  identityVocabulary,
  type ClaimVocabulary,`,
        },
      ],
      note: "The direction ADR-0037 §8 refuses. It is the *recoverable-looking* revert — re-deriving reuses the destination's own curated vocabulary, which reads as respecting local decisions — and it is the irreversible one: a destination alias the source lacks merges imported facts into a slot they never belonged to.",
    },
    {
      label: "a store-local `entity:` id travels verbatim",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "  return comparableTag(parsed) === ENTITY_TAG ? null : parsed;",
          newString: "  return parsed;",
        },
      ],
      note: "Counterfeit positive evidence of difference at `object_cmp`, which is the arm `supersessionCollisionJoin` becomes. Reads as *preserving data* and is strictly worse than the NULL it replaces: NULL is `unknown`, reaches a reviewer as tension, and stamps nothing.",
    },
    {
      label: "a LEGACY bundle's facts are left unkeyed",
      edits: [
        {
          file: IMPORT,
          oldString: `      subjectKey: slotKey(fact.subject, vocabulary.subject),
      predicateKey: slotKey(fact.predicate, vocabulary.predicate),
      objectKey: slotKey(fact.object, vocabulary.object),`,
          newString: `      subjectKey: null,
      predicateKey: null,
      objectKey: null,`,
        },
      ],
      note: "The pre-#5035 behaviour, restored for the population that still arrives without keys. An unkeyed fact corroborates nothing, earns no tension edge, and can neither supersede nor be superseded — and the publish-time disclosure reports \"nothing to supersede\" without being able to say the check could not run.",
    },
    {
      label: "the vocabulary is merged AFTER the brain again (the section reorder reverted)",
      edits: [
        {
          file: IMPORT,
          oldString: `      : { carried: false, vocabulary: await loadClaimVocabulary(client, orgId) };`,
          newString: `      : { carried: false, vocabulary: identityVocabulary };`,
        },
        {
          file: IMPORT,
          oldString: `  slotKey,
  type ClaimVocabulary,`,
          newString: `  slotKey,
  identityVocabulary,
  type ClaimVocabulary,`,
        },
      ],
      note: "Equivalent to keying before the arriving edges land, which is what the pre-#5035 section order forced. The legacy arm then composes only the destination's pre-existing decisions and discards the source's — the half of §8's merge that exists to be composed.",
    },
    {
      label: "`provisional` is never written for a nulled row",
      edits: [
        {
          file: IMPORT,
          oldString: `    comparableDropped:
      (fact.subjectCmp != null && subjectCmp === null) ||
      (fact.objectCmp != null && objectCmp === null),`,
          newString: `    comparableDropped: false,`,
        },
      ],
      note: "The null-out stays SAFE and stops being RECOVERABLE. `object_cmp IS NULL` matches every honest abstain, so without the marker there is no key-based way to find the rows whose comparable value a migration discarded.",
    },
    {
      label: "`provisional` is written for EVERY imported row",
      edits: [
        {
          file: IMPORT,
          oldString: `    comparableDropped:
      (fact.subjectCmp != null && subjectCmp === null) ||
      (fact.objectCmp != null && objectCmp === null),`,
          newString: `    comparableDropped: true,`,
        },
      ],
      note: "The opposite error, and the one that looks harmless. The marker stops meaning *this row's comparable value is worth recomputing* and starts meaning *was imported* — #4772's review filter then fills with rows that need no work, which is how a filter gets turned off. ⚠️ **This row killed NOTHING on the first measurement**, and the reason is the corpus rather than the assertions: both seeded facts carry a store-local id, so every imported row was legitimately `provisional` and the two programs were indistinguishable. The catch-up fact now arrives with both `_cmp` fields already NULL, which is the one fixture that can tell them apart.",
    },
    {
      label: "`parseStoredComparable` admits an empty payload",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "  return value.length > tag.length + TAG_SEPARATOR.length ? (value as TaggedComparable) : null;",
          newString: "  return value as TaggedComparable;",
        },
      ],
      note: "A truncated `entity:` or `money:` is exactly what `comparableDifferentSql`'s well-formedness arms refuse, so admitting one stores a value the database and this module disagree about.",
    },
    {
      label: "validation stops requiring the identity fields on a v3 fact",
      edits: [
        {
          file: IMPORT,
          oldString: `          if (version >= IDENTITY_FROM_VERSION) {
            if (!present || (f[field] !== null && typeof f[field] !== "string")) {`,
          newString: `          if (false) {
            if (!present || (f[field] !== null && typeof f[field] !== "string")) {`,
        },
      ],
      note: "A v3 producer that dropped a key then imports \"successfully\" with that key NULL. The manifest claims identity and the row has none — which is the state the version discriminator exists to make impossible.",
    },
    {
      label: "the required-sections gate reads `=== CURRENT` again",
      edits: [
        {
          file: IMPORT,
          oldString: "  if (version >= PILLAR_SECTIONS_FROM_VERSION) {",
          newString: "  if (version === PILLAR_SECTIONS_FROM_VERSION) {",
        },
      ],
      note: "The bug a version bump introduces by looking unrelated to it: written as `=== CURRENT_BUNDLE_VERSION`, the #4460 pillar check silently stopped applying to v3 the moment the constant moved, and a producer dropping `dashboards` would strand a pillar without an error.",
    },
    {
      label: "the exporter stops projecting the identity columns",
      edits: [
        {
          file: EXPORT,
          oldString: `              f.subject_key, f.predicate_key, f.object_key,
              f.subject_cmp, f.object_cmp,
`,
          newString: "",
        },
      ],
      note: "The wire half. Every field reads `undefined`, `textOrNull` degrades it to `null`, and validation refuses the bundle — IF something asserts the projection. The interesting column is `v3 pin`, which is the file-local replacement for what the `keys-not-on-the-wire.test.ts` exemption switches off.",
    },
    {
      label: "the exporter feeds identity values through a cast instead of `textOrNull`",
      edits: [
        {
          file: EXPORT,
          oldString: `      subjectCmp: textOrNull(f.subject_cmp),
      objectCmp: textOrNull(f.object_cmp),`,
          newString: `      subjectCmp: f.subject_cmp as string | null,
      objectCmp: f.object_cmp as string | null,`,
        },
      ],
      note: "A value of the wrong runtime shape reaches a column whose comparisons stamp `valid_to`. The same call `preWideningVisibleTo` makes one line up, at a position where the consequence is a false claim of difference rather than a disclosure.",
    },
    {
      label: "the importer writes `predicate_cardinality` again (from the legacy field)",
      edits: [
        {
          file: IMPORT,
          oldString: `visible_to, pre_widening_visible_to, created_at, updated_at)`,
          newString: `visible_to, pre_widening_visible_to, predicate_cardinality, created_at, updated_at)`,
        },
        {
          file: IMPORT,
          oldString: `                 $19, $20, $21, $22, $23)\`,`,
          newString: `                 $19, $20, $21, $22, $23, $24)\`,`,
        },
        {
          file: IMPORT,
          oldString: `          fact.preWideningVisibleTo ?? null,
          fact.createdAt,`,
          newString: `          fact.preWideningVisibleTo ?? null,
          fact.predicateCardinality ?? "multi",
          fact.createdAt,`,
        },
      ],
      note: "Restores a per-row LLM guess as though it were the curated decision #5027 moved to `brain_predicate_cardinality`. On a v3 bundle the field is absent, so this writes the schema default whether the importer honours it or not — the only population where the revert changes a stored value is a LEGACY bundle carrying `single`, which is why the legacy test asserts the column rather than the v3 path doing so.",
    },
  ],
};

export default spec;
