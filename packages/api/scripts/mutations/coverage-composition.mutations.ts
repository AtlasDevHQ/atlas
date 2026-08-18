/**
 * The Coverage Surface's composition, measured (#5214, ADR-0041).
 *
 * Every row here removes one honesty rule from `lib/brain/coverage.ts` and
 * records how many tests notice. The reason to spend the run on this module in
 * particular: **every one of these reverts reads as a simplification, and every
 * one of them fails in the flattering direction.** Dropping a cross-check looks
 * like removing a redundant comparison; treating an unprobed unit as current
 * looks like a sensible default; trusting a stored label looks like not doing
 * the same work twice. None of them throws, none of them looks wrong on the
 * page, and the page's entire product is a statement an admin repeats out loud.
 *
 * So a `0` in this table is not a note. It means a rule ADR-0041 argues for can
 * be deleted with the suites green, on a surface whose whole claim is that its
 * parts are each true.
 *
 * `coverage.test.ts` needs no database — the composition is a pure seam
 * (`composeCoverage`) precisely so its inputs can be authored adversarially.
 * `class-contract.test.ts` is in the target list because two rows below move the
 * threshold rather than the composition, and the contract is where that number
 * is declared.
 */

import type { MutationSpec } from "../mutation-spec";

const COVERAGE = "src/lib/brain/coverage.ts";
const CONTRACT = "src/lib/brain/class-contract.ts";

const spec: MutationSpec = {
  title: "Mutations the #5214 Coverage Surface suites catch",
  out: "scripts/mutations/coverage-composition.md",
  targets: [
    { name: "coverage.test.ts", file: "src/lib/brain/__tests__/coverage.test.ts" },
    { name: "class-contract.test.ts", file: "src/lib/brain/__tests__/class-contract.test.ts" },
    {
      name: "coverage-enumeration.test.ts",
      file: "src/lib/brain/__tests__/coverage-enumeration.test.ts",
    },
  ],
  preamble: `
Sources: \`${COVERAGE}\`, \`${CONTRACT}\`. Mutation list:
\`scripts/mutations/coverage-composition.mutations.ts\`.

The first four rows are ADR-0041's own named fixture mutations, inverted: rather
than breaking the fixture and asserting the page notices, they break the PAGE and
ask whether the fixture notices. Rows 5 onward are the honesty rules that have no
symptom at rest — a page that quietly stops re-deriving a label, or quietly reads
a stored zero as a measurement, looks exactly like one that does neither.
`,
  mutations: [
    {
      label: "an unprobed unit is reported CURRENT rather than unverified",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (!row.activity.probed) {
    return { kind: "unverified-since", since: asOf, reason: "not-probed" };
  }`,
          newString: `  if (!row.activity.probed) {
    return { kind: "current" };
  }`,
        },
      ],
      note: "The probe rotation is bounded, so MOST units are unprobed on most cycles — which makes this the single mutation with the widest blast radius on a real workspace. It renders as a green all-clear about every source nobody asked about, and it is the reading a developer reaches for when `probed: false` looks like missing data rather than an answer.",
    },
    {
      label: 'a quiet source is reported "unverified" rather than current',
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (row.activity.at === null) return { kind: "current", checkedAt: row.activity.checkedAt };`,
          newString: `  if (row.activity.at === null) {
    return { kind: "unverified-since", since: asOf, reason: "not-probed" };
  }`,
        },
      ],
      note: 'The other half of the same confusion, failing the other way. ADR-0041: "Quiet ≠ stale: a source that hasn\'t moved is current, however old its newest evidence." An empty history page IS a reading, and collapsing it into "we did not ask" makes every dormant channel permanently amber — which trains an admin to ignore the signal.',
    },
    {
      label: "the sick-pipe check moves BELOW the class capability check",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (pipeSick) {
    return { kind: "unverified-since", since: asOf, reason: "enumeration-unavailable" };
  }`,
          newString: "",
        },
      ],
      note: 'Deletes the arm rather than reordering it, because the reorder is a no-op for the classes that cannot ask anyway. A class that CAN measure a lag still did not look this cycle, and a reading taken before a failed cycle says nothing about now — ADR-0041 puts both cases on one sentence, and this is the half that is runtime state rather than contract.',
      },
    {
      label: "the aggregate and the roster tally are no longer compared",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (
    snapshot.surveyed !== surveyed ||
    snapshot.enumerated !== enumerated ||
    // The M1 number — "invited, configured, reading nothing" — is guarded too,
    // and it needs saying because it is the one an earlier cut left out. It is
    // derived by a different SQL expression from the other two
    // (\`state = 'enumerated' AND in_perimeter\`), so a mis-derivation of it alone
    // is exactly the shape that would ship under two green comparisons.
    snapshot.inPerimeterWithoutEvidence !== inPerimeterWithoutEvidence
  ) {`,
          newString: `  if (false) {`,
        },
      ],
      note: "ADR-0041's *remove an enumerated unit* mutation, from the page's side. A dropped roster row shrinks the denominator and leaves the numerator alone, so the ratio RISES — the page reports fuller coverage of a workspace that just lost a channel. Two independent statements about the same rows is the only instrument that can see it, and this is what makes the loss silent.",
    },
    {
      label: "the M1 blind count drops out of the cross-check",
      edits: [
        {
          file: COVERAGE,
          oldString: ` ||
    // The M1 number — "invited, configured, reading nothing" — is guarded too,
    // and it needs saying because it is the one an earlier cut left out. It is
    // derived by a different SQL expression from the other two
    // (\`state = 'enumerated' AND in_perimeter\`), so a mis-derivation of it alone
    // is exactly the shape that would ship under two green comparisons.
    snapshot.inPerimeterWithoutEvidence !== inPerimeterWithoutEvidence`,
          newString: ``,
        },
      ],
      note: "The arm an earlier cut of this module left out, and the review found. `inPerimeterWithoutEvidence` is derived by a DIFFERENT SQL expression from the two beside it (`state = 'enumerated' AND in_perimeter`), so a mis-derivation of it alone is exactly the shape that ships green under two passing comparisons — and it is the M1 sentence, the number whose whole job is to say a source was invited and is reading nothing.",
    },
    {
      label: "unrenderable map-edge marks leave no trace on the wire",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (snapshot.degradedIncomplete) {`,
          newString: `  if (false) {`,
        },
      ],
      note: "Reachable by a ROLLBACK, which is what makes it worth a row: a deploy below the build that first wrote a new map-edge arm reads a value it has no sentence for and drops it — shipping an empty edge list that the page renders as *the map of what these credentials can see is complete*. `readCoverageSnapshot` logs the drop; a page cannot read a log line, so without this the loudest instrument is silent exactly where the statement is most flattering.",
    },
    {
      label: "the read side trusts the STORED label instead of re-deriving it",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (decision.policy !== "name") return null;`,
          newString: `  if (false) return null;`,
        },
      ],
      note: "Reads as removing duplicated work — the write path already ran the policy. What it actually removes is the only thing that bounds a stored disclosure's lifetime: a class argued shut on `vendorPublic` stays open on the page until the next cycle rewrites every row, so the contract's closing date becomes the date the last cycle ran.",
    },
    {
      label: "green is read off the evidence date alone, ignoring the perimeter",
      edits: [
        {
          file: COVERAGE,
          oldString: `    const evidenceAt = row.state === "surveyed" ? row.newestEvidenceAt : null;`,
          newString: `    const evidenceAt = row.newestEvidenceAt;`,
        },
      ],
      note: "ADR-0040 rule 3's converse, which is the half a reader forgets: green is evidence, AND evidence is not green. A row keeps its `newest_evidence_at` after the bot is removed from the channel, so this leaves a departed channel permanently surveyed — and then hands it a freshness verdict about a source Atlas cannot read. ⚠️ This row measured `0` in its first spelling, because a second `evidenceAt !== null` at the use site absorbed the mutation; the derivation was made single-point in response, which is the change the number bought.",
    },
    {
      label: "a never-succeeded cycle renders as a dated, empty roster",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (snapshot.asOf === null) {`,
          newString: `  if (false) {`,
        },
      ],
      note: 'The residue #5213 handed this page, restored. `CoverageClassSnapshot` is flat, so a class that has never enumerated hands over `surveyed: 0, degraded: []` — which renders as *the map is complete and there is nothing on it*. The union arm is the fix, and deleting it puts the green-while-nothing-is-happening statement back.',
    },
    {
      label: "the class contract's cadence halves",
      edits: [
        {
          file: CONTRACT,
          oldString: "const CONNECTOR_SYNC_CADENCE_MS = 24 * 60 * 60_000;",
          newString: "const CONNECTOR_SYNC_CADENCE_MS = 12 * 60 * 60_000;",
        },
      ],
      note: "The threshold has no symptom at rest and no other consumer, so moving it changes what the word *stale* means for every workspace with nothing else to notice. Halved, every class syncing normally starts reading stale; the doubled direction is worse and quieter, which is why the constant is pinned against the sync fiber's default rather than merely commented.",
    },
    {
      label: "the staleness comparison drops the cadence entirely",
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (lagMs <= verdict.syncCadenceMs) {`,
          newString: `  if (lagMs <= 0) {`,
        },
      ],
      note: 'Turns "the source moved further ahead than this class promises to close" into "the source moved after we looked" — which is true of every healthy sync, so every surveyed unit reads stale forever. The tempting variant is `<`, which is off by one at exactly the boundary where a workspace syncing on schedule sits.',
    },
    {
      label: "the freshness tally counts only the NAMED units",
      edits: [
        {
          file: COVERAGE,
          oldString: `      if (freshness.kind === "current") current++;
      else if (freshness.kind === "stale") stale++;
      else unverified++;`,
          newString: `      if (label !== null) {
        if (freshness.kind === "current") current++;
        else if (freshness.kind === "stale") stale++;
        else unverified++;
      }`,
        },
      ],
      note: "The disclosure model's load-bearing half. Counts are always disclosable and labels are not, so the tally is where a withheld mailbox's staleness reaches the admin at all — tallying only the named units means the `email` class, which never names anything, silently reports nothing stale forever.",
    },
    {
      label: "the roster listing clips SILENTLY (the cap holds, the flag does not)",
      edits: [
        {
          file: COVERAGE,
          oldString: `    unitsTruncated: truncated,`,
          newString: `    unitsTruncated: false,`,
        },
      ],
      note: "`OVERSIGHT_BUCKET_MAX`'s argument one surface over: a clipped list reads as the whole roster. ⚠️ The first spelling of this row set `truncated = false`, which made the response ship EVERY row — it stopped clipping rather than clipping silently, so the note claimed the opposite of what the mutated code did and the honesty rule actually named went unmeasured. This anchor keeps the cap and removes only the announcement, which is the shape a reader would call a simplification.",
    },
    {
      label: "the roster listing stops clipping at all",
      edits: [
        {
          file: COVERAGE,
          oldString: `  const truncated = named.length > COVERAGE_UNITS_MAX;`,
          newString: `  const truncated = false;`,
        },
      ],
      note: "The other half, kept as its own row once the two were told apart: the bound stops biting AND the flag stops being set. Milder than it looks on a chat roster and not on a warehouse one, where the pairs have no vendor ceiling — an unbounded array on a page-render path.",
    },
    {
      label: 'a vendor reading of any age still licenses "current"',
      edits: [
        {
          file: COVERAGE,
          oldString: `  if (at.getTime() - checkedAtMs > verdict.syncCadenceMs) {`,
          newString: `  if (false) {`,
        },
      ],
      note: "The review finding this arm was added for. The probe rotation is `CHAT_ACTIVITY_PROBES_PER_CYCLE` = 20 per hourly cycle and the upsert carries an unprobed unit's previous reading forward, so a 5,000-channel workspace re-probes each unit roughly every ten days — and without this arm a ten-day-old vendor answer is compared against a 24-hour threshold and returns `current`. A confident present-tense all-clear about a channel that may have been moving daily since anyone looked, indistinguishable on the wire from one probed this cycle.",
    },
  ],
};

export default spec;
