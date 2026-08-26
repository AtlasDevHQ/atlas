"use client";

/**
 * The Coverage Plate (#5422, ADR-0041) — the Coverage Surface at a glance.
 *
 * A USGS quadrangle index crossed with admiralty-chart soundings, per the design
 * committed at `docs/design/coverage-plate-mockup.html`. One quad per source
 * class; one sounding per survey unit; unsurveyed ground hatched and DRAWN rather
 * than omitted; the map's edge torn rather than counted.
 *
 * ## What this component is FOR
 *
 * Condition 6 is satisfied by `arms.tsx` — the page states what Atlas knows and
 * every part of it is correct. What was missing is condition 3: someone who has
 * never used Atlas telling the tiers apart *without being taught the vocabulary*
 * (#5375). Prose at 665 lines is legible to a careful reader; this is the bet
 * that the same facts are legible at a glance.
 *
 * ## It SUPPLEMENTS the arms; it does not replace them
 *
 * The seam decision, stated once here because it is the thing a later reader will
 * want to re-open. AC3 requires the three freshness renderings survive *"on the
 * plate or one interaction away"*, and the arms are where they survive: `stale`
 * carries its own arithmetic, `unverified-since` carries a reason and a real
 * date, `current` carries when the source was asked. None of those is a shape.
 * Beyond them the arms also carry the four no-count arms, the credential-relative
 * captions, the `as of` dates, the withheld-unit sentence and the clipped-listing
 * rule — every one of which is a decision ADR-0041 records, and none of which a
 * picture can make.
 *
 * So the plate is the glance and the arms are the reading, and a quad is a LINK
 * to its own class card: one interaction, and it lands on the sentences rather
 * than on a second wording of them.
 *
 * ## There are no numbers on this sheet, and that is not an omission
 *
 * Soundings are countable — that is the admiralty convention, and it is what
 * makes a plate a statement of quantity without a figure. Printing a ratio under
 * each quad would restate the card's own headline three inches above it, which
 * this codebase has twice recorded as the expensive kind of duplication (two
 * wordings drift; one of them gets edited). The single figure the sheet does
 * carry is its SCALE, and only when it is not 1:1.
 *
 * ## The palette is the mockup's structure re-hued, deliberately
 *
 * The mockup's argument is an ordinal single-hue ramp for how deep a unit sits in
 * the perimeter, plus ONE reserved caution colour used nowhere else. That
 * structure is kept exactly. The hue is not: the mockup is teal and ADR-0023 §4
 * commits this product to forest, *"never teal"*, so the ramp is re-stepped onto
 * the brand hue and revalidated (`--ordinal`: monotone lightness, adjacent ΔL
 * ≥ 0.06, light end ≥ 2:1 on the card, single hue) in both modes. The caution
 * colour is `--destructive`, which is what `arms.tsx` already renders `stale` in —
 * the same state must not be two colours on one page.
 *
 * @see ./plate-model.ts — everything this file CLAIMS; the drawing is here, the arithmetic is there
 * @see ../../../../../../../docs/design/coverage-plate-mockup.html
 * @see ../../../../../../../docs/adr/0041-the-coverage-surface-counts-what-it-can-see.md
 */

import type { BrainCoverage } from "@/ui/lib/types";
import { CLASS_COPY } from "./vocabulary";
import {
  buildSheet,
  type PlateBlankReason,
  type PlateMarkKind,
  type PlateQuad,
  type PlateQuadSurveyed,
  type PlateSheet,
} from "./plate-model";

// ---------------------------------------------------------------------------
// The plate's words
// ---------------------------------------------------------------------------

/**
 * ## Why this copy is here and not in `vocabulary.ts`
 *
 * `plate-model.ts` imports `CLASS_ORDER` from `vocabulary.ts`, so copy keyed on
 * the model's unions cannot live there without a cycle. It is exhaustive
 * `Record`s for `vocabulary.ts`'s reason all the same: a blank reason with no
 * word renders as an unlabelled hatched square, and an unlabelled hatched square
 * is four different statements wearing one face.
 *
 * ⚠️ **These are STATE NAMES, not claims.** Every one of them has a full
 * sentence on the class card — `neverEnumeratedClaim`, `cannotEstablishClaim`,
 * and the rest — and this must never become a second wording of one. The rule:
 * what is written here names the state and stops; what makes the assertion about
 * it lives in `vocabulary.ts` and renders on the card the quad links to.
 */
const BLANK_STATE: Record<PlateBlankReason, string> = {
  "measured-empty": "none found",
  "never-enumerated": "never enumerated",
  "enumeration-never-succeeded": "never succeeded",
  "cannot-establish": "cannot establish",
};

interface MarkCopy {
  readonly name: string;
  readonly detail: string;
}

/**
 * The legend — the only place the mark vocabulary is spoken.
 *
 * ## The three freshness marks carry the CARD's words, not friendlier ones
 *
 * `current`, `stale` and `unverified` are what `arms.tsx` calls them, so the
 * plate and the card below it are one vocabulary a reader learns once. An
 * earlier draft of this legend said *"moved on without us"* for `stale` — plainer
 * in isolation, and it quietly made the page use two names for one state, which
 * is the seam a reader crosses every time they follow a quad to its card. The
 * plain-English gloss belongs in {@link MarkCopy.detail}, where it explains the
 * word instead of replacing it.
 */
const MARK_COPY: Record<PlateMarkKind, MarkCopy> = {
  "surveyed-current": {
    name: "Surveyed, current",
    detail: "Atlas has read it, and last time it asked, the source had not moved.",
  },
  "surveyed-stale": {
    name: "Surveyed, stale",
    detail:
      "Atlas has read it, and the source has moved on since — a measured lag, not a guess. The card below shows both dates.",
  },
  "surveyed-unverified": {
    name: "Surveyed, unverified",
    detail:
      "Atlas has read it, but cannot say whether the source has moved since. Hollow centre: nothing has looked lately.",
  },
  "in-scope-no-evidence": {
    name: "In scope, nothing read yet",
    detail: "Somebody put it in the perimeter and no evidence has come out of it.",
  },
  "visible-not-in-scope": {
    name: "Visible, not in scope",
    detail: "Atlas's credentials can see it exists. Nobody has put it in the perimeter.",
  },
};

// ---------------------------------------------------------------------------
// Sheet geometry
// ---------------------------------------------------------------------------

const SHEET_W = 1000;
const NEAT_INSET = 1;
const PAD = 22;
const QUAD_H = 148;
const LABEL_BAND = 36;
const GAP = 14;
const MARGIN_BAND = 52;

/** Fisher-Yates over a deterministic stream — a quad never reshuffles between renders. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function seedOf(text: string): number {
  return text.split("").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
}

/**
 * Where the soundings go.
 *
 * A jittered grid rather than the mockup's free scatter: free scatter clumps and
 * leaves holes, and on this sheet a hole reads as unsurveyed ground. The jitter
 * keeps it reading as soundings rather than as a matrix.
 */
function placements(count: number, w: number, h: number, next: () => number) {
  if (count <= 0) return [];
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * w) / h)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = w / cols;
  const cellH = h / rows;
  const r = Math.min(3.4, Math.max(1.5, Math.min(cellW, cellH) * 0.3));
  return Array.from({ length: count }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      cx: (col + 0.5) * cellW + (next() - 0.5) * cellW * 0.5,
      cy: (row + 0.5) * cellH + (next() - 0.5) * cellH * 0.5,
      r,
    };
  });
}

/**
 * The quad outline, torn on the right where the map ends.
 *
 * ADR-0041's state 3, drawn: the survey stops short of what these credentials can
 * see, so the sheet stops short too. A ragged edge carries no quantity, which is
 * the whole requirement — *"any denominator that includes it is fabricated"*.
 */
function quadPath(x: number, y: number, w: number, h: number, torn: boolean): string {
  if (!torn) return `M${x},${y} h${w} v${h} h${-w} Z`;
  const teeth = 9;
  const step = h / teeth;
  const parts = [`M${x},${y}`, `h${w - 6}`];
  for (let i = 0; i < teeth; i++) {
    parts.push(`l${i % 2 === 0 ? 6 : -6},${step.toFixed(2)}`);
  }
  parts.push(`H${x}`, "Z");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

function Mark({
  kind,
  cx,
  cy,
  r,
}: {
  kind: PlateMarkKind;
  cx: number;
  cy: number;
  r: number;
}) {
  switch (kind) {
    case "surveyed-current":
      return <circle cx={cx} cy={cy} r={r} fill="var(--plate-surveyed)" />;
    case "surveyed-stale":
      return (
        <>
          <circle cx={cx} cy={cy} r={r} fill="var(--plate-surveyed)" />
          <circle
            cx={cx}
            cy={cy}
            r={r + 2.1}
            fill="none"
            stroke="var(--plate-stale)"
            strokeWidth={1.3}
          />
        </>
      );
    case "surveyed-unverified":
      return (
        <>
          <circle cx={cx} cy={cy} r={r} fill="var(--plate-surveyed)" />
          {/* The hollow centre is the secondary encoding the whole legend leans
              on: it separates this from `current` for a reader who cannot use
              the ring, and it is why the three freshness renderings survive
              shape-first rather than colour-first. */}
          <circle cx={cx} cy={cy} r={Math.max(0.8, r * 0.45)} fill="var(--card)" />
        </>
      );
    case "in-scope-no-evidence":
      return (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="var(--plate-inscope)"
            strokeWidth={1.5}
          />
          <circle cx={cx} cy={cy} r={1.2} fill="var(--plate-inscope)" />
        </>
      );
    case "visible-not-in-scope":
      return (
        <circle
          cx={cx}
          cy={cy}
          r={r * 0.85}
          fill="none"
          stroke="var(--plate-visible)"
          strokeWidth={1.4}
        />
      );
  }
}

function Soundings({ quad, w, h }: { quad: PlateQuadSurveyed; w: number; h: number }) {
  const next = rng(seedOf(quad.sourceClass));
  const kinds: PlateMarkKind[] = [];
  for (const run of quad.runs) {
    for (let i = 0; i < run.marks; i++) kinds.push(run.kind);
  }
  // Interleave, so tiers read as mixed ground rather than as bands — a banded
  // quad would read as an ordering nobody measured.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = kinds[i];
    const other = kinds[j];
    if (swap === undefined || other === undefined) continue;
    kinds[i] = other;
    kinds[j] = swap;
  }
  const spots = placements(kinds.length, w - 16, h - 16, next);
  return (
    <>
      {spots.map((spot, i) => {
        const kind = kinds[i];
        if (kind === undefined) return null;
        return (
          <Mark
            key={i}
            kind={kind}
            cx={8 + spot.cx}
            cy={8 + spot.cy}
            r={spot.r}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Quads
// ---------------------------------------------------------------------------

/**
 * One quad's accessible name — the sheet's only spoken account of itself.
 *
 * It names the STATE and, for a drawn quad, the mark counts it actually shows.
 * The counts here are the run's `units`, never its `marks`: a screen reader must
 * be told what is true, not what was drawable at the sheet's current scale.
 */
function quadLabel(quad: PlateQuad): string {
  const title = CLASS_COPY[quad.sourceClass].title;
  switch (quad.render) {
    case "soundings": {
      const parts = quad.runs.map(
        (run) => `${run.units.toLocaleString()} ${MARK_COPY[run.kind].name.toLowerCase()}`,
      );
      const torn = quad.tornEdge ? ", and the survey stops short of what its credentials can see" : "";
      return `${title}: ${parts.join("; ")}${torn}. Open its card for the counts and dates.`;
    }
    case "unsurveyed":
      return `${title}: nothing surveyed — ${BLANK_STATE[quad.reason]}. Open its card for what that means.`;
    case "undrawable":
      return `${title}: its counts disagree, so nothing is drawn. Open its card.`;
    case "off-survey":
      return `${title}: not a surveyable class, so it is off the survey rather than unsurveyed.`;
  }
}

function Quad({
  quad,
  x,
  y,
  w,
}: {
  quad: PlateQuad;
  x: number;
  y: number;
  w: number;
}) {
  const copy = CLASS_COPY[quad.sourceClass];
  const blank = quad.render !== "soundings";
  const fault = quad.render === "unsurveyed" && quad.fault;
  const undrawable = quad.render === "undrawable";
  const caution = fault || undrawable;
  return (
    <a
      href={`#coverage-class-${quad.sourceClass}`}
      className="plate-quad"
      aria-label={quadLabel(quad)}
      data-testid={`plate-quad-${quad.sourceClass}`}
      data-render={quad.render}
    >
      <path
        d={quadPath(x, y, w, QUAD_H, quad.render === "soundings" && quad.tornEdge)}
        fill={blank ? "url(#plate-hatch)" : "var(--plate-ground)"}
        stroke={caution ? "var(--plate-stale)" : "var(--plate-rule)"}
        strokeWidth={caution ? 1.4 : 1}
        strokeDasharray={caution ? "5 3" : undefined}
      />
      {quad.render === "soundings" && (
        <g transform={`translate(${x},${y})`}>
          <Soundings quad={quad} w={w} h={QUAD_H} />
        </g>
      )}
      {/* The class name — italic when nothing is surveyed, after the chart
          convention the mockup names. `--plate-ink-soft` rather than a fainter
          ink because this is a real label carrying a real state, and the state
          word beside it is the only thing distinguishing four different kinds
          of blank. */}
      <text
        x={x + 1}
        y={y + QUAD_H + 15}
        fill="var(--plate-ink)"
        fontSize={12.5}
        fontWeight={blank ? 400 : 600}
        fontStyle={blank ? "italic" : "normal"}
      >
        {copy.title}
      </text>
      {quad.render === "unsurveyed" && (
        <text
          x={x + 1}
          y={y + QUAD_H + 29}
          fill={fault ? "var(--plate-stale)" : "var(--plate-ink-soft)"}
          fontSize={11}
          fontStyle="italic"
        >
          {BLANK_STATE[quad.reason]}
        </text>
      )}
      {quad.render === "undrawable" && (
        <text
          x={x + 1}
          y={y + QUAD_H + 29}
          fill="var(--plate-stale)"
          fontSize={11}
          fontStyle="italic"
        >
          counts disagree — not drawn
        </text>
      )}
      {quad.render === "soundings" && quad.frozen && (
        <text
          x={x + 1}
          y={y + QUAD_H + 29}
          fill="var(--plate-stale)"
          fontSize={11}
          fontStyle="italic"
        >
          enumeration frozen
        </text>
      )}
      {quad.render === "soundings" && quad.tornEdge && (
        <text
          x={x + w}
          y={y + QUAD_H + 29}
          fill="var(--plate-ink-soft)"
          fontSize={11}
          fontStyle="italic"
          textAnchor="end"
        >
          torn edge
        </text>
      )}
    </a>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function Sheet({ sheet }: { sheet: PlateSheet }) {
  const n = sheet.quads.length;
  const sheetH = PAD + QUAD_H + LABEL_BAND + PAD;
  const hasMargin = sheet.margin.length > 0;
  const totalH = sheetH + (hasMargin ? MARGIN_BAND : 0);
  const quadW = n > 0 ? (SHEET_W - PAD * 2 - GAP * (n - 1)) / n : 0;

  return (
    <svg
      viewBox={`0 0 ${SHEET_W} ${totalH}`}
      className="block h-auto w-full min-w-[820px]"
      role="img"
      aria-label="Coverage plate: one quadrangle per source class, one sounding per survey unit, unsurveyed ground hatched"
      data-testid="coverage-plate-sheet"
    >
      <defs>
        <pattern
          id="plate-hatch"
          width={7}
          height={7}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={7} stroke="var(--plate-hatch)" strokeWidth={1.7} />
        </pattern>
      </defs>

      {/* The neatline. Everything inside it is survey; the band beneath it is
          not, which is the whole reason a non-surveyable class is drawn down
          there rather than hatched up here. */}
      <rect
        x={NEAT_INSET}
        y={NEAT_INSET}
        width={SHEET_W - NEAT_INSET * 2}
        height={sheetH - NEAT_INSET * 2}
        fill="none"
        stroke="var(--plate-rule)"
        strokeWidth={1}
      />

      {sheet.quads.map((quad, i) => (
        <Quad
          key={quad.sourceClass}
          quad={quad}
          x={PAD + i * (quadW + GAP)}
          y={PAD}
          w={quadW}
        />
      ))}

      {hasMargin && (
        <g data-testid="coverage-plate-margin">
          <text
            x={PAD}
            y={sheetH + 20}
            fill="var(--plate-ink-soft)"
            fontSize={9.5}
            fontWeight={700}
            letterSpacing="1.6"
          >
            OFF SURVEY
          </text>
          {sheet.margin.map((quad, i) => (
            <a
              key={quad.sourceClass}
              href={`#coverage-class-${quad.sourceClass}`}
              className="plate-quad"
              aria-label={quadLabel(quad)}
              data-testid={`plate-quad-${quad.sourceClass}`}
              data-render="off-survey"
            >
              <rect
                x={PAD + i * 190}
                y={sheetH + 26}
                width={16}
                height={16}
                fill="none"
                stroke="var(--plate-rule)"
                strokeWidth={1}
              />
              <text
                x={PAD + i * 190 + 24}
                y={sheetH + 38}
                fill="var(--plate-ink-soft)"
                fontSize={12}
                fontStyle="italic"
              >
                {CLASS_COPY[quad.sourceClass].title} — not a surveyable class
              </text>
            </a>
          ))}
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function LegendMark({ kind }: { kind: PlateMarkKind }) {
  return (
    <svg width={34} height={14} aria-hidden className="mt-0.5 shrink-0">
      {[6, 17, 28].map((cx) => (
        <Mark key={cx} kind={kind} cx={cx} cy={7} r={3.1} />
      ))}
    </svg>
  );
}

function Legend({ sheet }: { sheet: PlateSheet }) {
  return (
    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2" data-testid="coverage-plate-legend">
      {(Object.keys(MARK_COPY) as PlateMarkKind[]).map((kind) => (
        <div key={kind} className="flex items-start gap-3">
          <LegendMark kind={kind} />
          <div className="min-w-0">
            <div className="text-xs font-semibold">{MARK_COPY[kind].name}</div>
            <div className="text-xs text-muted-foreground">{MARK_COPY[kind].detail}</div>
          </div>
        </div>
      ))}
      <div className="flex items-start gap-3">
        <svg width={34} height={14} aria-hidden className="mt-0.5 shrink-0">
          <rect
            x={1}
            y={1}
            width={32}
            height={12}
            fill="url(#plate-hatch-legend)"
            stroke="var(--plate-rule)"
            strokeWidth={1}
          />
          <defs>
            <pattern
              id="plate-hatch-legend"
              width={5}
              height={5}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1={0} y1={0} x2={0} y2={5} stroke="var(--plate-hatch)" strokeWidth={1.5} />
            </pattern>
          </defs>
        </svg>
        <div className="min-w-0">
          <div className="text-xs font-semibold italic">Unsurveyed</div>
          <div className="text-xs text-muted-foreground">
            Nothing is surveyed here. Drawn rather than left out, and set in italic — the word
            beneath each says which kind of nothing it is.
          </div>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <svg width={34} height={14} aria-hidden className="mt-0.5 shrink-0">
          <path
            d="M1,1 h26 l6,3 l-6,3 l6,3 l-6,3 H1 Z"
            fill="none"
            stroke="var(--plate-rule)"
            strokeWidth={1}
          />
        </svg>
        <div className="min-w-0">
          <div className="text-xs font-semibold">Torn edge</div>
          <div className="text-xs text-muted-foreground">
            The survey stops short of what these credentials can see. There is no count of what
            lies past it — any number here would be invented. The card says what happened.
          </div>
        </div>
      </div>
      {sheet.unitsPerMark > 1 && (
        <p className="text-xs text-muted-foreground sm:col-span-2" data-testid="coverage-plate-scale">
          Drawn at a reduced scale: one sounding stands for up to{" "}
          {sheet.unitsPerMark.toLocaleString()} survey units, and any count above zero still draws
          at least one sounding. The exact counts are on the cards below.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The plate
// ---------------------------------------------------------------------------

export function CoveragePlate({ coverage }: { coverage: BrainCoverage }) {
  const sheet = buildSheet(coverage);
  return (
    <section
      className="rounded-xl border bg-card text-card-foreground"
      aria-labelledby="coverage-plate-heading"
      data-testid="coverage-plate"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b px-6 py-4">
        <h2 id="coverage-plate-heading" className="text-base font-semibold tracking-tight">
          The coverage plate
        </h2>
        {/* The scale note, which on this sheet is a HONESTY rule and not a
            caption: a mark on one quad is a channel and on another an
            entity–dimension pair, so the quads are not comparable and the sheet
            has no total. That is ADR-0041's incommensurability, drawn. */}
        <p className="text-xs text-muted-foreground" data-testid="coverage-plate-caption">
          One quadrangle per source, one sounding per survey unit — a channel, a mailbox, an
          entity–dimension pair. Different sources count different things, so the quads do not
          add up and nothing here is a total. Select a quadrangle for its counts and dates.
        </p>
      </div>
      <div className="overflow-x-auto px-6 py-5">
        <Sheet sheet={sheet} />
      </div>
      <div className="border-t px-6 py-5">
        <Legend sheet={sheet} />
      </div>
    </section>
  );
}
