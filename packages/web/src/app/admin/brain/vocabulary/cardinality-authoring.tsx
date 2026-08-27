"use client";

import { useState } from "react";
import type { z } from "zod";
import type {
  BrainVocabularyCardinality,
  BrainVocabularySurfaceOption,
} from "@/ui/lib/types";
import { usePreviewSlot } from "./use-preview-slot";
import {
  BRAIN_VOCABULARY_CARDINALITIES,
  BrainVocabularyCardinalityRequestSchema,
  BrainVocabularyCardinalityWriteResponseSchema,
} from "@/ui/lib/admin-schemas";
import { BlastRadiusPreview } from "./blast-radius";
import { NormPicker } from "./norm-picker";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";

/**
 * **Declare a predicate's cardinality** — the second act that closes the
 * recognition loop, given a surface (#5447, ADR-0037 §3(d)3).
 *
 * ## Why this card exists at all
 *
 * The *In force* pane already RENDERS `entry.cardinality` as a badge. So the page
 * displayed a state it could not author, and the asymmetry is what made the gap
 * easy to miss: seven of the eight `brain-vocabulary` endpoints had a caller and
 * `POST /cardinality` had none. Every prod write of a `single` entry had to be a
 * hand-written `fetch` from a browser console.
 *
 * ## The preview is the reason the flip is safe to offer
 *
 * `POST /cardinality`'s own description is unambiguous: *"the blast radius is
 * retroactive. Flipping a predicate to `single` makes every existing published
 * pair in that slot supersedable at the NEXT publish, with no per-row record of
 * the regime each fact was written under — so call `/preview` with
 * `cardinality-flip` first and render its count as the FLOOR it is."*
 *
 * A card that offered the flip without the count would be **worse than no card**,
 * because the console `fetch` at least made an operator type the words. So the
 * write is gated on a SUCCESSFUL preview in both directions — exactly as the
 * alias verbs are one file over, and for the graver reason.
 *
 * `multi` is gated too. It is the un-curation, it re-keys nothing but it
 * DISARMS supersession across the slot, and `a removal is a re-key too` is the
 * argument the *In force* pane was built on. Its preview kind is
 * `cardinality-removal`, whose disarming side is the arbitration being withdrawn.
 *
 * ## The alias divergence is fixed at the API, not disclosed here
 *
 * `/preview` used to key its cardinality arms with `identityKey(predicateSurface)`
 * — normalization only — while `/cardinality` keyed its write with
 * `slotKey(predicateSurface, predicateAlias)` — normalization **and the alias
 * closure**. Those agree for an unaliased predicate and diverge for an aliased
 * one, and the picker offers aliased norms because it groups by the norm of the
 * observed SURFACE, not by the closed key. So for a predicate that is the source
 * of an in-force alias, the number on screen described one slot and the write
 * landed in another — which defeats the single property that justifies offering
 * this control at all.
 *
 * This card used to close that gap itself, walking the in-force edges to resolve
 * the pick and sending the RESOLVED norm to `/preview` while sending the PICKED
 * norm to `/cardinality`. It disclosed the fold, and refused rather than guessed
 * on an unprovable or non-terminating chain. That was a second implementation of
 * a closure the API owns, living in the browser, and its own header said the
 * better repair was to fix `/preview`.
 *
 * ⚠️ **That repair landed (#5466), so this card sends the PICKED norm to both
 * endpoints and holds no closure logic at all.** What it lost with the walk is
 * the fold disclosure, and that is the right trade rather than a regression: the
 * disclosure existed to make a possible DISAGREEMENT visible, and there is no
 * longer a disagreement to make visible. Re-rendering the resolved norm from the
 * server is not the replacement — `keys-not-on-the-wire.test.ts` refuses a slot
 * key on the wire outright.
 *
 * ⚠️ An even earlier cut simply blocked any aliased pick and told the operator to
 * choose the target instead. Recorded because it reads as the safer option and is
 * not: the picker lists norms of observed SURFACES, and an alias exists precisely
 * because claims spell the source — so the target was usually absent from the list
 * and the slot became uncurable through the UI, which is the console `fetch` this
 * card was built to end.
 */
/**
 * The write body, typed from the SERVER's own schema.
 *
 * The page's own rule, learned the hard way one file over: a
 * `Record<string, unknown>` body compiled for a misspelled field and failed as a
 * 400 at runtime — on the one call whose result gates a workspace-wide re-key.
 * `z.input` is the SSOT rather than a hand-written mirror, and it applies here
 * with more force, because this route's write is the retroactive one.
 */
type CardinalityRequest = z.input<typeof BrainVocabularyCardinalityRequestSchema>;

/**
 * The two directions, built FROM the canonical tuple.
 *
 * Not two hand-written `<SelectItem>`s. `BRAIN_VOCABULARY_CARDINALITIES` is
 * pinned in `@useatlas/schemas` against the wire union, so a third arm on that
 * union appears here as an option rather than as a value the page silently cannot
 * offer — and this `Record` is keyed on the union, so the same third arm is a
 * COMPILE ERROR until someone writes its prose. Between them the two make "the
 * API grew a cardinality and the picker did not" unrepresentable, which is the
 * shape `POSITIONS` takes one file over.
 */
interface CardinalityCopy {
  /** The option's text in the select. */
  readonly label: string;
  /** The consequence, under the select. */
  readonly hint: string;
  /**
   * ⚠️ The `/preview` kind for THIS arm, carried here rather than derived by a
   * `=== "single"` ternary.
   *
   * The earlier spelling made the docstring above only one-third true: three
   * sites binary-split on `single` versus *everything else*, so a third arm would
   * have previewed as `cardinality-removal`, rendered `multi`'s write label, and
   * silently dropped `multi`'s disclosure — shipping a write behind the wrong
   * counterfactual, which is exactly the failure the docstring claimed was
   * unrepresentable. Per-arm fields make the compile error land here instead.
   */
  readonly previewKind: "cardinality-flip" | "cardinality-removal";
  /** The write button's text for this arm. */
  readonly writeLabel: string;
  /**
   * Whether this arm needs the "absent already means this" disclosure.
   *
   * A property of the arm, not of `!== "single"`: it is true of the value that IS
   * the table's default, and a third arm would be neither the default nor `single`.
   */
  readonly isAbsentRowDefault: boolean;
}

const CARDINALITY_COPY: Record<BrainVocabularyCardinality, CardinalityCopy> = {
  single: {
    label: "single — one value at a time",
    hint:
      "⚠️ Retroactive. Every published pair already in this slot becomes supersedable at the " +
      "next publish, and Atlas keeps no per-row record of which regime each claim was written " +
      "under — so the count below is the floor, never a total.",
    previewKind: "cardinality-flip",
    writeLabel: "Curate as single-valued",
    isAbsentRowDefault: false,
  },
  multi: {
    label: "multi — values coexist",
    hint:
      "Multi is the un-curation: the adjudicated record that these values coexist, and the only " +
      "way back out of single short of a database operation.",
    previewKind: "cardinality-removal",
    writeLabel: "Record as multi-valued",
    isAbsentRowDefault: true,
  },
};

export function CardinalityAuthoring({ onWritten }: { onWritten: () => void }) {
  const [surface, setSurface] = useState<BrainVocabularySurfaceOption | null>(null);
  const [cardinality, setCardinality] = useState<BrainVocabularyCardinality>("single");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The slot, its staleness guard and its two derived questions — shared with
   * `page.tsx` rather than re-rolled here.
   *
   * The generation bump this hook owns matters more on this card than on either
   * of the page's two slots: changing the DIRECTION resets without previewing, so
   * a late response for the opposite verb would otherwise land in a cleared slot
   * and arm an un-curation behind a flip's count.
   */
  const preview = usePreviewSlot();

  const writeMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyCardinalityWriteResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/cardinality", method: "POST" });

  /**
   * Everything that varies by direction, read off ONE per-arm record.
   *
   * `single` sizes what the flip ARMS; `multi` sizes what the un-curation
   * DISARMS. Both come from the same object as the labels, so the preview kind
   * and the button that fires the write can never disagree about which decision
   * is being made.
   */
  const copy = CARDINALITY_COPY[cardinality];

  /**
   * Whether the write may be attempted.
   *
   * Five conditions, and each corresponds to a failure this page has actually
   * shipped or nearly shipped: a write behind NO number, behind a PENDING one,
   * behind a FAILED one, behind a number for a DIFFERENT SLOT, or behind a
   * vocabulary this page could not read.
   *
   * ⚠️ Declared ABOVE `onWrite`, which reads it. As a hoisted function
   * declaration reading a `const`, `onWrite` only worked because a click cannot
   * happen before render finishes — a real guarantee today and a temporal-dead-zone
   * throw the moment anything calls it during render. `page.tsx` orders
   * `bothPicked` before `onAuthor` for the same reason.
   */
  const armed = surface !== null && preview.hasRadius;

  async function onPreview() {
    if (surface === null) return;
    // ⚠️ The PICKED norm — the same value `onWrite` sends one function down, and
    // that sameness is the whole point (#5466). `/preview` applies the alias
    // closure itself now, exactly as `/cardinality` always has, so both
    // endpoints resolve one surface to one slot server-side. This page used to
    // walk the edge list itself and send the RESOLVED norm here, because the two
    // routes keyed differently and something had to make them agree; that walk
    // was a second implementation of a rule the API owns, and it is gone.
    await preview.load({ kind: copy.previewKind, predicateSurface: surface.norm });
  }

  async function onWrite() {
    if (surface === null || !armed) return;
    setError(null);
    setNotice(null);
    // The PICKED norm — unchanged, and now the same value `onPreview` sends.
    //
    // The route applies the closure itself and documents doing so ("curating `is
    // priced at` after `is priced at → priced at` is approved correctly curates
    // `priced at`"), so sending the pick lets the SERVER decide the slot. It
    // always did; what changed is that `/preview` does too, so the count and the
    // write can no longer be about different slots.
    const body: CardinalityRequest = { predicateSurface: surface.norm, cardinality };
    const result = await writeMutation.mutate({ body });
    if (!result.ok) {
      // The SERVER's prose, verbatim — the rule this page follows everywhere. It
      // is also what makes the entitlement bar legible: the route re-resolves
      // owner/admin against the workspace being written rather than reading it
      // off the session, so an admin of another workspace reads that refusal
      // here instead of finding a control that does nothing.
      setError(friendlyError(result.error));
      // ⚠️ `response_schema_mismatch` is the one failure where the WRITE LANDED
      // and only its description failed — the route's own 500 prose says so and
      // tells the operator to reload. The prose is rendered verbatim above, but
      // returning without refetching asks them to reload for state this page can
      // fetch itself, and leaves the In-force pane showing a vocabulary that is
      // already stale. So the refetch fires on exactly that code, and on no
      // other: every remaining arm changed nothing, and re-reading for them would
      // suggest otherwise.
      if (result.error.code === "response_schema_mismatch") onWritten();
      return;
    }
    const written = result.data?.cardinality ?? cardinality;
    setNotice(
      written === "single"
        ? `“${surface.norm}” is now curated single-valued and approved. Every published pair in ` +
            `that slot is supersedable at the next publish, and every future claim in it can ` +
            `supersede an earlier one. Nothing has been superseded yet — run the tension sweep ` +
            `below to flag what this decision put in tension.`
        : `“${surface.norm}” is now recorded as multi-valued. Supersession is disarmed in that ` +
            `slot, and the row is the adjudicated record that its values coexist — not the ` +
            `absence of a decision.`,
    );
    setSurface(null);
    preview.clear();
    onWritten();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Declare a predicate&rsquo;s cardinality</CardTitle>
        <CardDescription>
          Whether a relation holds one value at a time or many. Curating a predicate{" "}
          <strong>single</strong> is what lets a later claim replace an earlier one in that slot —
          and it applies to claims that already exist, not only to new ones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <NormPicker
          position="predicate"
          label="Which predicate"
          value={surface}
          onChange={(next) => {
            setSurface(next);
            preview.clear();
            setError(null);
            // ⚠️ The NOTICE too. A successful write clears the picker and leaves
            // its confirmation on screen, which is right until the operator picks
            // a second predicate — at which point “reports to is now curated
            // single-valued” sits above a form about something else, and reads as
            // this predicate's state. Same shared-slot conflation the page's
            // `removeError` split fixed, one pane over.
            setNotice(null);
          }}
        />

        <div className="space-y-2">
          <span className="text-sm font-medium">Cardinality</span>
          <Select
            value={cardinality}
            onValueChange={(next) => {
              // Narrowed through the CANONICAL tuple, never cast — the page's own
              // rule for its position select, and `.find` rather than a literal
              // comparison for the same reason `POSITIONS.find` is: a cast would
              // swallow a typo in the item list too, and the picker would then
              // post a cardinality the API refuses with a 400 nobody could
              // explain.
              const picked = BRAIN_VOCABULARY_CARDINALITIES.find((c) => c === next);
              if (picked === undefined) return;
              setCardinality(picked);
              setNotice(null);
              // ⚠️ Cleared, because the preview is DIRECTION-SPECIFIC: a flip's
              // count and an un-curation's count are different questions with
              // opposite signs. Without this, picking `single`, previewing, then
              // switching to `multi` would arm the un-curation behind the flip's
              // number.
              preview.clear();
              setError(null);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Predicate cardinality">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BRAIN_VOCABULARY_CARDINALITIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {CARDINALITY_COPY[value].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {copy.hint}
          </p>
        </div>

        {/* Criterion 3's sentence, and it is on screen rather than in a docstring.
            A predicate absent from the table ALREADY behaves as multi, so an
            operator who writes `multi` has not changed how Atlas treats the slot
            — they have recorded that they looked. Without this, `multi` reads as
            a no-op and the one thing it is for is invisible. */}
        {copy.isAbsentRowDefault ? (
          <Alert>
            <AlertDescription className="text-sm">
              A predicate that is <strong>absent from this table already means multi</strong> — that
              is the default, and nothing in Atlas is arming supersession for it today. So writing{" "}
              <code>multi</code> does not change behaviour unless the predicate is currently curated{" "}
              <code>single</code>. What it always does is <em>record a human declining the
              question</em>, which is why a stored <code>multi</code> and an absent row are
              different facts even though they behave alike.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* The fold disclosure that stood here is GONE, and its absence is the
            fix rather than a regression (#5466).

            It existed to make a possible DISAGREEMENT visible: `/preview` keyed
            without the alias closure and `/cardinality` keyed with it, so this
            page walked the edge list, sent the resolved norm to the preview, and
            displayed the fold so an operator could see which norm the number was
            about. Its two refusal arms — `unresolvable` when the alias set could
            not be proven complete, `cyclic` when the walk did not terminate —
            were the honest answers of a walk that could fail.

            `/preview` now applies the closure itself, through the same
            `loadClaimVocabulary` + `slotKey` composition `/cardinality` runs, so
            both endpoints resolve one picked surface to one slot server-side.
            There is no disagreement left to disclose, no walk here to fail, and
            no completeness for this page to prove. The resolved key deliberately
            does NOT come back to render instead: `keys-not-on-the-wire.test.ts`
            refuses a slot key on the wire outright, and that prohibition is
            older and wider than this card. */}

        <BlastRadiusPreview
          radius={preview.slot.radius}
          pending={preview.slot.pending}
          error={preview.slot.error}
        />

        {error !== null ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {notice !== null ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex gap-2">
          {/* NOT "Preview the impact" — the alias card one pane up and the
              Pending queue's per-entry control both already read exactly that,
              so a third would make `getByRole("button", {name: /Preview the
              impact/i})` ambiguous. Distinct copy rather than a test-only
              disambiguation: three identically-labelled buttons on one page is
              an operator problem before it is a test problem. */}
          <Button
            variant="outline"
            // Gated on a pick, matching `onPreview`'s own guard. It used to
            // additionally require this page to have RESOLVED the pick; the
            // server resolves it now, so a pick is the whole precondition.
            disabled={surface === null || preview.slot.pending}
            onClick={onPreview}
          >
            Preview the cardinality impact
          </Button>
          <Button disabled={!armed || writeMutation.saving} onClick={onWrite}>
            {copy.writeLabel}
          </Button>
        </div>

        {/* `awaitingFirst` rather than a second spelling of the triple. The two
            re-derivations had already drifted by a term. */}
        {surface !== null && preview.awaitingFirst ? (
          <p className="text-muted-foreground text-xs">
            Preview first. Curating a predicate changes what replaces what across every claim
            already in that slot, so the blast radius is not optional.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
