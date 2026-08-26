"use client";

import { useRef, useState } from "react";
import type { z } from "zod";
import type {
  BrainVocabularyBlastRadius,
  BrainVocabularyCardinality,
  BrainVocabularyEdgeEntry,
  BrainVocabularySurfaceOption,
} from "@/ui/lib/types";
import {
  BRAIN_VOCABULARY_CARDINALITIES,
  BrainVocabularyCardinalityRequestSchema,
  BrainVocabularyCardinalityWriteResponseSchema,
  BrainVocabularyPreviewResponseSchema,
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
 * ## ⚠️ The alias divergence, disclosed rather than papered over
 *
 * `/preview` keys its cardinality arms with `identityKey(predicateSurface)` —
 * normalization only. `/cardinality` keys its write with `slotKey(predicateSurface,
 * predicateAlias)` — normalization **and the alias closure**. Those agree for an
 * unaliased predicate and diverge for an aliased one, and the picker offers
 * aliased norms because it groups by the norm of the observed SURFACE, not by the
 * closed key.
 *
 * So for a predicate that is the source of an in-force predicate alias, the
 * number on screen describes one slot and the write lands in another. Both
 * behaviours are correct in isolation — the route documents curating
 * `is priced at` as correctly curating `priced at` — but the pair of them
 * defeats the single property that justifies offering this control.
 *
 * This card therefore detects that state from the in-force edges it is handed,
 * names the target, and refuses to arm the write. The operator's route is to pick
 * the target norm, where the preview and the write agree. Fixing the API to close
 * the alias in `/preview` would be the better repair and is out of this change's
 * scope; until then a surface that wrote silently across the divergence would be
 * the confident-false-number failure this whole area is built to refuse.
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
const CARDINALITY_COPY: Record<
  BrainVocabularyCardinality,
  { readonly label: string; readonly hint: string }
> = {
  single: {
    label: "single — one value at a time",
    hint:
      "⚠️ Retroactive. Every published pair already in this slot becomes supersedable at the " +
      "next publish, and Atlas keeps no per-row record of which regime each claim was written " +
      "under — so the count below is the floor, never a total.",
  },
  multi: {
    label: "multi — values coexist",
    hint:
      "Multi is the un-curation: the adjudicated record that these values coexist, and the only " +
      "way back out of single short of a database operation.",
  },
};

export function CardinalityAuthoring({
  edges,
  vocabularyKnown,
  onWritten,
}: {
  /** In-force alias edges, for the divergence check. Predicate-position only is read. */
  edges: readonly BrainVocabularyEdgeEntry[];
  /**
   * Whether {@link edges} is the workspace's whole in-force predicate vocabulary.
   *
   * ⚠️ `false` for a FAILED load and for a TRUNCATED one, and it blocks the
   * write in both. The list falls back to `[]` on failure, so "no alias edge
   * starts at this norm" and "nobody knows what starts at this norm" are the same
   * value — and the divergence above is precisely the hazard an absent edge would
   * be read as ruling out.
   */
  vocabularyKnown: boolean;
  onWritten: () => void;
}) {
  const [surface, setSurface] = useState<BrainVocabularySurfaceOption | null>(null);
  const [cardinality, setCardinality] = useState<BrainVocabularyCardinality>("single");
  const [radius, setRadius] = useState<{
    readonly radius: BrainVocabularyBlastRadius | null;
    readonly pending: boolean;
    readonly error: string | null;
  }>({ radius: null, pending: false, error: null });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The same generation counter the page's two preview slots carry, and for the
   * same defect: every reset here is synchronous and none of them invalidates an
   * in-flight preview, so a response for the OLD decision lands afterwards and
   * re-arms the write gate with a number computed for a different predicate — or,
   * worse here, for the opposite VERB, since changing the direction resets
   * without previewing.
   */
  const generation = useRef(0);

  const previewMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyPreviewResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/preview", method: "POST" });
  const writeMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyCardinalityWriteResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/cardinality", method: "POST" });

  function clearRadius() {
    generation.current += 1;
    setRadius({ radius: null, pending: false, error: null });
  }

  /**
   * The alias edge that would move this write to another slot, or `null`.
   *
   * Read off the in-force list rather than re-derived: the closure is what the
   * write will apply, and a second client-side implementation of it would be a
   * second thing to keep true. This only has to detect that a divergence EXISTS
   * — the target norm to point at comes straight off the edge.
   */
  const aliasedOnto =
    surface === null
      ? null
      : (edges.find((e) => e.position === "predicate" && e.fromNorm === surface.norm) ?? null);

  /**
   * The preview kind for the chosen direction.
   *
   * `single` sizes what the flip ARMS; `multi` sizes what the un-curation
   * DISARMS. Derived rather than stored so the two can never be out of step —
   * the state that would let a `single` write ship behind a removal's count.
   */
  const previewKind = cardinality === "single" ? "cardinality-flip" : "cardinality-removal";

  async function onPreview() {
    if (surface === null) return;
    const mine = ++generation.current;
    setRadius({ radius: null, pending: true, error: null });
    const result = await previewMutation.mutate({
      body: { kind: previewKind, predicateSurface: surface.norm },
    });
    // The decision moved on while this was in flight — drop it. See `generation`.
    if (mine !== generation.current) return;
    if (!result.ok) {
      setRadius({ radius: null, pending: false, error: friendlyError(result.error) });
      return;
    }
    setRadius({ radius: result.data?.radius ?? null, pending: false, error: null });
  }

  async function onWrite() {
    if (surface === null || !armed) return;
    setError(null);
    setNotice(null);
    const body: CardinalityRequest = { predicateSurface: surface.norm, cardinality };
    const result = await writeMutation.mutate({ body });
    if (!result.ok) {
      // The SERVER's prose, verbatim — the rule this page follows everywhere. It
      // is also what makes the entitlement bar legible: the route re-resolves
      // owner/admin against the workspace being written rather than reading it
      // off the session, so an admin of another workspace reads that refusal
      // here instead of finding a control that does nothing.
      setError(friendlyError(result.error));
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
    clearRadius();
    onWritten();
  }

  /**
   * Whether the write may be attempted.
   *
   * Four independent conditions, and each one has produced the same class of
   * failure on this page before: a write behind no number, behind a stale
   * number, behind a FAILED number, or behind a number for a different slot.
   */
  const armed =
    surface !== null &&
    radius.radius !== null &&
    radius.error === null &&
    !radius.pending &&
    aliasedOnto === null &&
    vocabularyKnown;

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
            clearRadius();
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
              clearRadius();
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
            {CARDINALITY_COPY[cardinality].hint}
          </p>
        </div>

        {/* Criterion 3's sentence, and it is on screen rather than in a docstring.
            A predicate absent from the table ALREADY behaves as multi, so an
            operator who writes `multi` has not changed how Atlas treats the slot
            — they have recorded that they looked. Without this, `multi` reads as
            a no-op and the one thing it is for is invisible. */}
        {cardinality === "multi" ? (
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

        {/* ⚠️ The divergence, and it blocks. See the module docstring. */}
        {aliasedOnto !== null ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription className="text-sm">
              <span className="font-medium">
                “{aliasedOnto.fromNorm}” is aliased onto “{aliasedOnto.toNorm}”, so this decision
                would not land in the slot the preview measures.
              </span>{" "}
              The write applies your workspace&rsquo;s alias closure and would curate “
              {aliasedOnto.toNorm}”; the preview does not, and counts “{aliasedOnto.fromNorm}”. Both
              answers are correct about different slots, which is exactly the case where a number
              cannot license a decision. Pick “{aliasedOnto.toNorm}” instead — there the count and
              the write are about the same slot.
            </AlertDescription>
          </Alert>
        ) : null}

        {surface !== null && !vocabularyKnown ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription className="text-sm">
              This page could not read the whole of what is in force, so it cannot tell whether “
              {surface.norm}” is aliased onto another predicate — and an alias would move this write
              to a different slot than the one previewed. That is <strong>unknown, not clear</strong>
              . Reload before deciding.
            </AlertDescription>
          </Alert>
        ) : null}

        <BlastRadiusPreview
          radius={radius.radius}
          pending={radius.pending}
          error={radius.error}
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
            disabled={surface === null || radius.pending}
            onClick={onPreview}
          >
            Preview the cardinality impact
          </Button>
          <Button disabled={!armed || writeMutation.saving} onClick={onWrite}>
            {cardinality === "single" ? "Curate as single-valued" : "Record as multi-valued"}
          </Button>
        </div>

        {surface !== null && radius.radius === null && radius.error === null && !radius.pending ? (
          <p className="text-muted-foreground text-xs">
            Preview first. Curating a predicate changes what replaces what across every claim
            already in that slot, so the blast radius is not optional.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
