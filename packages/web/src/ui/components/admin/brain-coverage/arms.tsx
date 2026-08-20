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

import type { ReactNode } from "react";
import {
  AlertTriangle,
  Clock,
  EyeOff,
  HelpCircle,
  Map as MapIcon,
  Radio,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
    <Card className="shadow-none" data-testid={`coverage-class-${sourceClass}`}>
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

      {arm.units.length > 0 && <UnitList units={arm.units} truncated={arm.unitsTruncated} />}
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
 * The namable units — with their evidence age, ordered so it can be compared.
 *
 * ## Both halves of ADR-0041's "thin is not a verdict"
 *
 * *"'Thin' has no computed badge. Counts are shown honestly; a thinness
 * threshold would be Atlas deciding how much evidence a channel ought to
 * produce. The judgment is the reader's."* — which only works if the reader is
 * given what to judge WITH. `newestEvidenceAt` used to be rendered in exactly
 * one place, inside the `stale` sentence, so a `current` or `unverified` unit
 * handed the reader a verdict and no evidence age at all. Every surveyed unit
 * now carries its own, in one column, so the ages line up.
 *
 * And the ORDER is the other half — the issue asks for counts "sorted and
 * comparable". Surveyed units sort by newest evidence, OLDEST FIRST, so the
 * quietest sources rise to the top without anything labelling them thin;
 * enumerated units follow alphabetically, since they have no evidence to sort
 * by. Sorting alphabetically throughout (the first cut) made the list findable
 * and the comparison the ADR asks for impossible.
 *
 * ⚠️ Ordering is NOT a verdict, and must not become one: no threshold, no
 * highlight, no "needs attention" — the rows are the same weight, and being
 * first means only that its newest evidence is older.
 */
function UnitList({
  units,
  truncated,
}: {
  units: readonly BrainCoverageNamedUnit[];
  truncated: boolean;
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
  return (
    <div className="space-y-1" data-testid="coverage-units">
      {sorted.map((unit) => (
        <div key={unit.unitId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
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
              {unit.inPerimeter
                ? "in scope, no evidence read yet"
                : "visible to Atlas, not in scope"}
            </span>
          )}
        </div>
      ))}
      {truncated && (
        <p className="text-xs text-muted-foreground" data-testid="coverage-units-truncated">
          The list above is clipped. The counts are not — they are tallied over every unit.
        </p>
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
