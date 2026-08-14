/**
 * The mutation list behind `episode-sync-archive.test.ts`'s AC-5 comment
 * (#5061, promoted from a hand-written list by #5060's runner).
 *
 * ## This table is mostly ZEROS, and they are the honest answer
 *
 * Two of the three mutations below are PURE TYPE edits, and the runner's
 * instrument is `bun test`, which strips types. They kill nothing here and
 * cannot: the gate that catches them is `bun run type` (tsgo, `/ci` stage 0),
 * which type-checks the whole repo including this suite — with the worktree
 * caveat below — and the instrument at
 * the test site is `@ts-expect-error` — a directive that INVERTS, so when the
 * narrowing evaporates the directive becomes unused and the type-check fails.
 *
 * A `0` recorded without that explanation would be a tombstone reading "no test
 * covers this", which `mutate.ts`'s dead-anchor arm exists to refuse. Recorded
 * WITH it, the table still earns its keep: what rots here is not a number but an
 * ANCHOR, and `--check` plus the dead-anchor refusal are exactly the gate a
 * prose list of three mutations never had. The third row is a runtime value
 * change and does have teeth under `bun test`.
 *
 * ⚠️ **The first mutation is NOT spelled the way the comment it replaces spelled
 * it, and that is the finding.** That comment named "annotating
 * `EPISODE_SOURCE_SPECS` `Record<EpisodeSource, EpisodeSourceSpec>`" — but
 * `EpisodeSource` IS `keyof typeof EPISODE_SOURCE_SPECS`, so an annotation in
 * those exact words is a CIRCULAR type alias. It errors, so the claim "caught by
 * `bun run type`" survives; it errors for the wrong reason, demonstrating a
 * circularity rather than the widening the row is about. That is precisely the
 * spelling-dependence #5060 was filed over, arriving in a list nobody could
 * re-run. The spelling below widens the key axis without the circle.
 *
 * ⚠️ TWO NEARBY EDITS ARE DELIBERATELY ABSENT, and naming them is the point:
 * dropping an `as const` from an `EPISODE_SOURCE_SPECS` entry weakens nothing
 * (its `satisfies EpisodeSourceSpec` supplies the literal contextually), and
 * neither does dropping the `const` modifier on `registerBrainSourceConnector`'s
 * type parameter (the constraint is already a literal union). Both were checked
 * at #4985; neither degrades the type, so a row for either would be a fabricated
 * measurement.
 *
 * No database needed.
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCES = "src/lib/brain/sources.ts";
const TYPES = "src/lib/brain/ingest/types.ts";

const spec: MutationSpec = {
  title: "Mutations the episode-source narrowing catches",
  out: "scripts/mutations/episode-source-narrowing.md",
  targets: [
    { name: "here", file: "src/lib/brain/ingest/__tests__/episode-sync-archive.test.ts" },
  ],
  preamble: `
Sources: \`${SOURCES}\` (\`EPISODE_SOURCE_SPECS\`), \`${TYPES}\`
(\`BrainSourceAudienceFor\`, \`AUDIENCE_GRAIN\`).
Mutation list: \`scripts/mutations/episode-source-narrowing.mutations.ts\`.

⚠️ **Read the zeros here against a different gate.** The claim under test is
AC-5 of #4985: a grant-deriving source class cannot declare
\`externally-synced\`. Two of its three halves are enforced at COMPILE time, and
this table's instrument is \`bun test\`, which strips types — so those two rows
measure 0 by construction, not by omission. \`bun run type\` is what fails on
them, and the \`@ts-expect-error\` directives in the target suite are the
falsifier: they invert, so a narrowing that evaporates turns an expected error
into an unused directive and reds the type-check.

The value this table adds is therefore not the numbers. It is that the three
mutations are now EXACT STRINGS the runner refuses to publish a row for once
they stop matching the source — which is the failure a three-bullet comment
could not detect, and which the comment had already suffered once (see the
mutation list's header on the circular spelling).

⚠️ **The two zeros were MEASURED, not reasoned about** — and re-measured at
review round 2, after the fixture below gained the \`scope\` it was missing and
after the worktree trap in the next paragraph was understood. Applied one at a
time against \`bun x tsgo --noEmit -p packages/api/tsconfig.json\` (the project
whose relative \`@atlas/api/* → ./src/*\` mapping reads THIS tree), each reds the
type-check with \`TS2578: Unused '@ts-expect-error' directive\` on the target
suite and nothing else: the directives invert, so the evaporated narrowing is
exactly what gets reported. A note claiming "nothing here can catch this" is a
claim, and this repo has been wrong about one before; running it costs a
minute.

The per-code COUNTS are deliberately not recorded. They are a hand-typed
measurement of a diagnostic list that moves whenever a directive is added or an
elaboration order changes — the thing this file exists to stop — and unlike a
cell nothing regenerates them, because \`--check\` compares the rendered BYTES
and would freeze a wrong count in as the expected output. The property is what
is stable, and a property is what the row claims.

⚠️ **THE ROOT \`bun run type\` CANNOT MEASURE THESE TWO FROM A GIT WORKTREE.**
Both files they mutate — \`sources.ts\` and \`ingest/types.ts\` — reach the root
program through an \`@atlas/api/*\` specifier, and the
\`packages/*/node_modules/@atlas/api\` symlink points at the primary checkout, so
those copies win TypeScript's package-ID dedup and the worktree's are dropped.
Mutate them here and the root type-check reports a clean tree for a change that
is applied on disk.

It is per-FILE, not per-tree: most of \`packages/api/src\` is read from the
worktree, and \`vocabulary-decide.ts\` — same directory, mutated by the sibling
spec — is worktree-only. Which copy wins depends on program order and can flip
when an unrelated import moves.

Measure with \`bun x tsgo --noEmit -p packages/api/tsconfig.json\`, whose
\`@atlas/api/* → ./src/*\` mapping is relative and so always reads this tree, or
from the primary checkout. \`bun\` itself is unaffected, so every \`bun test\`
cell in this repo is sound; only the type-gate claims are exposed.
\`docs/development/testing.md\` carries the general form.
`,
  mutations: [
    {
      label:
        "`EPISODE_SOURCE_SPECS` annotated `Record<string, EpisodeSourceSpec>` — the key axis widened off the literals",
      edits: [
        {
          file: SOURCES,
          oldString: "export const EPISODE_SOURCE_SPECS = Object.freeze({",
          newString:
            "export const EPISODE_SOURCE_SPECS: Readonly<Record<string, EpisodeSourceSpec>> = Object.freeze({",
        },
      ],
      note: "`EpisodeSource` becomes `string`, so `(typeof EPISODE_SOURCE_SPECS)[S][\"class\"]` widens to the whole class union, no arm extends `ReverifierRequiredClass`, and `BrainSourceAudienceFor` silently degrades to the permissive shape at every call site. Caught by `bun run type` only — the annotation the replaced comment named (`Record<EpisodeSource, …>`) is circular and would error for an unrelated reason.",
    },
    {
      label: "`BrainSourceAudienceFor` reverted to a bare `BrainSourceAudience`",
      edits: [
        {
          file: TYPES,
          oldString: `export type BrainSourceAudienceFor<S extends EpisodeSource> =
  (typeof EPISODE_SOURCE_SPECS)[S]["class"] extends ReverifierRequiredClass
    ? Extract<BrainSourceAudience, { kind: "reverified" }>
    : BrainSourceAudience;`,
          newString:
            "export type BrainSourceAudienceFor<S extends EpisodeSource> = BrainSourceAudience;",
        },
      ],
      note: "The literal signature this refactor deleted from three connectors. Every widening of it compiles, which is why the runtime re-check inside `registerBrainSourceConnector` exists — the type is the fast local error, the runtime check is what holds the invariant. Caught by `bun run type` only.",
    },
    {
      label: "`AUDIENCE_GRAIN.transcript` flipped to `not-required`",
      edits: [
        {
          file: TYPES,
          oldString: '  transcript: "per-object",',
          newString: '  transcript: "not-required",',
        },
      ],
      note: "The one row with teeth under `bun test`: this is a RUNTIME value, read by `requiresAudienceReverifier`, so flipping it lets a transcript-class connector register with `externally-synced` and mint `audience:` grants nothing refreshes — invisible for 168h. It is also the type's input (`ReverifierRequiredClass` is derived from this map), so it reds `bun run type` as well; the two halves of AC-5 are one edit apart.",
    },
  ],
};

export default spec;
