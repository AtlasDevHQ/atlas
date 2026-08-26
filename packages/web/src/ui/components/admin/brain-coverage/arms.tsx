"use client";

/**
 * The Coverage Surface's two arms, rendered (#5215, ADR-0041).
 *
 * ## The rendering rules here are DECISIONS, not styling
 *
 * Each of the following is a line from the ADR, and changing it changes what the
 * page claims:
 *
 *   - **State 3 renders as a mark with no number.** {@link MapEdgeList} has no
 *     count and no field one could be put in — *"any denominator that includes
 *     it is fabricated"*.
 *   - **Every denominator carries its credential-relative caption**
 *     ({@link UNIT_CAPTION}) and its `as of` date. A bare "1 of 2" would be read
 *     as coverage of the company, which is the claim this page never makes.
 *   - **Stale, "unverified since", and quiet-but-current are three distinct
 *     renderings**, never collapsed into a traffic light. `stale` shows its own
 *     arithmetic; `unverified` shows its reason and a real date; `current` says
 *     when it was checked, because a present-tense verdict resting on an
 *     unbounded-age reading is the flattering arm being the only opaque one.
 *   - **"Thin" gets no badge.** Counts are sorted and comparable and the
 *     judgment is the reader's — a thinness threshold would be Atlas deciding
 *     how much evidence a channel ought to produce.
 *   - **A degraded counter renders the "cannot establish" arm, never a zero.**
 *     Each no-counts arm has its own sentence, and none of them has a number.
 *   - **Labels appear only where the wire shape provides them.** The two-clause
 *     policy is server-side; nothing here derives, guesses, or falls back to an
 *     id when a label is absent — a withheld unit is not in `units` at all, and
 *     is disclosed as a count.
 */

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Clock,
  EyeOff,
  HelpCircle,
  Map as MapIcon,
  Radio,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  BrainCoverage,
  BrainCoverageClass,
  BrainCoverageClassAvailable,
  BrainCoverageFreshness,
  BrainCoverageMapEdge,
  BrainCoverageNamedUnit,
  BrainCoverageSourceClass,
} from "@/ui/lib/types";
import {
  type ClassCopy,
  CLASS_COPY,
  CLASS_ORDER,
  CLAUSE_COPY,
  MAP_EDGE_COPY,
  UNIT_CAPTION,
  UNVERIFIED_REASON_COPY,
  cannotEstablishClaim,
  datePhrase,
  enumerationNeverSucceededClaim,
  frozenEnumerationClaim,
  moreArmNoun,
  neverEnumeratedClaim,
  notSurveyableClaim,
  ratioPhrase,
} from "./vocabulary";
import { composeStatement } from "./statement";

/**
 * The top of the page: the composed statement.
 *
 * Rendered as prose, in the order {@link composeStatement} produced — one
 * sentence per class including the classes with nothing to say, then the map
 * edges, then the authority half. No tile, no ring, no headline number.
 */
export function CoverageStatement({ coverage }: { coverage: BrainCoverage }) {
  const statement = composeStatement(coverage);
  return (
    <Card className="shadow-none" data-testid="coverage-statement">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">What Atlas covers</CardTitle>
        <CardDescription>
          Stated in parts, each separately true. There is no single coverage percentage here —
          channels, mailboxes and warehouse entities are not the same kind of thing, so any one
          number would need weights nobody measured.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {statement.caveat !== null && (
          <p
            className="flex items-start gap-2 font-medium text-destructive"
            role="alert"
            data-testid="coverage-caveat"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{statement.caveat}</span>
          </p>
        )}
        <div className="space-y-1.5" data-testid="coverage-statement-availability">
          {statement.availability.map((sentence) => (
            <p key={sentence} className="text-muted-foreground">
              {sentence}
            </p>
          ))}
        </div>
        {statement.mapEdges.length > 0 && (
          <div className="space-y-1.5" data-testid="coverage-statement-map-edges">
            <p className="flex items-center gap-2 font-medium">
              <MapIcon className="size-4 shrink-0" aria-hidden />
              Where the map ends
            </p>
            {statement.mapEdges.map((sentence) => (
              <p key={sentence} className="text-muted-foreground">
                {sentence}
              </p>
            ))}
          </div>
        )}
        <div className="space-y-1.5" data-testid="coverage-statement-authority">
          {statement.authority.map((sentence) => (
            <p key={sentence} className="text-muted-foreground">
              {sentence}
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** The availability arm — one card per class, all five, always. */
export function AvailabilityArm({ coverage }: { coverage: BrainCoverage }) {
  return (
    <section className="space-y-4" aria-labelledby="coverage-availability-heading">
      <div>
        <h2 id="coverage-availability-heading" className="text-lg font-semibold">
          What is surveyed at all
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every count below is of what Atlas&apos;s own credentials can see, never of your company.
          Granting a broader scope makes a denominator grow, so connecting more can make a ratio go
          down — that is the number getting more honest, not worse.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {CLASS_ORDER.map((cls) => (
          <ClassCard key={cls} sourceClass={cls} arm={coverage.availability[cls]} />
        ))}
      </div>
    </section>
  );
}

function ClassCard({
  sourceClass,
  arm,
}: {
  sourceClass: BrainCoverageSourceClass;
  arm: BrainCoverageClass;
}) {
  const copy = CLASS_COPY[sourceClass];
  return (
    // The `id` is the plate's link target (#5422) — a quad on the Coverage
    // Plate is an anchor to its own card, which is the "one interaction away"
    // AC3 asks for. `scroll-mt-6` keeps the card's heading clear of the sticky
    // admin chrome when the anchor lands. It duplicates `data-testid` on
    // purpose: the test hook is a test hook, and hanging navigation off it
    // would make a rename of one silently break the other.
    <Card
      id={`coverage-class-${sourceClass}`}
      className="scroll-mt-6 shadow-none"
      data-testid={`coverage-class-${sourceClass}`}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{copy.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ClassBody sourceClass={sourceClass} arm={arm} />
      </CardContent>
    </Card>
  );
}

/**
 * The four arms, each with its own sentence and only ONE of them with numbers.
 *
 * The three no-count arms are what keeps a failed or absent enumeration from
 * rendering as an empty roster somebody measured — the green-while-nothing-is-
 * happening statement this whole surface exists to end.
 */
function ClassBody({
  sourceClass,
  arm,
}: {
  sourceClass: BrainCoverageSourceClass;
  arm: BrainCoverageClass;
}) {
  const copy = CLASS_COPY[sourceClass];

  // The CLAIMS come from `vocabulary.ts`; what this switch owns is the
  // PRESENTATION — which icon, which tone, and whether it is an alert. The two
  // were one thing until the paragraph and the card drifted into two wordings
  // of the same four sentences.
  switch (arm.state) {
    case "not-surveyable":
      return (
        <NoCounts icon={<EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden />}>
          {notSurveyableClaim(copy)}
        </NoCounts>
      );
    case "cannot-establish":
      return (
        <NoCounts
          tone="destructive"
          role="alert"
          icon={<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
        >
          {cannotEstablishClaim(copy)}
        </NoCounts>
      );
    case "never-enumerated":
      return arm.reason === "no-cycle-recorded" ? (
        <NoCounts icon={<HelpCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}>
          {neverEnumeratedClaim(copy)}
        </NoCounts>
      ) : (
        <NoCounts
          tone="destructive"
          role="alert"
          icon={<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
        >
          {enumerationNeverSucceededClaim(arm.lastAttemptAt, arm.unavailableReason)}
        </NoCounts>
      );
    case "enumerated":
      return <AvailableBody sourceClass={sourceClass} arm={arm} />;
  }
}

function AvailableBody({
  sourceClass,
  arm,
}: {
  sourceClass: BrainCoverageSourceClass;
  arm: BrainCoverageClassAvailable;
}) {
  const copy = CLASS_COPY[sourceClass];
  const asOf = datePhrase(arm.asOf);
  return (
    <>
      <div>
        {/* The ratio, and immediately beneath it the two things that make it a
            true statement: what the denominator is OF, and when it was taken.
            Neither is optional decoration — a bare ratio reads as coverage of
            the company. */}
        <p className="text-2xl font-bold" data-testid="coverage-ratio">
          {arm.ratio.enumerable === 0
            ? `No ${copy.units} found`
            : ratioPhrase(arm.ratio.surveyed, arm.ratio.enumerable, copy)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="coverage-denominator-caption">
          {UNIT_CAPTION[arm.ratio.unit]}
          {asOf === null ? "" : ` · as of ${asOf}`}
        </p>
      </div>

      {arm.unavailable !== null && (
        // Counts that are still the best Atlas has, over a caption saying they
        // are older than they look. Never INSTEAD of the counts — and never a
        // zero, which is what a client that dropped the arm would render.
        <p
          className="flex items-start gap-2 text-destructive"
          role="alert"
          data-testid="coverage-unavailable"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{frozenEnumerationClaim(arm.unavailable.since, arm.unavailable.reason)}</span>
        </p>
      )}

      {arm.ratio.enumerated > 0 && (
        <p className="text-muted-foreground">
          {arm.ratio.enumerated.toLocaleString()} {arm.ratio.enumerated === 1 ? "is" : "are"} visible
          to Atlas and unsurveyed
          {arm.ratio.inPerimeterWithoutEvidence > 0
            ? ` — ${arm.ratio.inPerimeterWithoutEvidence.toLocaleString()} of those are in scope and have produced no evidence yet`
            : ""}
          .
        </p>
      )}

      <FreshnessSummary arm={arm} />
      <MapEdgeList edges={arm.mapEdges} />

      {arm.unitsWithheld > 0 && (
        // Counted, never named. The most useful state-2 display would name a
        // mailbox — and naming a mailbox is naming a person.
        <p className="text-muted-foreground" data-testid="coverage-withheld">
          {arm.unitsWithheld.toLocaleString()} further{" "}
          {arm.unitsWithheld === 1 ? copy.unit : copy.units} counted above but not listed — nothing
          made their names disclosable. Their freshness is included in the tally.
        </p>
      )}

      {arm.units.length > 0 && (
        <UnitList units={arm.units} truncated={arm.unitsTruncated} copy={copy} />
      )}
    </>
  );
}

/**
 * The per-class freshness tally — the disclosure that costs a withheld unit
 * nothing.
 *
 * Three counts, never a single "health" verdict, because the three mean
 * different things and only one of them is a measurement.
 */
function FreshnessSummary({ arm }: { arm: BrainCoverageClassAvailable }) {
  if (arm.ratio.surveyed === 0) return null;
  const { current, stale, unverified } = arm.freshness;
  return (
    <div className="flex flex-wrap gap-2" data-testid="coverage-freshness">
      <Badge variant="outline" className="gap-1">
        <Radio className="size-3" aria-hidden />
        {current.toLocaleString()} current
      </Badge>
      <Badge variant={stale > 0 ? "destructive" : "outline"} className="gap-1">
        <Clock className="size-3" aria-hidden />
        {stale.toLocaleString()} stale
      </Badge>
      <Badge variant="secondary" className="gap-1">
        <HelpCircle className="size-3" aria-hidden />
        {unverified.toLocaleString()} unverified
      </Badge>
    </div>
  );
}

/**
 * State 3 — marks, and structurally no number.
 *
 * ⚠️ There is no count in this component and none may be added. An empty list
 * renders NOTHING rather than "the map is complete": the absence of edges is
 * already said by the ratio's caption, and a printed all-clear about the
 * unenumerable is the one sentence this surface can never support.
 */
function MapEdgeList({ edges }: { edges: readonly BrainCoverageMapEdge[] }) {
  if (edges.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="coverage-map-edges">
      <p className="flex items-center gap-2 font-medium">
        <MapIcon className="size-4 shrink-0" aria-hidden />
        Beyond the map
      </p>
      {edges.map((edge) => (
        <p key={edge} className="text-muted-foreground" data-testid={`coverage-map-edge-${edge}`}>
          {MAP_EDGE_COPY[edge]}
        </p>
      ))}
    </div>
  );
}

/**
 * How many units of ONE arm render before the rest go behind a disclosure.
 *
 * ⚠️ **A DISPLAY CHOICE, NOT A THRESHOLD.** The number is arbitrary: nothing
 * derives it and nothing may key off it. On this surface a bare constant beside
 * a coverage list is one refactor from becoming a verdict, which is the thing
 * ADR-0041 refuses in *"thin has no computed badge"* — so no count is compared
 * against this, no unit is styled by it, and it changes what is on SCREEN and
 * never what is CLAIMED. Every count renders OUTSIDE the disclosure whatever it
 * is set to; see {@link UnitList}.
 */
const UNIT_ARM_PREVIEW = 5;

/**
 * The namable units — with their evidence age, ordered so it can be compared,
 * and BOUNDED so the card cannot grow with the workspace (#5357).
 *
 * ## The bound is on both arms, and that is the whole point
 *
 * The defect was a warehouse card rendering 200 rows of `table.column` under a
 * ratio of 4 — 201 of the page's 205 unit rows in one card. The obvious fix is
 * to collapse the ENUMERATED arm, since an enumerated unit carries exactly one
 * bit ("it exists, nobody put it in the perimeter") that the count above already
 * states. That fix is also wrong on its own: `enumerable = surveyed +
 * enumerated`, so an admin who enrols 250 pairs rebuilds the same card out of
 * SURVEYED rows, with the enumerated arm already collapsed and the regression
 * therefore invisible as the thing that failed. Both arms are bounded by one
 * constant, and the invariant the suite pins is stated without a number:
 * **no card's default render is proportional to `ratio.enumerable`.**
 *
 * On today's data this degrades to exactly the small fix — warehouse surveyed is
 * 4, so the surveyed arm renders whole and only the enumerated arm collapses.
 *
 * ## Counts outside, statements about the LISTING inside
 *
 * The rule that decides where anything on this card goes, so it is not a
 * judgment call per element. The ratio, the unsurveyed count, the freshness
 * tally and the withheld sentence are counts: they render outside, always, and
 * a disclosure can never hide one. The clipped-listing sentence is a caption ON
 * the listing, so it renders inside — a reader who never expands has no listing
 * for it to be about, and spending a caption on an empty state teaches readers
 * to skip captions on a surface where the captions ARE the honesty rule.
 *
 * ⚠️ And it renders BEFORE the rows, not after. The old note sat after the
 * list; at 196 revealed rows that is 196 rows from where the reader starts, and
 * a disclosure about a long list placed at the end of that list is the original
 * defect in miniature.
 *
 * ## Ordering is unchanged, and must stay unchanged
 *
 * Surveyed units sort by newest evidence OLDEST FIRST, so the quietest sources
 * rise to the top; enumerated units follow alphabetically, having no evidence to
 * sort by. The preview is the FIRST {@link UNIT_ARM_PREVIEW} of that existing
 * order — never a re-sort. A bound that re-sorted would be a verdict about which
 * units deserve to be seen, which is the badge ADR-0041 refuses.
 */
function UnitList({
  units,
  truncated,
  copy,
}: {
  units: readonly BrainCoverageNamedUnit[];
  truncated: boolean;
  copy: ClassCopy;
}) {
  const sorted = units.toSorted((a, b) => {
    if (a.state !== b.state) return a.state === "surveyed" ? -1 : 1;
    if (a.state === "surveyed" && b.state === "surveyed") {
      // Lexicographic on the ISO stamps: same order as by instant, and it does
      // not invent a date for one that will not parse (`new Date(bad) - x` is
      // NaN, and NaN in a comparator scrambles the whole list silently).
      const byAge = a.newestEvidenceAt.localeCompare(b.newestEvidenceAt);
      if (byAge !== 0) return byAge;
    }
    return a.label.localeCompare(b.label);
  });
  const surveyed = sorted.filter((unit) => unit.state === "surveyed");
  const enumerated = sorted.filter((unit) => unit.state === "enumerated");
  // Which arm the clip landed in — DERIVED, not guessed. The server clips a
  // surveyed-first listing with `named.slice(0, COVERAGE_UNITS_MAX)`, so it
  // always removes from the tail, and the tail is the last arm holding units.
  const clippedArm = enumerated.length > 0 ? "enumerated" : "surveyed";
  return (
    <div className="space-y-3" data-testid="coverage-units">
      <UnitArm
        units={surveyed}
        kind="surveyed"
        copy={copy}
        clipped={truncated && clippedArm === "surveyed"}
      />
      <UnitArm
        units={enumerated}
        kind="enumerated"
        copy={copy}
        clipped={truncated && clippedArm === "enumerated"}
      />
    </div>
  );
}

/**
 * One arm of the unit list: a bounded preview, and the rest behind a disclosure.
 *
 * ⚠️ The expanded state is COMPONENT-LOCAL, deliberately against this admin
 * area's `nuqs` convention. A URL-persisted expansion is a deep link that
 * renders every shipped row on arrival — it hands the defect this bound exists
 * to fix to whoever receives the link, with nothing on the page explaining why
 * it looks like that. An expanded unit list is not a view worth sharing; the
 * shareable thing on this page is the statement, which always renders.
 */
function UnitArm({
  units,
  kind,
  copy,
  clipped,
}: {
  units: readonly BrainCoverageNamedUnit[];
  kind: "surveyed" | "enumerated";
  copy: ClassCopy;
  clipped: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (units.length === 0) return null;
  const preview = units.slice(0, UNIT_ARM_PREVIEW);
  const rest = units.slice(UNIT_ARM_PREVIEW);
  // The clipped-listing sentence has nowhere inside to go when this arm has no
  // disclosure, and it is still true — so it renders after the rows rather than
  // being dropped. An absent disclosure must never silence a statement.
  const clippedNote = clipped ? <ClippedListingNote copy={copy} /> : null;
  return (
    <div className="space-y-1" data-testid={`coverage-unit-arm-${kind}`}>
      {preview.map((unit) => (
        <UnitRow key={unit.unitId} unit={unit} />
      ))}
      {rest.length === 0 ? (
        clippedNote
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
            data-testid={`coverage-unit-more-${kind}`}
          >
            {/* No count, and no definite article. This control reveals what the
                response happened to carry, which for a clipped listing is fewer
                than the count stated above it — so "the unsurveyed pairs" would
                be a totality claim the control cannot keep, and a second number
                two lines under the first reads as a defect even when it is not. */}
            {open ? "Show fewer" : `Show more ${moreArmNoun(kind, copy)}`}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-1 pt-1">
            {clippedNote}
            {rest.map((unit) => (
              <UnitRow key={unit.unitId} unit={unit} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/**
 * The clipped listing's own caption — a **clipped listing** is response size,
 * never policy, and the two are not the same absence (`CONTEXT.md`).
 *
 * ⚠️ It names no number, and cannot. The cap is `COVERAGE_UNITS_MAX` in
 * `@atlas/api`, which the frontend does not import and the wire does not carry —
 * `unitsTruncated` is a boolean. Restating "200" here would be a second copy of
 * a constant across an HTTP boundary with nothing keeping the two in step, which
 * is a worse failure than an unnumbered sentence: the number would go quietly
 * wrong the day the cap moved. What the sentence must carry instead is the RULE
 * and its consequence — the clip is alphabetical, so names that sort later are
 * absent entirely, and a listing that says only "clipped" invites the reader to
 * assume a representative sample.
 */
function ClippedListingNote({ copy }: { copy: ClassCopy }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="coverage-units-truncated">
      This listing is clipped to the {copy.units} whose names sort earliest — later names are not
      listed at all. The counts above cover every {copy.unit}.
    </p>
  );
}

/**
 * One unit's row — unchanged by the bound: this decides WHAT is shown, the bound
 * decides how many.
 *
 * ## Both halves of ADR-0041's "thin is not a verdict"
 *
 * *"'Thin' has no computed badge. Counts are shown honestly; a thinness
 * threshold would be Atlas deciding how much evidence a channel ought to
 * produce. The judgment is the reader's."* — which only works if the reader is
 * given what to judge WITH. `newestEvidenceAt` used to be rendered in exactly
 * one place, inside the `stale` sentence, so a `current` or `unverified` unit
 * handed the reader a verdict and no evidence age at all. Every surveyed unit
 * carries its own, in one column, so the ages line up. The other half is the
 * ordering, which {@link UnitList} owns.
 */
function UnitRow({ unit }: { unit: BrainCoverageNamedUnit }) {
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
      data-testid="coverage-unit-row"
    >
      {/* The clause is on the label rather than in an `sr-only` note: why a
          name is disclosable is exactly as useful to a sighted admin, and a
          screen-reader-only version would have made this surface's own
          disclosure rule the one thing only some readers could see. */}
      <span className="font-medium" title={CLAUSE_COPY[unit.clause]}>
        {unit.label}
      </span>
      {unit.state === "surveyed" ? (
        <>
          <span className="text-xs text-muted-foreground" data-testid="coverage-evidence-age">
            newest evidence {datePhrase(unit.newestEvidenceAt) ?? "not recorded"}
          </span>
          <FreshnessLine freshness={unit.freshness} />
        </>
      ) : (
        <span className="text-xs text-muted-foreground">
          {unit.inPerimeter ? "in scope, no evidence read yet" : "visible to Atlas, not in scope"}
        </span>
      )}
    </div>
  );
}

/**
 * One unit's freshness, as three visually distinct sentences.
 *
 * `stale` carries its own arithmetic so the reader can check the verdict instead
 * of trusting it; `unverified-since` carries its reason and a real date, or no
 * date at all when nothing has ever been established — never today's; `current`
 * carries when the source was asked, because "current" is a claim about now
 * resting on a reading taken then.
 */
function FreshnessLine({ freshness }: { freshness: BrainCoverageFreshness }) {
  switch (freshness.kind) {
    case "current": {
      const checked = datePhrase(freshness.checkedAt);
      return (
        <span className="text-xs text-muted-foreground" data-testid="coverage-freshness-current">
          current{checked === null ? "" : ` — the source was asked on ${checked} and had not moved`}
        </span>
      );
    }
    case "stale": {
      // The arithmetic still travels — but the evidence half of it is the row's
      // own column now, so this states the OTHER instant and the direction. A
      // verdict a reader cannot check is a badge, which is what ADR-0041
      // refuses; both numbers are still on screen, just not twice.
      const moved = datePhrase(freshness.vendorActivityAt);
      return (
        <span
          className="text-xs font-medium text-destructive"
          data-testid="coverage-freshness-stale"
        >
          stale — the source moved on {moved ?? "an unreadable date"}, after that
        </span>
      );
    }
    case "unverified-since": {
      const since = datePhrase(freshness.since);
      return (
        <span className="text-xs text-muted-foreground" data-testid="coverage-freshness-unverified">
          {since === null
            ? "unverified — nothing has ever been established for it"
            : `unverified since ${since}`}{" "}
          ({UNVERIFIED_REASON_COPY[freshness.reason]})
        </span>
      );
    }
  }
}

/** A no-counts arm. It takes no number, which is the point. */
function NoCounts({
  children,
  icon,
  tone = "muted",
  role,
}: {
  children: ReactNode;
  icon: ReactNode;
  tone?: "muted" | "destructive";
  role?: "alert";
}) {
  return (
    <p
      className={
        tone === "destructive"
          ? "flex items-start gap-2 font-medium text-destructive"
          : "flex items-start gap-2 text-muted-foreground"
      }
      {...(role === undefined ? {} : { role })}
      data-testid="coverage-no-counts"
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}
