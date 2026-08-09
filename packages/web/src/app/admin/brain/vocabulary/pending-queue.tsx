"use client";

import { useState } from "react";
import type { z } from "zod";
import type {
  BrainVocabularyAliasEvidence,
  BrainVocabularyBlastRadius,
  BrainVocabularyCorrectionEvidence,
  BrainVocabularyDecideResponse,
  BrainVocabularyPendingAlias,
  BrainVocabularyPendingCardinality,
  BrainVocabularyPendingEntry,
  BrainVocabularyPositionCounts,
  BrainVocabularySlotPosition,
} from "@/ui/lib/types";
import {
  BrainVocabularyDecideResponseSchema,
  BrainVocabularyPendingResponseSchema,
} from "@/ui/lib/admin-schemas";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { BlastRadiusPreview } from "./blast-radius";
import { ScopeBadge } from "./norm-picker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, ArrowRight, Link2, Merge, Scale } from "lucide-react";

/**
 * The **Pending** queue — one list, two evidence models (#5088).
 *
 * ## One queue means one LIST, not one row schema
 *
 * The list, its ordering, its filters, the decide verbs and the preview
 * affordance are SHARED: muscle memory transfers between the two kinds, and
 * neither gets a bespoke approval path that can drift from the other.
 *
 * The evidence rendering is deliberately **not** shared, and there is no common
 * *"seen N times"* column. An alias's gate is 2 distinct subjects and a
 * cardinality's is 3, and those are not comparable magnitudes — the alias gate
 * is lower precisely because agreement-without-a-slot is positive and typed
 * where a correction event is circumstantial. One column at equal visual weight
 * would let an approver read 3 as stronger than 2, inverting the epistemic
 * ranking the thresholds encode. Every magnitude here therefore carries its unit
 * as a PHRASE, never a bare number in a shared column.
 *
 * ## The two kinds are distinguishable at a glance, because the consequence is
 *
 * An alias moves a population between slots. A cardinality flip arms
 * supersession for every future claim in a slot — retroactively, at the next
 * publish. Different icon, different badge, different verb in the summary line.
 *
 * ## ⚠️ Direction is never prefilled
 *
 * `direction: null` is the COMMON case, not an edge case: direction reads a
 * positive warehouse allowlist and never the negation of a guard, so
 * unclassifiable, neither-warehouse **and both**-warehouse all yield undirected —
 * which on a workspace with no warehouse producer is every proposal there is.
 *
 * `A → B` and `B → A` re-key opposite row sets and have different blast radii, so
 * a default would launder a deliberate abstention into a machine opinion. Both
 * directions are offered, neither is selected, each carries its OWN preview, and
 * Approve stays disabled until one is picked and its preview has come back.
 *
 * ⚠️ **And never from population size.** The obvious heuristic points backwards
 * in the case that matters: a newly-adopted canonical spelling is RARER than the
 * sloppy one it replaces, which is exactly the migration this feature performs.
 * Nothing here sorts, preselects or recommends by count.
 */
export function PendingQueue() {
  const [kind, setKind] = useState<"all" | "alias" | "cardinality">("all");
  const [position, setPosition] = useState<"all" | BrainVocabularySlotPosition>("all");
  const [notice, setNotice] = useState<string | null>(null);

  const query = new URLSearchParams();
  if (kind !== "all") query.set("kind", kind);
  if (position !== "all") query.set("position", position);
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;

  const { data, error, loading, refetch } = useAdminFetch<
    z.infer<typeof BrainVocabularyPendingResponseSchema>
  >(`/api/v1/admin/brain-vocabulary/pending${suffix}`, {
    schema: BrainVocabularyPendingResponseSchema,
  });

  const entries = data?.entries ?? [];
  const aliasCounts = data?.aliasCounts ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending</CardTitle>
        <CardDescription>
          Proposals Atlas raised from your own corpus, awaiting a decision. Nothing here is in
          force — an alias re-keys claims only once you approve it, and a curated predicate arms
          supersession only once you do.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice !== null ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        {/* SHARED filters — one control set for both kinds. */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(next) => setKind(narrowKind(next) ?? kind)}>
            <SelectTrigger className="w-48" aria-label="Filter by proposal kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Both kinds</SelectItem>
              <SelectItem value="alias">Aliases only</SelectItem>
              <SelectItem value="cardinality">Curated predicates only</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={position}
            onValueChange={(next) => setPosition(narrowPosition(next) ?? position)}
          >
            <SelectTrigger className="w-48" aria-label="Filter by position">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every position</SelectItem>
              <SelectItem value="subject">Subject</SelectItem>
              <SelectItem value="predicate">Predicate</SelectItem>
              <SelectItem value="object">Object</SelectItem>
            </SelectContent>
          </Select>
          {aliasCounts.map((c) => (
            <PositionCountBadge key={c.position} counts={c} />
          ))}
          {/* ⚠️ `null` means the caller FILTERED this kind out, so there is no
              count to render. Zeroed, it read "curated predicates · 0 of 0" with
              a clean scope badge for a question nobody asked. */}
          {data?.cardinalityCounts != null ? (
            <PositionCountBadge counts={data.cardinalityCounts} label="curated predicates" />
          ) : null}
        </div>

        <Separator />

        {error !== null ? (
          // ⚠️ NOT "no proposals are pending". The list falls back to `[]` on
          // failure, so the flat sentence would state the queue is clear at the
          // moment nobody knows what is in it — the failed-vs-empty conflation
          // this whole surface exists to prevent.
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription>
              The pending queue could not be loaded, so this list is empty because the request
              failed — not because there is nothing awaiting a decision. {friendlyError(error)}
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <p className="text-muted-foreground text-sm">Loading what is awaiting a decision…</p>
        ) : entries.length === 0 ? (
          // ⚠️ Never "you're all caught up". There is no caught-up state for a
          // vocabulary — only what has been decided and what has not yet been
          // observed. The coverage statement above this card is what says WHY
          // this is empty; this line must not contradict it with a congratulation.
          <p className="text-muted-foreground text-sm">
            Nothing is awaiting a decision
            {aliasCounts.some((c) => c.withheld > 0) ||
            (data?.cardinalityCounts?.withheld ?? 0) > 0
              ? " that you can see"
              : ""}
            . That is not the
            same as nothing needing one — see what this workspace has observed, above.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entryKey(entry)}>
                <PendingRow
                  entry={entry}
                  onDecided={(message) => {
                    setNotice(message);
                    // Unawaited deliberately: `useAdminFetch` owns the refetch's
                    // own loading and error state, and a rejection surfaces
                    // through `error`, which this card already renders.
                    void refetch();
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        {/* ⚠️ TWO facts, two remedies. One boolean carried both and the copy
            stated one of them unconditionally — so a row DROPPED because it
            would not narrow was reported as reachable by filtering, sending an
            approver hunting for a proposal no query returns. */}
        {data?.truncated ? (
          <p className="text-muted-foreground text-xs">
            More proposals are awaiting a decision than are listed here. Filter to reach them —
            their absence from this page does not mean they were decided.
          </p>
        ) : null}
        {data?.incomplete ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription>
              Some proposals could not be read and are <strong>not listed here at all</strong>.
              Filtering will not reach them — this is a fault on Atlas&rsquo;s side, and the
              server-side log names it.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Narrowed, not cast — the page's own list, so a value outside it is a break. */
function narrowKind(value: string): "all" | "alias" | "cardinality" | null {
  return value === "all" || value === "alias" || value === "cardinality" ? value : null;
}
function narrowPosition(value: string): "all" | BrainVocabularySlotPosition | null {
  return value === "all" || value === "subject" || value === "predicate" || value === "object"
    ? value
    : null;
}

/**
 * A cardinality entry has no id — its table is keyed on a predicate key, which
 * may never reach the wire — so the surface plus the kind is the row identity.
 * Stable enough for a list key because the queue holds at most one pending row
 * per predicate (the table's primary key guarantees it).
 */
function entryKey(entry: BrainVocabularyPendingEntry): string {
  return entry.kind === "alias"
    ? `alias:${entry.id}`
    : `cardinality:${entry.predicateSurface ?? "unaddressable"}`;
}

function PositionCountBadge({
  counts,
  label,
}: {
  counts: BrainVocabularyPositionCounts;
  label?: string;
}) {
  return (
    <div className="border-border flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
      <span className="font-medium capitalize">{label ?? counts.position}</span>
      <span className="text-muted-foreground">
        {counts.scoped} of {counts.total}
      </span>
      <ScopeBadge scope={counts.scope} />
      {/* ⚠️ A withheld count, never a silent omission. */}
      {counts.withheld > 0 ? <Badge variant="outline">{counts.withheld} withheld</Badge> : null}
      {!counts.countsConsistent ? <Badge variant="destructive">counts disagreed</Badge> : null}
    </div>
  );
}

function PendingRow({
  entry,
  onDecided,
}: {
  entry: BrainVocabularyPendingEntry;
  onDecided: (message: string) => void;
}) {
  return entry.kind === "alias" ? (
    <PendingAliasRow entry={entry} onDecided={onDecided} />
  ) : (
    <PendingCardinalityRow entry={entry} onDecided={onDecided} />
  );
}

// ---------------------------------------------------------------------------
// The alias half
// ---------------------------------------------------------------------------

/** One preview's three states, kept together so they cannot drift apart. */
interface PreviewSlot {
  readonly radius: BrainVocabularyBlastRadius | null;
  readonly pending: boolean;
  readonly error: string | null;
}

const EMPTY_PREVIEW: PreviewSlot = { radius: null, pending: false, error: null };

function PendingAliasRow({
  entry,
  onDecided,
}: {
  entry: BrainVocabularyPendingAlias;
  onDecided: (message: string) => void;
}) {
  const [forward, reverse] = orderings(entry);
  /**
   * ⚠️ Initialised to `null` for an undirected proposal, and to the PRODUCER's
   * direction for a directed one — never to `forward` as a fallback.
   *
   * `pair` is *"the pair in the order it arrived"* for an undirected proposal, so
   * seeding from it would be the implicit *"first norm wins"* the approval seam
   * refuses at the server. The seam would still refuse it (`direction-required`
   * is sent nothing), but the UI would have shown a selected radio nobody chose —
   * which is the half of the defect a server check cannot catch.
   */
  // ⚠️ Seeded from `entry.direction` ITSELF, never from `forward`. "`direction`,
  // when non-null, is `[pair[0], pair[1]]`" is prose the wire does not enforce —
  // a payload whose direction is the REVERSE ordering of `pair` is representable
  // in both the type and the schema, and seeding from `forward` would then
  // preselect the ordering the producer did NOT claim, on the surface whose
  // entire product is honest notice.
  const [chosen, setChosen] = useState<Ordering | null>(entry.direction);
  const [previews, setPreviews] = useState<Record<string, PreviewSlot>>({});
  const [decideError, setDecideError] = useState<string | null>(null);

  const previewMutation = useAdminMutation<{ radius: BrainVocabularyBlastRadius }>({
    path: "/api/v1/admin/brain-vocabulary/preview",
    method: "POST",
  });
  // ⚠️ The SHARED wire type, not a hand-rolled structural twin. The twin widened
  // `outcome` to `string`, so `outcome === "nothing_to_decide"` was a bare string
  // comparison in two files: rename the wire member and both still compile, and
  // `decideNotice` then tells the approver who LOST the race that every affected
  // claim has been re-keyed — the exact miscredit its own docstring exists to
  // prevent.
  const decideMutation = useAdminMutation<BrainVocabularyDecideResponse>({
    path: "/api/v1/admin/brain-vocabulary/decide",
    method: "POST",
  });

  /**
   * Load ONE ordering's blast radius.
   *
   * ⚠️ Keyed by ordering, so the two directions never share a slot. A single
   * shared `radius` would let the preview for `A → B` gate an approval of
   * `B → A` — a number computed for the opposite re-key, satisfying the gate
   * that exists to stop exactly that. `blast-radius` is the same component the
   * authoring card uses; the AC's *both directions render with their OWN
   * preview* is this keying plus that reuse.
   *
   * LAZY: nothing is fetched until an ordering is expanded or picked. The list
   * needs only the pair and the evidence.
   */
  async function loadPreview(ordering: Ordering): Promise<void> {
    const key = orderingKey(ordering);
    setPreviews((prev) => ({ ...prev, [key]: { radius: null, pending: true, error: null } }));
    const result = await previewMutation.mutate({
      body: {
        kind: "alias-approval",
        position: entry.position,
        fromNorm: ordering.fromNorm,
        toNorm: ordering.toNorm,
      },
    });
    setPreviews((prev) => ({
      ...prev,
      [key]: result.ok
        ? { radius: result.data?.radius ?? null, pending: false, error: null }
        : { radius: null, pending: false, error: friendlyError(result.error) },
    }));
  }

  async function decide(decision: "approved" | "rejected"): Promise<void> {
    setDecideError(null);
    const result = await decideMutation.mutate({
      body:
        decision === "approved"
          ? {
              kind: "alias",
              proposalId: entry.id,
              decision: "approved",
              // Only ever the CHOSEN ordering. The button is disabled while this
              // is null, and the server refuses `direction-required` if it ever
              // is not — two independent statements of one rule, on purpose.
              ...(chosen === null ? {} : { direction: chosen }),
            }
          : { kind: "alias", proposalId: entry.id, decision: "rejected" },
    });
    if (!result.ok) {
      // The SERVER's prose, verbatim — it names which ordering is not the pair's,
      // why a directed proposal is not flipped, and what to do instead.
      setDecideError(friendlyError(result.error));
      return;
    }
    const outcome = readDecideOutcome(result.data);
    if (outcome === null) {
      // ⚠️ NOT reported as the verb they pressed. `useAdminMutation` resolves
      // `{ ok: true, data: undefined }` for any 2xx whose body is not JSON, and
      // `outcome ?? ""` fell straight through to the STRONGEST success string —
      // "every affected claim has been re-keyed" — for a response nobody read.
      setDecideError(
        "Atlas could not confirm what happened to this proposal — the server answered, but not " +
          "in a shape this page understands. Reload before deciding again rather than retrying.",
      );
      return;
    }
    onDecided(decideNotice(entry, chosen, decision, outcome));
  }

  const chosenKey = chosen === null ? null : orderingKey(chosen);
  const chosenPreview = chosenKey === null ? EMPTY_PREVIEW : (previews[chosenKey] ?? EMPTY_PREVIEW);
  const approvable =
    chosen !== null && chosenPreview.radius !== null && chosenPreview.error === null;

  return (
    <div className="border-border space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* The KIND, at a glance: a merge icon for an alias. */}
        <Merge className="size-4 shrink-0" aria-hidden />
        <Badge variant="secondary">Alias</Badge>
        <span className="text-sm">
          <span className="font-mono">{entry.pair[0]}</span>
          <span className="text-muted-foreground mx-2">·</span>
          <span className="font-mono">{entry.pair[1]}</span>
        </span>
        <Badge variant="outline" className="capitalize">
          {entry.position}
        </Badge>
      </div>

      <p className="text-muted-foreground text-xs">
        Approving this moves every claim whose {entry.position} folds to one spelling into the
        other&rsquo;s slot. Raised by {entry.proposedBy || "an unnamed producer"} (
        {entry.sourceClass || "unrecorded source"}) · rank {entry.rank.toFixed(2)}, which orders
        this queue and is not a probability.
      </p>

      <AliasEvidenceBlock evidence={entry.evidence} />

      <DirectionChoice
        entry={entry}
        forward={forward}
        reverse={reverse}
        chosen={chosen}
        onChoose={(ordering) => {
          setChosen(ordering);
          if (previews[orderingKey(ordering)] === undefined) void loadPreview(ordering);
        }}
        previews={previews}
        onPreview={(ordering) => void loadPreview(ordering)}
      />

      {decideError !== null ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>{decideError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!approvable || decideMutation.saving} onClick={() => void decide("approved")}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={decideMutation.saving}
          onClick={() => void decide("rejected")}
        >
          Reject
        </Button>
      </div>
      {chosen === null ? (
        <p className="text-muted-foreground text-xs">
          Pick a direction. Nothing in the evidence says which spelling is canonical, and Atlas will
          not guess: the two directions re-key opposite sets of claims.
        </p>
      ) : chosenPreview.radius === null ? (
        <p className="text-muted-foreground text-xs">
          Preview first. This decision re-keys every affected claim in the workspace, so the blast
          radius is not optional.
        </p>
      ) : null}
    </div>
  );
}

/** One ordering of a pair. Not a direction until a human picks it. */
interface Ordering {
  readonly fromNorm: string;
  readonly toNorm: string;
}

function orderingKey(ordering: Ordering): string {
  // ` ` for `pairKey`'s reason one package over: a separator that cannot
  // occur in a norm, so two orderings cannot collide by containing the other's
  // separator.
  return `${ordering.fromNorm} ${ordering.toNorm}`;
}

function orderingsEqual(a: Ordering, b: Ordering): boolean {
  return a.fromNorm === b.fromNorm && a.toNorm === b.toNorm;
}

/**
 * The two orderings, in the row's own stored order first.
 *
 * ⚠️ **Stored order, and NEVER sorted by population.** The obvious heuristic —
 * merge the smaller spelling into the bigger one — points backwards during
 * exactly the migration this feature performs: a newly-adopted canonical
 * spelling is rarer than the sloppy one it replaces. Presenting the orderings in
 * an order derived from any count would be that heuristic, applied by layout
 * instead of by code, and it would be just as persuasive.
 */
function orderings(entry: BrainVocabularyPendingAlias): [Ordering, Ordering] {
  const [a, b] = entry.pair;
  return [
    { fromNorm: a, toNorm: b },
    { fromNorm: b, toNorm: a },
  ];
}

/**
 * The direction picker — two orderings, each with its own preview.
 *
 * ## Undirected: nothing selected, both offered
 *
 * Approve stays disabled until one is picked. Picking loads that ordering's
 * blast radius; the other stays uncomputed until expanded, because the list
 * needs only the pair and the evidence and a second preview is a second
 * workspace-wide scan.
 *
 * ## Directed: the alternative is still SHOWN, greyed, with its own count
 *
 * A producer's direction is EVIDENCE, not authority, and an approver overriding
 * it should see what they are overriding. But it cannot be picked here: the seam
 * refuses a flip at approval (`direction-conflict`) because the reviewer read
 * one direction and re-keying in the other is indistinguishable afterwards. So
 * the alternative renders with a preview affordance and no selection, and the
 * copy says the recovery is to reject and author the edge you want.
 */
function DirectionChoice({
  entry,
  forward,
  reverse,
  chosen,
  onChoose,
  previews,
  onPreview,
}: {
  entry: BrainVocabularyPendingAlias;
  forward: Ordering;
  reverse: Ordering;
  chosen: Ordering | null;
  onChoose: (ordering: Ordering) => void;
  previews: Record<string, PreviewSlot>;
  onPreview: (ordering: Ordering) => void;
}) {
  const directed = entry.direction !== null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {directed ? "Direction (claimed by the producer)" : "Direction — not yet chosen"}
      </p>
      {!directed ? (
        <p className="text-muted-foreground text-xs">
          Neither spelling is warehouse-derived, so nothing in the evidence says which is canonical.
          Atlas leaves this blank rather than defaulting: a default would turn a deliberate
          abstention into a machine opinion.
        </p>
      ) : null}
      {[forward, reverse].map((ordering) => {
        // ⚠️ Compared BY VALUE against the producer's claim, not by index. The
        // index test assumed `direction === [pair[0], pair[1]]`, which is prose
        // rather than a wire invariant — see the `useState` seed above.
        const isProducers =
          entry.direction !== null && orderingsEqual(ordering, entry.direction);
        const selectable = !directed || isProducers;
        const slot = previews[orderingKey(ordering)] ?? EMPTY_PREVIEW;
        return (
          <div
            key={orderingKey(ordering)}
            className={
              "border-border rounded-md border px-3 py-2 " +
              (chosen !== null && orderingsEqual(chosen, ordering)
                ? "bg-muted/60"
                : selectable
                  ? ""
                  : "opacity-60")
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">
                <span className="font-mono">{ordering.fromNorm}</span>
                <ArrowRight className="mx-2 inline size-3.5" aria-hidden />
                <span className="font-mono">{ordering.toNorm}</span>
              </span>
              {isProducers ? <Badge variant="secondary">producer&rsquo;s claim</Badge> : null}
              {directed && !isProducers ? <Badge variant="outline">not available</Badge> : null}
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" disabled={slot.pending} onClick={() => onPreview(ordering)}>
                  {slot.radius === null ? "Preview" : "Re-check"}
                </Button>
                {selectable ? (
                  <Button
                    size="sm"
                    variant={
                      chosen !== null && orderingsEqual(chosen, ordering) ? "default" : "outline"
                    }
                    onClick={() => onChoose(ordering)}
                  >
                    {chosen !== null && orderingsEqual(chosen, ordering) ? "Chosen" : "Choose this"}
                  </Button>
                ) : null}
              </div>
            </div>
            {directed && !isProducers ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Atlas will not flip a directed proposal at approval — you would be approving a
                re-key in the opposite direction from the one the evidence describes, and afterwards
                the two are indistinguishable. Its impact is shown so you can see what you would be
                overriding; to take it, reject this proposal and author the edge you want.
              </p>
            ) : null}
            {slot.radius !== null || slot.pending || slot.error !== null ? (
              <div className="mt-2">
                <BlastRadiusPreview
                  radius={slot.radius}
                  pending={slot.pending}
                  error={slot.error}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The alias evidence — *what agreed, and across how many distinct subjects*.
 *
 * ⚠️ The magnitude carries its UNIT as a phrase. Never a bare `2` in a column a
 * cardinality row also fills, because the two gates count the same thing
 * (distinct subjects) for different reasons and at different bars, and a shared
 * column invites the comparison the thresholds are designed to prevent.
 *
 * ⚠️ The `not-applicable` arm is not a zero. At an entity position the structural
 * question cannot be asked at all — the producer holds two claims in one SUBJECT
 * slot and compares their predicates — so *"0 subjects agree"* would report a
 * warehouse-key proposal as unsupported when its support is a primary key.
 */
function AliasEvidenceBlock({ evidence }: { evidence: BrainVocabularyAliasEvidence }) {
  if (evidence.kind === "not-applicable") {
    return (
      <p className="text-muted-foreground text-sm">
        Atlas raises structural evidence only for <strong>predicate</strong> pairs — it looks for
        two claims about one subject that agree about the object under different verbs. That
        question cannot be asked at this position, so this proposal has none, and that is not the
        same as none being found. Judge it on where it came from.
      </p>
    );
  }
  const { subjects, withheld, examples, threshold, countsConsistent } = evidence;
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-medium">
          {subjects} distinct {subjects === 1 ? "subject" : "subjects"} in your corpus
          {subjects === 1 ? " has" : " have"} claims that agree about the object under both
          spellings
        </span>{" "}
        <span className="text-muted-foreground">
          (Atlas raises a proposal at {threshold}
          {subjects < threshold
            ? " — this now reads below the bar that raised it, because the count is re-derived from the corpus as it stands"
            : ""}
          ).
        </span>
        {withheld > 0 ? (
          <span className="text-muted-foreground">
            {" "}
            {withheld} of {withheld === 1 ? "them involves a claim" : "them involve claims"} you
            cannot read, so {withheld === 1 ? "it is" : "they are"} counted but not shown.
          </span>
        ) : null}
        {!countsConsistent ? (
          <span className="text-destructive">
            {" "}
            These counts disagreed, so treat them as approximate rather than as facts.
          </span>
        ) : null}
      </p>
      {examples.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-md border text-xs">
          {examples.map((example, index) => (
            <li key={`${example.subject}:${index}`} className="px-3 py-2">
              <span className="font-medium">{example.subject}</span>
              <span className="text-muted-foreground">
                {" "}
                — “{example.fromPredicate}” and “{example.toPredicate}” both say{" "}
              </span>
              <span className="font-medium">{example.object}</span>
            </li>
          ))}
        </ul>
      ) : subjects > 0 ? (
        <p className="text-muted-foreground text-xs">
          None of the agreeing claims are readable by you, so the count above is all this page can
          show.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Nothing in your corpus currently exhibits this agreement.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The cardinality half
// ---------------------------------------------------------------------------

function PendingCardinalityRow({
  entry,
  onDecided,
}: {
  entry: BrainVocabularyPendingCardinality;
  onDecided: (message: string) => void;
}) {
  const [preview, setPreview] = useState<PreviewSlot>(EMPTY_PREVIEW);
  const [decideError, setDecideError] = useState<string | null>(null);

  const previewMutation = useAdminMutation<{ radius: BrainVocabularyBlastRadius }>({
    path: "/api/v1/admin/brain-vocabulary/preview",
    method: "POST",
  });
  const decideMutation = useAdminMutation<BrainVocabularyDecideResponse>({
    path: "/api/v1/admin/brain-vocabulary/decide",
    method: "POST",
  });

  // ⚠️ The narrowing IS the decidability. There is no `decidable` boolean beside
  // this any more: it was fully derived from the same field and the pair admitted
  // `{ predicateSurface: null, decidable: true }`, which renders the Approve
  // button that 400s — the state the flag was added to prevent.
  const surface = entry.predicateSurface;

  async function loadPreview(): Promise<void> {
    if (surface === null) return;
    setPreview({ radius: null, pending: true, error: null });
    const result = await previewMutation.mutate({
      body: { kind: "cardinality-flip", predicateSurface: surface },
    });
    setPreview(
      result.ok
        ? { radius: result.data?.radius ?? null, pending: false, error: null }
        : { radius: null, pending: false, error: friendlyError(result.error) },
    );
  }

  async function decide(decision: "approved" | "rejected"): Promise<void> {
    if (surface === null) return;
    setDecideError(null);
    const result = await decideMutation.mutate({
      body: { kind: "cardinality", predicateSurface: surface, decision },
    });
    if (!result.ok) {
      setDecideError(friendlyError(result.error));
      return;
    }
    const outcome = readDecideOutcome(result.data);
    if (outcome === null) {
      // See the alias arm: an unreadable body must never be reported as the
      // strongest success, and this one arms RETROACTIVE supersession.
      setDecideError(
        "Atlas could not confirm what happened to this proposal — the server answered, but not " +
          "in a shape this page understands. Reload before deciding again rather than retrying.",
      );
      return;
    }
    onDecided(
      outcome.outcome === "nothing_to_decide"
        ? `“${surface}” had already been decided, or is being decided right now — nothing changed here.`
        : decision === "approved"
          ? `Curated: “${surface}” now holds one value at a time. Every future claim in that slot can supersede an earlier one at the next publish.`
          : `Rejected: “${surface}” stays multi-valued. Atlas remembers this permanently, so its producers will not re-propose it.`,
    );
  }

  return (
    <div className="border-border space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* The KIND, at a glance: scales for a cardinality decision. */}
        <Scale className="size-4 shrink-0" aria-hidden />
        <Badge variant="secondary">Curated predicate</Badge>
        <span className="font-mono text-sm">
          {surface ?? "(no live claim carries this predicate)"}
        </span>
        <Badge variant="outline">{entry.cardinality}</Badge>
      </div>

      <p className="text-muted-foreground text-xs">
        {entry.cardinality === "single" ? (
          <>
            Approving this arms supersession for <strong>every future claim</strong> in this slot,
            and makes every existing published pair in it supersedable at the next publish —
            retroactively, with no per-row record of the regime each claim was written under. That
            is a different kind of change from an alias: it does not move a population, it changes
            what replaces what.
          </>
        ) : (
          <>
            Approving this records that values in this slot coexist. Nothing is superseded by it;
            it is the adjudicated answer that stops producers re-proposing the question.
          </>
        )}{" "}
        Raised by {entry.proposedBy || "an unnamed producer"} ({entry.sourceClass || "unrecorded source"}) ·{" "}
        {entry.claims} live {entry.claims === 1 ? "claim" : "claims"} in this slot.
      </p>

      <CorrectionEvidenceBlock evidence={entry.evidence} />

      {surface === null ? (
        // ⚠️ Stated, not left as a disabled button with no explanation. The entry
        // is real and is arming nothing yet, but every claim that produced its
        // predicate has been retracted — so there is no surface to name, and the
        // decide route addresses rows by surface precisely so no key reaches the
        // wire. An approver needs to know the row exists and why they cannot act.
        <Alert>
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            Every claim that produced this predicate has since been retracted, so Atlas has no
            spelling to address it by and this proposal cannot be decided from here. It is arming
            nothing while it stays pending.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <BlastRadiusPreview
            radius={preview.radius}
            pending={preview.pending}
            error={preview.error}
          />
          {decideError !== null ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <AlertDescription>{decideError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={preview.pending} onClick={() => void loadPreview()}>
              {preview.radius === null ? "Preview the impact" : "Re-check the impact"}
            </Button>
            <Button
              size="sm"
              disabled={
                decideMutation.saving || preview.radius === null || preview.error !== null
              }
              onClick={() => void decide("approved")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decideMutation.saving}
              onClick={() => void decide("rejected")}
            >
              Reject
            </Button>
          </div>
          {preview.radius === null ? (
            <p className="text-muted-foreground text-xs">
              Preview first. Curating a predicate is retroactive, so the blast radius is not
              optional.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The cardinality evidence — *how many corrections, and links to them*.
 *
 * ⚠️ **TWO numbers, and the AC's shorthand for them is wrong.** #5088 calls this
 * *"3 corrections"*, but the gate is `COUNT(DISTINCT subject_key)` — a reviewer
 * editing one slot four times has told Atlas about that slot, not about the
 * predicate, so repeated edits to one subject count once. Rendering only
 * *"3 corrections"* would name a number no gate reads. So the sentence leads with
 * the SUBJECTS that crossed the bar and carries the event count beside it.
 *
 * That also keeps the two kinds from being compared: both gates happen to count
 * distinct subjects, so a bare N really would be comparable — and comparable in
 * the wrong direction, because 3 circumstantial corrections are weaker evidence
 * than 2 typed agreements, not stronger.
 */
function CorrectionEvidenceBlock({ evidence }: { evidence: BrainVocabularyCorrectionEvidence }) {
  const { subjects, events, withheld, examples, threshold, countsConsistent } = evidence;
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-medium">
          A human has replaced a value at this predicate for {subjects} distinct{" "}
          {subjects === 1 ? "subject" : "subjects"}, across {events}{" "}
          {events === 1 ? "correction" : "corrections"}
        </span>{" "}
        <span className="text-muted-foreground">
          (Atlas raises a proposal at {threshold} subjects — repeated edits to one subject count
          once, because they say more about that slot than about the predicate
          {subjects < threshold
            ? "; this now reads below the bar that raised it, because the count is re-derived from the corpus as it stands"
            : ""}
          ).
        </span>
        {withheld > 0 ? (
          <span className="text-muted-foreground">
            {" "}
            {withheld} of {withheld === 1 ? "them involves a claim" : "them involve claims"} you
            cannot read, so {withheld === 1 ? "it is" : "they are"} counted but not shown.
          </span>
        ) : null}
        {!countsConsistent ? (
          <span className="text-destructive">
            {" "}
            These counts disagreed, so treat them as approximate rather than as facts.
          </span>
        ) : null}
      </p>
      {examples.length > 0 ? (
        <ul className="border-border divide-border divide-y rounded-md border text-xs">
          {examples.map((example) => (
            <li key={example.factId} className="flex items-start gap-2 px-3 py-2">
              <Link2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">{example.subject}</span>
                <span className="text-muted-foreground">: “{example.fromObject}” → </span>
                <span className="font-medium">“{example.toObject}”</span>
                <span className="text-muted-foreground"> · {example.at}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : subjects > 0 ? (
        <p className="text-muted-foreground text-xs">
          None of those corrections are readable by you, so the count above is all this page can
          show.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          No correction in your corpus currently supports this — it may have been raised before the
          claims behind it were retracted.
        </p>
      )}
    </div>
  );
}

/**
 * Parse the decide response, or `null` when it did not read back as one.
 *
 * ⚠️ `null` is a STATE, not a fallback. `useAdminMutation` resolves
 * `{ ok: true, data: undefined }` for any 2xx whose body is not JSON, and the
 * earlier `result.data?.outcome ?? ""` fell through every branch into the
 * strongest success sentence. On a surface where one of those sentences means
 * *"retroactive supersession is now armed"*, a body nobody read must produce an
 * explicit "Atlas could not confirm" rather than the most consequential guess.
 */
function readDecideOutcome(
  data: BrainVocabularyDecideResponse | undefined,
): BrainVocabularyDecideResponse | null {
  const parsed = BrainVocabularyDecideResponseSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * What actually happened, in the approver's words.
 *
 * ⚠️ `nothing_to_decide` is reported as itself rather than as the verb they
 * pressed. It is a truthful 200 — somebody else decided the row, or one is in
 * flight — and telling them "approved" would credit them with a workspace-wide
 * re-key they did not cause.
 *
 * ⚠️ `removedEdge` is read off the REJECTED arm only, because that is the only
 * arm that carries it. Flat, the type let the route invent `false` on an
 * approval and on a lost race; discriminated, this function cannot read it
 * anywhere it would be a fabrication.
 */
function decideNotice(
  entry: BrainVocabularyPendingAlias,
  chosen: Ordering | null,
  decision: "approved" | "rejected",
  outcome: BrainVocabularyDecideResponse,
): string {
  const pair = chosen ?? { fromNorm: entry.pair[0], toNorm: entry.pair[1] };
  if (outcome.outcome === "nothing_to_decide") {
    return `“${entry.pair[0]}” / “${entry.pair[1]}” had already been decided, or is being decided right now — nothing changed here.`;
  }
  if (outcome.outcome === "approved") {
    return `Approved: “${pair.fromNorm}” now resolves to “${pair.toNorm}”, and every affected claim has been re-keyed.`;
  }
  void decision;
  return outcome.removedEdge
    ? `Removed: the approved edge for “${entry.pair[0]}” / “${entry.pair[1]}” is gone, every affected claim has been re-keyed back, and Atlas remembers the removal permanently.`
    : `Rejected: “${entry.pair[0]}” and “${entry.pair[1]}” stay separate spellings. Atlas remembers this permanently, so its producers will not re-propose the pair.`;
}
