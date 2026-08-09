"use client";

import type { BrainVocabularyCoverage, BrainVocabularyPositionCounts } from "@/ui/lib/types";

/**
 * The empty state — a COVERAGE STATEMENT, never a congratulation.
 *
 * ## ⚠️ Never "you're all caught up"
 *
 * There is no caught-up state for a vocabulary. There is only what has been
 * decided and what has not yet been observed, and those are different things
 * that a congratulation collapses into one.
 *
 * Empty is the PRIMARY state for a while, and it is empty for a reason this
 * component can state exactly. The structural alias proposer fires only on
 * claims with a non-null `object_cmp` — #5034: *"today that skips nearly
 * always… on day one it returns zero rows."* The cardinality proposer needs
 * three correction events. So *"No proposals — you're all caught up!"* would be
 * **false in the way that matters**: it reports nothing-to-do on the surface
 * whose day-one job is the thing only a human can do.
 *
 * Same failure mode as the M1 dogfood, where the sync reported green because
 * the flag was on and only a row count separated that from a source never
 * connected.
 *
 * ## What it says instead
 *
 * 1. What is **in force** — *"3 aliases and 1 curated predicate are shaping
 *    identity"*, or plainly zero.
 * 2. Why Pending is empty **specifically** — *"the structural proposer only
 *    fires on claims with comparable objects; 0 of your 47 facts currently
 *    qualify."* One extra count, and it is the line that turns a dead page into
 *    a legible one.
 * 3. What is **withheld**, when anything is. An approver must be able to tell
 *    *"12 entity edges you cannot see"* from *"none"* — the vocabulary is
 *    workspace-global, so its size is not a secret even when its contents are.
 */
export function CoverageStatement({
  coverage,
  counts,
  edgeCount,
  cardinalityCount,
  cardinalityCounts,
}: {
  coverage: BrainVocabularyCoverage;
  counts: readonly BrainVocabularyPositionCounts[];
  edgeCount: number;
  cardinalityCount: number;
  /** Curated predicates: total vs what this reader may see. */
  cardinalityCounts: BrainVocabularyPositionCounts;
}) {
  // Cardinality entries fold into the SAME two numbers as the edges. Kept
  // separate in the props and merged here, rather than merged by the caller,
  // because the sentence below is the one that was making a workspace-wide
  // claim from a denied read and this is where that is fixed.
  const withheld =
    counts.reduce((sum, c) => sum + c.withheld, 0) + cardinalityCounts.withheld;
  const inconsistent =
    counts.some((c) => !c.countsConsistent) || !cardinalityCounts.countsConsistent;
  const denied =
    cardinalityCounts.scope === "deny-all" || counts.some((c) => c.scope === "deny-all");

  return (
    <div className="space-y-2 text-sm">
      <p className="text-foreground">
        {inForceSentence(edgeCount, cardinalityCount, denied, withheld)}
      </p>

      <p className="text-muted-foreground">{pendingSentence(coverage)}</p>

      {withheld > 0 ? (
        <p className="text-muted-foreground">
          <span className="text-foreground font-medium">
            {withheld} {withheld === 1 ? "entry is" : "entries are"} in force that you cannot see.
          </span>{" "}
          Entity-position entries are shown only where you can read at least one claim on each
          side. An entry you cannot see is also one you cannot remove here.
        </p>
      ) : null}

      {inconsistent ? (
        <p className="text-muted-foreground">
          These counts were taken from separate statements and disagreed, most likely because
          something was written while the page loaded. Reload to get a consistent pair rather than
          reading the withheld number as final.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Point 1 — what is in force, stated even when it is zero.
 *
 * ⚠️ The "nothing yet" sentence is a claim about the WORKSPACE, and it must not
 * be made from a read that was scoped or denied. Seeing nothing and there being
 * nothing are the two facts this entire surface exists to separate, and this was
 * the one place the component still conflated them.
 */
function inForceSentence(
  edges: number,
  cardinalities: number,
  denied: boolean,
  withheld: number,
): string {
  if (edges === 0 && cardinalities === 0) {
    if (denied) {
      return "Atlas cannot show you anything that is in force in this workspace — your account is not entitled to read the claims these entries are about. This is not the same as there being none.";
    }
    if (withheld > 0) {
      return `Nothing that you can see is shaping identity — but ${withheld} ${withheld === 1 ? "entry is" : "entries are"} in force that you cannot see, so this workspace's vocabulary is not empty.`;
    }
    return "Nothing is shaping identity yet — no alias edges and no curated predicates are in force in this workspace.";
  }
  const parts: string[] = [];
  if (edges > 0) parts.push(`${edges} ${edges === 1 ? "alias" : "aliases"}`);
  if (cardinalities > 0) {
    parts.push(`${cardinalities} curated ${cardinalities === 1 ? "predicate" : "predicates"}`);
  }
  const subject = parts.join(" and ");
  // "is"/"are" agrees with the FULL list, not with the last item: "1 alias and
  // 1 curated predicate" is two things.
  const plural = edges + cardinalities > 1;
  return `${subject} ${plural ? "are" : "is"} shaping identity in this workspace.`;
}

/**
 * Point 2 — why Pending is empty, SPECIFICALLY.
 *
 * The generic version of this sentence ("no proposals right now") is the one
 * that reads as an all-clear. Naming the gate and the number is what makes it a
 * statement about coverage: an approver who reads *"0 of your 47 facts
 * qualify"* knows the producer is working and has nothing to work on, which is
 * a different conclusion from "nothing needs doing".
 */
function pendingSentence(coverage: BrainVocabularyCoverage): string {
  const pending = coverage.pendingProposals + coverage.pendingCardinalities;
  if (pending > 0) {
    return `${pending} ${pending === 1 ? "proposal is" : "proposals are"} awaiting review.`;
  }
  if (coverage.liveFacts === 0) {
    return "Nothing is proposed, and nothing could be: this workspace has no live claims yet, so neither producer has anything to read.";
  }
  if (coverage.comparableFacts === 0) {
    return (
      `Nothing is proposed. The structural proposer only fires on claims with comparable objects, ` +
      `and 0 of your ${coverage.liveFacts} live ${coverage.liveFacts === 1 ? "claim" : "claims"} ` +
      `currently qualify; the cardinality proposer needs three repeated corrections at one ` +
      `predicate. Authoring below does not wait for either.`
    );
  }
  return (
    `Nothing is proposed yet. The structural proposer reads the ${coverage.comparableFacts} of your ` +
    `${coverage.liveFacts} live claims that carry a comparable object, and raises a proposal only ` +
    `where two distinct subjects agree under two predicate spellings. Authoring below does not ` +
    `wait for it.`
  );
}
