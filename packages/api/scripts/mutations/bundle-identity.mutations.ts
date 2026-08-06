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
    { name: "logging", file: "src/lib/residency/__tests__/migrate-identity-logging.test.ts" },
  ],
  preamble: `
Sources: \`${IMPORT}\`, \`${EXPORT}\`, \`${OBJECT_CMP}\`. Mutation list:
\`scripts/mutations/bundle-identity.mutations.ts\`.

The first three rows are the ones to read. Each is the slice's own decision
reverted to the alternative that was actually on the table in ADR-0037 §8, and
each reads as an improvement rather than a regression when you meet it in a
diff.

No row is zero across every column, and TWO of them were zero before the fixture
that separates the programs existed — *\`provisional\` is written for EVERY
imported row* and *the SUBJECT position is hardcoded to null*. In both cases the
corpus, not the assertions, was the problem: every fact carried a store-local id,
so "mark the dropped rows" and "mark every row" were one program, and so were
"follow the tag rule at the subject" and "always null the subject". Each note
records the fixture that split them.
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
          oldString: `      return verdict.tag === ENTITY_TAG
        ? { value: null, reason: "store-local" }
        : { value: verdict.value, reason: "carried" };`,
          newString: `      return { value: verdict.value, reason: "carried" };`,
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
      label: "the legacy arm keys against an EMPTY vocabulary (the load deleted)",
      edits: [
        {
          file: IMPORT,
          oldString: `    ? { carried: false, vocabulary: await loadClaimVocabulary(client, orgId) }`,
          newString: `    ? { carried: false, vocabulary: identityVocabulary }`,
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
      note: "⚠️ **Read the edit, not the old label.** This deletes the vocabulary LOAD; it does not move the section. An earlier version claimed to measure the reorder, and the equivalence it rested on held only while the legacy fixture's destination started EMPTY — which is no longer true, since that test now seeds a destination-side edge the imported fact must key through. What this row measures is that the legacy arm reads a real vocabulary at all; the reorder itself is covered by that assertion.",
    },
    {
      label: "`provisional` is never written for a nulled row",
      edits: [
        {
          file: IMPORT,
          oldString: `    comparableDropped: [subject.reason, object.reason].some(
      (r) => r === "store-local" || r === "unreadable",
    ),`,
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
          oldString: `    comparableDropped: [subject.reason, object.reason].some(
      (r) => r === "store-local" || r === "unreadable",
    ),`,
          newString: `    comparableDropped: true,`,
        },
      ],
      note: "The opposite error, and the one that looks harmless. The marker stops meaning *this row's comparable value is worth recomputing* and starts meaning *was imported* — #4772's review filter then fills with rows that need no work, which is how a filter gets turned off. ⚠️ **This row killed NOTHING on the first measurement**, and the reason is the corpus rather than the assertions: both seeded facts carry a store-local id, so every imported row was legitimately `provisional` and the two programs were indistinguishable. The catch-up fact now arrives with both `_cmp` fields already NULL, which is the one fixture that can tell them apart.",
    },
    {
      label: "`readStoredComparable` skips the PAYLOAD fixpoint check",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: `  if (tag !== ENTITY_TAG && !PAYLOAD_IS_CANONICAL[tag](payload)) {
    return { kind: "unreadable", detail: "payload" };
  }`,
          newString: "",
        },
      ],
      note: "⚠️ **The row this slice's review round exists for.** The first cut of the function did exactly this, on the reasoning that an unreadable payload *\"compares unequal to everything and proves nothing\"*. It is false in the direction that stamps: *different* is `a <> b AND same tag`, so an unreadable payload proves DIFFERENCE against every honest local value of its type. A region on an older release exports `date:2026-02-31`; the destination later observes `date:2026-03-01`; same tag, unequal, `valid_to` stamped with no human. Two regions are independently deployed and the bundle version does not track this grammar, so the skew is ordinary.",
    },
    {
      label: "the importer binds the ARRIVING `_cmp` straight through (the ComparableValue narrowing widened)",
      edits: [
        {
          file: IMPORT,
          oldString: `    subjectCmp: subject.value,
    objectCmp: object.value,`,
          newString: `    subjectCmp: fact.subjectCmp as ComparableValue,
    objectCmp: fact.objectCmp as ComparableValue,`,
        },
      ],
      note: "The one-token copy-paste from the three key lines directly above it. Under `ImportedIdentity`'s narrowed `ComparableValue` fields the honest spelling (`fact.subjectCmp ?? null`) does not compile at all — this row has to add a cast to express it, which is itself the measurement: the type turned a silent reintroduction of the verbatim `entity:` carry into something a reviewer must write down.",
    },
    {
      label: "the SUBJECT position is hardcoded to null instead of following the tag rule",
      edits: [
        {
          file: IMPORT,
          oldString: `    subjectCmp: subject.value,`,
          newString: `    subjectCmp: null,`,
        },
      ],
      note: "ADR-0037 §8 states the rule by TAG, not by position, *\"so the two cannot drift about what a store-local id is\"*. ⚠️ This killed **zero** until `migrate-roundtrip-pg.test.ts` gained a fact with a VALUE-typed `subject_cmp`: every other fixture carries `entity:` or NULL there, and against that corpus the hardcode and the rule are the same program. Third time in this arc — a disjunction, a conditional, and now a positional rule each needed a fixture drawn from the population the mutation lives in.",
    },
    {
      label: "`textOrNull` goes silent again",
      edits: [
        {
          file: EXPORT,
          oldString: `  if (value === null) return null;
  if (typeof value === "string") return value;`,
          newString: `  if (typeof value === "string") return value;`,
        },
      ],
      note: "The retracted argument was that a warn here *\"would be indistinguishable from a log line per honest abstain\"*. An abstain arrives as `null` and a dropped column arrives as `undefined`, and `preWideningGrant` eight lines up already separates them. What the silence hid: `f.subject_key` stops arriving → every fact exports `null` → the destination accepts it (null is legitimate) → the whole corpus lands UNKEYED, green `200` at both ends.",
    },
    {
      label: "the identity-loss line is deleted",
      edits: [
        {
          file: IMPORT,
          oldString: `  if (identityLoss.storeLocal > 0 || identityLoss.unreadable > 0 || identityLoss.unkeyable > 0) {`,
          newString: `  if (false) {`,
        },
      ],
      note: "An expected `entity:` drop, a tag vocabulary the two regions disagree about, and a corpus of surfaces that norm away all present as one `200` with healthy counts without it. `unreadable` is the count that means evidence was LOST rather than deferred, and nothing else in the system would ever mention it.",
    },
    {
      label: "the identity-loss line fires on every import (the `unreadable` split collapsed)",
      edits: [
        {
          file: IMPORT,
          oldString: `        if (reason === "store-local") identityLoss.storeLocal++;
        else if (reason === "unreadable") identityLoss.unreadable++;`,
          newString: `        if (reason !== "carried") identityLoss.storeLocal++;`,
        },
      ],
      note: "The opposite error and the one that looks tidier: three reasons folded into one counter. `absent` then counts as a loss, so the line fires on every import that carries a fact with no comparable value — which is nearly all of them — and an operator learns to skim it. The `unreadable` count, the only one that means evidence was lost, disappears entirely.",
    },
    {
      label: "the legacy READ runs without the workspace vocabulary lock",
      edits: [
        {
          file: IMPORT,
          oldString: `  if (legacyKeying) {
    await client.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, orgId]);
  }`,
          newString: "",
        },
      ],
      note: "Section 9 takes the lock only when the bundle carries EDGES, and a legacy bundle usually carries none — which is exactly the arm that reads the vocabulary. Unlocked: this transaction reads the closure at t0; a concurrent `decideAliasProposal` approves, rebuilds and re-keys every row for the workspace, committing before we do; our rows commit with pre-approval keys. The corpus is split permanently — `vocabulary-decide.ts`'s own \"a committed lie about what the corpus collides on\".",
    },
    {
      label: "a v3 import loads a vocabulary it never uses",
      edits: [
        {
          file: IMPORT,
          oldString: `  const legacyKeying =
    bundle.manifest.version < IDENTITY_FROM_VERSION &&
    (bundle.brainEpisodes ?? []).some((e) => e.facts.length > 0);`,
          newString: `  const legacyKeying = true;`,
        },
      ],
      note: "The negative for the two rows above: they would both pass against an importer that locked and loaded unconditionally, which serializes every region import against every alias approval for no reason — and makes a corrupt destination vocabulary fail a v3 import that never consults one.",
    },
    {
      label: "`readStoredComparable` admits an EMPTY payload",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: `  if (payload === "") return { kind: "unreadable", detail: "empty-payload" };`,
          newString: "",
        },
      ],
      note: "A truncated `entity:` or `money:` is exactly what `comparableDifferentSql`'s well-formedness arms refuse, so admitting one stores a value the database and this module disagree about.",
    },
    {
      label: "validation stops requiring the identity fields on a v3 fact",
      edits: [
        {
          file: IMPORT,
          oldString: `            if (!present || (f[field] !== null && typeof f[field] !== "string")) {`,
          newString: `            if (false) {`,
        },
      ],
      note: "A v3 producer that dropped a key then imports \"successfully\" with that key NULL. The manifest claims identity and the row has none — the state the version discriminator exists to make impossible. ⚠️ The edit neutralizes the INNER condition. An earlier version disabled the OUTER `if`, which fell through to the legacy-refusal arm and REJECTED a v3 fact that did carry its identity — the opposite behaviour, with one of its two kills spurious.",
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
      note: "The wire half. Every field reads `undefined` and `textOrNull` degrades it to `null` — and ⚠️ **validation ACCEPTS that bundle**, since `null` is legitimate at all five positions, so every fact imports UNKEYED. An earlier version of this note said validation refuses it; the table’s own `admin-migrate = 0` was the evidence against. Nothing at the seam catches it, which is why `v3 pin` exists: the file-local replacement for what the `keys-not-on-the-wire.test.ts` exemption switches off.",
    },
    {
      label: "the exporter feeds identity values through a cast instead of `textOrNull`",
      edits: [
        {
          file: EXPORT,
          oldString: `      subjectCmp: textOrNull(f.subject_cmp, f.id, "subject_cmp"),
      objectCmp: textOrNull(f.object_cmp, f.id, "object_cmp"),`,
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
