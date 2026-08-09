"use client";

import type {
  BrainVocabularyBlastRadius,
  BrainVocabularyObjectRadiusSide,
  BrainVocabularyStructurallyEmptyReason,
} from "@/ui/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Info } from "lucide-react";

/**
 * The blast-radius disclosure (#5086's engine, rendered).
 *
 * ## The `switch` is the whole point
 *
 * `BrainVocabularyBlastRadius` is a discriminated union and this component
 * branches on it before reading a single number. That is not style. The engine's
 * own docstring records what the flat shape produced: a renderer that read
 * `floor` before checking `structurallyEmpty` said *"at least 0 today, and every
 * future claim in this slot"* for an object-position alias — a sentence that is
 * false (no future claim in that slot can supersede) and is precisely the
 * confident false all-clear the preview exists to prevent.
 *
 * ## Why "at least"
 *
 * `floor` is always `true` on the computed branch, and the copy must say so. A
 * cardinality flip is not a batch: it applies to every future claim in the slot,
 * so the number is a floor and never a total. Reading it as a total is how an
 * approver decides a 3-pair blast radius is small.
 *
 * ## Why a removal shows the same thing
 *
 * A removal is a re-key too, so it gets the same preview — on the `disarming`
 * side. Both sides are always rendered when non-empty, because an approval that
 * disarms something and a removal that arms something are both surprising and
 * both real.
 */
export function BlastRadiusPreview({
  radius,
  pending,
  error,
}: {
  radius: BrainVocabularyBlastRadius | null;
  pending: boolean;
  error: string | null;
}) {
  if (error !== null) {
    // ⚠️ NOT rendered as "no impact". A preview that failed and a preview that
    // came back empty are opposite facts, and the whole surface exists because
    // those two are easy to confuse.
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" aria-hidden />
        <AlertDescription>
          The blast radius could not be computed, so what this decision would change is unknown —
          not zero. {error}
        </AlertDescription>
      </Alert>
    );
  }
  if (pending) {
    return <p className="text-muted-foreground text-sm">Computing the blast radius…</p>;
  }
  if (radius === null) return null;

  if (radius.kind === "structurally-empty") {
    return (
      <Alert>
        <Info className="size-4" aria-hidden />
        <AlertDescription>{structurallyEmptyCopy(radius.reason)}</AlertDescription>
      </Alert>
    );
  }

  if (radius.kind === "object-position") {
    return <ObjectPositionRadius radius={radius} />;
  }

  const { arming, disarming } = radius;
  const nothing = arming.total === 0 && disarming.total === 0;

  return (
    <div className="space-y-2 text-sm">
      {nothing ? (
        <p className="text-muted-foreground">
          <span className="text-foreground font-medium">
            No published claim becomes supersedable, or safe, as things stand today.
          </span>{" "}
          That is a floor, not a guarantee: this decision applies to every future claim in the slot
          as well.
        </p>
      ) : null}

      {arming.total > 0 ? (
        <SideLine
          tone="arming"
          label="become supersedable"
          total={arming.total}
          shown={arming.pairs.length}
          withheld={arming.withheld}
          truncated={arming.truncated}
          consistent={arming.countsConsistent}
        />
      ) : null}

      {disarming.total > 0 ? (
        <SideLine
          tone="disarming"
          label="become safe again"
          total={disarming.total}
          shown={disarming.pairs.length}
          withheld={disarming.withheld}
          truncated={disarming.truncated}
          consistent={disarming.countsConsistent}
        />
      ) : null}

      {radius.subtreeTruncated ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            The alias chain was deeper than Atlas walks, so both numbers describe a{" "}
            <strong>smaller population</strong> than you asked about. This is not the same as the
            numbers disagreeing — it means part of the chain was not looked at.
          </AlertDescription>
        </Alert>
      ) : null}

      {arming.pairs.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-md border text-xs">
          {arming.pairs.map((pair) => (
            <li key={`${pair.draftId}:${pair.supersededId}`} className="px-3 py-2">
              <span className="text-foreground">{pair.draftLabel}</span>
              <span className="text-muted-foreground"> would replace </span>
              <span className="text-foreground">{pair.supersededLabel}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The OBJECT-position disclosure — a different KIND of blast radius, rendered as
 * one.
 *
 * ⚠️ **It must not read like a smaller supersession radius.** The collision rule
 * never looks at the object's identity, so this decision cannot make a published
 * claim supersedable at all; what it moves is what AGREES and what is flagged as
 * contested. Reusing `SideLine` would have put *"become supersedable"* wording
 * over these numbers, which is the specific false sentence the engine split the
 * union to make unrepresentable.
 *
 * ## The three sentences, and why the third is the surprising one
 *
 * 1. **Corroboration.** After the merge these pairs occupy one object slot, so
 *    the next re-observation of either attaches to one row instead of minting a
 *    second belief. A floor: it applies to every future claim in the slot too.
 * 2. **Tension.** Advisory `in-tension-with` edges between pairs that would stop
 *    being rivals.
 * 3. ⚠️ **Those edges are not withdrawn.** The approval rewrites the object's
 *    identity key and nothing else — nothing deletes an edge — so each one is
 *    left flagging a contradiction between two claims Atlas now treats as
 *    agreeing. `staleEdgesPersist` is a literal `true` on the wire precisely so
 *    this paragraph is assertable rather than merely intended.
 *
 * A pair whose values PROVE they differ appears in neither number: the merge
 * makes the two claims share a slot and they stay in tension, which is correct
 * and is the thing an approver most needs to not be told otherwise.
 */
function ObjectPositionRadius({
  radius,
}: {
  radius: Extract<BrainVocabularyBlastRadius, { kind: "object-position" }>;
}) {
  const { corroborating, separating, tension } = radius;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        <span className="text-foreground font-medium">
          This is an object-position alias, so it changes nothing about what replaces what.
        </span>{" "}
        The rule that supersedes a published claim never reads the object&rsquo;s identity. What it
        does change is what Atlas treats as agreeing, and what it flags as contested.
      </p>

      <ObjectSideLine
        label={
          corroborating.total === 1
            ? "pair of live claims would agree about the object"
            : "pairs of live claims would agree about the object"
        }
        detail="They are not merged retroactively — the next time either claim is re-observed it attaches to one row instead of minting a second."
        side={corroborating}
      />

      {/* The REMOVAL's half. Rendered by the same component and gated only on
          being non-empty, so this panel never has to know which verb produced
          the radius — which is why the two are separate fields on the wire. */}
      <ObjectSideLine
        label={
          separating.total === 1
            ? "pair of live claims that agree today would stop agreeing"
            : "pairs of live claims that agree today would stop agreeing"
        }
        detail="Nothing splits them retroactively either: the claims stay as they are, and Atlas stops treating them as the same object from here on. No contradiction flag is written for them until one is re-observed."
        side={separating}
      />

      {/* ⚠️ The persistence sentence is READ OFF `staleEdgesPersist`, not
          hard-coded beside it. The field is a literal `true` on the wire for
          exactly one purpose — so a test can assert the sentence is rendered —
          and while the copy was hard-coded the field was dead: flipping it to
          `false` in a fixture changed nothing, so the literal justified a claim
          nothing checked. */}
      <ObjectSideLine
        label={
          tension.total === 1
            ? "contradiction Atlas has already flagged would stop being one"
            : "contradictions Atlas has already flagged would stop being ones"
        }
        detail={
          radius.staleEdgesPersist
            ? "⚠️ Those flags are NOT withdrawn by this decision. Nothing deletes them, so each one is left contradicting two claims Atlas would now consider to agree."
            : "Atlas did not report what becomes of those flags, so do not assume they are withdrawn."
        }
        side={tension}
      />

      {/* ⚠️ Gated on the zeros being KNOWN, not merely on their being zero. This
          is the one sentence on the branch that reads as an all-clear, so it
          must never be reachable from a count the server could not establish. */}
      {[corroborating, separating, tension].every((s) => s.total === 0 && s.countsConsistent) ? (
        <p className="text-muted-foreground">
          Nothing in the corpus agrees or contradicts differently under this merge as things stand
          today. That is a floor, not a guarantee: it applies to every future claim in this slot as
          well.
        </p>
      ) : null}

      {radius.subtreeTruncated ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            The alias chain was deeper than Atlas walks, so both numbers describe a{" "}
            <strong>smaller population</strong> than you asked about. This is not the same as the
            numbers disagreeing — it means part of the chain was not looked at.
          </AlertDescription>
        </Alert>
      ) : null}

      {corroborating.pairs.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-md border text-xs">
          {corroborating.pairs.map((pair) => (
            <li key={`${pair.leftId}:${pair.rightId}`} className="px-3 py-2">
              <span className="text-foreground">{pair.leftLabel}</span>
              <span className="text-muted-foreground"> would agree with </span>
              <span className="text-foreground">{pair.rightLabel}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ObjectSideLine({
  label,
  detail,
  side,
}: {
  label: string;
  detail: string;
  side: BrainVocabularyObjectRadiusSide;
}) {
  // ⚠️ SILENT ONLY WHEN THE ZERO IS KNOWN. The early return used to be a bare
  // `total === 0`, which reads `countsConsistent` four lines too late — so every
  // condition the server clears that flag for (a pair row that would not narrow,
  // a scoped-window value that did not read back, the two statements
  // disagreeing, a deny-all clause) rendered as NOTHING, and the all-clear
  // paragraph below then fired. That is this module's own named worst outcome —
  // a count Atlas could not establish, presented as "this changes nothing" —
  // produced by the renderer after the engine had said in-band that it did not
  // know.
  if (side.total === 0 && side.countsConsistent) return null;
  if (side.total === 0) {
    return (
      <p className="text-destructive">
        Atlas could not establish this number, so it is <strong>unknown, not zero</strong>. Treat
        this preview as incomplete and reload before deciding.
      </p>
    );
  }
  return (
    <p className="text-foreground">
      {/* "At least" for `SideLine`'s reason — `floor` is a literal `true` on this
          branch so the word is assertable rather than a hedge. */}
      <span className="font-medium">
        At least {side.total} {label}
      </span>{" "}
      today, and this applies to every future claim in the slot.{" "}
      <span className="text-muted-foreground">{detail}</span>
      {side.withheld > 0 ? (
        <>
          {" "}
          <span className="text-muted-foreground">
            {side.withheld} of those {side.withheld === 1 ? "involves a claim" : "involve claims"}{" "}
            you cannot read, so {side.withheld === 1 ? "it is" : "they are"} counted but not listed.
          </span>
        </>
      ) : null}
      {side.truncated && side.pairs.length < side.total - side.withheld ? (
        <>
          {" "}
          <span className="text-muted-foreground">
            Only the first {side.pairs.length} are listed.
          </span>
        </>
      ) : null}
      {!side.countsConsistent ? (
        <>
          {" "}
          <span className="text-destructive">
            These two counts disagreed, so treat them as approximate rather than as facts.
          </span>
        </>
      ) : null}
    </p>
  );
}

function SideLine({
  tone,
  label,
  total,
  shown,
  withheld,
  truncated,
  consistent,
}: {
  tone: "arming" | "disarming";
  label: string;
  total: number;
  shown: number;
  withheld: number;
  truncated: boolean;
  consistent: boolean;
}) {
  return (
    <p className={tone === "arming" ? "text-foreground" : "text-muted-foreground"}>
      {/* "At least" is not hedging — `floor` is a literal `true` on this branch
          precisely so this word is assertable. */}
      <span className="font-medium">
        At least {total} published {total === 1 ? "claim" : "claims"} {label}
      </span>{" "}
      today, and this applies to every future claim in the slot.
      {withheld > 0 ? (
        <>
          {" "}
          {withheld} of those {withheld === 1 ? "involves a claim" : "involve claims"} you cannot
          read, so {withheld === 1 ? "it is" : "they are"} counted but not listed.
        </>
      ) : null}
      {truncated && shown < total - withheld ? (
        <> Only the first {shown} are listed.</>
      ) : null}
      {!consistent ? (
        <>
          {" "}
          <span className="text-destructive">
            These two counts disagreed, so treat them as approximate rather than as facts.
          </span>
        </>
      ) : null}
    </p>
  );
}

/**
 * The five structurally-empty reasons, each as its own sentence.
 *
 * ⚠️ **A zero and a "this cannot produce pairs" are the same number and opposite
 * facts**, which is why the engine reports a reason rather than a count and why
 * this maps every reason individually. An approver reading *"0 pairs"* for an
 * object-position alias concludes the alias is harmless; what is true is that
 * its harm is of a different kind and is not measured here at all.
 *
 * The `default` is deliberately not a shrug: a reason this client does not know
 * is an API newer than the page, and saying so beats printing a raw slug.
 *
 * ⚠️ The parameter is the wire UNION, not `string`, for the reason `ScopeBadge`
 * gives one file over: a new arm on `BrainVocabularyStructurallyEmptyReason` must
 * be a compile error here rather than a silent fall through to the `default`.
 * Typing it does not make the `default` dead — a deployed page can be older than
 * the API that answered it, and Zod parses the response before this runs only
 * when the two agree — so the arm stays, now as the runtime backstop it was
 * always meant to be rather than as the type system's only line.
 */
function structurallyEmptyCopy(reason: BrainVocabularyStructurallyEmptyReason): string {
  switch (reason) {
    case "object-position":
      // ⚠️ Still reachable, and no longer the ordinary path. Since #5088 an
      // object-position alias gets its own `object-position` radius arm with the
      // corroboration and tension deltas; this string is what a request that
      // reaches the supersession PLANNER at that position would produce, which
      // is unreachable by construction and guarded anyway. So the copy no longer
      // says "Atlas cannot yet show you that" — it can, and a page still saying
      // otherwise would be the stale reassurance this file exists to refuse.
      return (
        "Atlas answered the supersession question for an object-position alias, which cannot " +
        "produce a supersession pair at all — the collision rule never reads the object's " +
        "identity. That is not a blast radius of zero, and it is also not the answer you asked " +
        "for: the corroboration and tension impact is what this decision changes. Reload before " +
        "deciding; this page and the API have disagreed about how to ask."
      );
    case "already-single":
      return "This predicate is already curated single-valued, so there is nothing to flip.";
    case "not-curated":
      return "This predicate has no approved single-valued entry, so there is nothing to un-curate.";
    case "unkeyable-surface":
      return (
        "That surface normalizes away to nothing — it is made only of separators — so it occupies " +
        "no slot and can join nothing. The preview could not be computed rather than coming back " +
        "empty."
      );
    case "no-such-edge":
      return (
        "No approved edge starts at that norm, so this removal would do nothing. That is not a " +
        "blast radius of zero; there is no decision here to measure."
      );
    default:
      return (
        `This decision cannot produce pairs, for a reason this page does not recognise ` +
        `("${reason}"). That is not a blast radius of zero — do not read it as one. The API is ` +
        "likely newer than this page; reload before deciding."
      );
  }
}
