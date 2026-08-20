/**
 * The Coverage Surface's words (#5215, ADR-0041).
 *
 * Every string a coverage number is rendered beside lives here, in one map per
 * closed union, because on this surface the caption is not decoration — it is
 * the honesty rule. ADR-0041: *"Every denominator is credential-relative. No
 * count on this page ever has 'the company' as its universe; the honest phrasing
 * is 'of what Atlas's credentials can see.'"* A ratio that reached the screen
 * without its caption would be read as coverage OF THE COMPANY, which is the one
 * claim this page exists never to make.
 *
 * ## Why these are exhaustive `Record`s and not `switch`es with a default
 *
 * Each map is keyed on a closed wire union, so a member added upstream is a
 * compile error here rather than a silently unlabelled mark or an uncaptioned
 * denominator. That matters most for {@link MAP_EDGE_COPY}: an edge with no
 * sentence renders as nothing, and *nothing* on the map-edge list is the page
 * saying the map is complete.
 *
 * ## The ONE string this module does not own
 *
 * `unavailable.reason` and `never-enumerated`'s `unavailableReason` are free
 * text from the enumerator, and they reach the DOM verbatim — the only reasons
 * on this surface that are not a closed enum with copy here. That is ADR-0041,
 * not an oversight: *"the reason is admin-facing text the enumerator wrote"*,
 * and it is the sentence that names something an operator can go fix (*"Slack
 * returned 429 for the channel listing"*). An enum would round every distinct
 * vendor failure to the same shrug. The bound on it is the wire schema's
 * `z.string()` and React's escaping; the rule it must keep is that it is always
 * ADDITIVE — appended after a claim this module owns, never the whole sentence,
 * so a producer that says nothing useful still leaves a true statement standing.
 *
 * ## There is no percentage in this file, deliberately
 *
 * Not one string here formats a ratio as a percent, and none ever should. A
 * percent is one `Object.values().reduce()` away from a blended company-wide
 * score, which ADR-0041 refuses permanently — the layers are incommensurable and
 * any blend needs invented weights. The renderable form of a ratio is
 * "{surveyed} of {enumerable} {unit}", with the unit attached.
 */

import type {
  BrainCoverageMapEdge,
  BrainCoverageSourceClass,
  BrainCoverageUnitOrigin,
  BrainCoverageUnverifiedReason,
} from "@/ui/lib/types";

/** How one source class is spoken about. */
export interface ClassCopy {
  /** Section heading — a place an admin recognises, not a wire enum. */
  readonly title: string;
  /** The plural noun a count of this class's units takes. */
  readonly units: string;
  /** The singular, for the "1 of 2" case. */
  readonly unit: string;
}

/**
 * The order every list of classes on this surface reads in — the composed
 * paragraph and the card grid alike.
 *
 * ## Fixed, and PINNED, and in one place
 *
 * Fixed because sorting by coverage would let the statement lead with whichever
 * class happens to look best today. In one place because it was briefly two
 * arrays in two files, which is the same list maintained twice.
 *
 * Pinned because a plain `readonly BrainCoverageSourceClass[]` is the one class
 * list a compiler cannot check. Adding a sixth class forces an edit to
 * {@link CLASS_COPY} and {@link UNIT_CAPTION} — they are exhaustive `Record`s —
 * so the author is stopped there and never sent here; the build then stays green
 * with the new class absent from the paragraph AND from the grid. That is
 * precisely the failure `statement.ts` calls load-bearing: *a class silently
 * omitted from the paragraph reads as a class with nothing to worry about.*
 */
export const CLASS_ORDER = [
  "chat",
  "transcript",
  "email",
  "warehouse",
  "human",
] as const satisfies readonly BrainCoverageSourceClass[];

/** Compile error if a class joins the union without joining the order above. */
type _ClassOrderCovers = [
  Exclude<BrainCoverageSourceClass, (typeof CLASS_ORDER)[number]>,
] extends [never]
  ? true
  : never;
const _classOrderCovers: _ClassOrderCovers = true;
void _classOrderCovers;

export const CLASS_COPY: Record<BrainCoverageSourceClass, ClassCopy> = {
  chat: { title: "Chat", units: "chat channels", unit: "chat channel" },
  transcript: {
    title: "Meeting transcripts",
    units: "meeting recordings",
    unit: "meeting recording",
  },
  email: { title: "Mail", units: "mailboxes", unit: "mailbox" },
  warehouse: {
    title: "Warehouse",
    units: "enrolled entity–dimension pairs",
    unit: "enrolled entity–dimension pair",
  },
  human: { title: "People", units: "people", unit: "person" },
};

/**
 * The denominator's caption — what the number is *of*, per unit.
 *
 * Each one names the CREDENTIAL, never the company, and each says so in words an
 * admin can act on: widening a scope grows the denominator, so a ratio going
 * down after connecting more sources is correct behaviour rather than a
 * regression, and the caption is where a reader learns that.
 */
export const UNIT_CAPTION: Record<BrainCoverageUnitOrigin, string> = {
  "chat-channel-roster": "of the channels Atlas's chat credentials can see",
  "granted-recording-scopes": "of the recordings Atlas's granted scopes can see",
  "mailbox-list": "of the mailboxes Atlas's mail credentials can see",
  "semantic-layer-enrollment": "of the entity–dimension pairs a human enrolled",
};

/**
 * The map edges — ADR-0041's third state, as SENTENCES.
 *
 * ⚠️ **Not one of these carries a number, and none may ever be given one.** The
 * unenumerable is a mark precisely because *"any denominator that includes it is
 * fabricated"*; "we estimate 40% of channels are invisible" is the rejected
 * alternative this vocabulary exists to make unspellable. Each string states
 * that the edge exists and what is beyond it, and stops there.
 */
export const MAP_EDGE_COPY: Record<BrainCoverageMapEdge, string> = {
  "chat-public-roster-unreadable":
    "The channel roster could not be read at all, so there are channels beyond everything counted here.",
  "chat-public-roster-truncated":
    "The channel roster came back clipped, so there are channels beyond the ones counted here.",
  "chat-activity-unreadable":
    "Chat would not report channel activity, so no lag could be measured for this class.",
  "chat-unit-ids-unrecognised":
    "Some channel identifiers were not recognised, so those channels sit outside every count here.",
  "warehouse-entity-bound-reached":
    "The entity enumeration reached its bound, so there are enrolled pairs beyond the ones counted here.",
  "warehouse-entity-unreadable":
    "The semantic layer's entity list could not be read, so there are enrolled pairs beyond everything counted here.",
};

/**
 * Why a unit carries no measured lag — six reasons, one sentence, per ADR-0041.
 *
 * They stay apart rather than collapsing into "unknown" because two of them are
 * ordinary (`no-activity-metadata` is a class that declared it cannot ask,
 * `not-probed` is the bounded rotation not having got there yet) and the rest
 * are faults an operator would act on. An admin cannot read a log line; this is
 * where the difference reaches them.
 */
export const UNVERIFIED_REASON_COPY: Record<BrainCoverageUnverifiedReason, string> = {
  "no-activity-metadata": "this source publishes no activity metadata, so no lag can be measured",
  "not-probed": "the rotation has not asked this source about it yet",
  "enumeration-unavailable": "the last enumeration cycle failed, so nobody looked",
  "reading-expired": "the last reading is older than this class's own sync cadence",
  "unreadable-reading": "the reading Atlas holds for it could not be read",
  "unresolvable-class": "this deployment cannot resolve the class",
};

/** Which clause admitted a label — shown so a reader knows why a name is here. */
export const CLAUSE_COPY = {
  "deliberate-act": "named because somebody put it in scope",
  "vendor-public": "named because its existence is public to the whole workspace",
} as const;

/**
 * "1 of 2 chat channels" — the only shape a ratio is rendered in.
 *
 * Takes both halves rather than a precomputed string so the singular/plural
 * agrees with the DENOMINATOR, which is the number the noun belongs to.
 */
export function ratioPhrase(
  surveyed: number,
  enumerable: number,
  copy: ClassCopy,
): string {
  const noun = enumerable === 1 ? copy.unit : copy.units;
  return `${surveyed.toLocaleString()} of ${enumerable.toLocaleString()} ${noun}`;
}

/**
 * A stored timestamp, resolved into the three things it can actually be.
 *
 * ## Why this is a union and not `string | null`
 *
 * It was `asOfLabel(): string | null`, and that name lied by conflation: `null`
 * meant BOTH *there is no date* and *the date would not parse*, which are
 * opposite statements on a surface whose whole job is not to conflate them. No
 * caller could tell them apart, so a corrupt stamp rendered as the absent case —
 * a unit with an unreadable reading read as *"nothing has ever been established
 * for it"*, and a frozen enumeration's caption simply lost its date.
 *
 * Three arms, and every caller must answer all three:
 *
 *   - `absent` — there is genuinely no date. Render NOTHING; never "recently"
 *     and never today's, which would turn "we have never looked" into "we looked
 *     just now".
 *   - `unreadable` — Atlas holds a stamp it cannot read. Say so. This is the arm
 *     that must not fall back to the absent case: a missing date reads as an
 *     ordinary state, and this one is a fault.
 *   - `date` — a real date, as an admin reads it.
 */
export type DateReading =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly raw: string }
  | { readonly kind: "date"; readonly label: string };

export function readDate(iso: string | null): DateReading {
  if (iso === null) return { kind: "absent" };
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { kind: "unreadable", raw: iso };
  return {
    kind: "date",
    label: parsed.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  };
}

/**
 * The date as a phrase, or `null` when there is genuinely none.
 *
 * The convenience the old `asOfLabel` was reaching for, WITHOUT the conflation:
 * an unreadable stamp comes back as words rather than as silence, so no caller
 * can drop a fault by writing `?? ""`.
 */
export function datePhrase(iso: string | null): string | null {
  const reading = readDate(iso);
  switch (reading.kind) {
    case "absent":
      return null;
    case "unreadable":
      return "an unreadable date";
    case "date":
      return reading.label;
  }
}

// ---------------------------------------------------------------------------
// The claims, stated ONCE
// ---------------------------------------------------------------------------

/**
 * ## Why the no-count arms live here rather than at their two render sites
 *
 * Each of these sentences is made twice — once as prose in the composed
 * statement, once beside an icon on the class card — and they were two
 * WORDINGS of the same claim, drifting independently. `statement.ts` already
 * makes this exact argument for the hidden-backlog line ("two WORDINGS would be
 * the maintenance hazard, since a later edit would reach one and not the
 * other") and simply had not applied it to the four class arms.
 *
 * So the CLAIM lives here and the PRESENTATION stays at each site: the card
 * keeps its icon, its tone and its `role="alert"`, the paragraph keeps its
 * `Title — ` prefix, and both say the same words.
 */
export function notSurveyableClaim(copy: ClassCopy): string {
  // `human`'s declared refusal. An affirmative product statement, not a gap:
  // the units would be people, and Atlas does not enumerate them.
  return `Not a surveyable class. Atlas does not enumerate ${copy.units}, so this is correctly absent from every ratio rather than missing from one.`;
}

export function cannotEstablishClaim(copy: ClassCopy): string {
  return `Atlas cannot establish anything about ${copy.units} in this deployment — the class has no contract here. No count is shown, because every number that could be shown would be made up.`;
}

export function neverEnumeratedClaim(copy: ClassCopy): string {
  return `Never enumerated. Nothing has looked for ${copy.units} in this workspace yet, so there is no denominator to show — not a zero.`;
}

/**
 * Tried and never once succeeded — a different sentence from "nobody has
 * looked", and the one that names something to fix.
 */
export function enumerationNeverSucceededClaim(
  lastAttemptAt: string | null,
  reason: string | null,
): string {
  const attempted = datePhrase(lastAttemptAt);
  const when = attempted === null ? "" : `, most recently on ${attempted}`;
  return `Enumeration has been attempted and has never succeeded${when}. ${reason ?? "No reason was recorded."}`;
}

/**
 * Dated counts whose enumerator has since stopped succeeding.
 *
 * ⚠️ Says "these counts", never "the counts above" — the same words have to
 * work in a paragraph and beside a card.
 */
export function frozenEnumerationClaim(since: string | null, reason: string): string {
  const when = datePhrase(since);
  const head =
    when === null
      ? "Enumeration has been unavailable since the last successful cycle."
      : `Enumeration has been unavailable since ${when}.`;
  return `${head} These counts are the last that succeeded. ${reason}`;
}
