"use client";

import type {
  BrainVocabularyBlastRadius,
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
      return (
        "An object-position alias cannot arm or disarm supersession at all — the collision rule " +
        "never reads the object's identity, so this is not a count of zero, it is a different " +
        "kind of change. What it does affect is what corroborates what, and what earns a tension " +
        "edge, and Atlas cannot yet show you that. Approve this one on what you know about the " +
        "two spellings, not on an impact estimate — there is none to read."
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
